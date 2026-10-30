// ビルド成果物（dist/）が PWA として成立しているかを確認する: npm run build のあとに実行
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };

need(existsSync(join(dist, 'index.html')), 'dist/index.html がありません（先に npm run build）');
need(existsSync(join(dist, 'sw.js')), 'dist/sw.js（Service Worker）がありません');

// 更新確認用の版数ファイル（src/pwa.ts が cache: 'no-store' で取りに行く）。
// package.json の版数と一致していること。古いと、公開したのに更新に気づけない。
const pkgEarly = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const versionPath = join(dist, 'version.json');
if (!existsSync(versionPath)) {
  errors.push('dist/version.json がありません（更新確認用の版数ファイル）');
} else {
  const v = JSON.parse(readFileSync(versionPath, 'utf8'));
  need(v.version === pkgEarly.version, `dist/version.json の版数（${v.version}）が package.json（${pkgEarly.version}）と違います`);
}
// 版数ファイルが SW の precache に入っていると、古い版数が返り続けて更新を検知できない
const swJs = existsSync(join(dist, 'sw.js')) ? readFileSync(join(dist, 'sw.js'), 'utf8') : '';
need(!swJs.includes('version.json'), 'sw.js の precache に version.json が含まれています（vite.config.ts の workbox.globIgnores を確認）');

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

// 外部の URL（CDN・Web フォントなど）が成果物に入っていないか。外部に頼るとオフラインで動かなくなる。
// 許すのは、通信しない文字列だけ（XML の名前空間、Workbox のエラーの説明文の URL）。
// アプリの公開 URL など、アプリごとに許すものがあれば、ここに正規表現を足す。
const ALLOWED_URL = [/^https?:\/\/www\.w3\.org\//, /^https:\/\/bit\.ly\/wb-precache$/];
const TEXT_FILE = /\.(?:html|js|css|webmanifest|json)$/;
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
if (existsSync(dist)) {
  for (const file of walk(dist).filter((p) => TEXT_FILE.test(p))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
      if (!ALLOWED_URL.some((re) => re.test(m[0]))) errors.push(`${relative(dist, file)} に外部の URL があります: ${m[0]}`);
    }
  }
}

// デザインの共通部品が全画面で使われているか（docs/DESIGN.md の約束事の機械チェック）。
// 帯を持つ画面は共通クラス（.sheet-footer / .page-footer と .page-icon-btn）で帯を
// 構成すること。画面専用の帯・ボタンを新しく作ると、ここで落ちる
const sliceFrom = (marker) => {
  const i = html.indexOf(marker);
  if (i < 0) return '';
  const rest = html.slice(i);
  const end = rest.indexOf('<section', 1);
  return end < 0 ? rest : rest.slice(0, end);
};
const tocHtml = sliceFrom('id="tocView"');
const gateHtml = sliceFrom('id="gateView"');
const readerHtml = sliceFrom('id="readerView"');
const endHtml = sliceFrom('id="endPage"');
need(tocHtml.includes('sheet-footer') && tocHtml.includes('page-icon-btn'), '目次ページの帯が共通部品（.sheet-footer / .page-icon-btn）で構成されていません');
need(gateHtml.includes('sheet-footer') && gateHtml.includes('page-icon-btn'), '扉の帯が共通部品（.sheet-footer / .page-icon-btn）で構成されていません');
need(readerHtml.includes('page-footer') && readerHtml.includes('page-icon-btn'), '本文の帯が共通部品（.page-footer / .page-icon-btn）で構成されていません');
need(endHtml.includes('sheet-footer') && endHtml.includes('endMenuBtn'), '奥付の帯が共通部品（.sheet-footer）で構成されていません');
need(!/toc-back|toc-pager|final-cover-link|finalToCoverBtn/.test(html + css), '廃止した画面専用部品（.toc-back / .toc-pager / 奥付の文字リンク）が残っています');

// 音声は「初回に全部取り込む」一括方式なので、全章の音声が SW の precache に
// 入っていることがオフライン再生の前提。1ファイルが vite.config.ts の上限
// （maximumFileSizeToCacheInBytes）を超えると、その章だけ静かに precache から
// 外れる。成果物側でも、実ファイルと sw.js の突き合わせで先に気づく
const audioDir = join(dist, 'book/audio');
if (existsSync(audioDir)) {
  const cfgText = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const capMatch = /maximumFileSizeToCacheInBytes:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(cfgText);
  need(capMatch !== null, 'vite.config.ts の maximumFileSizeToCacheInBytes が「N * 1024 * 1024」の形で読めません（precache 上限の検査ができません）');
  const cap = capMatch ? Number(capMatch[1]) * 1024 * 1024 : 0;
  for (const name of readdirSync(audioDir).filter((f) => f.endsWith('.mp3'))) {
    const size = statSync(join(audioDir, name)).size;
    need(size <= cap, `book/audio/${name}（${(size / 1048576).toFixed(1)}MB）が precache 上限（${cap / 1048576}MB）を超えています`);
    need(swJs.includes(`book/audio/${name}`), `sw.js の precache に book/audio/${name} が入っていません（上限超過で外れた可能性があります）`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log('✓ dist は PWA として成立しています');
