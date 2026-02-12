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
