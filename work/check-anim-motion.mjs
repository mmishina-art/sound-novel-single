// 全章に「動いているもの」があることの確認: 各章で #pageAnim の子の
// computed transform / opacity を時間を空けて2回測り、変化があるかを見る。
// 使い方: npm run build のあと node work/check-anim-motion.mjs
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4176, strictPort: true }, logLevel: 'warn' });
const url = 'http://localhost:4176/';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('#tocList li', { state: 'attached', timeout: 10000 });

  const sample = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#pageAnim > *')].map((el) => {
        const cs = getComputedStyle(el);
        return el.className + '|' + cs.transform + '|' + cs.opacity;
      }),
    );

  let allOk = true;
  for (let n = 0; n < 7; n++) {
    await page.click('#tocFromCoverBtn');
    await page.locator('.toc-item').nth(n).click();
    await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
    await page.waitForSelector('#readerView:not(.chrome-on)', { timeout: 10000 });
    const a = await sample();
    await page.waitForTimeout(3000);
    const b = await sample();
    const changed = a.filter((v, i) => v !== b[i]).length;
    const ok = changed > 0 && a.length > 0;
    allOk = allOk && ok;
    console.log(`第${n + 1}章: 要素${a.length}個 / 動いている要素${changed}個 ${ok ? 'OK' : 'NG'}`);
    // 表紙に戻って次の章へ
    await page.evaluate(() => {
      const box = document.getElementById('pageWrap').getBoundingClientRect();
      return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
    }).then(async (p) => {
      await page.mouse.click(p.x, p.y); // 中央タップで操作UIを出す
      await page.locator('#toCoverBtn').click();
      await page.waitForSelector('#coverView:not([hidden])', { timeout: 10000 });
    });
  }
  console.log(allOk ? '全章に動きあり' : '動きのない章がある');
  process.exitCode = allOk ? 0 : 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
