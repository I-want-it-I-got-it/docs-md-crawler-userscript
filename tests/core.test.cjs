const test = require('node:test');
const assert = require('node:assert/strict');

const crawler = require('../docs-md-crawler.user.js');

test('normalizeUrl strips hash and normalizes trailing slash', () => {
  assert.equal(
    crawler.normalizeUrl('https://example.com/docs/intro/#section'),
    'https://example.com/docs/intro'
  );
  assert.equal(
    crawler.normalizeUrl('https://example.com/docs/intro/'),
    'https://example.com/docs/intro'
  );
  assert.equal(crawler.normalizeUrl('https://example.com/'), 'https://example.com/');
});

test('isDocUrl keeps same-origin descendants under current page url', () => {
  const excludePatterns = ['/api/', '/login'];
  const baseUrl = 'https://example.com/docs/start';
  assert.equal(
    crawler.isDocUrl('https://example.com/docs/start', 'https://example.com', baseUrl, excludePatterns),
    true
  );
  assert.equal(
    crawler.isDocUrl('https://example.com/docs/start/child', 'https://example.com', baseUrl, excludePatterns),
    true
  );
  assert.equal(
    crawler.isDocUrl('https://example.com/docs/other', 'https://example.com', baseUrl, excludePatterns),
    false
  );
  assert.equal(
    crawler.isDocUrl('https://foo.com/docs/start', 'https://example.com', baseUrl, excludePatterns),
    false
  );
  assert.equal(
    crawler.isDocUrl('https://example.com/docs/start/api/users', 'https://example.com', baseUrl, excludePatterns),
    false
  );
});

test('buildMarkdownPath uses url segment + title and resolves collisions', () => {
  const used = new Set();
  const a = crawler.buildMarkdownPath('https://example.com/docs/guide/install', '安装指南', '/docs', used);
  assert.equal(a, 'docs/guide/install__安装指南.md');

  const b = crawler.buildMarkdownPath('https://example.com/docs/guide/install?ref=1', '安装指南', '/docs', used);
  assert.equal(b, 'docs/guide/install__安装指南-2.md');

  const c = crawler.buildMarkdownPath('https://example.com/docs/guide/', '快速开始', '/docs', used);
  assert.equal(c, 'docs/guide/index__快速开始.md');
});

test('getDisplayTitle prefers page title and falls back to url segment', () => {
  assert.equal(
    crawler.getDisplayTitle('https://example.com/docs/start/intro', 'Introduction'),
    'Introduction'
  );
  assert.equal(
    crawler.getDisplayTitle('https://example.com/docs/start/quick-start', ''),
    'quick-start'
  );
  assert.equal(
    crawler.getDisplayTitle('https://example.com/docs/start/', ''),
    'start'
  );
});

test('buildTreeItems creates grouped hierarchical entries', () => {
  const pages = [
    { url: 'https://example.com/docs/start', title: 'Start' },
    { url: 'https://example.com/docs/start/a', title: 'A' },
    { url: 'https://example.com/docs/start/a/one', title: 'One' },
    { url: 'https://example.com/docs/start/b/two', title: 'Two' }
  ];
  const entries = crawler.buildTreeItems(pages, 'https://example.com/docs/start');
  assert.deepEqual(
    entries.map((item) => ({
      type: item.type,
      title: item.title,
      depth: item.depth
    })),
    [
      { type: 'page', title: 'Start', depth: 0 },
      { type: 'page', title: 'A', depth: 0 },
      { type: 'group', title: 'a', depth: 0 },
      { type: 'page', title: 'One', depth: 1 },
      { type: 'group', title: 'b', depth: 0 },
      { type: 'page', title: 'Two', depth: 1 }
    ]
  );
});

test('buildTreeItems exposes stable group keys and page ancestors for toggle tree', () => {
  const pages = [
    { url: 'https://example.com/docs/start', title: 'Start' },
    { url: 'https://example.com/docs/start/a/nested/two', title: 'Two' }
  ];
  const entries = crawler.buildTreeItems(pages, 'https://example.com/docs/start');
  const nestedGroup = entries.find((item) => item.type === 'group' && item.title === 'nested');
  const nestedPage = entries.find((item) => item.type === 'page' && item.title === 'Two');
  assert.equal(nestedGroup.key, 'a/nested');
  assert.deepEqual(nestedPage.ancestors, ['a', 'a/nested']);
});

