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
  assert.match(text, /HTML 2\.00 KB/);
  assert.match(text, /图片 1\.00 MB/);
  assert.match(text, /总计 1\.00 MB/);
  assert.match(text, /页面抓取 3/);
  assert.match(text, /页面转换 2/);
  assert.match(text, /图片下载 8/);
  assert.match(text, /失败 1/);
  assert.match(text, /耗时 6\.5s/);
});
