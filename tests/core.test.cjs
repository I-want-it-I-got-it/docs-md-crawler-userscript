const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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

test('isDocUrl allows same-origin article links and still filters excluded/static URLs', () => {
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
    true
  );
  assert.equal(
    crawler.isDocUrl('https://foo.com/docs/start', 'https://example.com', baseUrl, excludePatterns),
    false
  );
  assert.equal(
    crawler.isDocUrl('https://example.com/docs/start/api/users', 'https://example.com', baseUrl, excludePatterns),
    false
  );
  assert.equal(
    crawler.isDocUrl('https://example.com/assets/logo.png', 'https://example.com', baseUrl, excludePatterns),
    false
  );
});

test('parseLinksFromDocument skips nav/footer links and keeps main scope links', () => {
  const mainAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/blog/a' : '';
      },
      textContent: 'Claude Agent Skills Complete Guide',
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/blog/footer-c' : '';
      },
      textContent: 'Contact',
      closest(selector) {
        if (selector === 'nav,[role="navigation"],header,[role="banner"],footer,[role="contentinfo"],aside,.menu,.navbar,.site-nav,.site-menu,.top-nav') {
          return { tagName: 'NAV' };
        }
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/categories/ai-agents' : '';
      },
      textContent: 'AI Agents',
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/blog/b' : '';
      },
      textContent: 'Ralph Wiggum AI Loop: The Viral Coding Technique',
      closest() {
        return null;
      }
    }
  ];
  const mainScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? mainAnchors : [];
    }
  };
  const mockDoc = {
    body: {
      querySelectorAll() {
        return [];
      }
    },
    querySelectorAll(selector) {
      if (selector === 'main') {
        return [mainScope];
      }
      return [];
    }
  };

  const links = crawler.parseLinksFromDocument(mockDoc, 'https://example.com/categories/ai-agents/');
  assert.deepEqual(links, [
    'https://example.com/blog/a',
    'https://example.com/categories/ai-agents',
    'https://example.com/blog/b'
  ]);
});

