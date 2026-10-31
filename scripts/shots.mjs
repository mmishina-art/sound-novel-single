// 画面の一括撮影: 主な画面を、スマホの幅・小さい画面（iPhone SE）・ダークモードで撮って、shots/ に保存する。
// 「画面を変えたら、実際に表示して確認する」（CLAUDE.md）を、コマンド 1 つでできるようにするため。
// 使い方: npm run shots（build してから撮る）→ shots/<大きさ>-<画面>.png と、全部を並べた shots/all.png
// 画面を足すときは、下の SCREENS に足す（open で、その画面まで操作する）。
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

// 保存キーの接頭辞（package.json の name）。初回案内の「見た」印に使う
const APP_ID = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;

/** 撮る画面。open は、ページを開いたあと、その画面を出すための操作。 */
// 本のデータ（book/data.json）が届いて目次が組み上がると、表紙の操作が効くようになる
const waitBook = async (page) => page.waitForSelector('#tocList li', { state: 'attached', timeout: 10000 });
// 画面間で状態が localStorage に残るため、撮る前に読み込み直して素の状態に戻す
const forcePageMode = async (page) => {
  await page.reload();
  await page.waitForFunction(() => globalThis.__appStarted === true);
  await waitBook(page);
};
// 目次ページへの入口は設定の「目次を開く」に一本化されている（表紙に目次ボタンはない）
const openToc = async (page) => {
  await waitBook(page);
  await page.click('#coverSettingsBtn');
  await page.click('#tocFromMenuBtn');
  await page.waitForSelector('#tocView:not([hidden])');
};
// 表面へのスワイプ（手動のページめくりはスワイプのみ。v1.13.6〜）。
// 縦書き（右綴じ）では指を右へ払う＝次へ、左へ払う＝前へ
const swipeSurface = async (page, box, dir, yRatio = 0.5) => {
  const cy = box.y + box.height * yRatio;
  const from = dir === 'next' ? 0.3 : 0.7;
  const to = dir === 'next' ? 0.75 : 0.25;
  await page.mouse.move(box.x + box.width * from, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, cy, { steps: 6 });
  await page.mouse.up();
};
const swipeGateNext = async (page) => {
  const box = await page.locator('#gateView').boundingBox();
  if (box) await swipeSurface(page, box, 'next');
};