test('computeSelectAllState returns checked and indeterminate correctly', () => {
  assert.deepEqual(crawler.computeSelectAllState(0, 0), { checked: false, indeterminate: false });
  assert.deepEqual(crawler.computeSelectAllState(5, 0), { checked: false, indeterminate: false });
  assert.deepEqual(crawler.computeSelectAllState(5, 2), { checked: false, indeterminate: true });
  assert.deepEqual(crawler.computeSelectAllState(5, 5), { checked: true, indeterminate: false });
});

test('computeStageProgress calculates bounded stage percentage', () => {
  assert.deepEqual(crawler.computeStageProgress(0, 10), { completed: 0, total: 10, percent: 0 });
  assert.deepEqual(crawler.computeStageProgress(5, 10), { completed: 5, total: 10, percent: 50 });
  assert.deepEqual(crawler.computeStageProgress(12, 10), { completed: 10, total: 10, percent: 100 });
  assert.deepEqual(crawler.computeStageProgress(0, 0), { completed: 0, total: 0, percent: 100 });
});

test('computeZipPackProgress converts JSZip metadata percent to 0-100 stage progress', () => {
  assert.deepEqual(
    crawler.computeZipPackProgress({ percent: 0 }),
    { completed: 0, total: 100, percent: 0 }
  );
  assert.deepEqual(
    crawler.computeZipPackProgress({ percent: 12.4 }),
    { completed: 12, total: 100, percent: 12 }
  );
  assert.deepEqual(
    crawler.computeZipPackProgress({ percent: 99.6 }),
    { completed: 100, total: 100, percent: 100 }
  );
  assert.deepEqual(
    crawler.computeZipPackProgress({ percent: 130 }),
    { completed: 100, total: 100, percent: 100 }
  );
  assert.deepEqual(
    crawler.computeZipPackProgress({}),
    { completed: 0, total: 100, percent: 0 }
  );
});

test('generateZipBlobWithFallback switches to uint8array when blob generation stalls', async () => {
  const callTypes = [];
  const zip = {
    generateAsync(options) {
      callTypes.push(options.type);
      if (options.type === 'blob') {
        return new Promise(() => {});
      }
      return Promise.resolve(Uint8Array.from([80, 75, 3, 4]));
    }
  };

  const result = await crawler.generateZipBlobWithFallback(zip, { timeoutMs: 20 });
  assert.deepEqual(callTypes, ['blob', 'uint8array']);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.timeoutTriggered, true);
  assert.ok(result.blob instanceof Blob);
});

test('generateZipBlobWithFallback rejects when both blob and uint8array generation stall', async () => {
  const callTypes = [];
  const zip = {
    generateAsync(options) {
      callTypes.push(options.type);
      return new Promise(() => {});
    }
  };

  await assert.rejects(
    () => crawler.generateZipBlobWithFallback(zip, { timeoutMs: 20 }),
    /zip-pack-fallback-timeout/
  );
  assert.deepEqual(callTypes, ['blob', 'uint8array']);
});

test('triggerZipDownloadByUrl prefers GM download path when available', async () => {
  const calls = [];
  const result = await crawler.triggerZipDownloadByUrl('blob:zip-1', 'demo.zip', {
    gmDownloadByUrl: async (url, name) => {
      calls.push(['gm', url, name]);
    },
    anchorDownloadByUrl: async () => {
      calls.push(['anchor']);
    }
  });

  assert.deepEqual(calls, [['gm', 'blob:zip-1', 'demo.zip']]);
  assert.equal(result.method, 'gm_download');
  assert.equal(result.usedFallback, false);
});

