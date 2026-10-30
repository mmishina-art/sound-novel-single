/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

const { version, name: appId } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; name: string };

// アプリ名・色はここと index.html の2か所だけ。新しいアプリを作るときに書き換える。
const APP_NAME = '空の郵便が届くまで';
const THEME_COLOR = '#17130e';
const BACKGROUND_COLOR = '#17130e';

export default defineConfig({
  // GitHub Pages のサブパス配信でも動くよう、相対パスにする
  base: './',
  // 画面に表示するバージョン（package.json の version）
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // アプリの ID（package.json の name）。保存データのキー・バックアップの app 名・起動失敗の復旧の範囲に使う。
    // GitHub Pages では、すべてのアプリが同じサイトに載るので、アプリごとに別の名前にする。
    __APP_ID__: JSON.stringify(appId),
  },
  plugins: [
    {
      // public/boot.js（Vite を通らない）が読めるように、アプリの ID を index.html に埋め込む
      name: 'app-id-meta',
      transformIndexHtml: (html) => html.replace('__APP_ID__', appId),
    },
    VitePWA({
      // 'prompt': 新版は待機させ、画面の「更新」ボタンで切り替える（プレイ中に勝手に切り替えない）
      registerType: 'prompt',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: 'サウンド単行本：朗読つき電子書籍『空の郵便が届くまで』（著・水瀬 葵）',
        lang: 'ja',
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: THEME_COLOR,
        background_color: BACKGROUND_COLOR,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // フォント・音・画像のファイルも、オフライン用に持つ。本文データ（book/data.json）も含める
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2,mp3,json,webmanifest}'],
        // 版数ファイル（version.json）は precache しない。更新確認が古い版数を見てしまうため
        globIgnores: ['**/version.json'],
        // 章音声を precache するための上限（既定は2MB）。配信は「初回に全部
        // 取り込む」一括方式を維持する（分割・ストリーミングにはしない）ため、
        // 長い本でも章ファイルが上限に当たって静かに precache から外れることが
        // ないよう、実測に余裕を持たせて 12MB に置く。根拠（v1.13.0 で設定）:
        // 朗読は 24kHz モノラル 64kbps で、20,000字級（朗読 約68分・総量
        // 約33MB）の本では章あたり最大でも 7〜8MB 程度（7章構成の実測換算）。
        // 10MB 超の章でも通るよう、その約1.5倍に置いた。際限なく大きくは
        // しない（上限を超える章が出たら、check:dist が「章が上限を超えて
        // いる」ことを知らせるので、そこで初めて見直す）。
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
    {
      // 更新確認用の版数ファイル（dist/version.json）。アプリが cache: 'no-store' で取りに行き、
      // 自分の版数と比べる（src/pwa.ts）。Service Worker の precache には絶対に入れない
      // （入ると古い版数が返り続けて更新に気づけない）。VitePWA より後に置いて SW 生成が
      // 終わってから書き、あわせて workbox.globIgnores でも除外して二重に防ぐ。
      name: 'app-version-file',
      apply: 'build',
      closeBundle() {
        writeFileSync(new URL('./dist/version.json', import.meta.url), JSON.stringify({ version }) + '\n');
      },
    },
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