test('parseLinksFromDocument skips invalid hrefs and normalizes bare domains', () => {
  const mainAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/intro' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? 'javascript:void(0)' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? 'mailto:dev@example.com' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? 'chat`' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? 'openai.com' : '';
      },
      closest() {
        return null;
      }
    }
  ];

  const mainScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? mainAnchors : [];
    }
  };
  const mockDoc = {
    body: {
      querySelectorAll() {
        return [];
      }
    },
    querySelectorAll(selector) {
      if (selector === 'main') {
        return [mainScope];
      }
      return [];
    }
  };

  const links = crawler.parseLinksFromDocument(mockDoc, 'https://example.com/docs/start');
  assert.deepEqual(links, [
    'https://example.com/docs/intro',
    'https://openai.com/'
  ]);
});

test('parseNavigationLinksFromDocument collects sidebar category links and skips header/footer noise', () => {
  const navAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/getting-started' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/api' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/pricing' : '';
      },
      closest(selector) {
        if (selector === 'header,[role="banner"],.site-header,.top-nav') {
          return { tagName: 'HEADER' };
        }
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/changelog' : '';
      },
      closest(selector) {
        if (selector === 'footer,[role="contentinfo"],#footer,.footer,.site-footer,[id*="footer" i],[class*="footer" i]') {
          return { tagName: 'FOOTER' };
        }
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/api' : '';
      },
      closest() {
        return null;
      }
    }
  ];

  const navScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? navAnchors : [];
    }
  };

  const mockDoc = {
    querySelectorAll(selector) {
      if (selector === 'aside nav' || selector === 'aside' || selector === '[role="navigation"]' || selector === 'nav') {
        return [navScope];
      }
      return [];
    }
  };

  const links = crawler.parseNavigationLinksFromDocument(mockDoc, 'https://example.com/docs');
  assert.deepEqual(links, [
    'https://example.com/docs/getting-started',
    'https://example.com/docs/api'
  ]);
});

test('parseNavigationLinksFromDocument prioritizes data-left-nav container links', () => {
  const leftNavAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/codex' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/codex/quickstart' : '';
      },
      closest() {
        return null;
      }
    }
  ];

  const globalNavAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/pricing' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/blog' : '';
      },
      closest() {
        return null;
      }
    }
  ];

  const leftNavScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? leftNavAnchors : [];
    }
  };

  const globalNavScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? globalNavAnchors : [];
    }
  };

  const mockDoc = {
    querySelectorAll(selector) {
      if (selector === '[data-left-nav-container]') {
        return [leftNavScope];
      }
      if (selector === 'nav') {
        return [globalNavScope];
      }
      return [];
    }
  };

  const links = crawler.parseNavigationLinksFromDocument(mockDoc, 'https://developers.openai.com/codex');
  assert.deepEqual(links, [
    'https://developers.openai.com/codex',
    'https://developers.openai.com/codex/quickstart'
  ]);
});

test('parseNavigationLinksFromDocument prioritizes VitePress sidebar over generic nav links', () => {
  const sidebarAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/backend/' : '';
      },
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/backend/getting-started.html' : '';
      },
      closest() {
        return null;
      }
    }
  ];

  const globalNavAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/pricing' : '';
      },
      closest() {
        return null;
      }
    }
  ];

  const sidebarScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? sidebarAnchors : [];
    }
  };

  const globalScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? globalNavAnchors : [];
    }
  };

  const mockDoc = {
    querySelectorAll(selector) {
      if (selector === '.VPSidebar') {
        return [sidebarScope];
      }
      if (selector === 'nav') {
        return [globalScope];
      }
      return [];
    }
  };

  const links = crawler.parseNavigationLinksFromDocument(mockDoc, 'https://ruoyi.plus/backend/');
  assert.deepEqual(links, [
    'https://ruoyi.plus/backend',
    'https://ruoyi.plus/backend/getting-started.html'
  ]);
});

test('parseNavigationEntriesFromDocument keeps sidebar anchor text as title', () => {
  const sidebarAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/backend/' : '';
      },
      textContent: '项目简介',
      closest() {
        return null;
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/backend/getting-started.html' : '';
      },
      textContent: '快速启动',
      closest() {
        return null;
      }
    }
  ];

  const sidebarScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? sidebarAnchors : [];
    }
  };

  const mockDoc = {
    querySelectorAll(selector) {
      if (selector === '.VPSidebar') {
        return [sidebarScope];
      }
      return [];
    }
  };

  const entries = crawler.parseNavigationEntriesFromDocument(mockDoc, 'https://ruoyi.plus/backend/');
  assert.deepEqual(entries, [
    { url: 'https://ruoyi.plus/backend', title: '项目简介' },
    { url: 'https://ruoyi.plus/backend/getting-started.html', title: '快速启动' }
  ]);
});

test('parseCategoryLinksFromDocument collects top category links under docs root', () => {
  const categoryAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/guide' : '';
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/api' : '';
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/pricing' : '';
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/docs/login' : '';
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? 'https://example.com/docs/api' : '';
      }
    }
  ];

  const headerScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? categoryAnchors : [];
    }
  };

  const mockDoc = {
    querySelectorAll(selector) {
      if (
        selector === 'header nav' ||
        selector === 'header [role="navigation"]' ||
        selector === '[role="banner"] nav' ||
        selector === '.top-nav'
      ) {
        return [headerScope];
      }
      return [];
    }
  };

  const links = crawler.parseCategoryLinksFromDocument(
    mockDoc,
    'https://example.com/docs/start',
    {
      docsRootPath: '/docs',
      excludePatterns: ['/login']
    }
  );

  assert.deepEqual(links, [
    'https://example.com/docs/guide',
    'https://example.com/docs/api'
  ]);
});

test('parseCategoryLinksFromDocument captures dropdown menu links in generic nav container', () => {
  const menuAnchors = [
    {
      getAttribute(name) {
        return name === 'href' ? '/api/docs' : '';
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/api/reference/overview' : '';
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/chatgpt' : '';
      }
    },
    {
      getAttribute(name) {
        return name === 'href' ? '/resources' : '';
      }
    }
  ];

  const navScope = {
    querySelectorAll(selector) {
      return selector === 'a[href]' ? menuAnchors : [];
    }
  };

  const mockDoc = {
    querySelectorAll(selector) {
      if (selector === 'nav') {
        return [navScope];
      }
      return [];
    }
  };

  const links = crawler.parseCategoryLinksFromDocument(
    mockDoc,
    'https://developers.openai.com/',
    {
      docsRootPath: '/',
      excludePatterns: []
    }
  );

  assert.deepEqual(links, [
    'https://developers.openai.com/api/docs',
    'https://developers.openai.com/api/reference/overview',
    'https://developers.openai.com/chatgpt',
    'https://developers.openai.com/resources'
  ]);
});

test('deriveCategoryPathPrefixes builds crawl prefixes from main category links', () => {
  const prefixes = crawler.deriveCategoryPathPrefixes(
    'https://example.com/docs/start',
    [
      'https://example.com/docs/guide',
      'https://example.com/docs/api/reference',
      'https://example.com/blog/announcements'
    ]
  );

  assert.deepEqual(prefixes, [
    '/docs/api/reference',
    '/docs/guide'
  ]);

  const fallback = crawler.deriveCategoryPathPrefixes(
    'https://example.com/docs/start',
    []
  );
  assert.deepEqual(fallback, ['/docs']);
});

test('matchesAnyPathPrefix constrains deep crawl into category paths', () => {
  assert.equal(
    crawler.matchesAnyPathPrefix('https://example.com/docs/api/auth/login', ['/docs/guide', '/docs/api']),
    true
  );
  assert.equal(
    crawler.matchesAnyPathPrefix('https://example.com/docs/changelog', ['/docs/guide', '/docs/api']),
    false
  );
  assert.equal(
    crawler.matchesAnyPathPrefix('https://example.com/docs/changelog', []),
    true
  );
});

test('inferDocRootPrefixes prefers article roots over generic category roots', () => {
  const roots = crawler.inferDocRootPrefixes(
    'https://example.com/categories/ai-agents',
    [
      'https://example.com/blog/post-a',
      'https://example.com/blog/post-b',
      'https://example.com/categories/tools'
    ],
    [
      'https://example.com/blog/post-c',
      'https://example.com/blog/post-d',
      'https://example.com/tag/llm'
    ],
    'https://example.com'
  );
  assert.deepEqual(roots, ['blog']);
});

test('inferDocsRootPath picks docs-like root on homepage and avoids generic fallback', () => {
  assert.equal(
    crawler.inferDocsRootPath(
      'https://example.com/',
      [
        'https://example.com/docs/getting-started',
        'https://example.com/docs/api/auth',
        'https://example.com/settings',
        'https://example.com/chat'
      ],
      '/'
    ),
    '/docs'
  );

  assert.equal(
    crawler.inferDocsRootPath(
      'https://example.com/',
      ['https://example.com/settings', 'https://example.com/chat'],
      '/'
    ),
    '/'
  );
});

test('isLikelyDocUrlByStructure filters nav/list paths and keeps article-like paths', () => {
  assert.equal(crawler.isLikelyDocUrlByStructure('https://example.com/blog/how-to-build-agents'), true);
  assert.equal(crawler.isLikelyDocUrlByStructure('https://example.com/blog/page/2'), false);
  assert.equal(crawler.isLikelyDocUrlByStructure('https://example.com/categories/ai-agents'), false);
  assert.equal(crawler.isLikelyDocUrlByStructure('https://example.com/contact'), false);
});

test('shouldExpandLinksFromPage skips expanding links on article pages by default', () => {
  assert.equal(
    crawler.shouldExpandLinksFromPage('https://example.com/blog/how-to-build-agents'),
    false
  );
  assert.equal(
    crawler.shouldExpandLinksFromPage('https://example.com/categories/ai-agents'),
    true
  );
  assert.equal(
    crawler.shouldExpandLinksFromPage('https://example.com/blog/how-to-build-agents', { followLinksInsideArticle: true }),
    true
  );
});

test('buildMarkdownPath uses article title as filename and resolves collisions', () => {
  const used = new Set();
  const a = crawler.buildMarkdownPath('https://example.com/docs/guide/install', '安装指南', '/docs', used);
  assert.equal(a, 'docs/guide/安装指南.md');

  const b = crawler.buildMarkdownPath('https://example.com/docs/guide/install?ref=1', '安装指南', '/docs', used);
  assert.equal(b, 'docs/guide/安装指南-2.md');

  const c = crawler.buildMarkdownPath('https://example.com/docs/guide/', '快速开始', '/docs', used);
  assert.equal(c, 'docs/guide/快速开始.md');
});

test('buildZipFilename uses cleaned site name and falls back safely', () => {
  assert.equal(
    crawler.buildZipFilename(['OpenAI Developer Docs | OpenAI'], 'platform.openai.com'),
    'OpenAI.zip'
  );
  assert.equal(
    crawler.buildZipFilename(['   '], 'docs.example.com'),
    'Example.zip'
  );
  assert.equal(
    crawler.buildZipFilename([], ''),
    'docs-md-export.zip'
  );
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

test('buildStageProgressText keeps ZIP stage as percentage-only text', () => {
  assert.equal(
    crawler.buildStageProgressText('ZIP打包', 40, 100),
    'ZIP打包: 40%'
  );
  assert.equal(
    crawler.buildStageProgressText('Markdown转换', 3, 10),
    'Markdown转换: 3/10 (30%)'
  );
});

test('resolveProgressFillPercent prefers overall progress for progress bar', () => {
  assert.equal(
    crawler.resolveProgressFillPercent('ZIP打包', 40, 100, 82),
    82
  );
  assert.equal(
    crawler.resolveProgressFillPercent('ZIP打包', 40, 100),
    40
  );
});

test('normalizeImageMode supports external/local/none and falls back to default', () => {
  assert.equal(crawler.normalizeImageMode('external'), 'external');
  assert.equal(crawler.normalizeImageMode('local'), 'local');
  assert.equal(crawler.normalizeImageMode('none'), 'none');
  assert.equal(crawler.normalizeImageMode('unexpected'), 'external');
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

test('generateZipBlobWithFallback uses blob as primary pack channel', async () => {
  const callTypes = [];
  const zip = {
    generateAsync(options) {
      callTypes.push(options.type);
      return Promise.resolve(new Blob([Uint8Array.from([80, 75, 3, 4])], { type: 'application/zip' }));
    }
  };

  const result = await crawler.generateZipBlobWithFallback(zip, { timeoutMs: 20 });
  assert.deepEqual(callTypes, ['blob']);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.timeoutTriggered, false);
  assert.equal(result.primaryType, 'blob');
  assert.ok(result.blob instanceof Blob);
});

test('generateZipBlobWithFallback falls back to uint8array when blob is unsupported', async () => {
  const callTypes = [];
  const zip = {
    generateAsync(options) {
      callTypes.push(options.type);
      if (options.type === 'blob') {
        return Promise.reject(new Error('blob not supported'));
      }
      return Promise.resolve(Uint8Array.from([80, 75, 3, 4]));
    }
  };

  const result = await crawler.generateZipBlobWithFallback(zip, { timeoutMs: 20 });
  assert.deepEqual(callTypes, ['blob', 'uint8array']);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.primaryType, 'blob');
  assert.equal(result.fallbackType, 'uint8array');
  assert.ok(result.blob instanceof Blob);
});

test('generateZipBlobWithFallback fails fast on primary timeout without starting fallback', async () => {
  const callTypes = [];
  const zip = {
    generateAsync(options) {
      callTypes.push(options.type);
      return new Promise(() => {});
    }
  };

  await assert.rejects(
    () => crawler.generateZipBlobWithFallback(zip, { timeoutMs: 20 }),
    /zip-pack-timeout/
  );
  assert.deepEqual(callTypes, ['blob']);
});

test('buildStoreZipBlob creates a valid store-mode zip payload', async () => {
  const blob = crawler.buildStoreZipBlob([
    { path: 'docs/a.md', text: '# A\n' },
    { path: 'assets/i.bin', bytes: Uint8Array.from([1, 2, 3, 4]) }
  ]);
  assert.ok(blob instanceof Blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  assert.equal(view.getUint32(0, true), 0x04034b50);
  const eocdOffset = bytes.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
  assert.equal(view.getUint16(eocdOffset + 8, true), 2);
  assert.equal(view.getUint16(eocdOffset + 10, true), 2);
});

test('buildStoreZipBlob rejects empty entry list', () => {
  assert.throws(
    () => crawler.buildStoreZipBlob([]),
    /zip-store-empty/
  );
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

test('playDownloadCompleteSound returns false when AudioContext is unavailable', () => {
  const played = crawler.playDownloadCompleteSound({
    AudioContextCtor: null
  });
  assert.equal(played, false);
});

test('playDownloadCompleteSound schedules a short tone and closes context', () => {
  const frequencyCalls = [];
  const gainSetCalls = [];
  const gainRampCalls = [];
  const startCalls = [];
  const stopCalls = [];
  const connectTargets = [];
  let closed = false;

  const fakeOscillator = {
    type: '',
    frequency: {
      setValueAtTime(value, time) {
        frequencyCalls.push([value, time]);
      }
    },
    connect(target) {
      connectTargets.push(target);
    },
    start(time) {
      startCalls.push(time);
    },
    stop(time) {
      stopCalls.push(time);
      if (typeof this.onended === 'function') {
        this.onended();
      }
    },
    onended: null
  };

  const fakeGainNode = {
    gain: {
      setValueAtTime(value, time) {
        gainSetCalls.push([value, time]);
      },
      exponentialRampToValueAtTime(value, time) {
        gainRampCalls.push([value, time]);
      }
    },
    connect(target) {
      connectTargets.push(target);
    }
  };

  function FakeAudioContext() {
    return {
      currentTime: 5,
      state: 'running',
      destination: { node: 'destination' },
      createOscillator() {
        return fakeOscillator;
      },
      createGain() {
        return fakeGainNode;
      },
      close() {
        closed = true;
      }
    };
  }

  const played = crawler.playDownloadCompleteSound({
    AudioContextCtor: FakeAudioContext,
    frequencyHz: 660,
    durationSec: 0.2,
    gain: 0.05
  });

  assert.equal(played, true);
  assert.equal(fakeOscillator.type, 'sine');
  assert.deepEqual(frequencyCalls, [[660, 5]]);
  assert.deepEqual(gainSetCalls, [[0.05, 5]]);
  assert.equal(gainRampCalls.length, 1);
  assert.equal(gainRampCalls[0][0], 0.0001);
  assert.ok(Math.abs(gainRampCalls[0][1] - 5.2) < 0.00001);
  assert.deepEqual(startCalls, [5]);
  assert.equal(stopCalls.length, 1);
  assert.ok(Math.abs(stopCalls[0] - 5.2) < 0.00001);
  assert.equal(connectTargets.length, 2);
  assert.equal(closed, true);
});

test('playDownloadCompleteSound uses a louder default gain', () => {
  const gainSetCalls = [];
  const fakeOscillator = {
    type: '',
    frequency: { setValueAtTime() {} },
    connect() {},
    start() {},
    stop() {},
    onended: null
  };
  const fakeGainNode = {
    gain: {
      setValueAtTime(value) {
        gainSetCalls.push(value);
      },
      exponentialRampToValueAtTime() {}
    },
    connect() {}
  };
  function FakeAudioContext() {
    return {
      currentTime: 0,
      state: 'running',
      destination: {},
      createOscillator() {
        return fakeOscillator;
      },
      createGain() {
        return fakeGainNode;
      },
      close() {}
    };
  }
  crawler.playDownloadCompleteSound({ AudioContextCtor: FakeAudioContext });
  assert.equal(gainSetCalls.length, 1);
  assert.equal(gainSetCalls[0], 0.08);
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
  assert.match(css, /\.docs-md-image-select\{/);
  assert.match(css, /\.docs-md-fail-link\{/);
  assert.match(css, /text-decoration-style:dashed/);
  assert.match(css, /\.docs-md-square-check\{/);
  assert.match(css, /\.docs-md-square-check:checked::before/);
  assert.match(css, /\.docs-md-square-check:indeterminate::before/);
  assert.match(css, /\.docs-md-square-check:checked\{border-color:hsl\(0 0% 0%\);background:hsl\(0 0% 0%\)/);
  assert.match(css, /\.docs-md-square-check:indeterminate\{border-color:hsl\(0 0% 0%\);background:hsl\(0 0% 0%\)/);
  assert.match(css, /\.docs-md-square-check\{[^}]*width:16px;height:16px/);
  assert.match(css, /\.docs-md-group-separator\{/);
  assert.match(css, /\.docs-md-inline-field\{/);
  assert.match(css, /\.docs-md-image-select\{/);
  assert.match(css, /\.docs-md-image-select:focus-visible\{outline:none/);
  assert.doesNotMatch(css, /\.docs-md-image-select:focus-visible\{outline:2px/);
  assert.doesNotMatch(css, /#docs-md-diag-wrap\{/);
  assert.doesNotMatch(css, /#docs-md-diag\{/);
  assert.doesNotMatch(css, /#docs-md-diag-clear\{/);
  assert.doesNotMatch(css, /#docs-md-download-wrap\{/);
  assert.doesNotMatch(css, /#docs-md-download-link\{/);
});

test('buildPanelMarkup keeps required ids and shadcn-style structure', () => {
  const html = crawler.buildPanelMarkup();
  assert.match(html, /id="docs-md-head"/);
  assert.match(html, /id="docs-md-image-mode"/);
  assert.match(html, /<select id="docs-md-image-mode" class="docs-md-image-select"/);
  assert.match(html, /<option value="external">外链插入<\/option>/);
  assert.match(html, /<option value="local">本地下载<\/option>/);
  assert.match(html, /<option value="none">不导出<\/option>/);
  assert.doesNotMatch(html, /id="docs-md-image-mode" type="checkbox"/);
  assert.match(html, /class="docs-md-field docs-md-inline-field"/);
  assert.match(html, /id="docs-md-scan"/);
  assert.match(html, /id="docs-md-export"/);
  assert.match(html, /id="docs-md-stop"/);
  assert.match(html, /id="docs-md-status-text"/);
  assert.match(html, /id="docs-md-tree"/);
  assert.match(html, /id="docs-md-progress-text">导出进度: 0%<\/div>/);
  assert.match(html, /docs-md-btn docs-md-btn-primary/);
  assert.match(html, /docs-md-btn docs-md-btn-outline/);
  assert.match(html, /docs-md-btn-export/);
  assert.match(html, /docs-md-surface/);
  assert.doesNotMatch(html, /id="docs-md-diag-wrap"/);
  assert.doesNotMatch(html, /id="docs-md-diag"/);
  assert.doesNotMatch(html, /id="docs-md-diag-clear"/);
  assert.doesNotMatch(html, /手动下载 ZIP/);
  assert.match(html, /id="docs-md-check-all-wrap"/);
  assert.match(html, /docs-md-check-row docs-md-hidden/);
  assert.match(html, /id="docs-md-check-all" type="checkbox" class="docs-md-square-check docs-md-group-check" checked/);
  assert.match(html, /id="docs-md-tree" class="docs-md-surface docs-md-hidden"/);
});

test('export bundle no longer includes SUMMARY.md entry', () => {
  const source = fs.readFileSync(require.resolve('../docs-md-crawler.user.js'), 'utf8');
  assert.doesNotMatch(source, /SUMMARY\.md/);
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

test('shouldRecordScanFailure ignores expected 404 noise in discovery stage', () => {
  assert.equal(crawler.shouldRecordScanFailure(new Error('http-404')), false);
  assert.equal(crawler.shouldRecordScanFailure(new Error('http-410')), false);
  assert.equal(crawler.shouldRecordScanFailure(new Error('http-500')), true);
  assert.equal(crawler.shouldRecordScanFailure(new Error('request-timeout')), true);
});

test('toTrustedHtml uses policy output when policy is available', () => {
  const calls = [];
  const policy = {
    createHTML(value) {
      calls.push(value);
      return { trusted: value };
    }
  };

  const value = crawler.toTrustedHtml('<div>ok</div>', policy);
  assert.deepEqual(value, { trusted: '<div>ok</div>' });
  assert.deepEqual(calls, ['<div>ok</div>']);
});

test('parseHtmlDocument retries with trusted html when raw parse is blocked', () => {
  const parseCalls = [];
  class FakeDOMParser {
    parseFromString(value, mimeType) {
      parseCalls.push({ value, mimeType });
      if (typeof value === 'string') {
        throw new TypeError('TrustedHTML required');
      }
      return { mimeType, value };
    }
  }
  const policy = {
    createHTML(value) {
      return { trusted: value };
    }
  };

  const doc = crawler.parseHtmlDocument('<main>safe</main>', {
    DOMParserCtor: FakeDOMParser,
    trustedPolicy: policy
  });

  assert.equal(doc.mimeType, 'text/html');
  assert.deepEqual(doc.value, { trusted: '<main>safe</main>' });
  assert.equal(parseCalls.length, 2);
  assert.equal(typeof parseCalls[0].value, 'string');
  assert.deepEqual(parseCalls[1].value, { trusted: '<main>safe</main>' });
});

test('runWithConcurrency limits in-flight workers and keeps result order', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5];

  const results = await crawler.runWithConcurrency(items, 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return value * 10;
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test('createHostRequestLimiter enforces per-host minimum request interval', async () => {
  let now = 1000;
  const sleepCalls = [];
  const limiter = crawler.createHostRequestLimiter({
    minIntervalMs: 40,
    nowFn: () => now,
    sleepFn: async (ms) => {
      sleepCalls.push(ms);
      now += ms;
    }
  });

  await Promise.all([
    limiter.wait('https://example.com/docs/a'),
    limiter.wait('https://example.com/docs/b'),
    limiter.wait('https://cdn.example.com/assets/logo.png')
  ]);

  assert.deepEqual(sleepCalls, [40]);
});

test('shouldRetryRequestError retries only transient failures', () => {
  assert.equal(crawler.shouldRetryRequestError(new Error('timeout')), true);
  assert.equal(crawler.shouldRetryRequestError(new Error('network-error')), true);
  assert.equal(crawler.shouldRetryRequestError(new Error('http-429')), true);
  assert.equal(crawler.shouldRetryRequestError(new Error('http-503')), true);
  assert.equal(crawler.shouldRetryRequestError(new Error('http-404')), false);
  assert.equal(crawler.shouldRetryRequestError(new Error('http-410')), false);
  assert.equal(crawler.shouldRetryRequestError(new Error('unsupported-binary:[object Object]')), false);
});

test('shouldUseSitemapForDiscovery enables sitemap in directory-only scan mode', () => {
  assert.equal(
    crawler.shouldUseSitemapForDiscovery({
      useSitemap: true,
      crawlDescendantsOnly: true,
      directoryOnly: false
    }),
    false
  );
  assert.equal(
    crawler.shouldUseSitemapForDiscovery({
      useSitemap: true,
      crawlDescendantsOnly: true,
      directoryOnly: true
    }),
    true
  );
  assert.equal(
    crawler.shouldUseSitemapForDiscovery({
      useSitemap: true,
      crawlDescendantsOnly: false,
      directoryOnly: false
    }),
    true
  );
});
