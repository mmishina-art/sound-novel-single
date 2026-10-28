// プレビュー用に、アプリを 1 つの HTML ファイルにまとめる（Claude が作業中の状態を Artifact に置くため）。
// 本番のビルド（dist/）とは別。Service Worker は登録せず、起動失敗の復旧（boot.js）も入れない。
// 保存データ（localStorage）は、プレビューの置き場所ごとに別になる（本番の記録には触れない）。
// 使い方: npm run build:preview → dist-preview/preview.html
import { build } from 'vite';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const OUT = 'dist-preview';
const { version, name: appId } = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  configFile: false,
  base: './',
  publicDir: false,
  logLevel: 'warn',
  define: { __APP_VERSION__: JSON.stringify(version), __APP_ID__: JSON.stringify(appId) },
  plugins: [
    {
      // アプリの ID を埋め込み、起動失敗の復旧（Service Worker のキャッシュを消す boot.js）は、プレビューでは外す
      name: 'preview-html',
      transformIndexHtml: { order: 'pre', handler: (html) => html.replace('__APP_ID__', appId).replace(/<script src="boot\.js"><\/script>\s*/, '') },
    },
    {
      // Service Worker の登録（更新ボタン）は、プレビューでは何もしない
      name: 'pwa-register-stub',
      resolveId: (id) => (id === 'virtual:pwa-register' ? '\0pwa-register-stub' : null),
      load: (id) => (id === '\0pwa-register-stub' ? 'export function registerSW() { return async () => {}; }' : null),
    },
  ],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000, // 画像・音も 1 つのファイルに入れる
  },
});

const assets = join(OUT, 'assets');
const files = existsSync(assets) ? readdirSync(assets) : [];
const read = (f) => readFileSync(join(assets, f), 'utf8');
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const dataUri = (path) => `data:${MIME[extname(path)] ?? 'application/octet-stream'};base64,${readFileSync(path).toString('base64')}`;

let html = readFileSync(join(OUT, 'index.html'), 'utf8')
  // アイコン（public/ のファイル）は、ファイルの中に埋め込む
  .replace(/href="(icons\/[^"]+)"/g, (m, p) => (existsSync(join('public', p)) ? `href="${dataUri(join('public', p))}"` : m))
  // CSS と JS を、ファイルの中に埋め込む（</script> は文字列の中でも閉じタグになるので、エスケープする）
  .replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/([^"]+)"[^>]*>/g, (_, f) => `<style>${read(f)}</style>`)
  .replace(/<script type="module"[^>]*src="\.\/assets\/([^"]+)"[^>]*><\/script>/g, (_, f) => `<script type="module">${read(f).replace(/<\/script/g, '<\\/script')}</script>`);

const left = files.filter((f) => html.includes(`assets/${f}`));
if (left.length) throw new Error(`埋め込めなかったファイルがある: ${left.join(', ')}`);
writeFileSync(join(OUT, 'preview.html'), html);
console.log(`${OUT}/preview.html (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
