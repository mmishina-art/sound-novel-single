// アイコンを生成する: npm run icons
// 正本は assets/logo-icon.svg（サウンド単行本の公式ロゴ：藍の角印に白抜きの
// 「音」＋開いた本＋波紋）。PNG を直接編集せず、正本差し替え→この再実行で作り直す。
// レンダリングは Chromium（@playwright/test）で行う（「音」の字はフォント描画が要るため）。
//
// 派生の作り分け（ホーム画面で印が欠けないように）:
// - icon.svg / icon-192 / icon-512（purpose: any）: 正本そのまま（透過地に角印）
// - apple-touch-icon（180px）: iOS が角を丸めるので、地を全面に広げた全面版。
//   図柄は 1.12 倍にして他アイコンと大きさを揃える
// - icon-maskable-512: Android が円・squircle 等で切り抜くので、全面版から
//   内枠を外し、図柄を 0.85 倍にして安全領域（中央 80%）に収める
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../assets/logo-icon.svg', import.meta.url), 'utf8');

// 地を全面に広げた版（印の背景 rect と質感クリップを全面に）
const SEAL_RECT = '<rect x="24" y="24" width="192" height="192" rx="27" fill="url(#gx2)"/>';
const CLIP_RECT = '<clipPath id="clipx2"><rect x="24" y="24" width="192" height="192" rx="27"/></clipPath>';
if (!src.includes(SEAL_RECT) || !src.includes(CLIP_RECT)) {
  throw new Error('assets/logo-icon.svg の構造が想定と違います（地の rect が見つかりません）');
}
const fullBleed = src
  .replace(SEAL_RECT, '<rect x="0" y="0" width="240" height="240" fill="url(#gx2)"/>')
  .replace(CLIP_RECT, '<clipPath id="clipx2"><rect x="0" y="0" width="240" height="240"/></clipPath>');

// 図柄（内枠の rect 以降）を中心基準で拡縮した版
function scaleArtwork(svg, s, cy = 122) {
  const i = svg.indexOf('<rect x="35.5"');
  if (i < 0) throw new Error('assets/logo-icon.svg の構造が想定と違います（内枠が見つかりません）');
  const tail = svg.slice(i).replace(/<\/svg>\s*$/, '');
  return `${svg.slice(0, i)}<g transform="translate(120 ${cy}) scale(${s}) translate(-120 ${-cy})">${tail}</g></svg>`;
}

// 内枠を外し、図柄（波紋以降）を拡縮した版（maskable 用）
function scaleArtworkNoFrame(svg, s) {
  const frame = /<rect x="35\.5"[^/]*\/>/;
  if (!frame.test(svg)) throw new Error('assets/logo-icon.svg の構造が想定と違います（内枠が見つかりません）');
  const noFrame = svg.replace(frame, '');
  const marker = '<g fill="none" stroke="#f7f2e7" stroke-linecap="round"><path d="M 68.0 104';
  const i = noFrame.indexOf(marker);
  if (i < 0) throw new Error('assets/logo-icon.svg の構造が想定と違います（波紋が見つかりません）');
  const tail = noFrame.slice(i).replace(/<\/svg>\s*$/, '');
  return `${noFrame.slice(0, i)}<g transform="translate(120 122) scale(${s}) translate(-120 -122)">${tail}</g></svg>`;
}

const variants = {
  'icon-192.png': { svg: src, size: 192 },
  'icon-512.png': { svg: src, size: 512 },
  'apple-touch-icon.png': { svg: scaleArtwork(fullBleed, 1.12, 120), size: 180 },
  'icon-maskable-512.png': { svg: scaleArtworkNoFrame(fullBleed, 0.85), size: 512 },
};

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const [name, { svg, size }] of Object.entries(variants)) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<!doctype html><style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.waitForTimeout(250);
  writeFileSync(new URL(name, out), await page.screenshot({ omitBackground: true }));
  await page.close();
}
await browser.close();

// favicon / manifest の SVG は正本そのまま
writeFileSync(new URL('icon.svg', out), src.endsWith('\n') ? src : src + '\n');
console.log('icons generated:', [...Object.keys(variants), 'icon.svg'].join(', '));