test('triggerZipDownloadByUrl falls back to anchor when GM download fails', async () => {
  const calls = [];
  const result = await crawler.triggerZipDownloadByUrl('blob:zip-2', 'demo.zip', {
    gmDownloadByUrl: async () => {
      throw new Error('not_whitelisted');
    },
    anchorDownloadByUrl: async (url, name) => {
      calls.push(['anchor', url, name]);
    }
  });

  assert.deepEqual(calls, [['anchor', 'blob:zip-2', 'demo.zip']]);
  assert.equal(result.method, 'anchor');
  assert.equal(result.usedFallback, true);
  assert.equal(result.errorMessage, 'not_whitelisted');
});

test('triggerZipDownloadByUrl retries with blob downloader before anchor fallback', async () => {
  const calls = [];
  const fakeBlob = new Blob([Uint8Array.from([80, 75, 3, 4])], { type: 'application/zip' });
  const result = await crawler.triggerZipDownloadByUrl('blob:zip-3', 'demo.zip', {
    blob: fakeBlob,
    gmDownloadByUrl: async () => {
      calls.push(['gm-url']);
      throw new Error('blob-url-blocked');
    },
    gmDownloadByBlob: async (blob, name) => {
      calls.push(['gm-blob', blob.size, name]);
    },
    anchorDownloadByUrl: async (url, name) => {
      calls.push(['anchor', url, name]);
    }
  });

  assert.deepEqual(calls, [
    ['gm-url'],
    ['gm-blob', 4, 'demo.zip']
  ]);
  assert.equal(result.method, 'gm_download_dataurl');
  assert.equal(result.usedFallback, true);
  assert.equal(result.errorMessage, 'blob-url-blocked');
});

test('normalizeBinaryPayload converts binary-like values into Uint8Array for JSZip', async () => {
  const fromArrayBuffer = await crawler.normalizeBinaryPayload(Uint8Array.from([1, 2, 3]).buffer);
  assert.ok(fromArrayBuffer instanceof Uint8Array);
  assert.deepEqual(Array.from(fromArrayBuffer), [1, 2, 3]);

  const fromTypedArray = await crawler.normalizeBinaryPayload(new Uint16Array([255, 1024]));
  assert.ok(fromTypedArray instanceof Uint8Array);
  assert.deepEqual(Array.from(fromTypedArray), [255, 0, 0, 4]);

  const fromString = await crawler.normalizeBinaryPayload('\x00\xffA');
  assert.ok(fromString instanceof Uint8Array);
  assert.deepEqual(Array.from(fromString), [0, 255, 65]);

  const blob = new Blob([Uint8Array.from([7, 8, 9])], { type: 'application/octet-stream' });
  const fromBlob = await crawler.normalizeBinaryPayload(blob);
  assert.ok(fromBlob instanceof Uint8Array);
  assert.deepEqual(Array.from(fromBlob), [7, 8, 9]);
});

test('normalizeBinaryPayload returns null for unsupported payload types', async () => {
  const payload = await crawler.normalizeBinaryPayload({ any: 'value' });
  assert.equal(payload, null);
});

test('formatUsageStats renders export usage counters', () => {
  const text = crawler.formatUsageStats({
    htmlBytes: 2048,
    imageBytes: 1048576,
    pageFetched: 3,
    pageConverted: 2,
    imagesDownloaded: 8,
    failedCount: 1,
    elapsedMs: 6543
  });
  assert.doesNotMatch(text, /占用:/);
  assert.doesNotMatch(text, /HTML 2\.00 KB/);
  assert.doesNotMatch(text, /图片 1\.00 MB/);
  assert.match(text, /页面抓取 3/);
  assert.match(text, /页面转换 2/);
  assert.match(text, /图片下载 8/);
  assert.match(text, /失败 1/);
  assert.match(text, /耗时 6\.5s/);
});

test('buildFailedQueueItems renders title-only entries with fallback title', () => {
  const entries = crawler.buildFailedQueueItems([
    { id: 1, url: 'https://example.com/docs/start/alpha', reason: 'discover:timeout' },
    { id: 2, url: 'https://example.com/docs/start/beta', title: 'Beta 文档', reason: 'page-fetch-fail:500' }
  ]);
  assert.deepEqual(
    entries.map((item) => ({
      id: item.id,
      title: item.title,
      reason: item.reason
    })),
    [
      { id: 1, title: 'alpha', reason: 'discover:timeout' },
      { id: 2, title: 'Beta 文档', reason: 'page-fetch-fail:500' }
    ]
  );
});

