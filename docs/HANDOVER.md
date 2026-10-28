# 引き継ぎメモ

作業の区切りごとに書き直す(次の作業を始める人や AI が、ここだけ読めば再開できるように)。古くなった内容は消し、今の状態だけを残す。

更新: 2026-10-28・版 v1.0.0

## 今の状態

- 単行本アプリ『空の郵便が届くまで』を、素の HTML/CSS/JS(app/)から **pwa-template の構成(Vite + TypeScript + vite-plugin-pwa)に載せ替え**、公開済み(https://mmishina-art.github.io/sound-novel-single/)。
- 画面と振る舞いは載せ替え前と同じ: 表紙(右綴じ)→章扉→ページめくり(実測ページ割り)、全文フリガナ、速度変更、章移動・シーク、しおり(ページ位置まで保存)、章単位の音声(book/audio/ch1〜7.mp3)。
- 資産の置き場所: 本文データは `public/book/data.json`(= `data/chapters.json` と同一内容)、表紙は `public/book/cover.svg`、音声は `public/book/audio/`。旧 `app/` は廃止した。
- 保存データは `src/storage.ts` 経由(接頭辞 `sound-novel-single-`)。旧実装のキー(`sora-yubin-*`)からは、起動時の移行処理でしおり・速度・ルビを引き継ぐ(旧キーは消さない)。
- テンプレートの共通機能が入った: インストール方法の入口(表紙)、バージョン表示(表紙、5回タップでデバッグモード)、記録のバックアップ(表紙)、更新バナー方式、起動失敗時の復旧(`public/boot.js`)。

## やりかけ

- なし

## 次にやること(優先順)

1. 実機(iPhone)で上端の文字のぼやけと、ホーム画面追加後の表示を確認する(ブラウザでは再現できない)。
2. 制作声(Leda/Charon)への差し替えは、音声ファイルを `public/book/audio/` に差し替えるだけ(Gemini 側の日次上限の回復待ち。素材は `audio/gemini/` と `work/raw/` に保管)。

## 注意・気づいたこと

- 公開は `gh-pages` ブランチへの手作業反映(このリポジトリの Pages 設定はブランチ配信)。手順: `npm run build` → `dist/` の中身を gh-pages のルートに置いて push(`.nojekyll` を含める)。テンプレート標準の GitHub Actions 配信(`pages.yml`)は使っていない。
- デフォルトブランチは `master`。CLAUDE.md の `main` は `master` に読み替える。
- 章音声は1ファイル約3〜4MB。precache の上限を `vite.config.ts` で 5MB に上げてある(下げると音声がオフライン対象から外れる)。
- `npm run build:preview`(1つの HTML)は、本文データと音声が `public/` の別ファイル参照のため、プレビュー内では本が開けない(既知の制限)。確認は公開 URL か `npm run shots` で行う。
- `src/sound.ts` はテンプレート由来で未使用(この本に効果音はない)。
- 横書き・左綴じは将来対応: `data.json` の `direction` と `src/logic.ts` の `DIR`、CSS の `body.dir-*` / `body.bound-*` が切り替え口。組版調整そのものは未実装。

## 再開のときの指示文

```
docs/HANDOVER.md と最近の変更(git log)を読んで、今の状態と最初の作業の案を出して。
```
