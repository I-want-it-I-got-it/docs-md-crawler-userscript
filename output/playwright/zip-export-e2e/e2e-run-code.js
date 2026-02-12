async page => {
  const pages = {
    '/docs/start/index.html': '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Docs Start</title></head><body><main><h1>开始页</h1><p>这是一段用于测试导出的正文内容。为了让转换行为更接近真实文档，这里放入足够长的中文段落，覆盖链接、标题、段落等常见内容结构，并确保扫描流程能够发现后续页面。</p><p>继续阅读页面：<a href="/docs/start/page-a.html">页面 A</a> 与 <a href="/docs/start/guide/page-b.html">页面 B</a>。</p></main></body></html>',
    '/docs/start/page-a.html': '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Page A</title></head><body><article><h1>页面 A</h1><p>页面 A 用于验证 Markdown 转换与链接重写。这里的文本同样保持较长，以便被主内容提取逻辑识别为有效文档节点。</p><p>回到 <a href="/docs/start/index.html">开始页</a>。</p></article></body></html>',
    '/docs/start/guide/page-b.html': '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Page B</title></head><body><article><h1>页面 B</h1><p>页面 B 用于补充多层路径目录结构，验证导出的 ZIP 中目录与 SUMMARY 文件是否按预期生成。</p><p>回到 <a href="/docs/start/index.html">开始页</a>。</p></article></body></html>'
  };

  await page.route('**/*', async route => {
    const reqUrl = new URL(route.request().url());
    if (reqUrl.hostname === 'cdn.jsdelivr.net') {
      await route.continue();
      return;
    }
    if (pages[reqUrl.pathname]) {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pages[reqUrl.pathname] });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found: ' + reqUrl.pathname });
  });

  await page.goto('https://zip-e2e.invalid/docs/start/index.html', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js' });
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js' });
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js' });
  await page.addScriptTag({ path: '/Users/squidward/Develop/Scrips/一键爬docs下载.markdown/docs-md-crawler.user.js' });

  await page.waitForSelector('#docs-md-fab', { timeout: 120000 });
  await page.click('#docs-md-fab');
  await page.click('#docs-md-scan');

  await page.waitForFunction(() => {
    const text = document.querySelector('#docs-md-status-text')?.textContent || '';
    return text.includes('扫描完成') || text.includes('扫描已停止');
  }, { timeout: 120000 });

  await page.waitForFunction(() => {
    const tree = document.querySelector('#docs-md-tree');
    if (!tree || tree.classList.contains('docs-md-hidden')) return false;
    return tree.querySelectorAll('input[type="checkbox"][data-url]').length >= 2;
  }, { timeout: 120000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#docs-md-export')
  ]);

  const savePath = '/Users/squidward/Develop/Scrips/一键爬docs下载.markdown/output/playwright/zip-export-e2e/downloads/export-e2e.zip';
  await download.saveAs(savePath);

  const statusText = await page.textContent('#docs-md-status-text');
  const checkedCount = await page.evaluate(() => document.querySelectorAll('#docs-md-tree input[type="checkbox"][data-url]:checked').length);

  return {
    savePath,
    suggestedFilename: download.suggestedFilename(),
    statusText,
    checkedCount
  };
}
