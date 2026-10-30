// 背景アニメーション確認用の撮影: scripts/shots.mjs は reducedMotion: 'reduce' で
// アニメーション層自体が出ないため、こちらは 'no-preference' で撮る。
// 使い方: npm run build のあと node work/shot-anim.mjs → work/shots-anim/ に保存
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { mkdirSync, rmSync } from 'node:fs';

const OUT = 'work/shots-anim';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = await preview({ preview: { port: 4175, strictPort: true }, logLevel: 'warn' });
const url = 'http://localhost:4175/';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('#tocList li', { state: 'attached', timeout: 10000 });

  const openChapter = async (n) => {
    await page.click('#coverSettingsBtn');
    await page.click('#tocFromMenuBtn');
    await page.locator('.toc-item').nth(n).click();
    await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
    // 操作UIが自動で消えるのを待ち、アニメーションが行き渡ってから撮る
    await page.waitForSelector('#readerView:not(.chrome-on)', { timeout: 10000 });
    await page.waitForTimeout(1600);
  };

  for (const n of [0, 1, 2, 4, 5, 6]) {
    await openChapter(n);
    await page.screenshot({ path: `${OUT}/ch${n + 1}.png` });
    // 表紙へ戻って次の章へ
    await page.evaluate(() => {
      const box = document.getElementById('pageWrap').getBoundingClientRect();
      document.getElementById('pageWrap').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.x + box.width * 0.5, clientY: box.y + box.height * 0.5 }));
    });
    await page.waitForSelector('#readerView.chrome-on', { timeout: 5000 });
    await page.click('#toCoverBtn');
    await page.waitForSelector('#coverView:not([hidden])', { timeout: 5000 });
  }
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
console.log(`${OUT}/ に保存した`);
