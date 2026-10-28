// 改修確認用：表紙・扉・本文ページを 390px 幅で撮影し、ページ割りの実測も出す
import { chromium } from '../../simple_visual_novel/node_modules/@playwright/test/index.mjs';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const ROOT = new URL('../app/', import.meta.url).pathname;
const OUT = new URL('./shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = join(ROOT, p);
  if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(8907, r));

const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8907/');
  await page.waitForFunction(() => !document.getElementById('coverView').hidden || document.querySelector('.book-cover'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + 'phone-cover.png' });

  // 扉：表紙をタップ（自動で本文に入る前に撮る）
  await page.click('.book-cover');
  await page.waitForTimeout(350);
  await page.screenshot({ path: OUT + 'phone-gate.png' });
  // 本文へ（扉タップ）
  await page.click('.gate-sheet');
  await page.waitForTimeout(700);
  await page.screenshot({ path: OUT + 'phone-page1.png' });

  const info1 = await page.evaluate(() => ({
    pagesPerChapter: PAGES.map((p) => p.length),
    totalPages: TOTAL_PAGES,
    curPage, folio: document.getElementById('pageFolio').textContent,
    label: document.getElementById('readerChapterLabel').textContent,
    contentBox: (() => { const c = document.getElementById('pageContent'); return { w: c.clientWidth, h: c.clientHeight, sw: c.scrollWidth }; })(),
    pageRect: (() => { const r = document.getElementById('pageEl').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    dir: DIR.mode + '/' + DIR.bound + '/' + DIR.nextSide,
    bodyClasses: document.body.className
  }));
  console.log(JSON.stringify(info1, null, 1));

  // 左タップで次ページ
  await page.mouse.click(60, 450);
  await page.waitForTimeout(350);
  await page.screenshot({ path: OUT + 'phone-page2.png' });
  const info2 = await page.evaluate(() => ({ curPage, folio: document.getElementById('pageFolio').textContent }));
  console.log('after next tap:', JSON.stringify(info2));

  // 右タップで前ページに戻る
  await page.mouse.click(340, 450);
  await page.waitForTimeout(350);
  const info3 = await page.evaluate(() => ({ curPage, folio: document.getElementById('pageFolio').textContent }));
  console.log('after prev tap:', JSON.stringify(info3));

  // 全ページ走査：はみ出し（scrollWidth超過）がないか
  const scan = await page.evaluate(() => {
    const bad = [];
    for (let ci = 0; ci < chapters.length; ci++) {
      enterChapter(ci, { autoplay: false });
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        const res = [];
        let badCount = 0;
        for (let ci = 0; ci < chapters.length; ci++) {
          current = ci; endShown = false; pageEl.hidden = false; endView.hidden = true;
          for (let pi = 0; pi < PAGES[ci].length; pi++) {
            curPage = pi; renderPage(0);
            const c = document.getElementById('pageContent');
            if (c.scrollWidth > c.clientWidth + 1) { badCount++; res.push(ci + ':' + pi + ' sw=' + c.scrollWidth + ' cw=' + c.clientWidth); }
          }
        }
        resolve({ badCount, res: res.slice(0, 8), total: TOTAL_PAGES });
      }, 600);
    });
  });
  console.log('overflow scan:', JSON.stringify(scan));

  // 最終章・最終ページ→おわりページ
  await page.evaluate(() => { enterChapter(chapters.length - 1, { autoplay: false }); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { curPage = PAGES[current].length - 1; renderPage(0); });
  await page.mouse.click(60, 450);
  await page.waitForTimeout(350);
  await page.screenshot({ path: OUT + 'phone-end.png' });
  const infoEnd = await page.evaluate(() => ({ endShown, endHidden: document.getElementById('endView').hidden }));
  console.log('end page:', JSON.stringify(infoEnd));

  // 小さい画面（SE相当 375x667）
  const ctx2 = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('se pageerror: ' + e.message));
  await p2.goto('http://localhost:8907/');
  await p2.waitForTimeout(500);
  await p2.click('.book-cover');
  await p2.waitForTimeout(200);
  await p2.click('.gate-sheet');
  await p2.waitForTimeout(700);
  await p2.screenshot({ path: OUT + 'se-page1.png' });
  const seInfo = await p2.evaluate(() => ({ pages: PAGES.map((p) => p.length), total: TOTAL_PAGES }));
  console.log('SE size:', JSON.stringify(seInfo));
  await ctx.close(); await ctx2.close();
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('shots saved to work/shots/');
