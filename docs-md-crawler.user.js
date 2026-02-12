// ==UserScript==
// @name         Docs Markdown Crawler (Manual Scan)
// @namespace    https://github.com/yourname/docs-md-crawler
// @version      0.1.0
// @description  Manually scan docs pages on the current site and export Markdown ZIP
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @require      https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js
// @require      https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js
// ==/UserScript==
// Webhook verification note: sync test marker.

(function bootstrap(factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory({ isNode: true });
  } else {
    factory({ isNode: false });
  }
})(function main(env) {
  'use strict';

  const DEFAULT_EXCLUDES = ['/api/', '/login', '/admin', 'token='];
  const DEFAULTS = {
    rootPath: '/docs',
    maxPages: 300,
    maxDepth: 6,
    requestDelayMs: 300,
    timeoutMs: 15000,
    retries: 2,
    imageMode: 'local'
  };

  function normalizeRootPath(raw) {
    let root = String(raw || '/').trim();
    if (!root.startsWith('/')) {
      root = '/' + root;
    }
    if (root.length > 1) {
      root = root.replace(/\/+$/, '');
    }
    return root || '/';
  }

  function normalizeUrl(input) {
    try {
      const u = new URL(input);
      u.hash = '';
      u.search = '';
      if (u.pathname.length > 1) {
        u.pathname = u.pathname.replace(/\/+$/, '');
      }
      return u.href;
    } catch (_) {
      return '';
    }
  }

  function pathStartsWithRoot(pathname, rootPath) {
    if (rootPath === '/') {
      return true;
    }
    return pathname === rootPath || pathname.startsWith(rootPath + '/');
  }

  function isDocUrl(url, origin, rootPath, excludePatterns) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) {
        return false;
      }
      if (u.origin !== origin) {
        return false;
      }
      const cleanRoot = normalizeRootPath(rootPath);
      if (!pathStartsWithRoot(u.pathname, cleanRoot)) {
        return false;
      }
      const full = (u.pathname + u.search).toLowerCase();
      for (const pat of excludePatterns || []) {
        if (!pat) continue;
        if (full.includes(String(pat).toLowerCase())) {
          return false;
        }
      }
      if (/\.(png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|tar|gz|mp4|mp3|woff2?)$/i.test(u.pathname)) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function sanitizeSegment(value, fallback) {
    const cleaned = String(value || '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\.+$/g, '')
      .trim();
    if (!cleaned) {
      return fallback || 'untitled';
    }
    return cleaned.slice(0, 80);
  }

  function splitRootSegments(rootPath) {
    if (rootPath === '/') {
      return [];
    }
    return rootPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  }

  function splitPathSegments(pathname) {
    return pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  }

  function toRelativeSegments(pathSegments, rootSegments) {
    if (!rootSegments.length) {
      return pathSegments.slice();
    }
    for (let i = 0; i < rootSegments.length; i += 1) {
      if (pathSegments[i] !== rootSegments[i]) {
        return pathSegments.slice();
      }
    }
    return pathSegments.slice(rootSegments.length);
  }

  function buildMarkdownPath(url, title, rootPath, usedPaths) {
    const original = new URL(url);
    const u = new URL(normalizeUrl(url) || url);
    const root = normalizeRootPath(rootPath || '/');
    const rootSegments = splitRootSegments(root);
    const pathSegments = splitPathSegments(u.pathname);
    const relativeSegments = toRelativeSegments(pathSegments, rootSegments);

    const isDirectoryLike = original.pathname.endsWith('/');
    const relativeDirs = isDirectoryLike ? relativeSegments.slice() : relativeSegments.slice(0, -1);
    const leaf = isDirectoryLike
      ? 'index'
      : (relativeSegments.length ? relativeSegments[relativeSegments.length - 1] : 'index');
    const safeLeaf = sanitizeSegment(leaf || 'index', 'index');
    const safeTitle = sanitizeSegment(title || safeLeaf, safeLeaf);

    const prefixDirs = rootSegments.concat(relativeDirs);
    const baseDir = prefixDirs.length ? prefixDirs.join('/') + '/' : '';
    let fileName = safeLeaf + '__' + safeTitle + '.md';
    let candidate = baseDir + fileName;

    if (usedPaths) {
      let counter = 2;
      while (usedPaths.has(candidate)) {
        fileName = safeLeaf + '__' + safeTitle + '-' + counter + '.md';
        candidate = baseDir + fileName;
        counter += 1;
      }
      usedPaths.add(candidate);
    }

    return candidate;
  }

  function relativePath(fromFile, toFile) {
    const fromParts = fromFile.split('/').slice(0, -1);
    const toParts = toFile.split('/');
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
      i += 1;
    }
    const up = fromParts.length - i;
    const down = toParts.slice(i);
    const prefix = up ? '../'.repeat(up) : '';
    return prefix + down.join('/');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseSitemapsFromRobots(robotsText, origin) {
    const urls = [];
    if (!robotsText) {
      return urls;
    }
    const lines = String(robotsText).split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*Sitemap\s*:\s*(\S+)/i);
      if (m && m[1]) {
        try {
          urls.push(new URL(m[1], origin).href);
        } catch (_) {
          // ignore invalid sitemap URL
        }
      }
    }
    return urls;
  }

  function parseLinksFromHtml(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = [];
    doc.querySelectorAll('a[href]').forEach((a) => {
      const raw = a.getAttribute('href');
      if (!raw) return;
      try {
        links.push(new URL(raw, baseUrl).href);
      } catch (_) {
        // ignore invalid URL
      }
    });
    return links;
  }

  function extractDocTitle(doc, fallbackUrl) {
    const h1 = doc.querySelector('h1');
    const title = (h1 && h1.textContent) || doc.title || new URL(fallbackUrl).pathname.split('/').pop() || 'index';
    return sanitizeSegment(title, 'index');
  }

  function extractMainNode(doc) {
    const selectors = ['article', 'main', '[role="main"]', '.content', '.docs-content', '.markdown-body'];
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      if (node && node.textContent && node.textContent.trim().length > 100) {
        return node.cloneNode(true);
      }
    }
    const body = doc.body ? doc.body.cloneNode(true) : doc.documentElement.cloneNode(true);
    return body;
  }

  function cleanNodeForMarkdown(root) {
    root.querySelectorAll('script,style,noscript,iframe,nav,footer,header,aside').forEach((el) => el.remove());
  }

  function getImageSrc(img) {
    return img.getAttribute('src') || img.getAttribute('data-src') || '';
  }

  function buildAssetPath(imageUrl, usedAssets) {
    const u = new URL(imageUrl);
    const host = sanitizeSegment(u.hostname, 'assets');
    const pathname = u.pathname || '/image';
    const rawName = pathname.split('/').pop() || 'image';
    const dot = rawName.lastIndexOf('.');
    const base = dot > 0 ? rawName.slice(0, dot) : rawName;
    const ext = dot > 0 ? rawName.slice(dot) : '.bin';
    const safeBase = sanitizeSegment(base, 'image');
    let file = 'assets/' + host + '/' + safeBase + ext;
    let idx = 2;
    while (usedAssets.has(file)) {
      file = 'assets/' + host + '/' + safeBase + '-' + idx + ext;
      idx += 1;
    }
    usedAssets.add(file);
    return file;
  }

  function createTurndownService() {
    const service = new TurndownService({
      codeBlockStyle: 'fenced',
      headingStyle: 'atx'
    });

    if (typeof turndownPluginGfm !== 'undefined' && turndownPluginGfm.gfm) {
      service.use(turndownPluginGfm.gfm);
    }

    return service;
  }

  if (env.isNode) {
    return {
      normalizeUrl,
      isDocUrl,
      buildMarkdownPath,
      normalizeRootPath,
      sanitizeSegment,
      relativePath
    };
  }

  const state = {
    scanning: false,
    exporting: false,
    stopRequested: false,
    discoveredUrls: [],
    failed: [],
    foundCount: 0,
    doneCount: 0,
    failCount: 0,
    queueCount: 0,
    currentUrl: '',
    elements: {},
    scanSession: 0
  };

  function addStyles() {
    const css = [
      '#docs-md-fab{position:fixed;right:18px;bottom:18px;z-index:2147483644;padding:10px 14px;border:0;border-radius:999px;background:#13315c;color:#fff;font:600 13px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.25)}',
      '#docs-md-panel{position:fixed;right:18px;bottom:70px;width:360px;max-height:78vh;background:#fff;border:1px solid #d4d7dd;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:2147483644;display:none;overflow:hidden;color:#1f2937;font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}',
      '#docs-md-panel.open{display:flex;flex-direction:column}',
      '#docs-md-head{padding:10px 12px;background:linear-gradient(130deg,#f6f9ff 0%,#e8f0ff 100%);border-bottom:1px solid #e3e7ee;display:flex;justify-content:space-between;align-items:center;font-weight:700}',
      '#docs-md-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px;overflow:auto}',
      '#docs-md-body input,#docs-md-body select{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #c9d0db;border-radius:8px;background:#fff}',
      '#docs-md-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '#docs-md-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '#docs-md-actions button{border:0;border-radius:8px;padding:7px 10px;cursor:pointer;font-weight:600}',
      '#docs-md-scan{background:#164e63;color:#fff}',
      '#docs-md-export{background:#0a7f38;color:#fff}',
      '#docs-md-stop{background:#8c2f39;color:#fff}',
      '#docs-md-status{background:#f7f9fc;border:1px solid #dbe3ef;border-radius:8px;padding:8px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '#docs-md-tree{border:1px solid #dbe3ef;border-radius:8px;padding:8px;max-height:260px;overflow:auto;background:#fbfcff}',
      '.docs-md-item{display:flex;align-items:flex-start;gap:6px;padding:4px 0;border-bottom:1px dashed #eef2f7}',
      '.docs-md-item:last-child{border-bottom:0}',
      '.docs-md-item span{word-break:break-all}',
      '.docs-md-mini{font-size:12px;color:#4b5563}',
      '#docs-md-close{background:transparent;border:0;font-size:18px;line-height:1;cursor:pointer;color:#1f2937}'
    ].join('');

    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function createUI() {
    const fab = document.createElement('button');
    fab.id = 'docs-md-fab';
    fab.type = 'button';
    fab.textContent = '扫描文档';

    const panel = document.createElement('div');
    panel.id = 'docs-md-panel';
    panel.innerHTML = [
      '<div id="docs-md-head"><span>Docs Markdown Crawler</span><button id="docs-md-close" type="button">×</button></div>',
      '<div id="docs-md-body">',
      '  <label class="docs-md-mini">文档根路径</label>',
      '  <input id="docs-md-root" value="' + DEFAULTS.rootPath + '" placeholder="/docs">',
      '  <div id="docs-md-row">',
      '    <div><label class="docs-md-mini">最大页面数</label><input id="docs-md-max-pages" type="number" min="1" max="2000" value="' + DEFAULTS.maxPages + '"></div>',
      '    <div><label class="docs-md-mini">图片模式</label><select id="docs-md-image-mode"><option value="local" selected>下载本地</option><option value="external">保留外链</option></select></div>',
      '  </div>',
      '  <div id="docs-md-actions">',
      '    <button id="docs-md-scan" type="button">扫描目录</button>',
      '    <button id="docs-md-export" type="button">导出 ZIP</button>',
      '    <button id="docs-md-stop" type="button">停止</button>',
      '  </div>',
      '  <div id="docs-md-status">等待手动扫描</div>',
      '  <label class="docs-md-mini"><input id="docs-md-check-all" type="checkbox" checked> 全选</label>',
      '  <div id="docs-md-tree"></div>',
      '</div>'
    ].join('');

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    state.elements = {
      fab,
      panel,
      closeBtn: panel.querySelector('#docs-md-close'),
      rootInput: panel.querySelector('#docs-md-root'),
      maxPagesInput: panel.querySelector('#docs-md-max-pages'),
      imageModeSelect: panel.querySelector('#docs-md-image-mode'),
      scanBtn: panel.querySelector('#docs-md-scan'),
      exportBtn: panel.querySelector('#docs-md-export'),
      stopBtn: panel.querySelector('#docs-md-stop'),
      status: panel.querySelector('#docs-md-status'),
      tree: panel.querySelector('#docs-md-tree'),
      checkAll: panel.querySelector('#docs-md-check-all')
    };

    state.elements.fab.addEventListener('click', () => {
      panel.classList.toggle('open');
    });

    state.elements.closeBtn.addEventListener('click', () => {
      panel.classList.remove('open');
    });

    state.elements.scanBtn.addEventListener('click', runScan);
    state.elements.exportBtn.addEventListener('click', runExport);
    state.elements.stopBtn.addEventListener('click', () => {
      state.stopRequested = true;
      setStatus('已请求停止，等待当前任务收尾...');
    });

    state.elements.checkAll.addEventListener('change', () => {
      const checked = state.elements.checkAll.checked;
      state.elements.tree.querySelectorAll('input[type="checkbox"][data-url]').forEach((el) => {
        el.checked = checked;
      });
    });
  }

  function setStatus(text) {
    if (state.elements.status) {
      state.elements.status.textContent = text;
    }
  }

  function updateProgress(extra) {
    const lines = [
      '发现: ' + state.foundCount,
      '队列: ' + state.queueCount,
      '成功: ' + state.doneCount,
      '失败: ' + state.failCount,
      '当前: ' + (state.currentUrl || '-'),
      extra || ''
    ].filter(Boolean);
    setStatus(lines.join('\n'));
  }

  function renderTree(urls) {
    const tree = state.elements.tree;
    tree.innerHTML = '';

    if (!urls.length) {
      tree.textContent = '未发现文档链接';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of urls) {
      const row = document.createElement('label');
      row.className = 'docs-md-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.url = item;
      const span = document.createElement('span');
      span.textContent = item;
      row.appendChild(cb);
      row.appendChild(span);
      frag.appendChild(row);
    }
    tree.appendChild(frag);
  }

  function gmRequest(method, url, opts) {
    const options = opts || {};
    const timeout = options.timeoutMs || DEFAULTS.timeoutMs;

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: method,
          url: url,
          timeout: timeout,
          responseType: options.responseType || 'text',
          headers: options.headers || {},
          onload: function (resp) {
            resolve(resp);
          },
          ontimeout: function () {
            reject(new Error('timeout'));
          },
          onerror: function () {
            reject(new Error('network-error'));
          }
        });
      });
    }

    return fetch(url, {
      method: method,
      headers: options.headers || {}
    }).then(async (resp) => {
      if (options.responseType === 'arraybuffer') {
        const buffer = await resp.arrayBuffer();
        return {
          status: resp.status,
          response: buffer,
          responseText: ''
        };
      }
      const text = await resp.text();
      return {
        status: resp.status,
        responseText: text,
        response: text
      };
    });
  }

  async function fetchTextWithRetry(url, retries, delayMs) {
    let lastError = null;
    for (let i = 0; i <= retries; i += 1) {
      try {
        const resp = await gmRequest('GET', url, { timeoutMs: DEFAULTS.timeoutMs });
        if (resp.status >= 200 && resp.status < 400) {
          return String(resp.responseText || '');
        }
        lastError = new Error('http-' + resp.status);
      } catch (err) {
        lastError = err;
      }
      if (i < retries) {
        await sleep(delayMs * Math.pow(2, i));
      }
    }
    throw lastError || new Error('request-failed');
  }

  async function fetchBinaryWithRetry(url, retries, delayMs) {
    let lastError = null;
    for (let i = 0; i <= retries; i += 1) {
      try {
        const resp = await gmRequest('GET', url, {
          timeoutMs: DEFAULTS.timeoutMs,
          responseType: 'arraybuffer'
        });
        if (resp.status >= 200 && resp.status < 400 && resp.response) {
          return resp.response;
        }
        lastError = new Error('http-' + resp.status);
      } catch (err) {
        lastError = err;
      }
      if (i < retries) {
        await sleep(delayMs * Math.pow(2, i));
      }
    }
    throw lastError || new Error('request-failed');
  }

  async function discoverSitemapUrls(origin) {
    const candidates = [new URL('/sitemap.xml', origin).href];
    try {
      const robots = await fetchTextWithRetry(new URL('/robots.txt', origin).href, 1, 400);
      parseSitemapsFromRobots(robots, origin).forEach((url) => candidates.push(url));
    } catch (_) {
      // ignore robots parse failure
    }

    const queue = Array.from(new Set(candidates));
    const visited = new Set();
    const found = new Set();

    while (queue.length && found.size < DEFAULTS.maxPages && !state.stopRequested) {
      const sitemapUrl = queue.shift();
      if (visited.has(sitemapUrl)) {
        continue;
      }
      visited.add(sitemapUrl);

      let xmlText;
      try {
        xmlText = await fetchTextWithRetry(sitemapUrl, 1, 500);
      } catch (_) {
        continue;
      }

      const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
      const parseError = xml.querySelector('parsererror');
      if (parseError) {
        continue;
      }

      const urlNodes = xml.querySelectorAll('url > loc');
      urlNodes.forEach((node) => {
        const value = (node.textContent || '').trim();
        if (value) {
          found.add(value);
        }
      });

      const sitemapNodes = xml.querySelectorAll('sitemap > loc');
      sitemapNodes.forEach((node) => {
        const value = (node.textContent || '').trim();
        if (value && !visited.has(value)) {
          queue.push(value);
        }
      });
    }

    return Array.from(found);
  }

  function collectCurrentPageLinks() {
    const links = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const raw = a.getAttribute('href');
      if (!raw) return;
      try {
        links.push(new URL(raw, location.href).href);
      } catch (_) {
        // ignore invalid links
      }
    });
    return links;
  }

  async function discoverUrls(options) {
    const origin = options.origin;
    const rootPath = normalizeRootPath(options.rootPath);
    const maxPages = options.maxPages;
    const maxDepth = options.maxDepth;
    const excludePatterns = options.excludePatterns || [];

    const discovered = new Set();
    const visited = new Set();
    const queue = [];
    const depthMap = new Map();

    function addUrl(maybeUrl, depth) {
      const normalized = normalizeUrl(maybeUrl);
      if (!normalized) return;
      if (!isDocUrl(normalized, origin, rootPath, excludePatterns)) return;
      if (discovered.has(normalized)) return;
      if (discovered.size >= maxPages) return;
      discovered.add(normalized);
      queue.push(normalized);
      depthMap.set(normalized, depth);
      state.foundCount = discovered.size;
      state.queueCount = queue.length;
      updateProgress();
    }

    addUrl(new URL(rootPath, origin).href, 0);

    for (const link of collectCurrentPageLinks()) {
      addUrl(link, 0);
    }

    const sitemapLinks = await discoverSitemapUrls(origin);
    for (const link of sitemapLinks) {
      addUrl(link, 0);
      if (discovered.size >= maxPages || state.stopRequested) {
        break;
      }
    }

    while (queue.length && discovered.size < maxPages && !state.stopRequested) {
      const current = queue.shift();
      state.queueCount = queue.length;
      if (visited.has(current)) {
        updateProgress();
        continue;
      }
      visited.add(current);

      const depth = depthMap.get(current) || 0;
      if (depth >= maxDepth) {
        updateProgress();
        continue;
      }

      state.currentUrl = current;
      updateProgress('扫描链接中...');

      let html;
      try {
        html = await fetchTextWithRetry(current, options.retries, options.requestDelayMs);
      } catch (err) {
        state.failed.push({ url: current, reason: 'discover:' + (err && err.message ? err.message : 'failed') });
        state.failCount = state.failed.length;
        updateProgress();
        await sleep(options.requestDelayMs);
        continue;
      }

      const links = parseLinksFromHtml(html, current);
      for (const link of links) {
        addUrl(link, depth + 1);
        if (discovered.size >= maxPages) {
          break;
        }
      }

      await sleep(options.requestDelayMs);
    }

    return Array.from(discovered).sort();
  }

  function selectedUrlsFromTree() {
    const selected = [];
    state.elements.tree.querySelectorAll('input[type="checkbox"][data-url]').forEach((cb) => {
      if (cb.checked) {
        selected.push(cb.dataset.url);
      }
    });
    return selected;
  }

  function rewriteLinksAndImages(node, pageUrl, pageFile, urlToFilePath, imageMode, imageRegistry) {
    const imageTasks = [];

    node.querySelectorAll('a[href]').forEach((a) => {
      const raw = a.getAttribute('href');
      if (!raw) return;
      try {
        const absolute = new URL(raw, pageUrl);
        const normalizedTarget = normalizeUrl(absolute.href);
        const mappedFile = urlToFilePath.get(normalizedTarget);
        if (mappedFile) {
          let rel = relativePath(pageFile, mappedFile);
          if (absolute.hash) {
            rel += absolute.hash;
          }
          a.setAttribute('href', rel);
        } else {
          a.setAttribute('href', absolute.href);
        }
      } catch (_) {
        // keep original href
      }
    });

    node.querySelectorAll('img').forEach((img) => {
      const raw = getImageSrc(img);
      if (!raw) return;

      let absoluteUrl;
      try {
        absoluteUrl = new URL(raw, pageUrl).href;
      } catch (_) {
        return;
      }

      if (imageMode === 'external') {
        img.setAttribute('src', absoluteUrl);
        img.removeAttribute('srcset');
        return;
      }

      let assetPath = imageRegistry.byUrl.get(absoluteUrl);
      if (!assetPath) {
        assetPath = buildAssetPath(absoluteUrl, imageRegistry.usedPaths);
        imageRegistry.byUrl.set(absoluteUrl, assetPath);
        imageTasks.push({
          url: absoluteUrl,
          path: assetPath
        });
      }

      img.setAttribute('src', relativePath(pageFile, assetPath));
      img.removeAttribute('srcset');
    });

    return imageTasks;
  }

  async function runScan() {
    if (state.scanning || state.exporting) {
      return;
    }

    const rootPath = normalizeRootPath(state.elements.rootInput.value || DEFAULTS.rootPath);
    const maxPages = Math.max(1, Math.min(2000, Number(state.elements.maxPagesInput.value) || DEFAULTS.maxPages));
    state.elements.rootInput.value = rootPath;
    state.elements.maxPagesInput.value = String(maxPages);

    state.scanning = true;
    state.stopRequested = false;
    state.scanSession += 1;
    const mySession = state.scanSession;
    state.discoveredUrls = [];
    state.failed = [];
    state.foundCount = 0;
    state.doneCount = 0;
    state.failCount = 0;
    state.queueCount = 0;
    state.currentUrl = '';
    updateProgress('开始扫描...');

    try {
      const urls = await discoverUrls({
        origin: location.origin,
        rootPath,
        maxPages,
        maxDepth: DEFAULTS.maxDepth,
        excludePatterns: DEFAULT_EXCLUDES,
        requestDelayMs: DEFAULTS.requestDelayMs,
        retries: DEFAULTS.retries
      });

      if (mySession !== state.scanSession) {
        return;
      }

      state.discoveredUrls = urls;
      renderTree(urls);
      state.queueCount = 0;
      state.currentUrl = '';

      if (state.stopRequested) {
        updateProgress('扫描已停止');
      } else {
        updateProgress('扫描完成，可勾选后导出');
      }
    } catch (err) {
      setStatus('扫描失败: ' + (err && err.message ? err.message : 'unknown'));
    } finally {
      state.scanning = false;
      state.stopRequested = false;
    }
  }

  async function downloadImagesToZip(zip, imageJobs) {
    const uniqueJobs = [];
    const seen = new Set();
    for (const job of imageJobs) {
      if (!seen.has(job.path)) {
        seen.add(job.path);
        uniqueJobs.push(job);
      }
    }

    for (let i = 0; i < uniqueJobs.length; i += 1) {
      if (state.stopRequested) {
        break;
      }
      const job = uniqueJobs[i];
      state.currentUrl = job.url;
      updateProgress('下载图片: ' + (i + 1) + '/' + uniqueJobs.length);
      try {
        const binary = await fetchBinaryWithRetry(job.url, DEFAULTS.retries, DEFAULTS.requestDelayMs);
        zip.file(job.path, binary);
      } catch (err) {
        state.failed.push({
          url: job.url,
          reason: 'image-download-fail:' + (err && err.message ? err.message : 'failed')
        });
        state.failCount = state.failed.length;
      }
      await sleep(120);
    }
  }

  function buildSummary(pages) {
    const lines = ['# Summary', ''];
    pages
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach((page) => {
        lines.push('- [' + page.title + '](' + page.path + ')');
      });
    return lines.join('\n');
  }

  async function runExport() {
    if (state.exporting || state.scanning) {
      return;
    }

    const rootPath = normalizeRootPath(state.elements.rootInput.value || DEFAULTS.rootPath);
    const imageMode = state.elements.imageModeSelect.value || DEFAULTS.imageMode;
    const selected = selectedUrlsFromTree();

    if (!selected.length) {
      alert('请先扫描并勾选至少一个页面');
      return;
    }

    state.exporting = true;
    state.stopRequested = false;
    state.doneCount = 0;
    state.failCount = state.failed.length;
    state.currentUrl = '';

    const zip = new JSZip();
    const turndown = createTurndownService();
    const usedPaths = new Set();
    const pageDrafts = [];

    try {
      updateProgress('读取页面中...');
      for (let i = 0; i < selected.length; i += 1) {
        if (state.stopRequested) {
          break;
        }

        const url = selected[i];
        state.currentUrl = url;
        updateProgress('抓取页面: ' + (i + 1) + '/' + selected.length);

        let html;
        try {
          html = await fetchTextWithRetry(url, DEFAULTS.retries, DEFAULTS.requestDelayMs);
        } catch (err) {
          state.failed.push({
            url,
            reason: 'page-fetch-fail:' + (err && err.message ? err.message : 'failed')
          });
          state.failCount = state.failed.length;
          continue;
        }

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title = extractDocTitle(doc, url);
        const path = buildMarkdownPath(url, title, rootPath, usedPaths);

        pageDrafts.push({
          url,
          doc,
          title,
          path
        });

        await sleep(DEFAULTS.requestDelayMs);
      }

      const urlToFilePath = new Map();
      for (const page of pageDrafts) {
        urlToFilePath.set(normalizeUrl(page.url), page.path);
      }

      const imageRegistry = {
        byUrl: new Map(),
        usedPaths: new Set()
      };

      const imageJobs = [];
      const exportedPages = [];

      for (let i = 0; i < pageDrafts.length; i += 1) {
        if (state.stopRequested) {
          break;
        }

        const page = pageDrafts[i];
        state.currentUrl = page.url;
        updateProgress('转换 Markdown: ' + (i + 1) + '/' + pageDrafts.length);

        const mainNode = extractMainNode(page.doc);
        cleanNodeForMarkdown(mainNode);

        const newTasks = rewriteLinksAndImages(
          mainNode,
          page.url,
          page.path,
          urlToFilePath,
          imageMode,
          imageRegistry
        );
        newTasks.forEach((task) => imageJobs.push(task));

        let markdown = '';
        try {
          markdown = turndown.turndown(mainNode);
        } catch (err) {
          state.failed.push({
            url: page.url,
            reason: 'markdown-fail:' + (err && err.message ? err.message : 'failed')
          });
          state.failCount = state.failed.length;
          continue;
        }

        const frontMatter = [
          '---',
          'title: "' + page.title.replace(/"/g, '\\"') + '"',
          'source: "' + page.url.replace(/"/g, '\\"') + '"',
          '---',
          ''
        ].join('\n');

        zip.file(page.path, frontMatter + markdown + '\n');
        exportedPages.push(page);
        state.doneCount += 1;
      }

      if (imageMode === 'local' && imageJobs.length) {
        await downloadImagesToZip(zip, imageJobs);
      }

      zip.file('SUMMARY.md', buildSummary(exportedPages));

      if (state.failed.length) {
        const failText = state.failed
          .map((item) => item.url + ' | ' + item.reason)
          .join('\n');
        zip.file('failed-urls.txt', failText + '\n');
      }

      updateProgress('打包 ZIP 中...');
      const blob = await zip.generateAsync({ type: 'blob' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = 'docs-md-export-' + stamp + '.zip';

      const a = document.createElement('a');
      const objUrl = URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 8000);

      if (state.stopRequested) {
        updateProgress('已停止，已导出当前完成内容');
      } else {
        updateProgress('导出完成: ' + state.doneCount + ' 页');
      }
    } catch (err) {
      setStatus('导出失败: ' + (err && err.message ? err.message : 'unknown'));
    } finally {
      state.currentUrl = '';
      state.exporting = false;
      state.stopRequested = false;
    }
  }

  function init() {
    if (!document.body) {
      return;
    }
    addStyles();
    createUI();
  }

  init();

  return {
    normalizeUrl,
    isDocUrl,
    buildMarkdownPath,
    normalizeRootPath,
    sanitizeSegment,
    relativePath
  };
});