// 目次で目的の章を選ぶ（項目が別ページにあるときは、目次を送りながら探す）。
// セレクタは E2E と同じく #tocList 内の data-idx で絞る（計測用の隠しコピーを
// 数えないため。旧実装は .toc-item の nth で数えていて最終ページ撮影が止まっていた）
const clickTocChapterShots = async (page, idx) => {
  const item = page.locator(`#tocList .toc-item[data-idx="${idx}"]`);
  for (let i = 0; i < 6 && !(await item.isVisible()); i++) {
    const box = await page.locator('#tocView').boundingBox();
    if (!box) break;
    await swipeSurface(page, box, 'next', 0.08);
    await page.waitForTimeout(250);
  }
  await item.click();
};
const openReader = async (page) => {
  await waitBook(page);
  await page.click('#earModeBtn');
  // 初めて読むときは目次から始まる（v1.12.4）。第一章を選んで扉へ。
  // しおりがあるときは扉を経由せず本文へ直接再開する（v1.13.11〜。撮影は
  // 同一コンテキストで続くため、前の画面が置いたしおりが残っていることがある）
  await page.waitForSelector('#tocView:not([hidden]), #gateView:not([hidden]), #readerView:not([hidden])', { timeout: 10000 });
  if (await page.locator('#tocView').isVisible()) {
    await page.locator('.toc-item').first().click();
    await page.waitForSelector('#gateView:not([hidden])');
  }
  // 章扉は章題コールのあと自動で本文へ進む
  await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(400);
};
const SCREENS = [
  {
    // 初回案内（音声の総容量と Wi-Fi 推奨、v1.13.0〜）。ほかの画面は「見た」状態で
    // 撮るため、この画面だけ素の状態（fresh: 別の新規コンテキスト）で開く
    name: 'dl-notice',
    fresh: true,
    open: async (page) => {
      await page.waitForSelector('#dlNotice:not([hidden])', { timeout: 10000 });
    },
  },
  { name: 'cover' },
  {
    // しおりがあるときの表紙（ボタン上の情報文が「第一章のつづきから」になる状態）。
    // しおりを置いて読み込み直す
    name: 'cover-resume',
    open: async (page) => {
      await page.evaluate(() => {
        const appId = globalThis.document.querySelector('meta[name="app-id"]')?.content || '';
        globalThis.localStorage.setItem(`${appId}-bookmark`, JSON.stringify({ chapter: 0, time: 33, title: '第一章 雨の日の客', savedAt: Date.now(), anchor: 0, page: 1 }));
      });
      await page.reload();
      await page.waitForFunction(() => globalThis.__appStarted === true);
      await waitBook(page);
      await page.waitForFunction(() => globalThis.document.getElementById('coverResume')?.textContent?.includes('つづきから'));
    },
  },
  { name: 'toc-page', open: openToc },
  {
    name: 'gate',
    open: async (page) => {
      // 扉そのものを撮るため、しおりを消して目次経由で第一章の扉へ入る
      // （しおりがあると再開で本文へ直行し、扉は出ない。v1.13.11〜）
      await page.evaluate(() => {
        const appId = globalThis.document.querySelector('meta[name="app-id"]')?.content || '';
        globalThis.localStorage.removeItem(`${appId}-bookmark`);
      });
      await page.reload();
      await page.waitForFunction(() => globalThis.__appStarted === true);
      await waitBook(page);
      await page.click('#earModeBtn');
      await page.waitForSelector('#tocView:not([hidden])');
      await page.locator('.toc-item').first().click();
      await page.waitForSelector('#gateView:not([hidden])');
    },
  },
  {
    name: 'gate2',
    open: async (page) => {
      await openToc(page);
      await page.locator('.toc-item').nth(1).click();
      await page.waitForSelector('#gateView:not([hidden])');
    },
  },
  // page1 も page-clean も現在の本文ページ（操作ボタンはページの帯に常時あるため、
  // 出し分けはしない。どちらも素の読書画面）
  {
    name: 'page1',
    open: async (page) => {
      await openReader(page);
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'page-clean',
    open: async (page) => {
      await openReader(page);
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'page2',
    open: async (page) => {
      await openReader(page);
      // 右綴じ: 次ページへは右方向のスワイプ
      const box = await page.locator('#pageWrap').boundingBox();
      await swipeSurface(page, box, 'next');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'menu',
    open: async (page) => {
      await openReader(page);
      // 設定はページ下の帯のボタンから直接開く（常時表示）
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
    name: 'final-page',
    open: async (page) => {
      await forcePageMode(page);
      await openToc(page);
      await clickTocChapterShots(page, 6);
      await swipeGateNext(page);
      await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
      const box = await page.locator('#pageWrap').boundingBox();
      for (let i = 0; i < 300; i++) {
        if ((await page.locator('#pageContent .story-end').count()) > 0) break;
        await swipeSurface(page, box, 'next');
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
      await clickTocChapterShots(page, 6);
      await swipeGateNext(page);
      await page.waitForSelector('#readerView:not([hidden])', { timeout: 10000 });
      const box = await page.locator('#pageWrap').boundingBox();
      for (let i = 0; i < 300; i++) {
        if ((await page.locator('#pageContent .story-end').count()) > 0) break;
        await swipeSurface(page, box, 'next');
        await page.waitForTimeout(40);
      }
      await swipeSurface(page, box, 'next');
      await page.waitForSelector('#endPage:not([hidden])', { timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  // 管理系は設定（表紙の「設定」）の中に集約した
  { name: 'install', open: async (page) => { await page.click('#coverSettingsBtn'); await page.click('#install-open'); } },
  { name: 'cover-menu', open: async (page) => { await page.click('#coverSettingsBtn'); } },
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
    const ctxOpts = {
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 2,
      colorScheme: size.dark ? 'dark' : 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    };
    const context = await browser.newContext(ctxOpts);
    // 撮影は「2回目以降の訪問」として進める：初回案内は見たことにしておく
    // （案内そのものは fresh の別コンテキストで撮る）
    await context.addInitScript((id) => {
      localStorage.setItem(`${id}-dl-notice-seen`, 'true');
    }, APP_ID);
    for (const screen of SCREENS) {
      const ownContext = screen.fresh ? await browser.newContext(ctxOpts) : null;
      const page = await (ownContext ?? context).newPage();
      page.on('pageerror', (e) => errors.push(`${size.name}/${screen.name}: ${e.message}`));
      await page.goto(url);
      await page.waitForFunction(() => globalThis.__appStarted === true);
      if (screen.open) await screen.open(page);
      await page.waitForTimeout(300);
      const file = `${OUT}/${size.name}-${screen.name}.png`;
      await page.screenshot({ path: file });
      files.push(file);
      await page.close();
      if (ownContext) await ownContext.close();
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