test('buildUiStyles provides shadcn-style tokens and button variants', () => {
  const css = crawler.buildUiStyles();
  assert.match(css, /--background:/);
  assert.match(css, /--foreground:/);
  assert.match(css, /--card:/);
  assert.match(css, /\.docs-md-btn\{/);
  assert.match(css, /\.docs-md-btn-primary\{/);
  assert.match(css, /\.docs-md-btn-outline\{/);
  assert.match(css, /\.docs-md-surface\{/);
  assert.match(css, /\.docs-md-switch\{/);
  assert.match(css, /\.docs-md-fail-link\{/);
  assert.match(css, /text-decoration-style:dashed/);
  assert.match(css, /\.docs-md-square-check\{/);
  assert.match(css, /\.docs-md-square-check:checked::before/);
  assert.match(css, /\.docs-md-square-check:indeterminate::before/);
  assert.match(css, /\.docs-md-square-check:checked\{border-color:hsl\(0 0% 0%\);background:hsl\(0 0% 0%\)/);
  assert.match(css, /\.docs-md-square-check:indeterminate\{border-color:hsl\(0 0% 0%\);background:hsl\(0 0% 0%\)/);
  assert.match(css, /\.docs-md-group-separator\{/);
  assert.match(css, /\.docs-md-inline-field\{/);
  assert.match(css, /#docs-md-diag-wrap\{/);
  assert.match(css, /#docs-md-diag\{/);
  assert.match(css, /#docs-md-diag-clear\{/);
});

test('buildPanelMarkup keeps required ids and shadcn-style structure', () => {
  const html = crawler.buildPanelMarkup();
  assert.match(html, /id="docs-md-head"/);
  assert.match(html, /id="docs-md-image-mode"/);
  assert.match(html, /id="docs-md-image-mode" type="checkbox"/);
  assert.doesNotMatch(html, /<select id="docs-md-image-mode"/);
  assert.match(html, /class="docs-md-field docs-md-inline-field"/);
  assert.match(html, /id="docs-md-scan"/);
  assert.match(html, /id="docs-md-export"/);
  assert.match(html, /id="docs-md-stop"/);
  assert.match(html, /id="docs-md-status-text"/);
  assert.match(html, /id="docs-md-tree"/);
  assert.match(html, /docs-md-btn docs-md-btn-primary/);
  assert.match(html, /docs-md-btn docs-md-btn-outline/);
  assert.match(html, /docs-md-btn-export/);
  assert.match(html, /docs-md-surface/);
  assert.match(html, /id="docs-md-diag-wrap"/);
  assert.match(html, /id="docs-md-diag"/);
  assert.match(html, /id="docs-md-diag-clear"/);
  assert.match(html, /id="docs-md-check-all-wrap"/);
  assert.match(html, /docs-md-check-row docs-md-hidden/);
  assert.match(html, /id="docs-md-check-all" type="checkbox" class="docs-md-square-check docs-md-group-check" checked/);
  assert.match(html, /id="docs-md-tree" class="docs-md-surface docs-md-hidden"/);
});

test('buildPanelMarkup removes shadcn-inspired subtitle text', () => {
  const html = crawler.buildPanelMarkup();
  assert.doesNotMatch(html, /shadcn-inspired UI/);
});

test('buildUiStyles includes stateful scan button loading/success animation hooks', () => {
  const css = crawler.buildUiStyles();
  assert.match(css, /\.docs-md-btn-scan/);
  assert.match(css, /\.docs-md-btn-stateful/);
  assert.match(css, /\.docs-md-btn-scan\.is-scanning::before/);
  assert.match(css, /\.docs-md-btn-scan\.is-done::after/);
  assert.match(css, /@keyframes docs-md-btn-spin/);
  assert.match(css, /@keyframes docs-md-btn-check-pop/);
});

test('buildUiStyles includes stateful export button loading/success animation hooks', () => {
  const css = crawler.buildUiStyles();
  assert.match(css, /\.docs-md-btn-export/);
  assert.match(css, /\.docs-md-btn-export\.is-exporting::before/);
  assert.match(css, /\.docs-md-btn-export\.is-done::after/);
  assert.match(css, /\.docs-md-btn-export\.is-exporting \.docs-md-btn-label/);
  assert.match(css, /\.docs-md-tree-toggle/);
  assert.match(css, /\.docs-md-square-check/);
  assert.match(css, /\.docs-md-hidden\{display:none/);
});

test('buildUsageStatsMarkup wraps failed count with clickable dashed underline', () => {
  const html = crawler.buildUsageStatsMarkup({
    pageFetched: 12,
    pageConverted: 11,
    imagesDownloaded: 8,
    failedCount: 4,
    elapsedMs: 2480
  });
  assert.match(html, /class="docs-md-fail-link"/);
  assert.match(html, /失败 4/);
  assert.match(html, /页面抓取 12/);
  assert.match(html, /页面转换 11/);
});

test('buildUsageStatsMarkup keeps plain text when there are no failures', () => {
  const html = crawler.buildUsageStatsMarkup({
    pageFetched: 2,
    pageConverted: 2,
    imagesDownloaded: 0,
    failedCount: 0,
    elapsedMs: 1500
  });
  assert.doesNotMatch(html, /docs-md-fail-link/);
  assert.match(html, /失败 0/);
});

test('computeStopControlState switches stop control between stop/continue states', () => {
  assert.deepEqual(
    crawler.computeStopControlState({
      scanning: false,
      exporting: false,
      pauseRequested: false,
      paused: false
    }),
    { label: '停止', disabled: true, mode: 'idle' }
  );

  assert.deepEqual(
    crawler.computeStopControlState({
      scanning: true,
      exporting: false,
      pauseRequested: false,
      paused: false
    }),
    { label: '停止', disabled: false, mode: 'stop' }
  );

  assert.deepEqual(
    crawler.computeStopControlState({
      scanning: false,
      exporting: true,
      pauseRequested: true,
      paused: false
    }),
    { label: '停止', disabled: false, mode: 'stop' }
  );

  assert.deepEqual(
    crawler.computeStopControlState({
      scanning: false,
      exporting: true,
      pauseRequested: false,
      paused: true
    }),
    { label: '继续', disabled: false, mode: 'resume' }
  );
});

test('computeGroupSelectionState returns checked and indeterminate for group descendants', () => {
  const entries = crawler.buildTreeItems(
    [
      { url: 'https://example.com/docs/start', title: 'Start' },
      { url: 'https://example.com/docs/start/a/one', title: 'One' },
      { url: 'https://example.com/docs/start/a/two', title: 'Two' },
      { url: 'https://example.com/docs/start/b/three', title: 'Three' }
    ],
    'https://example.com/docs/start'
  );

  const none = crawler.computeGroupSelectionState(entries, 'a', new Set());
  assert.deepEqual(
    { checked: none.checked, indeterminate: none.indeterminate, total: none.total, selected: none.selected },
    { checked: false, indeterminate: false, total: 2, selected: 0 }
  );

  const partial = crawler.computeGroupSelectionState(
    entries,
    'a',
    new Set(['https://example.com/docs/start/a/one'])
  );
  assert.deepEqual(
    { checked: partial.checked, indeterminate: partial.indeterminate, total: partial.total, selected: partial.selected },
    { checked: false, indeterminate: true, total: 2, selected: 1 }
  );

  const all = crawler.computeGroupSelectionState(
    entries,
    'a',
    new Set([
      'https://example.com/docs/start/a/one',
      'https://example.com/docs/start/a/two'
    ])
  );
  assert.deepEqual(
    { checked: all.checked, indeterminate: all.indeterminate, total: all.total, selected: all.selected },
    { checked: true, indeterminate: false, total: 2, selected: 2 }
  );
});
