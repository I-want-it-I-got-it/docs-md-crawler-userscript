// ==UserScript==
// @name         Docs Markdown Crawler (Manual Scan)
// @namespace    https://github.com/yourname/docs-md-crawler
// @version      0.2.18
// @description  Manually scan docs pages on the current site and export Markdown ZIP
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
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

  const DEFAULT_EXCLUDES = ['/login', '/admin', 'token='];
  const DEFAULTS = {
    maxDepth: 6,
    requestDelayMs: 120,
    timeoutMs: 15000,
    retries: 1,
    minRequestIntervalMs: 100,
    scanConcurrency: 6,
    exportFetchConcurrency: 6,
    imageConcurrency: 4,
    imageMode: 'external',
    zipPackTimeoutMs: 30000
  };
  const EXPORT_BUTTON_IDLE_TEXT = '导出 ZIP';
  const EXPORT_STAGE_SEQUENCE = ['页面抓取', 'Markdown转换', '图片下载', 'ZIP打包'];
  const IMAGE_MODE_OPTIONS = new Set(['external', 'local', 'none']);
  const TRUSTED_TYPES_POLICY_NAMES = ['docs-md-crawler', 'default'];
  const GENERIC_ROOT_SEGMENTS = new Set([
    'category',
    'categories',
    'tag',
    'tags',
    'author',
    'authors',
    'page',
    'pages',
    'search'
  ]);
  const DOCS_ROOT_HINT_SEGMENTS = new Set([
    'docs',
    'doc',
    'documentation',
    'developer',
    'developers',
    'guide',
    'guides',
    'api',
    'reference',
    'manual',
    'kb',
    'help'
  ]);
  const BARE_DOMAIN_LINK_PATTERN = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d+)?(?:[/?#].*)?$/i;

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

  function shouldSkipRawHref(rawHref) {
    const value = String(rawHref || '').trim();
    if (!value) {
      return true;
    }
    if (value.startsWith('#')) {
      return true;
    }
    if (/[`\s]/.test(value)) {
      return true;
    }
    const lowered = value.toLowerCase();
    return (
      lowered.startsWith('javascript:') ||
      lowered.startsWith('mailto:') ||
      lowered.startsWith('tel:') ||
      lowered.startsWith('data:')
    );
  }

  function looksLikeBareDomainHref(rawHref) {
    const value = String(rawHref || '').trim();
    if (!value || value.startsWith('/') || value.startsWith('#')) {
      return false;
    }
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) {
      return false;
    }
    return BARE_DOMAIN_LINK_PATTERN.test(value);
  }

  function resolveHrefForCrawl(rawHref, baseUrl) {
    const value = String(rawHref || '').trim();
    if (shouldSkipRawHref(value)) {
      return '';
    }

    let candidate = value;
    if (candidate.startsWith('//')) {
      candidate = 'https:' + candidate;
    } else if (looksLikeBareDomainHref(candidate)) {
      candidate = 'https://' + candidate;
    }

    try {
      const absolute = new URL(candidate, baseUrl);
      if (!/^https?:$/.test(absolute.protocol)) {
        return '';
      }
      return absolute.href;
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
    let fileName = safeTitle + '.md';
    let candidate = baseDir + fileName;

    if (usedPaths) {
      let counter = 2;
      while (usedPaths.has(candidate)) {
        fileName = safeTitle + '-' + counter + '.md';
        candidate = baseDir + fileName;
        counter += 1;
      }
      usedPaths.add(candidate);
    }

    return candidate;
  }

  function normalizeSiteNameHint(rawHint) {
    const hint = String(rawHint || '').replace(/\s+/g, ' ').trim();
    if (!hint) {
      return '';
    }
    const head = hint.split(/\s*[|｜\-—–:：·•]\s*/)[0].trim();
    if (!head) {
      return '';
    }
    const trimmed = head
      .replace(/\b(docs?|documentation|developers?|developer|guide|guides|platform|文档)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const candidate = trimmed || head;
    return sanitizeSegment(candidate, '');
  }

  function buildZipFilename(siteHints, hostname) {
    const hints = Array.isArray(siteHints) ? siteHints : [siteHints];
    for (const hint of hints) {
      const normalized = normalizeSiteNameHint(hint);
      if (normalized) {
        return normalized + '.zip';
      }
    }

    const hostText = String(hostname || '').trim().toLowerCase().replace(/^www\./, '');
    if (hostText) {
      const labels = hostText.split('.').filter(Boolean);
      const rawLabel = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
      const prettyLabel = String(rawLabel || '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
        .trim();
      const fallbackName = sanitizeSegment(prettyLabel, '');
      if (fallbackName) {
        return fallbackName + '.zip';
      }
    }

    return 'docs-md-export.zip';
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
    function walk(node, depth, ancestors) {
      node.pages
        .slice()
        .sort((a, b) => a.url.localeCompare(b.url))
        .forEach((page) => {
          entries.push({
            type: 'page',
            url: page.url,
            title: page.title,
            depth,
            ancestors: ancestors.slice()
          });
        });

      Array.from(node.groups.keys())
        .sort((a, b) => a.localeCompare(b))
        .forEach((segment) => {
          const groupNode = node.groups.get(segment);
          const groupKey = ancestors.length ? ancestors[ancestors.length - 1] + '/' + segment : segment;
          entries.push({
            type: 'group',
            key: groupKey,
            title: sanitizeSegment(decodeURIComponent(segment), 'index'),
            depth,
            ancestors: ancestors.slice()
          });
          walk(groupNode, depth + 1, ancestors.concat(groupKey));
        });
    }

    walk(root, 0, []);
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

  function collectGroupDescendantUrls(entries, groupKey) {
    return (entries || [])
      .filter((item) => item.type === 'page' && (item.ancestors || []).includes(groupKey))
      .map((item) => item.url);
  }

  function computeGroupSelectionState(entries, groupKey, selectedUrls) {
    const descendants = collectGroupDescendantUrls(entries, groupKey);
    const selectedSet = selectedUrls instanceof Set ? selectedUrls : new Set(selectedUrls || []);
    let selected = 0;
    descendants.forEach((url) => {
      if (selectedSet.has(url)) {
        selected += 1;
      }
    });
    const base = computeSelectAllState(descendants.length, selected);
    return {
      checked: base.checked,
      indeterminate: base.indeterminate,
      total: descendants.length,
      selected,
      descendants
    };
  }

  function computeStageProgress(completed, total) {
    if (!total || total <= 0) {
      return { completed: 0, total: 0, percent: 100 };
    }
    const bounded = Math.min(Math.max(completed, 0), total);
    const percent = Math.round((bounded / total) * 100);
    return { completed: bounded, total, percent };
  }

  function buildStageProgressText(stageLabel, completed, total) {
    const progress = computeStageProgress(completed, total);
    if (stageLabel === 'ZIP打包') {
      return stageLabel + ': ' + progress.percent + '%';
    }
    return stageLabel + ': ' + progress.completed + '/' + progress.total + ' (' + progress.percent + '%)';
  }

  function resolveProgressFillPercent(stageLabel, completed, total, overallPercent) {
    const stagePercent = computeStageProgress(completed, total).percent;
    const parsedOverall = Number(overallPercent);
    if (Number.isFinite(parsedOverall)) {
      return Math.min(100, Math.max(0, Math.round(parsedOverall)));
    }
    return stagePercent;
  }

  function normalizeImageMode(rawValue) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (IMAGE_MODE_OPTIONS.has(value)) {
      return value;
    }
    return DEFAULTS.imageMode;
  }

  function computeZipPackProgress(metadata) {
    const rawPercent = metadata && Number(metadata.percent);
    if (!Number.isFinite(rawPercent)) {
      return { completed: 0, total: 100, percent: 0 };
    }
    const completed = Math.min(100, Math.max(0, Math.round(rawPercent)));
    return computeStageProgress(completed, 100);
  }

  function withTimeout(promise, timeoutMs, message) {
    const ms = Number(timeoutMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      return promise;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(message || 'timeout'));
      }, ms);

      Promise.resolve(promise).then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function isLikelyBlobSupportError(err) {
    const message = String((err && err.message) || '').toLowerCase();
    if (!message) {
      return false;
    }
    const mentionsBlobType = message.includes('blob') || message.includes('type');
    const mentionsUnsupported = message.includes('unsupported') ||
      message.includes('not support') ||
      message.includes('invalid');
    return mentionsBlobType && mentionsUnsupported;
  }

  function isLikelyUint8ArraySupportError(err) {
    const message = String((err && err.message) || '').toLowerCase();
    if (!message) {
      return false;
    }
    const mentionsUint8Type = message.includes('uint8array') ||
      message.includes('typed array') ||
      message.includes('arraybuffer');
    const mentionsUnsupported = message.includes('unsupported') ||
      message.includes('not support') ||
      message.includes('invalid');
    return mentionsUint8Type && mentionsUnsupported;
  }

  function toZipBlob(payload) {
    if (isBlobValue(payload)) {
      return payload;
    }

    const BlobCtor = typeof Blob !== 'undefined' ? Blob : null;
    if (!BlobCtor) {
      throw new Error('blob-not-supported');
    }

    if (isArrayBufferValue(payload)) {
      return new BlobCtor([payload], { type: 'application/zip' });
    }

    if (ArrayBuffer.isView(payload)) {
      const bytes = copyToUint8Array(new Uint8Array(payload.buffer, payload.byteOffset || 0, payload.byteLength || 0));
      return new BlobCtor([bytes], { type: 'application/zip' });
    }

    throw new Error('unsupported-zip-payload');
  }

  function encodeUtf8(value) {
    return new TextEncoder().encode(String(value || ''));
  }

  function writeUint16LE(dataView, offset, value) {
    dataView.setUint16(offset, Number(value) >>> 0, true);
  }

  function writeUint32LE(dataView, offset, value) {
    dataView.setUint32(offset, Number(value) >>> 0, true);
  }

  let crc32TableCache = null;

  function getCrc32Table() {
    if (crc32TableCache) {
      return crc32TableCache;
    }
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let j = 0; j < 8; j += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    crc32TableCache = table;
    return table;
  }

  function computeCrc32(bytes) {
    const table = getCrc32Table();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      const idx = (crc ^ bytes[i]) & 0xff;
      crc = table[idx] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toUint8Array(value) {
    if (value == null) {
      return new Uint8Array(0);
    }
    if (isArrayBufferValue(value)) {
      return copyToUint8Array(new Uint8Array(value));
    }
    if (ArrayBuffer.isView(value)) {
      return copyToUint8Array(new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || 0));
    }
    if (typeof value === 'string') {
      return encodeUtf8(value);
    }
    return encodeUtf8(String(value));
  }

  function buildStoreZipBlob(entries) {
    const normalized = (entries || [])
      .map((entry) => {
        if (!entry || !entry.path) {
          return null;
        }
        const path = String(entry.path).replace(/\\/g, '/');
        if (!path) {
          return null;
        }
        const nameBytes = encodeUtf8(path);
        const dataBytes = entry.bytes != null ? toUint8Array(entry.bytes) : toUint8Array(entry.text || '');
        return {
          path,
          nameBytes,
          dataBytes,
          crc32: computeCrc32(dataBytes)
        };
      })
      .filter(Boolean);

    if (!normalized.length) {
      throw new Error('zip-store-empty');
    }

    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    let centralSize = 0;

    normalized.forEach((item) => {
      const nameLen = item.nameBytes.byteLength;
      const dataLen = item.dataBytes.byteLength;

      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);
      writeUint32LE(localView, 0, 0x04034b50);
      writeUint16LE(localView, 4, 20);
      writeUint16LE(localView, 6, 0);
      writeUint16LE(localView, 8, 0);
      writeUint16LE(localView, 10, 0);
      writeUint16LE(localView, 12, 0);
      writeUint32LE(localView, 14, item.crc32);
      writeUint32LE(localView, 18, dataLen);
      writeUint32LE(localView, 22, dataLen);
      writeUint16LE(localView, 26, nameLen);
      writeUint16LE(localView, 28, 0);
      localParts.push(localHeader, item.nameBytes, item.dataBytes);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer, centralHeader.byteOffset, centralHeader.byteLength);
      writeUint32LE(centralView, 0, 0x02014b50);
      writeUint16LE(centralView, 4, 20);
      writeUint16LE(centralView, 6, 20);
      writeUint16LE(centralView, 8, 0);
      writeUint16LE(centralView, 10, 0);
      writeUint16LE(centralView, 12, 0);
      writeUint16LE(centralView, 14, 0);
      writeUint32LE(centralView, 16, item.crc32);
      writeUint32LE(centralView, 20, dataLen);
      writeUint32LE(centralView, 24, dataLen);
      writeUint16LE(centralView, 28, nameLen);
      writeUint16LE(centralView, 30, 0);
      writeUint16LE(centralView, 32, 0);
      writeUint16LE(centralView, 34, 0);
      writeUint16LE(centralView, 36, 0);
      writeUint32LE(centralView, 38, 0);
      writeUint32LE(centralView, 42, localOffset);
      centralParts.push(centralHeader, item.nameBytes);

      const localRecordSize = localHeader.byteLength + nameLen + dataLen;
      const centralRecordSize = centralHeader.byteLength + nameLen;
      localOffset += localRecordSize;
      centralSize += centralRecordSize;
    });

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer, end.byteOffset, end.byteLength);
    writeUint32LE(endView, 0, 0x06054b50);
    writeUint16LE(endView, 4, 0);
    writeUint16LE(endView, 6, 0);
    writeUint16LE(endView, 8, normalized.length);
    writeUint16LE(endView, 10, normalized.length);
    writeUint32LE(endView, 12, centralSize);
    writeUint32LE(endView, 16, localOffset);
    writeUint16LE(endView, 20, 0);

    return new Blob(localParts.concat(centralParts).concat([end]), { type: 'application/zip' });
  }

  async function generateZipBlobWithFallback(zip, options) {
    if (!zip || typeof zip.generateAsync !== 'function') {
      throw new Error('invalid-zip-instance');
    }

    const opts = options || {};
    const timeoutMs = Number(opts.timeoutMs) || DEFAULTS.zipPackTimeoutMs;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : undefined;
    const primaryType = opts.primaryType === 'uint8array' ? 'uint8array' : 'blob';
    const fallbackType = primaryType === 'uint8array' ? 'blob' : 'uint8array';
    const primaryTimeoutError = 'zip-pack-timeout';
    const fallbackTimeoutError = 'zip-pack-fallback-timeout';

    try {
      const primaryPayload = await withTimeout(
        zip.generateAsync({
          type: primaryType,
          compression: 'STORE',
          streamFiles: true
        }, onProgress),
        timeoutMs,
        primaryTimeoutError
      );
      return {
        blob: toZipBlob(primaryPayload),
        fallbackUsed: false,
        timeoutTriggered: false,
        primaryType
      };
    } catch (err) {
      const timeoutTriggered = err && err.message === primaryTimeoutError;
      if (timeoutTriggered) {
        throw err;
      }
      const supportError = primaryType === 'blob'
        ? isLikelyBlobSupportError(err)
        : isLikelyUint8ArraySupportError(err);
      if (!supportError) {
        throw err;
      }

      const fallbackPayload = await withTimeout(
        zip.generateAsync({
          type: fallbackType,
          compression: 'STORE',
          streamFiles: true
        }, onProgress),
        timeoutMs,
        fallbackTimeoutError
      );
      return {
        blob: toZipBlob(fallbackPayload),
        fallbackUsed: true,
        timeoutTriggered: false,
        primaryType,
        fallbackType
      };
    }
  }

  function normalizeErrorMessage(err, fallback) {
    const fromMessage = err && err.message ? String(err.message).trim() : '';
    if (fromMessage) {
      return fromMessage;
    }
    const fromErrorField = err && err.error ? String(err.error).trim() : '';
    if (fromErrorField) {
      return fromErrorField;
    }
    return fallback || 'unknown';
  }

  function gmDownloadByUrl(downloadUrl, filename, options) {
    const opts = options || {};
    const gmDownloadFn = opts.gmDownloadFn || (typeof GM_download === 'function' ? GM_download : null);
    if (typeof gmDownloadFn !== 'function') {
      return Promise.reject(new Error('gm-download-unavailable'));
    }

    const timeoutMs = Number(opts.timeoutMs);
    const saveAs = Boolean(opts.saveAs);
    const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error('gm-download-timeout'));
      }, boundedTimeout);

      function done(fn, value) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      try {
        const requestResult = gmDownloadFn({
          url: downloadUrl,
          name: filename,
          saveAs,
          onload: function () {
            done(resolve);
          },
          onerror: function (err) {
            done(reject, new Error(normalizeErrorMessage(err, 'gm-download-error')));
          },
          ontimeout: function () {
            done(reject, new Error('gm-download-timeout'));
          }
        });

        if (requestResult && typeof requestResult.then === 'function') {
          requestResult.then(
            function () {
              done(resolve);
            },
            function (err) {
              done(reject, new Error(normalizeErrorMessage(err, 'gm-download-error')));
            }
          );
        }
      } catch (err) {
        done(reject, new Error(normalizeErrorMessage(err, 'gm-download-throw')));
      }
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      if (!isBlobValue(blob)) {
        reject(new Error('blob-dataurl-invalid-blob'));
        return;
      }
      if (typeof FileReader === 'undefined') {
        reject(new Error('blob-dataurl-file-reader-unavailable'));
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        const value = String(reader.result || '');
        if (!value.startsWith('data:')) {
          reject(new Error('blob-dataurl-empty'));
          return;
        }
        resolve(value);
      };
      reader.onerror = function () {
        reject(new Error('blob-dataurl-read-fail'));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function gmDownloadByBlobDataUrl(blob, filename, options) {
    const dataUrl = await blobToDataUrl(blob);
    return gmDownloadByUrl(dataUrl, filename, options);
  }

  function anchorDownloadByUrl(downloadUrl, filename) {
    if (typeof document === 'undefined' || !document.body) {
      return Promise.reject(new Error('anchor-download-unavailable'));
    }

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return Promise.resolve();
  }

  function playDownloadCompleteSound(options) {
    const opts = options || {};
    const AudioContextCtor = opts.AudioContextCtor || (
      typeof window !== 'undefined'
        ? (window.AudioContext || window.webkitAudioContext)
        : null
    );
    if (!AudioContextCtor) {
      return false;
    }

    let ctx = null;
    try {
      ctx = new AudioContextCtor();
    } catch (_) {
      return false;
    }

    if (!ctx || typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function' || !ctx.destination) {
      try {
        if (ctx && typeof ctx.close === 'function') {
          ctx.close();
        }
      } catch (_) {
        // ignore close failure
      }
      return false;
    }

    const frequencyHz = Number(opts.frequencyHz) > 0 ? Number(opts.frequencyHz) : 880;
    const durationSec = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : 0.12;
    const gainValue = Number(opts.gain);
    const volume = Number.isFinite(gainValue) && gainValue >= 0 ? gainValue : 0.08;
    const now = Number(ctx.currentTime) || 0;

    try {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      if (oscillator.frequency && typeof oscillator.frequency.setValueAtTime === 'function') {
        oscillator.frequency.setValueAtTime(frequencyHz, now);
      }

      if (gainNode.gain && typeof gainNode.gain.setValueAtTime === 'function') {
        gainNode.gain.setValueAtTime(volume, now);
      }
      if (gainNode.gain && typeof gainNode.gain.exponentialRampToValueAtTime === 'function') {
        gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
      }

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        Promise.resolve(ctx.resume()).catch(() => {});
      }

      oscillator.onended = () => {
        if (typeof ctx.close === 'function') {
          Promise.resolve(ctx.close()).catch(() => {});
        }
      };
      oscillator.start(now);
      oscillator.stop(now + durationSec);
      return true;
    } catch (_) {
      try {
        if (typeof ctx.close === 'function') {
          Promise.resolve(ctx.close()).catch(() => {});
        }
      } catch (_) {
        // ignore close failure
      }
      return false;
    }
  }

  async function triggerZipDownloadByUrl(downloadUrl, filename, deps) {
    const options = deps || {};
    const blob = options.blob;
    const gmDownloader = typeof options.gmDownloadByUrl === 'function' ? options.gmDownloadByUrl : null;
    const gmBlobDownloader = typeof options.gmDownloadByBlob === 'function' ? options.gmDownloadByBlob : null;
    const anchorDownloader = typeof options.anchorDownloadByUrl === 'function'
      ? options.anchorDownloadByUrl
      : anchorDownloadByUrl;

    if (gmDownloader) {
      try {
        await gmDownloader(downloadUrl, filename);
        return {
          method: 'gm_download',
          usedFallback: false,
          errorMessage: ''
        };
      } catch (err) {
        if (gmBlobDownloader && isBlobValue(blob)) {
          try {
            await gmBlobDownloader(blob, filename);
            return {
              method: 'gm_download_dataurl',
              usedFallback: true,
              errorMessage: normalizeErrorMessage(err, 'gm-download-error')
            };
          } catch (_) {
            // continue to anchor fallback
          }
        }
        await anchorDownloader(downloadUrl, filename);
        return {
          method: 'anchor',
          usedFallback: true,
          errorMessage: normalizeErrorMessage(err, 'gm-download-error')
        };
      }
    }

    await anchorDownloader(downloadUrl, filename);
    return {
      method: 'anchor',
      usedFallback: false,
      errorMessage: ''
    };
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

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createTrustedHtmlPolicy(options) {
    const opts = options || {};
    const trustedTypesApi = opts.trustedTypes || (typeof trustedTypes !== 'undefined' ? trustedTypes : null);
    if (!trustedTypesApi || typeof trustedTypesApi.createPolicy !== 'function') {
      return null;
    }

    const nameCandidates = [];
    if (opts.preferredName) {
      nameCandidates.push(String(opts.preferredName));
    }
    for (const name of TRUSTED_TYPES_POLICY_NAMES) {
      if (!nameCandidates.includes(name)) {
        nameCandidates.push(name);
      }
    }

    const policyFactory = {
      createHTML(value) {
        return String(value || '');
      }
    };

    for (const name of nameCandidates) {
      if (!name) {
        continue;
      }
      try {
        return trustedTypesApi.createPolicy(name, policyFactory);
      } catch (_) {
        // policy not allowed or already exists, continue trying
      }
    }

    if (typeof trustedTypesApi.getPolicy === 'function') {
      for (const name of nameCandidates) {
        if (!name) {
          continue;
        }
        try {
          const policy = trustedTypesApi.getPolicy(name);
          if (policy && typeof policy.createHTML === 'function') {
            return policy;
          }
        } catch (_) {
          // ignore inaccessible policy lookups
        }
      }
    }

    const defaultPolicy = trustedTypesApi.defaultPolicy;
    if (defaultPolicy && typeof defaultPolicy.createHTML === 'function') {
      return defaultPolicy;
    }
    return null;
  }

  function toTrustedHtml(html, trustedPolicy) {
    const rawHtml = String(html || '');
    if (!trustedPolicy || typeof trustedPolicy.createHTML !== 'function') {
      return rawHtml;
    }
    try {
      return trustedPolicy.createHTML(rawHtml);
    } catch (_) {
      return rawHtml;
    }
  }

  function parseHtmlDocument(html, options) {
    const opts = options || {};
    const DOMParserCtor = opts.DOMParserCtor || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DOMParserCtor) {
      throw new Error('domparser-unavailable');
    }
    const rawHtml = String(html || '');
    const parser = new DOMParserCtor();
    try {
      return parser.parseFromString(rawHtml, 'text/html');
    } catch (err) {
      const trustedHtml = toTrustedHtml(rawHtml, opts.trustedPolicy);
      if (trustedHtml === rawHtml) {
        throw err;
      }
      return parser.parseFromString(trustedHtml, 'text/html');
    }
  }

  const trustedHtmlPolicy = createTrustedHtmlPolicy();

  function formatFailureReason(reason) {
    const raw = String(reason || '').trim();
    if (!raw) {
      return 'unknown';
    }
    const mappings = [
      ['discover:', '扫描失败: '],
      ['page-fetch-fail:', '页面抓取失败: '],
      ['markdown-fail:', 'Markdown 转换失败: '],
      ['image-download-fail:', '图片下载失败: '],
      ['retry-fail:', '重试失败: ']
    ];
    for (const pair of mappings) {
      if (raw.startsWith(pair[0])) {
        return pair[1] + (raw.slice(pair[0].length) || 'unknown');
      }
    }
    return raw;
  }

  function formatUsageStats(stats) {
    const pageFetched = Number(stats.pageFetched) || 0;
    const pageConverted = Number(stats.pageConverted) || 0;
    const imagesDownloaded = Number(stats.imagesDownloaded) || 0;
    const failedCount = Number(stats.failedCount) || 0;
    const elapsedMs = Number(stats.elapsedMs) || 0;

    return '任务: 页面抓取 ' + pageFetched + ' | 页面转换 ' + pageConverted + ' | 图片下载 ' + imagesDownloaded + ' | 失败 ' + failedCount + ' | 耗时 ' + formatDuration(elapsedMs);
  }

  function buildUsageStatsMarkup(stats) {
    const pageFetched = Number(stats.pageFetched) || 0;
    const pageConverted = Number(stats.pageConverted) || 0;
    const imagesDownloaded = Number(stats.imagesDownloaded) || 0;
    const failedCount = Math.max(0, Number(stats.failedCount) || 0);
    const elapsedMs = Number(stats.elapsedMs) || 0;

    const prefix = '任务: 页面抓取 ' + pageFetched + ' | 页面转换 ' + pageConverted + ' | 图片下载 ' + imagesDownloaded + ' | ';
    const suffix = ' | 耗时 ' + formatDuration(elapsedMs);
    if (failedCount > 0) {
      return escapeHtml(prefix) + '<button type="button" class="docs-md-fail-link">失败 ' + failedCount + '</button>' + escapeHtml(suffix);
    }
    return escapeHtml(prefix + '失败 0' + suffix);
  }

  function computeStopControlState(flags) {
    const running = Boolean(flags && (flags.scanning || flags.exporting));
    const paused = Boolean(flags && flags.paused);
    if (!running) {
      return { label: '停止', disabled: true, mode: 'idle' };
    }
    if (paused) {
      return { label: '继续', disabled: false, mode: 'resume' };
    }
    return { label: '停止', disabled: false, mode: 'stop' };
  }

  function buildFailedQueueItems(failedItems) {
    return (failedItems || []).map((item) => ({
      id: item.id,
      url: item.url,
      reason: item.reason,
      reasonText: formatFailureReason(item.reason),
      title: getDisplayTitle(item.url, item.title || '')
    }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runWithConcurrency(items, concurrency, worker) {
    const list = Array.isArray(items) ? items : [];
    const run = typeof worker === 'function' ? worker : async () => undefined;
    if (!list.length) {
      return [];
    }

    const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
    const workerCount = Math.min(limit, list.length);
    const results = new Array(list.length);
    let cursor = 0;

    async function consume() {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await run(list[index], index);
      }
    }

    const runners = [];
    for (let i = 0; i < workerCount; i += 1) {
      runners.push(consume());
    }
    await Promise.all(runners);
    return results;
  }

  function createHostRequestLimiter(options) {
    const opts = options || {};
    const minIntervalMs = Math.max(0, Math.floor(Number(opts.minIntervalMs) || 0));
    const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();
    const sleepFn = typeof opts.sleepFn === 'function' ? opts.sleepFn : sleep;
    const hostLocks = new Map();
    const nextAllowedByHost = new Map();

    function normalizeHostKey(url) {
      try {
        return new URL(url).host || '*';
      } catch (_) {
        return '*';
      }
    }

    async function wait(url) {
      if (minIntervalMs <= 0) {
        return;
      }
      const host = normalizeHostKey(url);
      const previous = hostLocks.get(host) || Promise.resolve();
      let release = null;
      const current = new Promise((resolve) => {
        release = resolve;
      });
      hostLocks.set(host, current);
      await previous;

      try {
        const now = Number(nowFn()) || 0;
        const nextAllowed = Number(nextAllowedByHost.get(host)) || 0;
        const delay = nextAllowed - now;
        if (delay > 0) {
          await sleepFn(delay);
        }
        nextAllowedByHost.set(host, (Number(nowFn()) || 0) + minIntervalMs);
      } finally {
        if (typeof release === 'function') {
          release();
        }
        if (hostLocks.get(host) === current) {
          hostLocks.delete(host);
        }
      }
    }

    return {
      wait
    };
  }

  function parseHttpStatusFromError(error) {
    const message = String(error && error.message ? error.message : error || '').trim().toLowerCase();
    const match = message.match(/^http-(\d{3})\b/);
    if (!match) {
      return 0;
    }
    return Number(match[1]) || 0;
  }

  function shouldRetryRequestError(error) {
    const message = String(error && error.message ? error.message : error || '').trim().toLowerCase();
    if (!message) {
      return true;
    }
    if (
      message === 'timeout' ||
      message === 'network-error' ||
      message === 'request-failed'
    ) {
      return true;
    }
    if (message.startsWith('unsupported-binary:')) {
      return false;
    }
    const status = parseHttpStatusFromError(error);
    if (!status) {
      return true;
    }
    if (status === 408 || status === 425 || status === 429) {
      return true;
    }
    if (status >= 500) {
      return true;
    }
    return false;
  }

  function shouldUseSitemapForDiscovery(options) {
    const opts = options || {};
    if (opts.useSitemap !== true) {
      return false;
    }
    const crawlDescendantsOnly = opts.crawlDescendantsOnly !== false;
    const directoryOnly = opts.directoryOnly === true;
    return directoryOnly || !crawlDescendantsOnly;
  }

  function copyToUint8Array(view) {
    const source = view instanceof Uint8Array ? view : new Uint8Array(view);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  }

  function isArrayBufferValue(value) {
    if (!value) {
      return false;
    }
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      return true;
    }
    return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  }

  function isBlobValue(value) {
    if (!value) {
      return false;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return true;
    }
    return typeof value.arrayBuffer === 'function' && typeof value.size === 'number';
  }

  function stringToBinaryBytes(value) {
    const raw = String(value || '');
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  async function normalizeBinaryPayload(payload) {
    if (payload == null) {
      return null;
    }

    if (isArrayBufferValue(payload)) {
      return copyToUint8Array(new Uint8Array(payload));
    }

    if (ArrayBuffer.isView(payload)) {
      return copyToUint8Array(new Uint8Array(payload.buffer, payload.byteOffset || 0, payload.byteLength || 0));
    }

    if (isBlobValue(payload)) {
      try {
        const buffer = await payload.arrayBuffer();
        return copyToUint8Array(new Uint8Array(buffer));
      } catch (_) {
        return null;
      }
    }

    if (typeof payload === 'string') {
      return stringToBinaryBytes(payload);
    }

    return null;
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
    const doc = parseHtmlDocument(html, { trustedPolicy: trustedHtmlPolicy });
    return parseLinksFromDocument(doc, baseUrl);
  }

  function parseNavigationLinksFromHtml(html, baseUrl) {
    const doc = parseHtmlDocument(html, { trustedPolicy: trustedHtmlPolicy });
    return parseNavigationLinksFromDocument(doc, baseUrl);
  }

  function parseCategoryLinksFromHtml(html, baseUrl, options) {
    const doc = parseHtmlDocument(html, { trustedPolicy: trustedHtmlPolicy });
    return parseCategoryLinksFromDocument(doc, baseUrl, options);
  }

  function getLinkScopeNodes(doc, preferContentScopes) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return [];
    }
    const scopes = [];
    const seen = new Set();
    const selectors = ['main', 'article', '[role="main"]', '.content', '.docs-content', '.markdown-body', '#content', '#main'];

    if (preferContentScopes) {
      selectors.forEach((selector) => {
        doc.querySelectorAll(selector).forEach((node) => {
          if (!node || seen.has(node)) {
            return;
          }
          seen.add(node);
          scopes.push(node);
        });
      });
    }

    if (scopes.length) {
      return scopes;
    }

    const fallback = doc.body || doc.documentElement;
    return fallback ? [fallback] : [];
  }

  function getNavigationScopeNodes(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return [];
    }
    const scopes = [];
    const seen = new Set();
    const leftNavSelectors = [
      '[data-left-nav-container] [data-left-nav]',
      'nav[data-left-nav]',
      '[data-left-nav]',
      '[data-left-nav-id]',
      '[data-left-nav-container]'
    ];

    leftNavSelectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((node) => {
        if (!node || seen.has(node)) {
          return;
        }
        seen.add(node);
        scopes.push(node);
      });
    });

    if (scopes.length) {
      return scopes;
    }

    const frameworkSidebarSelectors = [
      '#VPSidebarNav',
      '.VPSidebar',
      'aside.VPSidebar',
      '.vp-sidebar',
      '.theme-doc-sidebar',
      '#sidebar'
    ];

    frameworkSidebarSelectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((node) => {
        if (!node || seen.has(node)) {
          return;
        }
        seen.add(node);
        scopes.push(node);
      });
    });

    if (scopes.length) {
      return scopes;
    }

    const selectors = [
      'aside nav',
      'aside',
      '[role="navigation"]',
      'nav',
      '.sidebar',
      '.docs-sidebar',
      '.doc-sidebar',
      '.site-sidebar',
      '.menu',
      '.site-menu',
      '.toc',
      '.table-of-contents',
      '[class*="sidebar" i]',
      '[class*="toc" i]'
    ];

    selectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((node) => {
        if (!node || seen.has(node)) {
          return;
        }
        seen.add(node);
        scopes.push(node);
      });
    });

    return scopes;
  }

  function getCategoryScopeNodes(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return [];
    }
    const scopes = [];
    const seen = new Set();
    const selectors = [
      'header nav',
      'header [role="navigation"]',
      '[role="banner"] nav',
      '.top-nav',
      '.site-nav',
      '.docs-nav',
      '.navbar',
      'nav[aria-label*="category" i]',
      'nav[aria-label*="main" i]',
      'nav[aria-label*="global" i]',
      '[role="menu"]',
      'nav'
    ];

    selectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((node) => {
        if (!node || seen.has(node)) {
          return;
        }
        seen.add(node);
        scopes.push(node);
      });
    });

    return scopes;
  }

  function isNavigationLikeAnchor(anchor, footerSelector) {
    if (!anchor) {
      return false;
    }

    if (typeof anchor.closest === 'function') {
      const navContainer = anchor.closest(
        'nav,[role="navigation"],header,[role="banner"],footer,[role="contentinfo"],aside,.menu,.navbar,.site-nav,.site-menu,.top-nav'
      );
      if (navContainer) {
        return true;
      }

      const footerContainer = anchor.closest(footerSelector);
      if (footerContainer) {
        return true;
      }
    }

    return false;
  }

  function getFirstPathSegment(url) {
    try {
      const pathname = new URL(url).pathname;
      const segments = splitPathSegments(pathname);
      return segments.length ? segments[0].toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function getDocRootPathFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const segments = splitPathSegments(pathname);
      if (!segments.length) {
        return '/';
      }
      return '/' + segments[0];
    } catch (_) {
      return '/';
    }
  }

  function inferDocsRootPath(startUrl, candidateUrls, fallbackPath) {
    const fallback = normalizeRootPath(fallbackPath || getDocRootPathFromUrl(startUrl));
    if (fallback !== '/') {
      return fallback;
    }

    let origin = '';
    try {
      origin = new URL(startUrl).origin;
    } catch (_) {
      return fallback;
    }

    const scoreByRoot = new Map();
    const inputs = Array.isArray(candidateUrls) ? candidateUrls : [];
    for (const rawUrl of inputs) {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) {
        continue;
      }
      try {
        const u = new URL(normalized);
        if (u.origin !== origin) {
          continue;
        }
        const segments = splitPathSegments(u.pathname).map((item) => item.toLowerCase());
        if (!segments.length) {
          continue;
        }
        const root = segments[0];
        if (!root || GENERIC_ROOT_SEGMENTS.has(root)) {
          continue;
        }
        const weight = DOCS_ROOT_HINT_SEGMENTS.has(root) ? 4 : 1;
        scoreByRoot.set(root, (scoreByRoot.get(root) || 0) + weight);
      } catch (_) {
        // ignore invalid URL
      }
    }

    if (!scoreByRoot.size) {
      return '/';
    }

    const ranked = Array.from(scoreByRoot.entries()).sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      const aHint = DOCS_ROOT_HINT_SEGMENTS.has(a[0]) ? 1 : 0;
      const bHint = DOCS_ROOT_HINT_SEGMENTS.has(b[0]) ? 1 : 0;
      if (bHint !== aHint) {
        return bHint - aHint;
      }
      return a[0].localeCompare(b[0]);
    });

    const topRoot = ranked[0][0];
    const topScore = ranked[0][1];
    if (!DOCS_ROOT_HINT_SEGMENTS.has(topRoot) && topScore < 2) {
      return '/';
    }

    return '/' + topRoot;
  }

  function deriveCategoryPathPrefixes(startUrl, categoryUrls, docsRootPath) {
    const rootPath = normalizeRootPath(docsRootPath || getDocRootPathFromUrl(startUrl));
    const prefixes = new Set();
    const inputs = Array.isArray(categoryUrls) ? categoryUrls : [];

    inputs.forEach((rawUrl) => {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) {
        return;
      }
      try {
        const pathname = normalizeRootPath(new URL(normalized).pathname || '/');
        if (rootPath !== '/' && !pathStartsWithRoot(pathname, rootPath)) {
          return;
        }
        prefixes.add(pathname);
      } catch (_) {
        // ignore invalid URL
      }
    });

    if (!prefixes.size) {
      prefixes.add(rootPath);
    }

    return Array.from(prefixes).sort((a, b) => a.localeCompare(b));
  }

  function matchesAnyPathPrefix(url, pathPrefixes) {
    const prefixes = Array.isArray(pathPrefixes) ? pathPrefixes : [];
    if (!prefixes.length) {
      return true;
    }
    try {
      const pathname = normalizeRootPath(new URL(url).pathname || '/');
      return prefixes.some((prefix) => {
        const normalizedPrefix = normalizeRootPath(prefix);
        return pathStartsWithRoot(pathname, normalizedPrefix);
      });
    } catch (_) {
      return false;
    }
  }

  function inferDocRootPrefixes(startUrl, seedLinks, sitemapUrls, origin) {
    const scoreByRoot = new Map();
    const inputs = [startUrl]
      .concat(seedLinks || [])
      .concat(sitemapUrls || []);

    inputs.forEach((rawUrl) => {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) {
        return;
      }
      try {
        const u = new URL(normalized);
        if (origin && u.origin !== origin) {
          return;
        }
        const segments = splitPathSegments(u.pathname).map((item) => item.toLowerCase());
        if (segments.length < 2) {
          return;
        }
        const root = segments[0];
        if (!root || GENERIC_ROOT_SEGMENTS.has(root)) {
          return;
        }
        scoreByRoot.set(root, (scoreByRoot.get(root) || 0) + 1);
      } catch (_) {
        // ignore invalid url
      }
    });

    if (!scoreByRoot.size) {
      const startRoot = getFirstPathSegment(startUrl);
      return startRoot && !GENERIC_ROOT_SEGMENTS.has(startRoot) ? [startRoot] : [];
    }

    let maxScore = 0;
    scoreByRoot.forEach((score) => {
      if (score > maxScore) {
        maxScore = score;
      }
    });

    const roots = Array.from(scoreByRoot.entries())
      .sort((a, b) => b[1] - a[1])
      .map((entry) => entry[0]);
    const picked = roots.filter((root) => (scoreByRoot.get(root) || 0) >= Math.max(2, Math.ceil(maxScore * 0.5)));
    if (picked.length) {
      return picked;
    }
    return roots.slice(0, 1);
  }

  function matchesDocRootPrefix(url, rootPrefixes) {
    if (!rootPrefixes || !rootPrefixes.size) {
      return true;
    }
    const root = getFirstPathSegment(url);
    return rootPrefixes.has(root);
  }

  function isLikelyDocUrlByStructure(url) {
    try {
      const u = new URL(url);
      const segments = splitPathSegments(u.pathname).map((item) => item.toLowerCase());
      if (!segments.length) {
        return false;
      }

      const first = segments[0];
      const leaf = segments[segments.length - 1];
      const blockedSingle = new Set([
        'home',
        'about',
        'contact',
        'privacy',
        'terms',
        'cookies',
        'rss',
        'sitemap',
        'search',
        'login',
        'signup',
        'register'
      ]);
      const blockedRoots = new Set(['category', 'categories', 'tag', 'tags', 'author', 'authors']);

      if (blockedRoots.has(first)) {
        return false;
      }
      if (segments.length === 1 && blockedSingle.has(leaf)) {
        return false;
      }
      if (segments.includes('page')) {
        for (let i = 0; i < segments.length - 1; i += 1) {
          if (segments[i] === 'page' && /^\d+$/.test(segments[i + 1])) {
            return false;
          }
        }
      }
      if (leaf === 'feed' || leaf === 'rss') {
        return false;
      }
      if (segments.length >= 2) {
        return true;
      }
      return leaf.includes('-') && leaf.length >= 12;
    } catch (_) {
      return false;
    }
  }

  function shouldExpandLinksFromPage(url, options) {
    const opts = options || {};
    if (opts.followLinksInsideArticle === true) {
      return true;
    }
    return !isLikelyDocUrlByStructure(url);
  }

  function normalizeInlineText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractNodeText(node) {
    if (!node) {
      return '';
    }
    if (typeof node.cloneNode === 'function' && typeof node.querySelectorAll === 'function') {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('rt').forEach((el) => el.remove());
      return normalizeInlineText(clone.textContent || '');
    }
    return normalizeInlineText(node.textContent || '');
  }

  function extractAnchorTitle(anchor) {
    if (!anchor) {
      return '';
    }
    if (typeof anchor.querySelector === 'function') {
      const selectors = ['[data-docs-md-title]', '.text', '.link-text', 'p', 'span'];
      for (const selector of selectors) {
        const node = anchor.querySelector(selector);
        const text = extractNodeText(node);
        if (text) {
          return text;
        }
      }
    }
    return extractNodeText(anchor);
  }

  function parseLinkEntriesFromDocument(doc, baseUrl, options) {
    const opts = options || {};
    const preferContentScopes = opts.preferContentScopes !== false;
    const skipFooterLinks = opts.skipFooterLinks !== false;
    const footerSelector = 'footer,[role="contentinfo"],#footer,.footer,.site-footer,[id*="footer" i],[class*="footer" i]';
    const entries = [];
    const unique = new Set();
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return entries;
    }

    const scopes = getLinkScopeNodes(doc, preferContentScopes);
    scopes.forEach((scope) => {
      scope.querySelectorAll('a[href]').forEach((a) => {
        if (skipFooterLinks && isNavigationLikeAnchor(a, footerSelector)) {
          return;
        }
        const raw = a.getAttribute('href');
        if (!raw) return;
        const absolute = resolveHrefForCrawl(raw, baseUrl);
        if (!absolute) {
          return;
        }
        const normalized = normalizeUrl(absolute) || absolute;
        if (unique.has(normalized)) {
          return;
        }
        unique.add(normalized);
        entries.push({
          url: normalized,
          title: getDisplayTitle(normalized, extractAnchorTitle(a))
        });
      });
    });
    return entries;
  }

  function parseLinksFromDocument(doc, baseUrl, options) {
    return parseLinkEntriesFromDocument(doc, baseUrl, options).map((item) => item.url);
  }

  function parseNavigationEntriesFromDocument(doc, baseUrl, options) {
    const opts = options || {};
    const skipHeaderLinks = opts.skipHeaderLinks !== false;
    const skipFooterLinks = opts.skipFooterLinks !== false;
    const headerSelector = 'header,[role="banner"],.site-header,.top-nav';
    const footerSelector = 'footer,[role="contentinfo"],#footer,.footer,.site-footer,[id*="footer" i],[class*="footer" i]';
    const entries = [];
    const unique = new Set();

    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return entries;
    }

    const scopes = getNavigationScopeNodes(doc);
    scopes.forEach((scope) => {
      scope.querySelectorAll('a[href]').forEach((a) => {
        if (!a) {
          return;
        }
        if (skipHeaderLinks && typeof a.closest === 'function' && a.closest(headerSelector)) {
          return;
        }
        if (skipFooterLinks && typeof a.closest === 'function' && a.closest(footerSelector)) {
          return;
        }
        const raw = a.getAttribute('href');
        if (!raw) {
          return;
        }
        const absolute = resolveHrefForCrawl(raw, baseUrl);
        if (!absolute) {
          return;
        }
        const normalized = normalizeUrl(absolute) || absolute;
        if (unique.has(normalized)) {
          return;
        }
        unique.add(normalized);
        entries.push({
          url: normalized,
          title: getDisplayTitle(normalized, extractAnchorTitle(a))
        });
      });
    });

    return entries;
  }

  function parseNavigationLinksFromDocument(doc, baseUrl, options) {
    return parseNavigationEntriesFromDocument(doc, baseUrl, options).map((item) => item.url);
  }

  function parseCategoryLinksFromDocument(doc, baseUrl, options) {
    const opts = options || {};
    const excludePatterns = Array.isArray(opts.excludePatterns) ? opts.excludePatterns : [];
    const docsRootPath = normalizeRootPath(opts.docsRootPath || getDocRootPathFromUrl(baseUrl));
    const links = [];
    const unique = new Set();

    let baseOrigin = '';
    let normalizedBase = '';
    try {
      baseOrigin = new URL(baseUrl).origin;
      normalizedBase = normalizeUrl(baseUrl);
    } catch (_) {
      return links;
    }

    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return links;
    }

    const scopes = getCategoryScopeNodes(doc);
    scopes.forEach((scope) => {
      scope.querySelectorAll('a[href]').forEach((a) => {
        if (!a) {
          return;
        }
        const raw = a.getAttribute('href');
        if (!raw) {
          return;
        }

        const absolute = resolveHrefForCrawl(raw, baseUrl);
        if (!absolute) {
          return;
        }

        const normalized = normalizeUrl(absolute);
        if (!normalized || normalized === normalizedBase) {
          return;
        }
        if (!isDocUrl(normalized, baseOrigin, baseUrl, excludePatterns)) {
          return;
        }

        try {
          const pathname = new URL(normalized).pathname;
          if (docsRootPath !== '/' && !pathStartsWithRoot(pathname, docsRootPath)) {
            return;
          }
        } catch (_) {
          return;
        }

        if (unique.has(normalized)) {
          return;
        }
        unique.add(normalized);
        links.push(normalized);
      });
    });

    return links;
  }

  function collectVisibleLinksFromCurrentPage(baseUrl) {
    if (typeof document === 'undefined') {
      return [];
    }
    return parseLinksFromDocument(document, baseUrl);
  }

  function collectVisibleEntriesFromCurrentPage(baseUrl) {
    if (typeof document === 'undefined') {
      return [];
    }
    return parseLinkEntriesFromDocument(document, baseUrl);
  }

  function collectNavigationLinksFromCurrentPage(baseUrl) {
    if (typeof document === 'undefined') {
      return [];
    }
    return parseNavigationLinksFromDocument(document, baseUrl);
  }

  function collectNavigationEntriesFromCurrentPage(baseUrl) {
    if (typeof document === 'undefined') {
      return [];
    }
    return parseNavigationEntriesFromDocument(document, baseUrl);
  }

  function collectCategoryLinksFromCurrentPage(baseUrl, options) {
    if (typeof document === 'undefined') {
      return [];
    }
    return parseCategoryLinksFromDocument(document, baseUrl, options);
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
      '.docs-md-inline-field{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}',
      '.docs-md-inline-field .docs-md-label{margin:0;white-space:nowrap}',
      '.docs-md-inline-field .docs-md-image-select{margin-left:auto}',
      '.docs-md-label{font-size:12px;color:hsl(var(--muted-foreground));font-weight:600}',
      '.docs-md-image-select{appearance:none;-webkit-appearance:none;min-width:148px;height:34px;padding:0 28px 0 10px;border:1px solid hsl(var(--input));border-radius:10px;background:hsl(var(--background));color:hsl(var(--foreground));font-size:12px;font-weight:600;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,hsl(var(--muted-foreground)) 50%),linear-gradient(135deg,hsl(var(--muted-foreground)) 50%,transparent 50%);background-position:calc(100% - 13px) 14px,calc(100% - 8px) 14px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}',
      '.docs-md-image-select:focus,.docs-md-image-select:focus-visible{outline:none;border-color:hsl(var(--input));box-shadow:none}',
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
      '.docs-md-btn-stateful{position:relative;display:inline-flex;align-items:center;justify-content:center;overflow:hidden}',
      '.docs-md-btn-label{display:inline-flex;align-items:center;justify-content:center;transition:transform .2s ease,opacity .2s ease}',
      '.docs-md-btn-stateful::before,.docs-md-btn-stateful::after{position:absolute;left:10px;top:50%;transform:translateY(-50%) scale(0);opacity:0;pointer-events:none}',
      '.docs-md-btn-stateful::before{content:"";width:14px;height:14px;border-radius:999px;border:2px solid currentColor;border-right-color:transparent}',
      '.docs-md-btn-stateful::after{content:"✓";font-size:12px;font-weight:900;line-height:1;color:currentColor}',
      '.docs-md-btn-scan.is-scanning::before,.docs-md-btn-export.is-exporting::before{opacity:.95;transform:translateY(-50%) scale(1);animation:docs-md-btn-spin .75s linear infinite}',
      '.docs-md-btn-scan.is-scanning .docs-md-btn-label,.docs-md-btn-export.is-exporting .docs-md-btn-label{transform:translateX(8px)}',
      '.docs-md-btn-scan.is-done::after,.docs-md-btn-export.is-done::after{opacity:1;transform:translateY(-50%) scale(1);animation:docs-md-btn-check-pop .42s ease}',
      '.docs-md-btn-scan.is-done .docs-md-btn-label,.docs-md-btn-export.is-done .docs-md-btn-label{transform:translateX(8px)}',
      '@keyframes docs-md-btn-spin{to{transform:translateY(-50%) scale(1) rotate(360deg)}}',
      '@keyframes docs-md-btn-check-pop{0%{opacity:0;transform:translateY(-50%) scale(.35)}65%{opacity:1;transform:translateY(-50%) scale(1.12)}100%{opacity:1;transform:translateY(-50%) scale(1)}}',
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
      '#docs-md-usage{font-size:11px;color:hsl(var(--muted-foreground));line-height:1.5;word-break:break-word}',
      '.docs-md-fail-link{appearance:none;border:0;background:transparent;padding:0;font:inherit;color:hsl(var(--destructive));text-decoration-line:underline;text-decoration-style:dashed;text-decoration-thickness:1px;text-underline-offset:2px;cursor:pointer}',
      '.docs-md-fail-link:hover{color:hsl(var(--destructive) / .86)}',
      '.docs-md-fail-link:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:2px;border-radius:3px}',
      '#docs-md-failed-wrap{display:none;padding:8px 10px}',
      '#docs-md-failed-wrap.open{display:block}',
      '#docs-md-tree{max-height:260px;overflow:auto;padding:6px 10px}',
      '.docs-md-item{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px dashed hsl(var(--border))}',
      '.docs-md-item:last-child{border-bottom:0}',
      '.docs-md-group-row{padding:8px 0;align-items:center;justify-content:space-between;gap:10px}',
      '.docs-md-group-separator{border-top:1px solid hsl(var(--border));margin-top:6px;padding-top:10px}',
      '.docs-md-tree-toggle{display:flex;align-items:center;gap:8px;border:0;background:transparent;padding:0;cursor:pointer;color:inherit;font:inherit;min-width:0;flex:1}',
      '.docs-md-toggle-caret{display:inline-flex;align-items:center;justify-content:center;width:14px;min-width:14px;color:hsl(var(--muted-foreground));font-size:12px}',
      '.docs-md-square-check{appearance:none;-webkit-appearance:none;margin-top:0;width:16px;height:16px;border-radius:5px;border:1.5px solid hsl(var(--border));background:hsl(var(--background));display:inline-grid;place-items:center;cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease;flex-shrink:0}',
      '.docs-md-square-check::before{content:"";width:7px;height:4px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg) scale(0);transform-origin:center;transition:transform .16s ease}',
      '.docs-md-square-check:checked{border-color:hsl(0 0% 0%);background:hsl(0 0% 0%);box-shadow:0 4px 10px -6px rgba(0,0,0,.55)}',
      '.docs-md-square-check:checked::before{transform:rotate(-45deg) scale(1)}',
      '.docs-md-square-check:indeterminate{border-color:hsl(0 0% 0%);background:hsl(0 0% 0%);box-shadow:0 4px 10px -6px rgba(0,0,0,.55)}',
      '.docs-md-square-check:indeterminate::before{width:8px;height:2px;border:0;border-radius:999px;background:#fff;transform:scale(1)}',
      '.docs-md-square-check:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}',
      '.docs-md-square-check:focus-visible{outline:2px solid hsl(var(--ring));outline-offset:1px}',
      '.docs-md-group-check{margin-top:0}',
      '.docs-md-item-content{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.docs-md-item-title{font-weight:600;word-break:break-word;color:hsl(var(--foreground))}',
      '.docs-md-item-reason{font-size:11px;color:hsl(var(--muted-foreground));word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}',
      '.docs-md-item-group{display:inline-flex;align-items:center;font-size:12px;font-weight:600;color:hsl(var(--foreground))}',
      '.docs-md-retry{min-height:28px;padding:0 10px}',
      '.docs-md-hidden{display:none !important}',
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
      '  </div>',
      '  <button id="docs-md-close" type="button" aria-label="关闭面板">×</button>',
      '</div>',
      '<div id="docs-md-body">',
      '  <div class="docs-md-field docs-md-inline-field">',
      '    <label class="docs-md-label" for="docs-md-image-mode">图片模式</label>',
      '    <select id="docs-md-image-mode" class="docs-md-image-select">',
      '      <option value="external">外链插入</option>',
      '      <option value="local">本地下载</option>',
      '      <option value="none">不导出</option>',
      '    </select>',
      '  </div>',
      '  <div id="docs-md-actions">',
      '    <button id="docs-md-scan" type="button" class="docs-md-btn docs-md-btn-primary docs-md-btn-scan docs-md-btn-stateful"><span class="docs-md-btn-label">扫描目录</span></button>',
      '    <button id="docs-md-export" type="button" class="docs-md-btn docs-md-btn-secondary docs-md-btn-export docs-md-btn-stateful" data-progress="0%"><span class="docs-md-btn-label">导出 ZIP</span></button>',
      '    <button id="docs-md-stop" type="button" class="docs-md-btn docs-md-btn-destructive">停止</button>',
      '  </div>',
      '  <div id="docs-md-status" class="docs-md-surface">',
      '    <div id="docs-md-status-text" aria-live="polite">等待手动扫描</div>',
      '    <button id="docs-md-fail-toggle" type="button" class="docs-md-btn docs-md-btn-outline" disabled>失败: 0</button>',
      '  </div>',
      '  <div id="docs-md-failed-wrap" class="docs-md-surface"><div id="docs-md-failed-tree">暂无失败项</div></div>',
      '  <div id="docs-md-export-progress" class="docs-md-surface">',
      '    <div id="docs-md-progress-bar"><div id="docs-md-progress-fill"></div></div>',
      '    <div id="docs-md-progress-text">导出进度: 0%</div>',
      '    <div id="docs-md-usage"></div>',
      '  </div>',
      '  <label id="docs-md-check-all-wrap" class="docs-md-check-row docs-md-hidden"><input id="docs-md-check-all" type="checkbox" class="docs-md-square-check docs-md-group-check" checked>全选</label>',
      '  <div id="docs-md-tree" class="docs-md-surface docs-md-hidden"></div>',
      '</div>'
    ].join('');
  }

  if (env.isNode) {
    return {
      normalizeUrl,
      parseLinksFromDocument,
      parseLinkEntriesFromDocument,
      parseNavigationLinksFromDocument,
      parseNavigationEntriesFromDocument,
      parseCategoryLinksFromDocument,
      deriveCategoryPathPrefixes,
      matchesAnyPathPrefix,
      inferDocRootPrefixes,
      inferDocsRootPath,
      isLikelyDocUrlByStructure,
      matchesDocRootPrefix,
      shouldExpandLinksFromPage,
      isDocUrl,
      resolveHrefForCrawl,
      buildMarkdownPath,
      buildZipFilename,
      getDisplayTitle,
      buildTreeItems,
      buildFailedQueueItems,
      computeSelectAllState,
      computeGroupSelectionState,
      computeStageProgress,
      buildStageProgressText,
      resolveProgressFillPercent,
      computeZipPackProgress,
      normalizeImageMode,
      formatUsageStats,
      buildUsageStatsMarkup,
      computeStopControlState,
      formatFailureReason,
      runWithConcurrency,
      createHostRequestLimiter,
      shouldRetryRequestError,
      shouldUseSitemapForDiscovery,
      normalizeBinaryPayload,
      generateZipBlobWithFallback,
      buildStoreZipBlob,
      playDownloadCompleteSound,
      triggerZipDownloadByUrl,
      createTrustedHtmlPolicy,
      toTrustedHtml,
      parseHtmlDocument,
      shouldRecordScanFailure,
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
    pauseRequested: false,
    paused: false,
    pauseResolvers: [],
    discoveredUrls: [],
    selectedUrls: new Set(),
    collapsedGroups: new Set(),
    failed: [],
    foundCount: 0,
    doneCount: 0,
    failCount: 0,
    queueCount: 0,
    currentUrl: '',
    scanStartUrl: '',
    failedSeq: 0,
    scanSuccessTimer: 0,
    exportSuccessTimer: 0,
    downloadObjectUrl: '',
    elements: {},
    scanSession: 0,
    scanHtmlCache: new Map()
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
    const panelDoc = parseHtmlDocument(buildPanelMarkup(), { trustedPolicy: trustedHtmlPolicy });
    const panelBody = panelDoc && panelDoc.body ? panelDoc.body : null;
    if (!panelBody) {
      throw new Error('panel-markup-parse-failed');
    }
    const panelFragment = document.createDocumentFragment();
    Array.from(panelBody.childNodes).forEach((node) => {
      panelFragment.appendChild(document.importNode(node, true));
    });
    panel.appendChild(panelFragment);

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
      checkAllWrap: panel.querySelector('#docs-md-check-all-wrap'),
      checkAll: panel.querySelector('#docs-md-check-all')
    };
    if (state.elements.imageModeSelect) {
      state.elements.imageModeSelect.value = normalizeImageMode(DEFAULTS.imageMode);
    }
    state.elements.scanBtnLabel = state.elements.scanBtn.querySelector('.docs-md-btn-label');
    state.elements.exportBtnLabel = state.elements.exportBtn.querySelector('.docs-md-btn-label');

    state.elements.fab.addEventListener('click', () => {
      panel.classList.toggle('open');
    });

    state.elements.closeBtn.addEventListener('click', () => {
      panel.classList.remove('open');
    });

    state.elements.scanBtn.addEventListener('click', runScan);
    state.elements.exportBtn.addEventListener('click', runExport);
    state.elements.stopBtn.addEventListener('click', () => {
      if (state.paused) {
        resumeCurrentTask();
      } else {
        requestPauseCurrentTask();
      }
    });

    state.elements.checkAll.addEventListener('change', () => {
      const checked = state.elements.checkAll.checked;
      if (checked) {
        state.selectedUrls = new Set(state.discoveredUrls.map((item) => item.url));
      } else {
        state.selectedUrls.clear();
      }
      renderTree(state.discoveredUrls);
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

    state.elements.usageText.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains('docs-md-fail-link')) {
        return;
      }
      if (state.failCount <= 0) {
        return;
      }
      setFailedWrapVisible(true);
      renderFailedQueue();
    });

    updateFailToggle();
    renderFailedQueue();
    clearDiagnosticLogs();
    setSelectAllVisible(false);
    setTreeVisible(false);
    setExportButtonBusy(false);
    setStopButtonState();
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

  function clearElementChildren(element) {
    if (!element) {
      return;
    }
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function renderFailedQueue() {
    if (!state.elements.failedTree) {
      return;
    }
    const tree = state.elements.failedTree;
    clearElementChildren(tree);
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

      const reasonSpan = document.createElement('span');
      reasonSpan.className = 'docs-md-item-reason';
      reasonSpan.textContent = item.reasonText;
      content.appendChild(reasonSpan);

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
        const doc = parseHtmlDocument(html, { trustedPolicy: trustedHtmlPolicy });
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
            state.selectedUrls.add(normalized);
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

  function syncSelectAllState() {
    const total = state.discoveredUrls.length;
    const selected = state.selectedUrls.size;
    const status = computeSelectAllState(total, selected);
    state.elements.checkAll.checked = status.checked;
    state.elements.checkAll.indeterminate = status.indeterminate;
  }

  function setSelectAllVisible(visible) {
    if (!state.elements.checkAllWrap) {
      return;
    }
    state.elements.checkAllWrap.classList.toggle('docs-md-hidden', !visible);
  }

  function setTreeVisible(visible) {
    if (!state.elements.tree) {
      return;
    }
    state.elements.tree.classList.toggle('docs-md-hidden', !visible);
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

  function setExportProgress(stageLabel, completed, total, overallPercent) {
    const fillPercent = resolveProgressFillPercent(stageLabel, completed, total, overallPercent);
    state.elements.progressFill.style.width = fillPercent + '%';
    state.elements.progressText.textContent = buildStageProgressText(stageLabel, completed, total);
  }

  function setScanButtonBusy(scanning) {
    if (!state.elements.scanBtn) {
      return;
    }
    const busy = Boolean(scanning);
    state.elements.scanBtn.classList.toggle('is-scanning', busy);
    state.elements.scanBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (busy) {
      state.elements.scanBtn.classList.remove('is-done');
      if (state.scanSuccessTimer) {
        clearTimeout(state.scanSuccessTimer);
        state.scanSuccessTimer = 0;
      }
    }
  }

  function setExportButtonProgress(percent) {
    if (!state.elements.exportBtn) {
      return;
    }
    const bounded = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
    const progressText = bounded + '%';
    state.elements.exportBtn.dataset.progress = progressText;
    if (state.elements.exportBtnLabel) {
      state.elements.exportBtnLabel.textContent = '已导出' + progressText;
    } else {
      state.elements.exportBtn.textContent = '已导出' + progressText;
    }
  }

  function setExportButtonBusy(exporting) {
    if (!state.elements.exportBtn) {
      return;
    }
    const busy = Boolean(exporting);
    state.elements.exportBtn.classList.toggle('is-exporting', busy);
    state.elements.exportBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    state.elements.exportBtn.disabled = busy;
    if (busy) {
      state.elements.exportBtn.classList.remove('is-done');
      if (state.exportSuccessTimer) {
        clearTimeout(state.exportSuccessTimer);
        state.exportSuccessTimer = 0;
      }
    }
    if (busy) {
      setExportButtonProgress(0);
      return;
    }
    state.elements.exportBtn.dataset.progress = '0%';
    if (state.elements.exportBtnLabel) {
      state.elements.exportBtnLabel.textContent = EXPORT_BUTTON_IDLE_TEXT;
    } else {
      state.elements.exportBtn.textContent = EXPORT_BUTTON_IDLE_TEXT;
    }
  }

  function playStatefulButtonSuccess(buttonEl, timerKey) {
    if (!buttonEl || !timerKey) {
      return;
    }
    const currentTimer = state[timerKey];
    if (currentTimer) {
      clearTimeout(currentTimer);
      state[timerKey] = 0;
    }
    buttonEl.classList.add('is-done');
    state[timerKey] = setTimeout(() => {
      buttonEl.classList.remove('is-done');
      state[timerKey] = 0;
    }, 1400);
  }

  function flushPauseResolvers() {
    if (!state.pauseResolvers.length) {
      return;
    }
    const waiters = state.pauseResolvers.splice(0, state.pauseResolvers.length);
    waiters.forEach((resolve) => {
      try {
        resolve();
      } catch (_) {
        // ignore resolver failures
      }
    });
  }

  function setStopButtonState() {
    if (!state.elements.stopBtn) {
      return;
    }
    const control = computeStopControlState({
      scanning: state.scanning,
      exporting: state.exporting,
      pauseRequested: state.pauseRequested,
      paused: state.paused
    });
    state.elements.stopBtn.textContent = control.label;
    state.elements.stopBtn.disabled = control.disabled;
    state.elements.stopBtn.classList.toggle('docs-md-btn-secondary', control.mode === 'resume');
    state.elements.stopBtn.classList.toggle('docs-md-btn-destructive', control.mode !== 'resume');
  }

  function resetPauseState() {
    state.pauseRequested = false;
    state.paused = false;
    flushPauseResolvers();
    setStopButtonState();
  }

  function requestPauseCurrentTask() {
    if (!(state.scanning || state.exporting)) {
      setStopButtonState();
      return;
    }
    if (state.pauseRequested || state.paused) {
      return;
    }
    state.pauseRequested = true;
    setStopButtonState();
    setStatus('已请求停止，等待当前任务暂停...');
    addDiagnosticLog('CTRL', '已请求停止，等待当前任务暂停');
  }

  function resumeCurrentTask() {
    if (!state.paused) {
      return;
    }
    state.pauseRequested = false;
    state.paused = false;
    if (state.scanning) {
      setScanButtonBusy(true);
    }
    flushPauseResolvers();
    setStopButtonState();
    setStatus('继续当前任务...');
    addDiagnosticLog('CTRL', '继续当前任务');
  }

  async function waitIfPaused() {
    if (!state.pauseRequested && !state.paused) {
      return;
    }
    if (state.pauseRequested) {
      state.pauseRequested = false;
      state.paused = true;
      if (state.scanning) {
        setScanButtonBusy(false);
      }
      setStopButtonState();
      setStatus('任务已停止，点击“继续”恢复');
      addDiagnosticLog('CTRL', '任务已暂停，等待继续');
    }
    if (!state.paused) {
      return;
    }
    await new Promise((resolve) => {
      state.pauseResolvers.push(resolve);
    });
  }

  function computeOverallExportPercent(stageLabel, completed, total) {
    const stagePercent = computeStageProgress(completed, total).percent;
    const stageIndex = EXPORT_STAGE_SEQUENCE.indexOf(stageLabel);
    if (stageIndex < 0) {
      return stagePercent;
    }
    return Math.round(((stageIndex + stagePercent / 100) / EXPORT_STAGE_SEQUENCE.length) * 100);
  }

  function updateUsageText(stats) {
    if (!state.elements.usageText) {
      return;
    }
    const pageFetched = Number(stats.pageFetched) || 0;
    const pageConverted = Number(stats.pageConverted) || 0;
    const imagesDownloaded = Number(stats.imagesDownloaded) || 0;
    const failedCount = Math.max(0, Number(stats.failedCount) || 0);
    const elapsedMs = Number(stats.elapsedMs) || 0;

    clearElementChildren(state.elements.usageText);
    state.elements.usageText.appendChild(
      document.createTextNode(
        '任务: 页面抓取 ' + pageFetched + ' | 页面转换 ' + pageConverted + ' | 图片下载 ' + imagesDownloaded + ' | '
      )
    );

    if (failedCount > 0) {
      const failButton = document.createElement('button');
      failButton.type = 'button';
      failButton.className = 'docs-md-fail-link';
      failButton.textContent = '失败 ' + failedCount;
      state.elements.usageText.appendChild(failButton);
    } else {
      state.elements.usageText.appendChild(document.createTextNode('失败 0'));
    }

    state.elements.usageText.appendChild(
      document.createTextNode(' | 耗时 ' + formatDuration(elapsedMs))
    );
  }

  function clearDiagnosticLogs() {}

  function addDiagnosticLog() {}

  function releaseDownloadObjectUrl() {
    if (!state.downloadObjectUrl) {
      return;
    }
    try {
      URL.revokeObjectURL(state.downloadObjectUrl);
    } catch (_) {
      // ignore object URL release failures
    }
    state.downloadObjectUrl = '';
  }

  function resetDownloadLink() {
    releaseDownloadObjectUrl();
  }

  function prepareDownloadLink(blob) {
    if (!isBlobValue(blob)) {
      throw new Error('invalid-zip-blob');
    }
    releaseDownloadObjectUrl();
    const objectUrl = URL.createObjectURL(blob);
    state.downloadObjectUrl = objectUrl;
    return objectUrl;
  }

  function resetExportProgress() {
    setExportProgressVisible(false);
    if (state.elements.progressFill) {
      state.elements.progressFill.style.width = '0%';
    }
    if (state.elements.progressText) {
      state.elements.progressText.textContent = '导出进度: 0%';
    }
    if (state.elements.usageText) {
      state.elements.usageText.textContent = '';
    }
    resetDownloadLink();
  }

  function updateProgress(extra) {
    const lines = [
      '发现/队列: ' + state.foundCount + '/' + state.queueCount,
      extra || ''
    ].filter(Boolean);
    setStatus(lines.join('\n'));
  }

  function renderTree(items) {
    const tree = state.elements.tree;
    clearElementChildren(tree);
    setTreeVisible(true);

    if (!items.length) {
      setSelectAllVisible(false);
      tree.textContent = '未发现文档链接';
      return;
    }
    setSelectAllVisible(true);

    const treeItems = buildTreeItems(items, state.scanStartUrl || normalizeUrl(location.href) || location.href);
    const frag = document.createDocumentFragment();
    const separatedGroups = new Set();
    for (const item of treeItems) {
      if ((item.ancestors || []).some((key) => state.collapsedGroups.has(key))) {
        continue;
      }
      const row = document.createElement('div');
      row.className = 'docs-md-item';
      row.style.paddingLeft = (item.depth * 14) + 'px';
      if (item.ancestors && item.ancestors.length) {
        const directParentGroup = item.ancestors[item.ancestors.length - 1];
        if (!separatedGroups.has(directParentGroup)) {
          row.classList.add('docs-md-group-separator');
          separatedGroups.add(directParentGroup);
        }
      }

      if (item.type === 'group') {
        row.classList.add('docs-md-group-row');
        const expanded = !state.collapsedGroups.has(item.key);
        const groupState = computeGroupSelectionState(treeItems, item.key, state.selectedUrls);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'docs-md-tree-toggle';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');

        const caret = document.createElement('span');
        caret.className = 'docs-md-toggle-caret';
        caret.textContent = expanded ? '▾' : '▸';

        const group = document.createElement('span');
        group.className = 'docs-md-item-group';
        group.textContent = item.title;

        toggle.appendChild(caret);
        toggle.appendChild(group);
        toggle.addEventListener('click', () => {
          if (state.collapsedGroups.has(item.key)) {
            state.collapsedGroups.delete(item.key);
          } else {
            state.collapsedGroups.add(item.key);
          }
          renderTree(state.discoveredUrls);
        });

        const groupCheck = document.createElement('input');
        groupCheck.type = 'checkbox';
        groupCheck.className = 'docs-md-square-check docs-md-group-check';
        groupCheck.checked = groupState.checked;
        groupCheck.indeterminate = groupState.indeterminate;
        groupCheck.disabled = groupState.total <= 0;
        groupCheck.addEventListener('change', () => {
          groupState.descendants.forEach((url) => {
            if (groupCheck.checked) {
              state.selectedUrls.add(url);
            } else {
              state.selectedUrls.delete(url);
            }
          });
          renderTree(state.discoveredUrls);
          syncSelectAllState();
        });

        row.appendChild(toggle);
        row.appendChild(groupCheck);
      } else {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'docs-md-square-check';
        cb.checked = state.selectedUrls.has(item.url);
        cb.dataset.url = item.url;
        cb.addEventListener('change', () => {
          if (cb.checked) {
            state.selectedUrls.add(item.url);
          } else {
            state.selectedUrls.delete(item.url);
          }
          renderTree(state.discoveredUrls);
          syncSelectAllState();
        });

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

  async function fetchTextWithRetry(url, retries, delayMs, options) {
    const opts = options || {};
    const requestLimiter = opts.requestLimiter;
    const timeoutMs = Number(opts.timeoutMs) || DEFAULTS.timeoutMs;
    const maxRetries = Math.max(0, Math.floor(Number(retries) || 0));
    const backoffBaseMs = Math.max(0, Number(delayMs) || 0);
    let lastError = null;
    for (let i = 0; i <= maxRetries; i += 1) {
      try {
        if (requestLimiter && typeof requestLimiter.wait === 'function') {
          await requestLimiter.wait(url);
        }
        const resp = await gmRequest('GET', url, { timeoutMs });
        if (resp.status >= 200 && resp.status < 400) {
          return String(resp.responseText || '');
        }
        lastError = new Error('http-' + resp.status);
      } catch (err) {
        lastError = err;
      }
      if (i >= maxRetries || !shouldRetryRequestError(lastError)) {
        break;
      }
      if (backoffBaseMs > 0) {
        await sleep(backoffBaseMs * Math.pow(2, i));
      }
    }
    throw lastError || new Error('request-failed');
  }

  async function fetchBinaryWithRetry(url, retries, delayMs, options) {
    const opts = options || {};
    const requestLimiter = opts.requestLimiter;
    const timeoutMs = Number(opts.timeoutMs) || DEFAULTS.timeoutMs;
    const maxRetries = Math.max(0, Math.floor(Number(retries) || 0));
    const backoffBaseMs = Math.max(0, Number(delayMs) || 0);
    let lastError = null;
    for (let i = 0; i <= maxRetries; i += 1) {
      try {
        if (requestLimiter && typeof requestLimiter.wait === 'function') {
          await requestLimiter.wait(url);
        }
        const resp = await gmRequest('GET', url, {
          timeoutMs,
          responseType: 'arraybuffer'
        });
        if (resp.status >= 200 && resp.status < 400) {
          const payload = resp.response != null ? resp.response : resp.responseText;
          const normalized = await normalizeBinaryPayload(payload);
          if (normalized) {
            return normalized;
          }
          const type = Object.prototype.toString.call(payload);
          lastError = new Error('unsupported-binary:' + type);
          continue;
        }
        lastError = new Error('http-' + resp.status);
      } catch (err) {
        lastError = err;
      }
      if (i >= maxRetries || !shouldRetryRequestError(lastError)) {
        break;
      }
      if (backoffBaseMs > 0) {
        await sleep(backoffBaseMs * Math.pow(2, i));
      }
    }
    throw lastError || new Error('request-failed');
  }

  function shouldRecordScanFailure(error) {
    const message = String(error && error.message ? error.message : error || '').trim().toLowerCase();
    if (!message) {
      return true;
    }
    return !/^http-(404|410)\b/.test(message);
  }

  async function discoverSitemapUrls(origin, options) {
    const opts = options || {};
    const candidates = [new URL('/sitemap.xml', origin).href];
    try {
      const robots = await fetchTextWithRetry(new URL('/robots.txt', origin).href, 1, 400, {
        requestLimiter: opts.requestLimiter,
        timeoutMs: opts.timeoutMs
      });
      parseSitemapsFromRobots(robots, origin).forEach((url) => candidates.push(url));
    } catch (_) {
      // ignore robots parse failure
    }

    const queue = Array.from(new Set(candidates));
    const visited = new Set();
    const found = new Set();

    while (queue.length) {
      await waitIfPaused();
      const sitemapUrl = queue.shift();
      if (visited.has(sitemapUrl)) {
        continue;
      }
      visited.add(sitemapUrl);

      let xmlText;
      try {
        xmlText = await fetchTextWithRetry(sitemapUrl, 1, 500, {
          requestLimiter: opts.requestLimiter,
          timeoutMs: opts.timeoutMs
        });
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

  async function discoverUrls(options) {
    const origin = options.origin;
    const startUrl = normalizeUrl(options.startUrl || location.href);
    const maxDepth = options.maxDepth;
    const retries = Number.isFinite(Number(options.retries)) ? Number(options.retries) : DEFAULTS.retries;
    const requestDelayMs = Number.isFinite(Number(options.requestDelayMs))
      ? Number(options.requestDelayMs)
      : DEFAULTS.requestDelayMs;
    const timeoutMs = Number(options.timeoutMs) || DEFAULTS.timeoutMs;
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 1));
    const requestLimiter = options.requestLimiter || null;
    const htmlCache = options.htmlCache instanceof Map ? options.htmlCache : null;
    const excludePatterns = options.excludePatterns || [];
    const seedTitleEntries = Array.isArray(options.seedTitleEntries) ? options.seedTitleEntries : [];
    const seedLinks = Array.isArray(options.seedLinks) ? options.seedLinks : [];
    const navigationSeedLinks = Array.isArray(options.navigationSeedLinks) ? options.navigationSeedLinks : [];
    const categorySeedLinks = Array.isArray(options.categorySeedLinks) ? options.categorySeedLinks : [];
    const categoryPathPrefixes = Array.isArray(options.categoryPathPrefixes)
      ? options.categoryPathPrefixes.map((item) => normalizeRootPath(item)).filter(Boolean)
      : [];
    const docsRootPath = normalizeRootPath(options.docsRootPath || getDocRootPathFromUrl(startUrl));
    const directoryOnly = options.directoryOnly === true;
    const crawlDescendantsOnly = options.crawlDescendantsOnly !== false;
    const useSitemap = shouldUseSitemapForDiscovery({
      useSitemap: options.useSitemap,
      crawlDescendantsOnly,
      directoryOnly
    });
    const followLinksInsideArticle = options.followLinksInsideArticle === true;
    const useContentLinks = options.useContentLinks === true;
    const crawlByStructure = options.crawlByStructure === true;

    let sitemapUrls = [];
    if (useSitemap) {
      try {
        sitemapUrls = await discoverSitemapUrls(origin, {
          requestLimiter,
          timeoutMs
        });
      } catch (_) {
        sitemapUrls = [];
      }
    }

    if (sitemapUrls.length) {
      addDiagnosticLog('SCAN', 'Sitemap 候选: ' + sitemapUrls.length);
    }

    let docRootPrefixes = new Set();
    if (!crawlDescendantsOnly) {
      const inferredRoots = inferDocRootPrefixes(startUrl, seedLinks, sitemapUrls, origin);
      docRootPrefixes = new Set(inferredRoots);
      if (inferredRoots.length) {
        addDiagnosticLog('SCAN', 'URL 结构前缀: ' + inferredRoots.map((item) => '/' + item + '/').join(', '));
      }
    }

    const discovered = new Set();
    const titles = new Map();
    seedTitleEntries.forEach((item) => {
      if (!item || typeof item !== 'object') {
        return;
      }
      const normalized = normalizeUrl(item.url);
      const rawTitle = String(item.title || '').trim();
      if (!normalized || !rawTitle || titles.has(normalized)) {
        return;
      }
      titles.set(normalized, rawTitle);
    });
    const visited = new Set();
    const queued = new Set();
    const queue = [];
    const depthMap = new Map();

    function addUrl(maybeUrl, depth, source) {
      const normalized = normalizeUrl(maybeUrl);
      if (!normalized) return;
      if (!isDocUrl(normalized, origin, startUrl, excludePatterns)) return;
      if (docsRootPath !== '/') {
        try {
          const pathname = new URL(normalized).pathname;
          if (!pathStartsWithRoot(pathname, docsRootPath)) {
            return;
          }
        } catch (_) {
          return;
        }
      }
      if (source !== 'start' && categoryPathPrefixes.length && !matchesAnyPathPrefix(normalized, categoryPathPrefixes)) {
        return;
      }

      const isDocLike = isLikelyDocUrlByStructure(normalized);
      const matchesRoot = matchesDocRootPrefix(normalized, docRootPrefixes);
      const shouldCrawl = crawlDescendantsOnly ? true : (matchesRoot || isDocLike);
      if (!shouldCrawl) {
        return;
      }

      if (!queued.has(normalized)) {
        queued.add(normalized);
        queue.push(normalized);
        depthMap.set(normalized, depth);
      }

      if (crawlDescendantsOnly) {
        discovered.add(normalized);
      } else if (isDocLike && matchesRoot && !discovered.has(normalized)) {
        discovered.add(normalized);
      }

      state.foundCount = discovered.size;
      state.queueCount = queue.length;
      updateProgress();
    }

    addUrl(startUrl, 0, 'start');
    seedLinks.forEach((seedUrl) => addUrl(seedUrl, 1, 'seed'));
    navigationSeedLinks.forEach((navUrl) => addUrl(navUrl, 1, 'nav-seed'));
    categorySeedLinks.forEach((categoryUrl) => addUrl(categoryUrl, 1, 'category-seed'));
    if (useSitemap) {
      sitemapUrls.forEach((sitemapUrl) => addUrl(sitemapUrl, 1, 'sitemap'));
    }

    if (directoryOnly) {
      state.queueCount = 0;
      state.currentUrl = '';
      updateProgress();
      return Array.from(discovered).sort().map((url) => ({
        url,
        title: getDisplayTitle(url, titles.get(url) || '')
      }));
    }

    while (queue.length) {
      await waitIfPaused();
      const batchSize = Math.min(queue.length, concurrency);
      const batch = queue.splice(0, batchSize);
      state.queueCount = queue.length;
      updateProgress();

      await runWithConcurrency(batch, concurrency, async (current) => {
        await waitIfPaused();
        state.queueCount = queue.length;
        if (visited.has(current)) {
          updateProgress();
          return;
        }
        visited.add(current);

        const depth = depthMap.get(current) || 0;
        if (depth >= maxDepth) {
          updateProgress();
          return;
        }

        state.currentUrl = current;
        updateProgress();

        let html;
        try {
          html = await fetchTextWithRetry(current, retries, requestDelayMs, {
            requestLimiter,
            timeoutMs
          });
        } catch (err) {
          const reason = err && err.message ? err.message : 'failed';
          if (shouldRecordScanFailure(err)) {
            addFailed(current, 'discover:' + reason);
          } else {
            addDiagnosticLog('SCAN', '跳过不可达页面: ' + current + ' (' + reason + ')');
          }
          updateProgress();
          return;
        }

        if (htmlCache) {
          htmlCache.set(current, html);
        }

        try {
          const pageDoc = parseHtmlDocument(html, { trustedPolicy: trustedHtmlPolicy });
          titles.set(current, extractDocTitle(pageDoc, current));
        } catch (_) {
          // keep fallback title
        }

        const shouldExpand = shouldExpandLinksFromPage(current, {
          followLinksInsideArticle
        });

        const categoryLinks = parseCategoryLinksFromHtml(html, current, {
          docsRootPath,
          excludePatterns
        });
        for (const categoryLink of categoryLinks) {
          addUrl(categoryLink, depth + 1, 'category');
        }

        const navigationLinks = parseNavigationLinksFromHtml(html, current);
        for (const navLink of navigationLinks) {
          addUrl(navLink, depth + 1, 'nav');
        }

        const shouldExpandContent = useContentLinks && (crawlByStructure || shouldExpand);
        if (shouldExpandContent) {
          const links = parseLinksFromHtml(html, current);
          for (const link of links) {
            addUrl(link, depth + 1, 'crawl');
          }
        }
      });
    }

    return Array.from(discovered).sort().map((url) => ({
      url,
      title: getDisplayTitle(url, titles.get(url) || '')
    }));
  }

  function selectedUrlsFromTree() {
    if (!state.selectedUrls.size) {
      return [];
    }
    return state.discoveredUrls
      .map((item) => item.url)
      .filter((url) => state.selectedUrls.has(url));
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

      if (imageMode === 'none') {
        img.remove();
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
    const baseDocRootPath = getDocRootPathFromUrl(startUrl);
    const navigationEntries = collectNavigationEntriesFromCurrentPage(startUrl);
    const hasNavigationEntries = navigationEntries.length > 0;
    const fallbackVisibleEntries = hasNavigationEntries ? [] : collectVisibleEntriesFromCurrentPage(startUrl);
    const scanSeedEntries = hasNavigationEntries ? navigationEntries : fallbackVisibleEntries;
    const scanSeedLinks = scanSeedEntries.map((item) => item.url);
    const docsRootPath = hasNavigationEntries
      ? inferDocsRootPath(startUrl, scanSeedLinks, baseDocRootPath)
      : '/';
    const categoryPathPrefixes = hasNavigationEntries
      ? deriveCategoryPathPrefixes(startUrl, scanSeedLinks, docsRootPath)
      : [];
    state.scanStartUrl = startUrl;
    resetExportProgress();
    clearDiagnosticLogs();
    addDiagnosticLog('SCAN', '开始扫描，起始地址: ' + startUrl);
    addDiagnosticLog('SCAN', '文档根路径: ' + docsRootPath);
    addDiagnosticLog('SCAN', '链接来源: ' + (hasNavigationEntries ? '左侧目录' : '正文回退'));
    addDiagnosticLog('SCAN', (hasNavigationEntries ? '左侧目录链接: ' : '正文链接: ') + scanSeedLinks.length);
    if (!hasNavigationEntries) {
      addDiagnosticLog('WARN', '未检测到左侧目录，已回退正文链接采集');
    }
    addDiagnosticLog('SCAN', '分类路径前缀: ' + (categoryPathPrefixes.length ? categoryPathPrefixes.join(', ') : '(none)'));
    addDiagnosticLog('SCAN', '扫描策略: 快速目录扫描（仅发现 URL，不抓取页面内容）');

    state.scanning = true;
    resetPauseState();
    setScanButtonBusy(true);
    setStopButtonState();
    setSelectAllVisible(false);
    setTreeVisible(false);
    state.selectedUrls = new Set();
    state.collapsedGroups.clear();
    if (state.elements.tree) {
      state.elements.tree.textContent = '';
    }
    state.scanSession += 1;
    const mySession = state.scanSession;
    state.discoveredUrls = [];
    state.scanHtmlCache = new Map();
    state.failed = [];
    renderFailedQueue();
    updateFailToggle();
    state.foundCount = 0;
    state.doneCount = 0;
    state.failCount = 0;
    state.queueCount = 0;
    state.currentUrl = '';
    state.doneCount = 0;
    updateProgress('开始快速扫描目录...');
    let scanSucceeded = false;
    const requestLimiter = createHostRequestLimiter({
      minIntervalMs: DEFAULTS.minRequestIntervalMs
    });

    try {
      addDiagnosticLog(
        'SCAN',
        '抓取参数: 并发 ' + DEFAULTS.scanConcurrency +
        '，最小请求间隔 ' + DEFAULTS.minRequestIntervalMs + 'ms，重试 ' + DEFAULTS.retries
      );
      const urls = await discoverUrls({
        origin: location.origin,
        startUrl,
        maxDepth: DEFAULTS.maxDepth,
        excludePatterns: DEFAULT_EXCLUDES,
        seedTitleEntries: scanSeedEntries,
        seedLinks: scanSeedLinks,
        navigationSeedLinks: [],
        categorySeedLinks: scanSeedLinks,
        categoryPathPrefixes,
        docsRootPath,
        crawlDescendantsOnly: true,
        useSitemap: false,
        directoryOnly: true,
        followLinksInsideArticle: false,
        useContentLinks: false,
        crawlByStructure: false,
        concurrency: DEFAULTS.scanConcurrency,
        timeoutMs: DEFAULTS.timeoutMs,
        requestDelayMs: DEFAULTS.requestDelayMs,
        retries: DEFAULTS.retries,
        requestLimiter,
        htmlCache: state.scanHtmlCache
      });

      if (mySession !== state.scanSession) {
        return;
      }

      state.discoveredUrls = urls;
      state.selectedUrls = new Set(urls.map((item) => item.url));
      state.collapsedGroups.clear();
      renderTree(urls);
      state.queueCount = 0;
      state.currentUrl = '';
      updateProgress('目录扫描完成，可勾选后导出');
      addDiagnosticLog('SCAN', '扫描完成，发现页面: ' + urls.length + '，缓存页面: ' + state.scanHtmlCache.size);
      scanSucceeded = true;
    } catch (err) {
      renderTree(state.discoveredUrls);
      setStatus('扫描失败: ' + (err && err.message ? err.message : 'unknown'));
      addDiagnosticLog('ERROR', '扫描失败: ' + (err && err.message ? err.message : 'unknown'));
    } finally {
      state.scanning = false;
      setScanButtonBusy(false);
      if (scanSucceeded) {
        playStatefulButtonSuccess(state.elements.scanBtn, 'scanSuccessTimer');
      }
      addDiagnosticLog('SCAN', '扫描流程结束');
      resetPauseState();
    }
  }

  async function downloadImagesToZip(zip, imageJobs, onProgress, onSuccess, onAdded, options) {
    const opts = options || {};
    const concurrency = Math.max(1, Math.floor(Number(opts.concurrency) || DEFAULTS.imageConcurrency));
    const requestLimiter = opts.requestLimiter || null;
    const timeoutMs = Number(opts.timeoutMs) || DEFAULTS.timeoutMs;
    const uniqueJobs = [];
    const seen = new Set();
    for (const job of imageJobs) {
      if (!seen.has(job.path)) {
        seen.add(job.path);
        uniqueJobs.push(job);
      }
    }

    let completed = 0;
    await runWithConcurrency(uniqueJobs, concurrency, async (job) => {
      await waitIfPaused();
      try {
        const binary = await fetchBinaryWithRetry(job.url, DEFAULTS.retries, DEFAULTS.requestDelayMs, {
          requestLimiter,
          timeoutMs
        });
        zip.file(job.path, binary, { binary: true });
        if (typeof onAdded === 'function') {
          onAdded(job.path, binary);
        }
        if (typeof onSuccess === 'function') {
          onSuccess(binary.byteLength || binary.length || 0);
        }
      } catch (err) {
        addFailed(job.url, 'image-download-fail:' + (err && err.message ? err.message : 'failed'));
      }
      completed += 1;
      if (typeof onProgress === 'function') {
        onProgress(completed, uniqueJobs.length);
      }
    });
  }

  async function runExport() {
    if (state.exporting || state.scanning) {
      return;
    }

    const exportRootPath = '/';
    const imageMode = normalizeImageMode(
      state.elements.imageModeSelect
        ? state.elements.imageModeSelect.value
        : DEFAULTS.imageMode
    );
    let selected = selectedUrlsFromTree();

    if (!selected.length) {
      alert('请先扫描并勾选至少一个页面');
      return;
    }

    clearDiagnosticLogs();
    addDiagnosticLog('EXPORT', '开始导出，已选目录: ' + selected.length + '，图片模式: ' + imageMode);

    state.exporting = true;
    resetPauseState();
    setExportButtonBusy(true);
    setStopButtonState();
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

    let maxExportPercent = 0;
    const stageEntered = new Set();
    const stageCompleted = new Set();
    let zipProgressBucket = -1;

    function updateExportStage(stageLabel, completed, total) {
      const stageProgress = computeStageProgress(completed, total);
      if (!stageEntered.has(stageLabel)) {
        stageEntered.add(stageLabel);
        addDiagnosticLog('STAGE', '进入阶段: ' + stageLabel + ' (total=' + stageProgress.total + ')');
      }
      if (
        stageLabel === 'ZIP打包' &&
        stageProgress.total > 0
      ) {
        const bucket = Math.floor(stageProgress.percent / 20);
        if (bucket > zipProgressBucket) {
          zipProgressBucket = bucket;
          addDiagnosticLog('ZIP', '打包进度: ' + stageProgress.percent + '%');
        }
      }
      if (
        !stageCompleted.has(stageLabel) &&
        stageProgress.completed >= stageProgress.total
      ) {
        stageCompleted.add(stageLabel);
        addDiagnosticLog('STAGE', '阶段完成: ' + stageLabel);
      }
      const overallPercent = computeOverallExportPercent(stageLabel, completed, total);
      maxExportPercent = Math.max(maxExportPercent, overallPercent);
      setExportButtonProgress(maxExportPercent);
      setExportProgressVisible(true);
      setExportProgress(stageLabel, completed, total, maxExportPercent);
      refreshUsage();
    }

    const zip = new JSZip();
    const turndown = createTurndownService();
    const usedPaths = new Set();
    const pageDrafts = [];
    const zipEntries = [];
    let zipInputCount = 0;
    let zipInputTextBytes = 0;
    let zipInputBinaryBytes = 0;
    let exportSucceeded = false;
    const requestLimiter = createHostRequestLimiter({
      minIntervalMs: DEFAULTS.minRequestIntervalMs
    });
    const scanHtmlCache = state.scanHtmlCache instanceof Map ? state.scanHtmlCache : new Map();

    try {
      addDiagnosticLog(
        'EXPORT',
        '抓取参数: 页面并发 ' + DEFAULTS.exportFetchConcurrency +
        '，图片并发 ' + DEFAULTS.imageConcurrency +
        '，最小请求间隔 ' + DEFAULTS.minRequestIntervalMs + 'ms，重试 ' + DEFAULTS.retries
      );
      const exportStartUrl = state.scanStartUrl || normalizeUrl(location.href) || location.href;
      const exportDocsRootPath = getDocRootPathFromUrl(exportStartUrl);
      const exportCategoryPrefixes = deriveCategoryPathPrefixes(exportStartUrl, selected, exportDocsRootPath);
      selected = Array.from(new Set(selected.map((url) => normalizeUrl(url)).filter(Boolean)));
      addDiagnosticLog('EXPORT', '按左侧目录勾选导出，候选前缀: ' + exportCategoryPrefixes.join(', '));
      addDiagnosticLog('EXPORT', '待导出页面: ' + selected.length);
      updateProgress('开始抓取已勾选目录页面...');

      updateExportStage('页面抓取', 0, selected.length);
      const fetchedPages = new Array(selected.length);
      let fetchProcessed = 0;
      let cacheHits = 0;
      await runWithConcurrency(selected, DEFAULTS.exportFetchConcurrency, async (url, index) => {
        await waitIfPaused();

        const normalizedUrl = normalizeUrl(url) || url;
        state.currentUrl = normalizedUrl;
        try {
          let html;
          if (scanHtmlCache.has(normalizedUrl)) {
            html = String(scanHtmlCache.get(normalizedUrl) || '');
            cacheHits += 1;
          } else {
            html = await fetchTextWithRetry(normalizedUrl, DEFAULTS.retries, DEFAULTS.requestDelayMs, {
              requestLimiter,
              timeoutMs: DEFAULTS.timeoutMs
            });
            scanHtmlCache.set(normalizedUrl, html);
          }
          exportStats.pageFetched += 1;
          exportStats.htmlBytes += new TextEncoder().encode(html).length;
          const doc = parseHtmlDocument(html, { trustedPolicy: trustedHtmlPolicy });
          const title = extractDocTitle(doc, normalizedUrl);
          fetchedPages[index] = {
            url: normalizedUrl,
            doc,
            title
          };
        } catch (err) {
          const matched = state.discoveredUrls.find((item) => item.url === normalizedUrl);
          addFailed(normalizedUrl, 'page-fetch-fail:' + (err && err.message ? err.message : 'failed'), matched ? matched.title : '');
        } finally {
          fetchProcessed += 1;
          updateExportStage('页面抓取', fetchProcessed, selected.length);
        }
      });

      for (let i = 0; i < fetchedPages.length; i += 1) {
        const page = fetchedPages[i];
        if (!page) {
          continue;
        }
        const path = buildMarkdownPath(page.url, page.title, exportRootPath, usedPaths);
        pageDrafts.push({
          url: page.url,
          doc: page.doc,
          title: page.title,
          path
        });
      }
      addDiagnosticLog('EXPORT', '扫描缓存命中: ' + cacheHits + '/' + selected.length);

      const urlToFilePath = new Map();
      for (const page of pageDrafts) {
        urlToFilePath.set(normalizeUrl(page.url), page.path);
      }

      const imageRegistry = {
        byUrl: new Map(),
        usedPaths: new Set()
      };

      const imageJobs = [];
      let convertProcessed = 0;
      updateExportStage('Markdown转换', 0, pageDrafts.length);

      for (let i = 0; i < pageDrafts.length; i += 1) {
        await waitIfPaused();

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

        const markdownText = frontMatter + markdown + '\n';
        zip.file(page.path, markdownText);
        zipEntries.push({
          path: page.path,
          text: markdownText
        });
        zipInputCount += 1;
        zipInputTextBytes += new TextEncoder().encode(markdownText).length;
        state.doneCount += 1;
        exportStats.pageConverted += 1;
        convertProcessed += 1;
        updateExportStage('Markdown转换', convertProcessed, pageDrafts.length);
      }

      if (imageMode === 'local') {
        updateExportStage('图片下载', 0, imageJobs.length);
        if (imageJobs.length) {
          addDiagnosticLog('EXPORT', '本地图片下载任务: ' + imageJobs.length + '，并发 ' + DEFAULTS.imageConcurrency);
          await downloadImagesToZip(
            zip,
            imageJobs,
            (completed, total) => {
              exportStats.imagesDownloaded = completed;
              updateExportStage('图片下载', completed, total);
            },
            (bytes) => {
              exportStats.imageBytes += bytes;
            },
            (path, binary) => {
              const normalizedBinary = copyToUint8Array(binary);
              zipEntries.push({
                path,
                bytes: normalizedBinary
              });
              zipInputCount += 1;
              zipInputBinaryBytes += normalizedBinary.byteLength;
            },
            {
              concurrency: DEFAULTS.imageConcurrency,
              requestLimiter,
              timeoutMs: DEFAULTS.timeoutMs
            }
          );
        }
      } else {
        updateExportStage('图片下载', 0, 0);
      }

      if (state.failed.length) {
        const failText = state.failed
          .map((item) => item.url + ' | ' + item.reason)
          .join('\n');
        const failedText = failText + '\n';
        zip.file('failed-urls.txt', failedText);
        zipEntries.push({
          path: 'failed-urls.txt',
          text: failedText
        });
        zipInputCount += 1;
        zipInputTextBytes += new TextEncoder().encode(failedText).length;
      }

      updateExportStage('ZIP打包', 0, 100);
      addDiagnosticLog(
        'ZIP',
        '开始生成 ZIP（主通道 blob，超时 ' + DEFAULTS.zipPackTimeoutMs + 'ms）'
      );
      addDiagnosticLog(
        'ZIP',
        '输入统计: files=' + zipInputCount + ', text=' + formatBytes(zipInputTextBytes) + ', binary=' + formatBytes(zipInputBinaryBytes)
      );
      const zipPackStartedAt = Date.now();
      const zipHeartbeatTimer = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - zipPackStartedAt) / 1000);
        addDiagnosticLog('ZIP', '打包进行中，已耗时 ' + elapsedSec + 's');
      }, 10000);
      let zipPack = null;
      try {
        zipPack = await generateZipBlobWithFallback(zip, {
          timeoutMs: DEFAULTS.zipPackTimeoutMs,
          primaryType: 'blob',
          onProgress: (metadata) => {
            const progress = computeZipPackProgress(metadata);
            updateExportStage('ZIP打包', progress.completed, progress.total);
          }
        });
      } catch (packErr) {
        const packMessage = normalizeErrorMessage(packErr, 'zip-pack-error');
        if (packMessage !== 'zip-pack-timeout' && packMessage !== 'zip-pack-fallback-timeout') {
          throw packErr;
        }
        addDiagnosticLog('ZIP', 'JSZip 通道超时，尝试内置 STORE 回退打包');
        try {
          zipPack = {
            blob: buildStoreZipBlob(zipEntries),
            fallbackUsed: true,
            timeoutTriggered: true,
            primaryType: 'store-manual',
            fallbackType: 'store-manual',
            method: 'store_manual'
          };
          addDiagnosticLog('ZIP', '内置 STORE 回退打包完成');
        } catch (storeErr) {
          throw new Error('zip-store-fallback-failed:' + normalizeErrorMessage(storeErr, 'unknown'));
        }
      } finally {
        clearInterval(zipHeartbeatTimer);
      }
      if (zipPack.fallbackUsed) {
        if (zipPack.method === 'store_manual') {
          addDiagnosticLog('ZIP', '已切换内置 STORE 打包通道');
          setStatus('JSZip 打包超时，已切换内置兼容打包模式');
        } else {
          addDiagnosticLog(
            'ZIP',
            'blob 通道不兼容，已切换 uint8array 回退'
          );
          setStatus('ZIP 打包主通道不兼容，已自动切换兼容模式');
        }
      } else {
        addDiagnosticLog('ZIP', 'blob 通道生成完成');
      }
      const blob = zipPack.blob;
      updateExportStage('ZIP打包', 100, 100);
      const siteHints = [];
      if (typeof document !== 'undefined') {
        const metaSelectors = [
          'meta[property="og:site_name"]',
          'meta[name="application-name"]',
          'meta[name="apple-mobile-web-app-title"]'
        ];
        for (const selector of metaSelectors) {
          const metaEl = document.querySelector(selector);
          const content = metaEl ? metaEl.getAttribute('content') : '';
          if (content && String(content).trim()) {
            siteHints.push(content);
          }
        }
        if (document.title && String(document.title).trim()) {
          siteHints.push(document.title);
        }
      }
      const filename = buildZipFilename(
        siteHints,
        typeof location !== 'undefined' ? location.hostname : ''
      );

      const downloadUrl = prepareDownloadLink(blob);
      addDiagnosticLog('DOWNLOAD', '已准备下载链接: ' + filename);
      let autoDownloadResult = null;
      try {
        autoDownloadResult = await triggerZipDownloadByUrl(downloadUrl, filename, {
          blob,
          gmDownloadByUrl: typeof GM_download === 'function'
            ? (url, name) => gmDownloadByUrl(url, name, {
              gmDownloadFn: GM_download,
              timeoutMs: 12000,
              saveAs: false
            })
            : null,
          gmDownloadByBlob: typeof GM_download === 'function'
            ? (blobValue, name) => gmDownloadByBlobDataUrl(blobValue, name, {
              gmDownloadFn: GM_download,
              timeoutMs: 12000,
              saveAs: false
            })
            : null,
          anchorDownloadByUrl
        });
        addDiagnosticLog(
          'DOWNLOAD',
          '自动下载结果: ' + (autoDownloadResult ? autoDownloadResult.method : 'unknown')
        );
        if (autoDownloadResult) {
          playDownloadCompleteSound();
        }
      } catch (err) {
        addDiagnosticLog('ERROR', '自动下载失败: ' + normalizeErrorMessage(err, 'unknown'));
        setStatus('ZIP 已生成，但自动下载失败：' + normalizeErrorMessage(err, 'unknown'));
      }

      const methodSuffix = autoDownloadResult
        ? (autoDownloadResult.method === 'gm_download'
          ? '（Tampermonkey 下载）'
          : (autoDownloadResult.method === 'gm_download_dataurl'
            ? '（Tampermonkey data-url 回退）'
            : (autoDownloadResult.usedFallback ? '（自动回退浏览器下载）' : '（浏览器下载）')))
        : '（未触发自动下载）';
      updateProgress('导出完成: ' + state.doneCount + ' 页 ' + methodSuffix);
      exportSucceeded = true;
    } catch (err) {
      const errMessage = err && err.message ? err.message : 'unknown';
      if (errMessage === 'zip-pack-timeout') {
        setStatus('导出失败: ZIP 打包超时（主通道 blob）');
      } else if (errMessage === 'zip-pack-fallback-timeout') {
        setStatus('导出失败: ZIP 打包超时（回退通道 uint8array）');
      } else if (errMessage.startsWith('zip-store-fallback-failed:')) {
        setStatus('导出失败: 内置回退打包失败（' + errMessage.slice('zip-store-fallback-failed:'.length) + '）');
      } else {
        setStatus('导出失败: ' + errMessage);
      }
      addDiagnosticLog('ERROR', '导出失败: ' + errMessage);
    } finally {
      state.currentUrl = '';
      state.exporting = false;
      setExportButtonBusy(false);
      if (exportSucceeded) {
        playStatefulButtonSuccess(state.elements.exportBtn, 'exportSuccessTimer');
      }
      addDiagnosticLog('EXPORT', '导出流程结束' + (exportSucceeded ? '（成功）' : '（失败）'));
      resetPauseState();
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
