// ==UserScript==
// @name         Docs Markdown Crawler (Manual Scan)
// @namespace    https://github.com/yourname/docs-md-crawler
// @version      0.2.1
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

  function isDocUrl(url, origin, baseUrl, excludePatterns) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) {
        return false;
      }
      if (u.origin !== origin) {
        return false;
      }
      const normalizedBase = normalizeUrl(baseUrl);
      if (!normalizedBase) {
        return false;
      }
      const base = new URL(normalizedBase);
      if (!pathStartsWithRoot(u.pathname, base.pathname)) {
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

  function getDisplayTitle(url, rawTitle) {
    const plainTitle = String(rawTitle || '').trim();
    if (plainTitle) {
      return sanitizeSegment(plainTitle, 'index');
    }
    try {
      const u = new URL(url);
      const segments = splitPathSegments(u.pathname);
      const leaf = segments.length ? segments[segments.length - 1] : 'index';
      return sanitizeSegment(decodeURIComponent(leaf), 'index');
    } catch (_) {
      return 'index';
    }
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

  function getRelativePathSegments(targetUrl, startUrl) {
    try {
      const target = new URL(normalizeUrl(targetUrl) || targetUrl);
      const start = new URL(normalizeUrl(startUrl) || startUrl);
      const targetSegments = splitPathSegments(target.pathname);
      const startSegments = splitPathSegments(start.pathname);
      let index = 0;
      while (index < startSegments.length && targetSegments[index] === startSegments[index]) {
        index += 1;
      }
      return targetSegments.slice(index);
    } catch (_) {
      return [];
    }
  }

  function buildTreeItems(pages, startUrl) {
    const root = {
      pages: [],
      groups: new Map()
    };

    function ensureGroup(node, segment) {
      if (!node.groups.has(segment)) {
        node.groups.set(segment, {
          pages: [],
          groups: new Map()
        });
      }
      return node.groups.get(segment);
    }

    const sortedPages = (pages || []).slice().sort((a, b) => a.url.localeCompare(b.url));
    for (const page of sortedPages) {
      const relSegments = getRelativePathSegments(page.url, startUrl);
      let cursor = root;
      for (let i = 0; i < relSegments.length - 1; i += 1) {
        cursor = ensureGroup(cursor, relSegments[i]);
      }
      cursor.pages.push({
        type: 'page',
        url: page.url,
        title: getDisplayTitle(page.url, page.title || ''),
        depth: Math.max(0, relSegments.length - 1)
      });
    }

    const entries = [];
    function walk(node, depth) {
      node.pages
        .slice()
        .sort((a, b) => a.url.localeCompare(b.url))
        .forEach((page) => {
          entries.push({
            type: 'page',
            url: page.url,
            title: page.title,
            depth
          });
        });

      Array.from(node.groups.keys())
        .sort((a, b) => a.localeCompare(b))
        .forEach((segment) => {
          const groupNode = node.groups.get(segment);
          entries.push({
            type: 'group',
            key: segment + ':' + depth,
            title: sanitizeSegment(decodeURIComponent(segment), 'index'),
            depth
          });
          walk(groupNode, depth + 1);
        });
    }

    walk(root, 0);
    return entries;
  }

  function computeSelectAllState(total, selected) {
    if (!total || total <= 0) {
      return { checked: false, indeterminate: false };
    }
    if (selected <= 0) {
      return { checked: false, indeterminate: false };
    }
    if (selected >= total) {
      return { checked: true, indeterminate: false };
    }
    return { checked: false, indeterminate: true };
  }

  function computeStageProgress(completed, total) {
    if (!total || total <= 0) {
      return { completed: 0, total: 0, percent: 100 };
    }
    const bounded = Math.min(Math.max(completed, 0), total);
    const percent = Math.round((bounded / total) * 100);
    return { completed: bounded, total, percent };
  }

  function computeZipPackProgress(metadata) {
    const rawPercent = metadata && Number(metadata.percent);
    if (!Number.isFinite(rawPercent)) {
      return { completed: 0, total: 100, percent: 0 };
    }
    const completed = Math.min(100, Math.max(0, Math.round(rawPercent)));
    return computeStageProgress(completed, 100);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) {
      return (value / (1024 * 1024)).toFixed(2) + ' MB';
    }
    if (value >= 1024) {
      return (value / 1024).toFixed(2) + ' KB';
    }
    return value.toFixed(0) + ' B';
  }

  function formatDuration(ms) {
    return (Math.max(0, Number(ms) || 0) / 1000).toFixed(1) + 's';
  }

  function formatUsageStats(stats) {
    const htmlBytes = Number(stats.htmlBytes) || 0;
    const imageBytes = Number(stats.imageBytes) || 0;
    const totalBytes = htmlBytes + imageBytes;
    const pageFetched = Number(stats.pageFetched) || 0;
    const pageConverted = Number(stats.pageConverted) || 0;
    const imagesDownloaded = Number(stats.imagesDownloaded) || 0;
    const failedCount = Number(stats.failedCount) || 0;
    const elapsedMs = Number(stats.elapsedMs) || 0;

    return [
      '占用: HTML ' + formatBytes(htmlBytes) + ' | 图片 ' + formatBytes(imageBytes) + ' | 总计 ' + formatBytes(totalBytes),
      '任务: 页面抓取 ' + pageFetched + ' | 页面转换 ' + pageConverted + ' | 图片下载 ' + imagesDownloaded + ' | 失败 ' + failedCount + ' | 耗时 ' + formatDuration(elapsedMs)
    ].join('\n');
  }

  function buildFailedQueueItems(failedItems) {
    return (failedItems || []).map((item) => ({
      id: item.id,
      url: item.url,
      reason: item.reason,
      title: getDisplayTitle(item.url, item.title || '')
    }));
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

  function buildUiStyles() {
    return [
      '#docs-md-fab,#docs-md-panel{--background:0 0% 100%;--foreground:222.2 84% 4.9%;--card:0 0% 100%;--card-foreground:222.2 84% 4.9%;--muted:210 40% 96.1%;--muted-foreground:215.4 16.3% 46.9%;--border:214.3 31.8% 91.4%;--input:214.3 31.8% 91.4%;--primary:222.2 47.4% 11.2%;--primary-foreground:210 40% 98%;--secondary:210 40% 96.1%;--secondary-foreground:222.2 47.4% 11.2%;--destructive:0 72.2% 50.6%;--destructive-foreground:210 40% 98%;--radius:12px;--ring:215 20.2% 65.1%}',
      '#docs-md-fab,#docs-md-panel,#docs-md-panel *{box-sizing:border-box}',
      '#docs-md-fab{position:fixed;right:20px;bottom:18px;z-index:2147483644;padding:10px 16px;border:1px solid hsl(var(--border));border-radius:999px;background:hsl(var(--background));color:hsl(var(--foreground));font:600 13px/1.2 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;box-shadow:0 10px 24px -12px rgba(15,23,42,.45);transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease}',
      '#docs-md-fab:hover{transform:translateY(-1px);box-shadow:0 14px 30px -14px rgba(15,23,42,.5)}',
      '#docs-md-fab:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}',
      '#docs-md-panel{position:fixed;right:18px;bottom:68px;width:min(420px,calc(100vw - 24px));max-height:78vh;background:linear-gradient(160deg,hsl(var(--card)) 0%,hsl(var(--muted)) 100%);border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 4px);box-shadow:0 24px 55px -30px rgba(15,23,42,.55);z-index:2147483644;display:none;overflow:hidden;color:hsl(var(--card-foreground));font:13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
      '#docs-md-panel.open{display:flex;flex-direction:column}',
      '#docs-md-head{padding:14px 16px 12px;border-bottom:1px solid hsl(var(--border));display:flex;justify-content:space-between;align-items:flex-start;gap:10px;background:hsla(var(--background),.88);backdrop-filter:blur(4px)}',
      '.docs-md-head-main{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.docs-md-head-title{font-size:15px;font-weight:700;letter-spacing:.01em}',
      '.docs-md-head-subtitle{font-size:11px;color:hsl(var(--muted-foreground));font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}',
      '#docs-md-close{border:1px solid hsl(var(--border));background:hsl(var(--background));border-radius:8px;height:28px;width:28px;display:inline-flex;align-items:center;justify-content:center;font-size:18px;line-height:1;cursor:pointer;color:hsl(var(--muted-foreground));transition:background .2s ease,border-color .2s ease,color .2s ease}',
      '#docs-md-close:hover{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}',
      '#docs-md-close:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px}',
      '#docs-md-body{padding:12px;display:flex;flex-direction:column;gap:10px;overflow:auto}',
      '.docs-md-field{display:flex;flex-direction:column;gap:6px}',
      '.docs-md-label{font-size:12px;color:hsl(var(--muted-foreground));font-weight:600}',
      '#docs-md-image-mode{width:100%;min-height:36px;padding:8px 10px;border:1px solid hsl(var(--input));border-radius:var(--radius);background:hsl(var(--background));color:hsl(var(--foreground));font:500 13px/1.25 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;transition:border-color .2s ease,box-shadow .2s ease}',
      '#docs-md-image-mode:focus-visible{outline:none;border-color:hsl(var(--ring));box-shadow:0 0 0 2px hsla(var(--ring),.25)}',
      '#docs-md-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
      '.docs-md-btn{min-height:34px;padding:0 10px;border-radius:10px;border:1px solid transparent;font-size:12px;font-weight:700;letter-spacing:.01em;cursor:pointer;transition:background .18s ease,color .18s ease,border-color .18s ease,transform .18s ease}',
      '.docs-md-btn:hover{transform:translateY(-1px)}',
      '.docs-md-btn:disabled{cursor:not-allowed;opacity:.55;transform:none}',
      '.docs-md-btn:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:1px}',
      '.docs-md-btn-primary{background:hsl(var(--primary));color:hsl(var(--primary-foreground))}',
      '.docs-md-btn-primary:hover{background:hsl(var(--primary) / .9)}',
      '.docs-md-btn-secondary{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));border-color:hsl(var(--border))}',
      '.docs-md-btn-secondary:hover{background:hsl(var(--secondary) / .78)}',
      '.docs-md-btn-outline{background:hsl(var(--background));color:hsl(var(--muted-foreground));border-color:hsl(var(--border))}',
      '.docs-md-btn-outline:hover{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}',
      '.docs-md-btn-destructive{background:hsl(var(--destructive));color:hsl(var(--destructive-foreground))}',
      '.docs-md-btn-destructive:hover{background:hsl(var(--destructive) / .9)}',
      '.docs-md-surface{border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--background));padding:10px}',
      '#docs-md-status{display:flex;gap:8px;align-items:flex-start;justify-content:space-between}',
      '#docs-md-status-text{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;line-height:1.45;flex:1;min-width:0;color:hsl(var(--foreground))}',
      '#docs-md-fail-toggle{padding:0 10px;border-radius:999px;min-height:26px;white-space:nowrap}',
      '#docs-md-fail-toggle.has-fail{border-color:hsl(var(--destructive));color:hsl(var(--destructive));background:hsl(var(--destructive) / .08)}',
      '#docs-md-export-progress{display:none;gap:8px;flex-direction:column}',
      '#docs-md-export-progress.active{display:flex}',
      '#docs-md-progress-bar{width:100%;height:8px;background:hsl(var(--secondary));border-radius:999px;overflow:hidden}',
      '#docs-md-progress-fill{height:100%;width:0;background:linear-gradient(90deg,hsl(var(--primary)) 0%,hsl(var(--primary) / .72) 100%);transition:width .22s ease}',
      '#docs-md-progress-text{font-size:12px;color:hsl(var(--foreground))}',
      '#docs-md-usage{font-size:11px;color:hsl(var(--muted-foreground));white-space:pre-wrap;line-height:1.5}',
      '#docs-md-failed-wrap{display:none;padding:8px 10px}',
      '#docs-md-failed-wrap.open{display:block}',
      '#docs-md-tree{max-height:260px;overflow:auto;padding:6px 10px}',
      '.docs-md-item{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px dashed hsl(var(--border))}',
      '.docs-md-item:last-child{border-bottom:0}',
      '.docs-md-item>input[type="checkbox"]{margin-top:2px;accent-color:hsl(var(--primary));flex-shrink:0}',
      '.docs-md-item-content{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.docs-md-item-title{font-weight:600;word-break:break-word;color:hsl(var(--foreground))}',
      '.docs-md-item-group{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;background:hsl(var(--secondary));border:1px solid hsl(var(--border));font-size:11px;font-weight:700;color:hsl(var(--secondary-foreground))}',
      '.docs-md-retry{min-height:28px;padding:0 10px}',
      '.docs-md-check-row{display:flex;align-items:center;gap:7px;font-size:12px;color:hsl(var(--muted-foreground));padding:0 2px}',
      '.docs-md-check-row input{accent-color:hsl(var(--primary))}',
      '@media (max-width:640px){#docs-md-fab{right:12px;bottom:12px}#docs-md-panel{right:12px;left:12px;width:auto;max-height:80vh}#docs-md-actions{grid-template-columns:1fr}}'
    ].join('');
  }

  function buildPanelMarkup() {
    return [
      '<div id="docs-md-head">',
      '  <div class="docs-md-head-main">',
      '    <span class="docs-md-head-title">Docs Markdown Crawler</span>',
      '    <span class="docs-md-head-subtitle">shadcn-inspired UI</span>',
      '  </div>',
      '  <button id="docs-md-close" type="button" aria-label="关闭面板">×</button>',
      '</div>',
      '<div id="docs-md-body">',
      '  <div class="docs-md-field">',
      '    <label class="docs-md-label" for="docs-md-image-mode">图片模式</label>',
      '    <select id="docs-md-image-mode">',
      '      <option value="local" selected>下载本地</option>',
      '      <option value="external">保留外链</option>',
      '    </select>',
      '  </div>',
      '  <div id="docs-md-actions">',
      '    <button id="docs-md-scan" type="button" class="docs-md-btn docs-md-btn-primary">扫描目录</button>',
      '    <button id="docs-md-export" type="button" class="docs-md-btn docs-md-btn-secondary">导出 ZIP</button>',
      '    <button id="docs-md-stop" type="button" class="docs-md-btn docs-md-btn-destructive">停止</button>',
      '  </div>',
      '  <div id="docs-md-status" class="docs-md-surface">',
      '    <div id="docs-md-status-text" aria-live="polite">等待手动扫描</div>',
      '    <button id="docs-md-fail-toggle" type="button" class="docs-md-btn docs-md-btn-outline" disabled>失败: 0</button>',
      '  </div>',
      '  <div id="docs-md-failed-wrap" class="docs-md-surface"><div id="docs-md-failed-tree">暂无失败项</div></div>',
      '  <div id="docs-md-export-progress" class="docs-md-surface">',
      '    <div id="docs-md-progress-bar"><div id="docs-md-progress-fill"></div></div>',
      '    <div id="docs-md-progress-text">导出进度: 0/0 (0%)</div>',
      '    <div id="docs-md-usage"></div>',
      '  </div>',
      '  <label class="docs-md-check-row"><input id="docs-md-check-all" type="checkbox" checked>全选</label>',
      '  <div id="docs-md-tree" class="docs-md-surface"></div>',
      '</div>'
    ].join('');
  }

  if (env.isNode) {
    return {
      normalizeUrl,
      isDocUrl,
      buildMarkdownPath,
      getDisplayTitle,
      buildTreeItems,
      buildFailedQueueItems,
      computeSelectAllState,
      computeStageProgress,
      computeZipPackProgress,
      formatUsageStats,
      normalizeRootPath,
      sanitizeSegment,
      relativePath,
      buildUiStyles,
      buildPanelMarkup
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
    scanStartUrl: '',
    failedSeq: 0,
    elements: {},
    scanSession: 0
  };

  function addStyles() {
    const css = buildUiStyles();

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
    fab.textContent = 'Docs MD';

    const panel = document.createElement('div');
    panel.id = 'docs-md-panel';
    panel.innerHTML = buildPanelMarkup();

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    state.elements = {
      fab,
      panel,
      closeBtn: panel.querySelector('#docs-md-close'),
      imageModeSelect: panel.querySelector('#docs-md-image-mode'),
      scanBtn: panel.querySelector('#docs-md-scan'),
      exportBtn: panel.querySelector('#docs-md-export'),
      stopBtn: panel.querySelector('#docs-md-stop'),
      status: panel.querySelector('#docs-md-status'),
      statusText: panel.querySelector('#docs-md-status-text'),
      failToggle: panel.querySelector('#docs-md-fail-toggle'),
      failedWrap: panel.querySelector('#docs-md-failed-wrap'),
      failedTree: panel.querySelector('#docs-md-failed-tree'),
      exportProgress: panel.querySelector('#docs-md-export-progress'),
      progressFill: panel.querySelector('#docs-md-progress-fill'),
      progressText: panel.querySelector('#docs-md-progress-text'),
      usageText: panel.querySelector('#docs-md-usage'),
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
      getPageCheckboxes().forEach((el) => {
        el.checked = checked;
      });
      syncSelectAllState();
    });

    state.elements.failToggle.addEventListener('click', () => {
      if (state.failCount <= 0) {
        return;
      }
      const opened = state.elements.failedWrap.classList.toggle('open');
      if (opened) {
        renderFailedQueue();
      }
    });

    updateFailToggle();
    renderFailedQueue();
  }

  function setStatus(text) {
    if (state.elements.statusText) {
      state.elements.statusText.textContent = text;
    }
    updateFailToggle();
  }

  function setFailedWrapVisible(visible) {
    if (!state.elements.failedWrap) {
      return;
    }
    if (visible) {
      state.elements.failedWrap.classList.add('open');
    } else {
      state.elements.failedWrap.classList.remove('open');
    }
  }

  function updateFailToggle() {
    if (!state.elements.failToggle) {
      return;
    }
    const count = state.failed.length;
    state.failCount = count;
    state.elements.failToggle.textContent = '失败: ' + count;
    state.elements.failToggle.disabled = count <= 0;
    state.elements.failToggle.classList.toggle('has-fail', count > 0);
    if (count <= 0) {
      setFailedWrapVisible(false);
    }
  }

  function renderFailedQueue() {
    if (!state.elements.failedTree) {
      return;
    }
    const tree = state.elements.failedTree;
    tree.innerHTML = '';
    const items = buildFailedQueueItems(state.failed);
    if (!items.length) {
      tree.textContent = '暂无失败项';
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'docs-md-item';

      const content = document.createElement('span');
      content.className = 'docs-md-item-content';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'docs-md-item-title';
      titleSpan.textContent = item.title;
      content.appendChild(titleSpan);

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'docs-md-btn docs-md-btn-outline docs-md-retry';
      retryBtn.textContent = '重试';
      retryBtn.addEventListener('click', () => {
        retryFailedItem(item.id, retryBtn);
      });

      row.appendChild(content);
      row.appendChild(retryBtn);
      frag.appendChild(row);
    });

    tree.appendChild(frag);
  }

  function addFailed(url, reason, title) {
    state.failedSeq += 1;
    const item = {
      id: state.failedSeq,
      url,
      reason,
      title: title || ''
    };
    state.failed.push(item);
    state.failCount = state.failed.length;
    renderFailedQueue();
    updateFailToggle();
    return item;
  }

  function removeFailedById(failedId) {
    const index = state.failed.findIndex((item) => item.id === failedId);
    if (index < 0) {
      return null;
    }
    const removed = state.failed.splice(index, 1)[0];
    state.failCount = state.failed.length;
    renderFailedQueue();
    updateFailToggle();
    return removed;
  }

  async function retryFailedItem(failedId, buttonEl) {
    if (state.scanning || state.exporting) {
      setStatus('扫描或导出进行中，暂不可重试失败项');
      return;
    }
    const failedItem = state.failed.find((item) => item.id === failedId);
    if (!failedItem) {
      return;
    }

    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = '重试中...';
    }

    try {
      const reason = String(failedItem.reason || '');
      if (reason.startsWith('image-download-fail:')) {
        await fetchBinaryWithRetry(failedItem.url, DEFAULTS.retries, DEFAULTS.requestDelayMs);
      } else {
        const html = await fetchTextWithRetry(failedItem.url, DEFAULTS.retries, DEFAULTS.requestDelayMs);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title = extractDocTitle(doc, failedItem.url);
        failedItem.title = title;

        if (reason.startsWith('markdown-fail:')) {
          const mainNode = extractMainNode(doc);
          cleanNodeForMarkdown(mainNode);
          const turndown = createTurndownService();
          turndown.turndown(mainNode);
        }

        if (reason.startsWith('discover:')) {
          const normalized = normalizeUrl(failedItem.url);
          const baseUrl = state.scanStartUrl || normalizeUrl(location.href) || location.href;
          if (
            normalized &&
            !state.discoveredUrls.some((item) => item.url === normalized) &&
            isDocUrl(normalized, location.origin, baseUrl, DEFAULT_EXCLUDES)
          ) {
            state.discoveredUrls.push({
              url: normalized,
              title: getDisplayTitle(normalized, title)
            });
            state.discoveredUrls.sort((a, b) => a.url.localeCompare(b.url));
            renderTree(state.discoveredUrls);
          }
        }
      }

      const removed = removeFailedById(failedId);
      const doneTitle = getDisplayTitle(failedItem.url, (removed && removed.title) || failedItem.title || '');
      updateProgress('重试成功: ' + doneTitle);
    } catch (err) {
      failedItem.reason = 'retry-fail:' + (err && err.message ? err.message : 'failed');
      renderFailedQueue();
      updateFailToggle();
      setStatus('重试失败: ' + getDisplayTitle(failedItem.url, failedItem.title || ''));
    } finally {
      if (buttonEl && buttonEl.isConnected) {
        buttonEl.disabled = false;
        buttonEl.textContent = '重试';
      }
    }
  }

  function getPageCheckboxes() {
    return Array.from(state.elements.tree.querySelectorAll('input[type="checkbox"][data-url]'));
  }

  function syncSelectAllState() {
    const total = getPageCheckboxes().length;
    const selected = getPageCheckboxes().filter((cb) => cb.checked).length;
    const status = computeSelectAllState(total, selected);
    state.elements.checkAll.checked = status.checked;
    state.elements.checkAll.indeterminate = status.indeterminate;
  }

  function setExportProgressVisible(visible) {
    if (!state.elements.exportProgress) {
      return;
    }
    if (visible) {
      state.elements.exportProgress.classList.add('active');
    } else {
      state.elements.exportProgress.classList.remove('active');
    }
  }

  function setExportProgress(stageLabel, completed, total) {
    const progress = computeStageProgress(completed, total);
    state.elements.progressFill.style.width = progress.percent + '%';
    state.elements.progressText.textContent = stageLabel + ': ' + progress.completed + '/' + progress.total + ' (' + progress.percent + '%)';
  }

  function updateUsageText(stats) {
    state.elements.usageText.textContent = formatUsageStats(stats);
  }

  function resetExportProgress() {
    setExportProgressVisible(false);
    if (state.elements.progressFill) {
      state.elements.progressFill.style.width = '0%';
    }
    if (state.elements.progressText) {
      state.elements.progressText.textContent = '导出进度: 0/0 (0%)';
    }
    if (state.elements.usageText) {
      state.elements.usageText.textContent = '';
    }
  }

  function updateProgress(extra) {
    const lines = [
      '发现: ' + state.foundCount,
      '队列: ' + state.queueCount,
      extra || ''
    ].filter(Boolean);
    setStatus(lines.join('\n'));
  }

  function renderTree(items) {
    const tree = state.elements.tree;
    tree.innerHTML = '';

    if (!items.length) {
      tree.textContent = '未发现文档链接';
      return;
    }

    const treeItems = buildTreeItems(items, state.scanStartUrl || normalizeUrl(location.href) || location.href);
    const frag = document.createDocumentFragment();
    for (const item of treeItems) {
      const row = document.createElement('div');
      row.className = 'docs-md-item';
      row.style.paddingLeft = (item.depth * 14) + 'px';

      if (item.type === 'group') {
        const group = document.createElement('span');
        group.className = 'docs-md-item-group';
        group.textContent = item.title;
        row.appendChild(group);
      } else {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.url = item.url;
        cb.addEventListener('change', syncSelectAllState);

        const content = document.createElement('span');
        content.className = 'docs-md-item-content';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'docs-md-item-title';
        titleSpan.textContent = item.title;

        content.appendChild(titleSpan);
        row.appendChild(cb);
        row.appendChild(content);
      }
      frag.appendChild(row);
    }
    tree.appendChild(frag);
    syncSelectAllState();
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

    while (queue.length && !state.stopRequested) {
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
    const startUrl = normalizeUrl(options.startUrl || location.href);
    const maxDepth = options.maxDepth;
    const excludePatterns = options.excludePatterns || [];

    const discovered = new Set();
    const titles = new Map();
    const visited = new Set();
    const queue = [];
    const depthMap = new Map();

    function addUrl(maybeUrl, depth) {
      const normalized = normalizeUrl(maybeUrl);
      if (!normalized) return;
      if (!isDocUrl(normalized, origin, startUrl, excludePatterns)) return;
      if (discovered.has(normalized)) return;
      discovered.add(normalized);
      queue.push(normalized);
      depthMap.set(normalized, depth);
      state.foundCount = discovered.size;
      state.queueCount = queue.length;
      updateProgress();
    }

    addUrl(startUrl, 0);

    while (queue.length && !state.stopRequested) {
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
      updateProgress('扫描中');

      let html;
      try {
        html = await fetchTextWithRetry(current, options.retries, options.requestDelayMs);
      } catch (err) {
        addFailed(current, 'discover:' + (err && err.message ? err.message : 'failed'));
        updateProgress();
        await sleep(options.requestDelayMs);
        continue;
      }

      try {
        const pageDoc = new DOMParser().parseFromString(html, 'text/html');
        titles.set(current, extractDocTitle(pageDoc, current));
      } catch (_) {
        // keep fallback title
      }

      const links = parseLinksFromHtml(html, current);
      for (const link of links) {
        addUrl(link, depth + 1);
      }

      await sleep(options.requestDelayMs);
    }

    return Array.from(discovered).sort().map((url) => ({
      url,
      title: getDisplayTitle(url, titles.get(url) || '')
    }));
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

    const startUrl = normalizeUrl(location.href) || location.href;
    state.scanStartUrl = startUrl;
    resetExportProgress();

    state.scanning = true;
    state.stopRequested = false;
    state.scanSession += 1;
    const mySession = state.scanSession;
    state.discoveredUrls = [];
    state.failed = [];
    renderFailedQueue();
    updateFailToggle();
    state.foundCount = 0;
    state.doneCount = 0;
    state.failCount = 0;
    state.queueCount = 0;
    state.currentUrl = '';
    state.doneCount = 0;
    updateProgress('开始扫描当前页面及其子链接...');

    try {
      const urls = await discoverUrls({
        origin: location.origin,
        startUrl,
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

  async function downloadImagesToZip(zip, imageJobs, onProgress, onSuccess) {
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
      try {
        const binary = await fetchBinaryWithRetry(job.url, DEFAULTS.retries, DEFAULTS.requestDelayMs);
        zip.file(job.path, binary);
        if (typeof onSuccess === 'function') {
          onSuccess(binary.byteLength || 0);
        }
      } catch (err) {
        addFailed(job.url, 'image-download-fail:' + (err && err.message ? err.message : 'failed'));
      }
      if (typeof onProgress === 'function') {
        onProgress(i + 1, uniqueJobs.length);
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

    const exportRootPath = '/';
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
    updateFailToggle();
    state.currentUrl = '';

    const exportStats = {
      htmlBytes: 0,
      imageBytes: 0,
      pageFetched: 0,
      pageConverted: 0,
      imagesDownloaded: 0,
      failedCount: state.failCount,
      elapsedMs: 0,
      startMs: Date.now()
    };

    function refreshUsage() {
      exportStats.failedCount = state.failCount;
      exportStats.elapsedMs = Date.now() - exportStats.startMs;
      updateUsageText(exportStats);
    }

    function updateExportStage(stageLabel, completed, total) {
      setExportProgressVisible(true);
      setExportProgress(stageLabel, completed, total);
      refreshUsage();
    }

    const zip = new JSZip();
    const turndown = createTurndownService();
    const usedPaths = new Set();
    const pageDrafts = [];

    try {
      updateExportStage('页面抓取', 0, selected.length);
      let fetchProcessed = 0;
      for (let i = 0; i < selected.length; i += 1) {
        if (state.stopRequested) {
          break;
        }

        const url = selected[i];
        let html;
        try {
          html = await fetchTextWithRetry(url, DEFAULTS.retries, DEFAULTS.requestDelayMs);
          exportStats.pageFetched += 1;
          exportStats.htmlBytes += new TextEncoder().encode(html).length;
        } catch (err) {
          const matched = state.discoveredUrls.find((item) => item.url === url);
          addFailed(url, 'page-fetch-fail:' + (err && err.message ? err.message : 'failed'), matched ? matched.title : '');
          fetchProcessed += 1;
          updateExportStage('页面抓取', fetchProcessed, selected.length);
          continue;
        }

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title = extractDocTitle(doc, url);
        const path = buildMarkdownPath(url, title, exportRootPath, usedPaths);

        pageDrafts.push({
          url,
          doc,
          title,
          path
        });

        fetchProcessed += 1;
        updateExportStage('页面抓取', fetchProcessed, selected.length);
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
      let convertProcessed = 0;
      updateExportStage('Markdown转换', 0, pageDrafts.length);

      for (let i = 0; i < pageDrafts.length; i += 1) {
        if (state.stopRequested) {
          break;
        }

        const page = pageDrafts[i];
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
          addFailed(page.url, 'markdown-fail:' + (err && err.message ? err.message : 'failed'), page.title);
          convertProcessed += 1;
          updateExportStage('Markdown转换', convertProcessed, pageDrafts.length);
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
        exportStats.pageConverted += 1;
        convertProcessed += 1;
        updateExportStage('Markdown转换', convertProcessed, pageDrafts.length);
      }

      if (imageMode === 'local') {
        updateExportStage('图片下载', 0, imageJobs.length);
        if (imageJobs.length) {
          await downloadImagesToZip(
            zip,
            imageJobs,
            (completed, total) => {
              exportStats.imagesDownloaded = completed;
              updateExportStage('图片下载', completed, total);
            },
            (bytes) => {
              exportStats.imageBytes += bytes;
            }
          );
        }
      } else {
        updateExportStage('图片下载', 0, 0);
      }

      zip.file('SUMMARY.md', buildSummary(exportedPages));

      if (state.failed.length) {
        const failText = state.failed
          .map((item) => item.url + ' | ' + item.reason)
          .join('\n');
        zip.file('failed-urls.txt', failText + '\n');
      }

      updateExportStage('ZIP打包', 0, 100);
      const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        const progress = computeZipPackProgress(metadata);
        updateExportStage('ZIP打包', progress.completed, progress.total);
      });
      updateExportStage('ZIP打包', 100, 100);
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
