// ビルド成果物（dist/）が PWA として成立しているかを確認する: npm run build のあとに実行
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };

need(existsSync(join(dist, 'index.html')), 'dist/index.html がありません（先に npm run build）');
need(existsSync(join(dist, 'sw.js')), 'dist/sw.js（Service Worker）がありません');

const manifestPath = join(dist, 'manifest.webmanifest');
if (!existsSync(manifestPath)) {
  errors.push('dist/manifest.webmanifest がありません');
} else {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  need(m.lang === 'ja', 'manifest: lang が ja ではありません');
  need(m.display === 'standalone', 'manifest: display が standalone ではありません');
  need(m.start_url === './' && m.scope === './', 'manifest: start_url / scope は ./ にしてください');
  need(m.name && m.short_name, 'manifest: name / short_name がありません');
  need(m.theme_color && m.background_color, 'manifest: theme_color / background_color がありません');
  const icons = m.icons ?? [];
  need(icons.some((i) => i.sizes === '192x192'), 'manifest: 192x192 のアイコンがありません');
  need(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'), 'manifest: 512x512 (any) のアイコンがありません');
  need(icons.some((i) => i.purpose === 'maskable'), 'manifest: maskable アイコンがありません');
  for (const i of icons) need(existsSync(join(dist, i.src)), `manifest が参照するアイコンが dist にありません: ${i.src}`);
}

// コメント内の文言で誤検知しないよう、HTML コメントは除く
const html = (existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : '').replace(/<!--[\s\S]*?-->/g, '');
for (const [re, label] of [
  [/rel="manifest"/, 'link rel=manifest'],
  [/name="theme-color"/, 'meta theme-color'],
  [/rel="apple-touch-icon"/, 'apple-touch-icon'],
  [/viewport-fit=cover/, 'viewport-fit=cover'],
]) need(re.test(html), `index.html に ${label} がありません`);
need(/id="install-open"/.test(html) && /id="install-dialog"/.test(html), '最初の画面にインストール説明の入口（#install-open と #install-dialog）がありません');
need(/id="version"/.test(html), '最初の画面にバージョン表示（#version）がありません');
need(existsSync(join(dist, 'boot.js')) && /<script src="boot.js">/.test(html) && /id="boot-error"/.test(html) && /id="boot-repair"/.test(html), '起動失敗時の復旧（boot.js と #boot-error / #boot-repair）がありません');
// アプリの ID（package.json の name）。GitHub Pages では、すべてのアプリが同じサイトに載り、
// localStorage・Service Worker・キャッシュを共有するので、アプリごとに別の名前にする。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const idMeta = /<meta name="app-id" content="([^"]*)"/.exec(html)?.[1];
need(idMeta === pkg.name, `index.html の app-id（${idMeta}）が package.json の name（${pkg.name}）と違います`);
if (pkg.pwaTemplate !== true && pkg.name === 'pwa-app') {
  errors.push('package.json の name が、テンプレートのままです（pwa-app）。アプリごとに別の名前にしてください（保存データが、ほかのアプリと混ざります）');
}
if (pkg.pwaTemplate === true && pkg.name !== 'pwa-app') {
  errors.push('package.json の name を変えたので、テンプレート用の印 "pwaTemplate" を削除してください');
}
const boot = existsSync(join(dist, 'boot.js')) ? readFileSync(join(dist, 'boot.js'), 'utf8') : '';
need(/isMyRegistration/.test(boot) && /isMyCache/.test(boot), 'boot.js の復旧が、このアプリの Service Worker とキャッシュだけに限定されていません（ほかのアプリのキャッシュまで消えます）');
// iPhone の画面の上端のぼかしを避ける（ステータスバーは不透明、上端の余白は --safe-top）
need(/name="apple-mobile-web-app-status-bar-style" content="(black|default)"/.test(html), 'apple-mobile-web-app-status-bar-style を black か default（不透明）にしてください（black-translucent だと、画面の上端がぼやけます）');
const css = existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dist, 'assets', f), 'utf8')).join('\n') : '';
need(/--safe-top/.test(css), '上端の余白（--safe-top）が CSS にありません（src/style.css の --top-gap / --safe-top を残してください）');
need(!/user-scalable=no|maximum-scale/.test(html), 'viewport で拡大を禁止しないでください（user-scalable=no / maximum-scale）');
need(!/(?:src|href)="\/(?!\/)/.test(html), 'index.html に絶対パス（/ から始まる参照）があります。相対パスにしてください');

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log('✓ dist は PWA として成立しています');
