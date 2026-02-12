async page => {
  await page.goto('https://zip-e2e.invalid/docs/start/', { waitUntil: 'domcontentloaded' });
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
  }, undefined, { timeout: 120000 });
  await page.waitForFunction(() => {
    const tree = document.querySelector('#docs-md-tree');
    if (!tree || tree.classList.contains('docs-md-hidden')) return false;
    return tree.querySelectorAll('input[type="checkbox"][data-url]').length >= 3;
  }, undefined, { timeout: 120000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#docs-md-export')
  ]);
  const savePath = '/Users/squidward/Develop/Scrips/一键爬docs下载.markdown/output/playwright/zip-export-e2e/downloads/export-e2e-clean.zip';
  await download.saveAs(savePath);
  return {
    savePath,
    suggestedFilename: download.suggestedFilename(),
    statusText: await page.textContent('#docs-md-status-text')
  };
}
