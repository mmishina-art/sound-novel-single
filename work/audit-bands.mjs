// 下帯ルール（v1.13.7）の実測監査：
// 各章の1ページ目を開き、(a) 帯の表示高さ比 (b) 本体の上限位置 (c) 本文の
// 最下行の位置をページ高さ比で測る。あわせて最終ページのノンブルから
// 総ページ数を記録する。スクリーンショットは work/audit-bands/ に残す。
// 使い方: npm run build のあと node work/audit-bands.mjs
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { mkdirSync, rmSync } from 'node:fs';

// 生成パラメータ（work/split-bg-bands.py の出力と対）: [cut, bodyStart]（地絵の行比）
const PARAMS = {
  1: [0.720, 0.800], 2: [0.715, 0.795], 3: [0.748, 0.828], 4: [0.803, 0.890],
  5: [0.700, 0.780], 6: [0.675, 0.762], 7: [0.675, 0.762],
};

const OUT = new URL('./audit-bands/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = await preview({ preview: { port: 4173 } });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

const waitBook = () => page.waitForSelector('#tocList li', { state: 'attached', timeout: 15000 });
const swipeSurface = async (loc, dir, yRatio = 0.5) => {
  const box = await loc.boundingBox();
  const cy = box.y + box.height * yRatio;
  const from = dir === 'next' ? 0.3 : 0.7;
  const to = dir === 'next' ? 0.75 : 0.25;
  await page.mouse.move(box.x + box.width * from, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, cy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(350);
};

await page.goto('http://localhost:4173/');
await page.waitForFunction(() => globalThis.__appStarted === true);
await waitBook();

// 初回案内（容量・Wi-Fi）が出ていたら閉じる
const dismissNotice = async () => {
  const close = page.locator('#dlNoticeClose');
  if (await close.isVisible().catch(() => false)) await close.click();
};

const results = [];
for (let idx = 0; idx < 7; idx++) {
  // 状態を素に戻す
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => globalThis.__appStarted === true);
  await waitBook();
  await dismissNotice();
  // 目モードで表紙→目次→章の扉→本文1ページ目
  await page.click('#eyeModeBtn');
  await page.waitForSelector('#tocView:not([hidden])');
  const item = page.locator(`#tocList .toc-item[data-idx="${idx}"]`);
  for (let i = 0; i < 6 && !(await item.isVisible()); i++) {
    await swipeSurface(page.locator('#tocView'), 'next', 0.08);
  }
  await item.click();
  await page.waitForSelector('#gateView:not([hidden])');
  await swipeSurface(page.locator('#gateView'), 'next');
  await page.waitForSelector('#readerView:not([hidden])');
  await page.waitForTimeout(400);

  const m = await page.evaluate(async () => {
    const pageEl = document.querySelector('.page');
    const wrap = document.querySelector('.page-wrap');
    const content = document.querySelector('#readerView .page-content');
    const pr = pageEl.getBoundingClientRect();
    // 本文の最下点（全テキストノードの矩形の最大 bottom）
    let maxBottom = 0;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT_NODE);
    const range = document.createRange();
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) maxBottom = Math.max(maxBottom, r.bottom);
    }
    // 帯画像の実寸から表示高さを求める
    const bgVar = getComputedStyle(wrap).getPropertyValue('--chapter-bg-bottom');
    const url = /url\("?([^")]+)"?\)/.exec(bgVar)?.[1];
    let band = null;
    if (url) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const dispH = (pr.width * img.naturalHeight) / img.naturalWidth;
      band = { url, nw: img.naturalWidth, nh: img.naturalHeight, pct: (dispH / pr.height) * 100 };
    }
    return {
      textBottomPct: ((maxBottom - pr.top) / pr.height) * 100,
      band,
    };
  });
  const [cut, bodyStart] = PARAMS[idx + 1];
  const bodyPct = m.band ? m.band.pct * ((1 - bodyStart) / (1 - cut)) : null;
  const bodyTopPct = bodyPct !== null ? 100 - bodyPct : null;
  results.push({ ch: idx + 1, ...m, bodyPct, bodyTopPct });
  await page.screenshot({ path: `${OUT}ch${idx + 1}-p1.png` });
  console.log(
    `ch${idx + 1}: 帯=${m.band?.pct.toFixed(1)}% 本体=${bodyPct?.toFixed(1)}%（上限位置 ${bodyTopPct?.toFixed(1)}%） 本文最下=${m.textBottomPct.toFixed(1)}%`,
  );
  // 表紙へ戻る（メニュー経由）
  await page.click('#menuBtn');
  await page.click('#toCoverFromMenuBtn');
  await page.waitForSelector('#coverView:not([hidden])');
}

// 総ページ数：目モードで最終章の最終ページまで送り、ノンブルを読む
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => globalThis.__appStarted === true);
await waitBook();
await dismissNotice();
await page.click('#eyeModeBtn');
await page.waitForSelector('#tocView:not([hidden])');
const last = page.locator('#tocList .toc-item[data-idx="6"]');
for (let i = 0; i < 6 && !(await last.isVisible()); i++) {
  await swipeSurface(page.locator('#tocView'), 'next', 0.08);
}
await last.click();
await page.waitForSelector('#gateView:not([hidden])');
await swipeSurface(page.locator('#gateView'), 'next');
await page.waitForSelector('#readerView:not([hidden])');
for (let i = 0; i < 40; i++) {
  const ended = await page.evaluate(() => !!document.querySelector('#readerView .story-end'));
  if (ended) break;
  await swipeSurface(page.locator('#readerView .page-wrap'), 'next');
}
const folio = await page.locator('#readerView .page-footer').innerText();
console.log(`総ページ数（最終ページのノンブル）: ${folio.trim()}`);
await page.screenshot({ path: `${OUT}ch7-last.png` });

await browser.close();
server.httpServer.close();
