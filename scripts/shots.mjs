// 画面の一括撮影: 主な画面を、スマホの幅・小さい画面（iPhone SE）・ダークモードで撮って、shots/ に保存する。
// 「画面を変えたら、実際に表示して確認する」（CLAUDE.md）を、コマンド 1 つでできるようにするため。
// 使い方: npm run shots（build してから撮る）→ shots/<大きさ>-<画面>.png と、全部を並べた shots/all.png
// 画面を足すときは、下の SCREENS に足す（open で、その画面まで操作する）。
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { mkdirSync, rmSync } from 'node:fs';

/** 撮る画面。open は、ページを開いたあと、その画面を出すための操作。 */
// 本のデータ（book/data.json）が届いて目次が組み上がると、表紙の操作が効くようになる
const waitBook = async (page) => page.waitForSelector('#tocList li', { state: 'attached', timeout: 10000 });
// 表示方式は画面間で localStorage に残るため、ページ形式で撮りたい画面は先に固定する
const forcePageMode = async (page) => {
  await page.evaluate(() => {
    const appId = globalThis.document.querySelector('meta[name="app-id"]')?.content || '';
    globalThis.localStorage.setItem(`${appId}-display`, 'page');
  });
  await page.reload();
  await page.waitForFunction(() => globalThis.__appStarted === true);
  await waitBook(page);
};
// 目次ページへの入口はメニューの「目次を開く」に一本化されている（表紙に目次ボタンはない）
const openToc = async (page) => {
  await waitBook(page);
  await page.click('#coverMenuBtn');
  await page.click('#tocFromMenuBtn');
  await page.waitForSelector('#tocView:not([hidden])');
};
const openReader = async (page) => {
  await waitBook(page);
  await page.click('#coverTap');
  // 章扉は約1.8秒で自動で本文へ進む
  await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);
};
const SCREENS = [
  { name: 'cover' },
  {
    // しおりがあるときの表紙（再開ボタンが出る状態）。しおりを置いて読み込み直す
    name: 'cover-resume',
    open: async (page) => {
      await page.evaluate(() => {
        const appId = globalThis.document.querySelector('meta[name="app-id"]')?.content || '';
        globalThis.localStorage.setItem(`${appId}-bookmark`, JSON.stringify({ chapter: 0, time: 33, title: '第一章 雨の日の客', savedAt: Date.now(), anchor: 0, page: 1 }));
      });
      await page.reload();
      await page.waitForFunction(() => globalThis.__appStarted === true);
      await waitBook(page);
      await page.waitForSelector('#resumeBtn:not([hidden])');
    },
  },
  { name: 'toc-page', open: openToc },
  { name: 'gate', open: async (page) => { await waitBook(page); await page.click('#coverTap'); } },
  {
    name: 'gate2',
    open: async (page) => {
      await openToc(page);
      await page.locator('.toc-item').nth(1).click();
      await page.waitForSelector('#gateView:not([hidden])');
    },
  },
  // page1 は操作UIが出ている状態（開いた直後は出ていないので、中央タップで出す）、
  // page-clean は自動で消えたあとの本文だけの状態
  {
    name: 'page1',
    open: async (page) => {
      await openReader(page);
      const box = await page.locator('#pageWrap').boundingBox();
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.waitForSelector('#readerView.chrome-on', { timeout: 5000 });
    },
  },
  {
    name: 'page-clean',
    open: async (page) => {
      await openReader(page);
      await page.waitForSelector('#readerView:not(.chrome-on)', { timeout: 10000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'page2',
    open: async (page) => {
      await openReader(page);
      // 右綴じ: 次ページは左側タップ
      const box = await page.locator('#pageWrap').boundingBox();
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'menu',
    open: async (page) => {
      await openReader(page);
      // 操作UIは開いた直後は出ていないので、中央タップで出してから「メニュー」を押す
      const box = await page.locator('#pageWrap').boundingBox();
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.waitForSelector('#readerView.chrome-on', { timeout: 5000 });
      await page.click('#menuBtn');
    },
  },
  {
    name: 'page-highlight',
    open: async (page) => {
      await openReader(page);
      // 朗読中の文に強調が付くまで待つ
      await page.waitForSelector('.unit.now', { timeout: 10000 });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'karaoke',
    open: async (page) => {
      await openReader(page);
      const box = await page.locator('#pageWrap').boundingBox();
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.waitForSelector('#readerView.chrome-on', { timeout: 5000 });
      await page.click('#menuBtn');
      await page.click('#displayModeBtn'); // ページ形式 → カラオケ方式
      await page.click('#menuCloseBtn');
      await page.waitForSelector('.unit.now', { timeout: 10000 });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'final-page',
    open: async (page) => {
      await forcePageMode(page);
      await openToc(page);
      await page.locator('.toc-item').nth(6).click();
      await page.click('#gateView');
      await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
      const box = await page.locator('#pageWrap').boundingBox();
      for (let i = 0; i < 300; i++) {
        const pos = await page.locator('#pageChapterPos').textContent();
        const m = /(\d+) \/ (\d+)/.exec(pos || '');
        if (m && m[1] === m[2]) break;
        await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(300);
    },
  },
  {
    // 奥付ページ（本文の最終ページから、もう1つ送った先）
    name: 'end-page',
    open: async (page) => {
      await forcePageMode(page);
      await openToc(page);
      await page.locator('.toc-item').nth(6).click();
      await page.click('#gateView');
      await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
      const box = await page.locator('#pageWrap').boundingBox();
      for (let i = 0; i < 300; i++) {
        const pos = await page.locator('#pageChapterPos').textContent();
        const m = /(\d+) \/ (\d+)/.exec(pos || '');
        if (m && m[1] === m[2]) break;
        await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
        await page.waitForTimeout(40);
      }
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
      await page.waitForSelector('#endPage:not([hidden])', { timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  // 管理系はメニュー（表紙の「設定」）の中に集約した
  { name: 'install', open: async (page) => { await page.click('#coverMenuBtn'); await page.click('#install-open'); } },
  { name: 'cover-menu', open: async (page) => { await page.click('#coverMenuBtn'); } },
];

/** 撮る大きさ。このアプリは暗い固定配色なので、ダークモードの撮り分けはしない。 */
const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'se', width: 375, height: 667 },
];

const OUT = 'shots';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: 'warn' });
const url = 'http://localhost:4174/';
// CHROMIUM_PATH: Playwright のブラウザを入れていない環境で、入っている Chromium を使うとき（ふつうは不要。`npx playwright install chromium`）
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const files = [];
try {
  for (const size of SIZES) {
    // Service Worker は止める（前の撮影のキャッシュが残らないように）。アニメーションは止めて、毎回同じ絵にする
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 2,
      colorScheme: size.dark ? 'dark' : 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    for (const screen of SCREENS) {
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${size.name}/${screen.name}: ${e.message}`));
      await page.goto(url);
      await page.waitForFunction(() => globalThis.__appStarted === true);
      if (screen.open) await screen.open(page);
      await page.waitForTimeout(300);
      const file = `${OUT}/${size.name}-${screen.name}.png`;
      await page.screenshot({ path: file });
      files.push(file);
      await page.close();
    }
    await context.close();
  }
  // 全部を 1 枚に並べる（行 = 大きさ、列 = 画面）。見比べやすいように
  const page = await browser.newPage({ viewport: { width: 400 * SCREENS.length, height: 900 } });
  const { readFileSync } = await import('node:fs');
  const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const rows = SIZES.map((s) => `<tr><th>${s.name}</th>${SCREENS.map((sc) => `<td><img src="${img(`${OUT}/${s.name}-${sc.name}.png`)}" width="${s.width}"><br>${sc.name}</td>`).join('')}</tr>`).join('');
  await page.setContent(`<style>body{margin:8px;font:14px sans-serif;background:#888}td{vertical-align:top;text-align:center;padding:4px}img{border:1px solid #333}</style><table>${rows}</table>`);
  await page.screenshot({ path: `${OUT}/all.png`, fullPage: true });
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

console.log(`${files.length} 枚を ${OUT}/ に保存した（一覧: ${OUT}/all.png）`);
if (errors.length) {
  console.error(`画面でエラーが出た:\n${errors.join('\n')}`);
  process.exit(1);
}
