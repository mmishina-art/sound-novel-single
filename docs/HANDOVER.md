# 引き継ぎメモ

作業の区切りごとに書き直す(次の作業を始める人や AI が、ここだけ読めば再開できるように)。古くなった内容は消し、今の状態だけを残す。

更新: 2026-10-28・版 v1.2.0

## 今の状態

- 単行本アプリ『空の郵便が届くまで』を、素の HTML/CSS/JS(app/)から **pwa-template の構成(Vite + TypeScript + vite-plugin-pwa)に載せ替え**、公開済み(https://mmishina-art.github.io/sound-novel-single/)。
- v1.0.1 の変更: (1) 表紙の縦横比を四六判(127:188)に変更。(2) 画面のアイコン最小化。(3) 章ごとの背景イメージ+オン/オフ設定。
- v1.1.0 の変更: (1) **読書用BGM**を追加（下記）。(2) **男性パートの声を差し替え**（下記）。
- v1.1.1 の変更: BGM の音量をサウンドノベル並み（朗読比 約-7dB）に引き上げ。
- v1.2.0 の変更: (1) **章背景のアニメーション**（下記）。(2) **ノンブルを常時表示**に変更（下記）。(3) **バックグラウンド再生**設定と **Media Session** 対応（下記）。
- **BGM**: 書き下ろしの静かなピアノバラード（作曲データ `src/bgm-song.ts`、BPM 60・192拍＝3分12秒ループ、再生は `src/sound.ts` が Web Audio 合成。姉妹アプリのタイトルBGMと同じ流儀で音ファイルは持たない）。ビブラート・トレモロ・スウィングなし。音量はマスターゲイン 0.84 で、実測の平均は朗読（-26.2〜-24.7dB）より約7dB下の -32.5dB（`work/measure-bgm.mjs` で再測定可）。これは姉妹アプリ『サウンドノベル』の生成型BGMの朗読比（literary 約-7.7dB／romance 約-6.4dB、再現描画は `work/measure-soundnovel-bgm.mjs`）に合わせた値で、2026-10-28 にユーザーが「サウンドノベルと同じに」と指定して変更した（当初は 0.17＝朗読比約-21dB で小さすぎた）。設定は保存キー `bgm`（既定オン、メニュー内「BGM」）。最初のタップ以降に鳴り始め、表紙→本文・章またぎでも継続。オフで即停止。
- **男性声**: 素のG（qvd_02415）は英語訛りが目立つため廃止し、**avocado_v2:MAI_03 (ja_JP)・speed 90** に差し替え（ch2・4・6 の全195文）。ピッチ/EQ なし。テンポは完成音声の実測で **300.8字/分**（全章）に調整：章ごとに atempo（ch2 0.8463 / ch4 0.8610 / ch6 0.8301）を文へ適用し、文間無音 0.3s は維持。生成は `work/gen_mai.py`（素材 `work/mai-raw/`、伸長後 `work/mai-stretched/`、記録 `work/stats-mai.json`）。旧Gの章音声は `work/muse-raw-backup-g-male-chapters/` に退避。女性章（Lily）は無変更。
- 表紙(右綴じ)→章扉→ページめくり(実測ページ割り)、全文フリガナ、速度変更、章移動・シーク、しおり(ページ位置まで保存)、章単位の音声(book/audio/ch1〜7.mp3)。
- **読書画面の操作UIは普段は非表示**。中央タップで上下にオーバーレイ表示(約3.5秒で自動消去)。常時表示は画面下端の極細の進み具合ライン(本全体のページ位置)とノンブルだけ。**ノンブルは「本の一部」として常時表示**（v1.2.0〜。紙の本のノンブルと同じ考え方で、操作UIには連動させない）。章内位置は操作表示中のみ。章扉・おわりページにはノンブルを付けない（紙の本の慣例）。ページ送りの常設矢印は廃止(タップ/スワイプ)。
- 機能の入口は「メニュー」モーダルに集約(読書画面ヘッダーの「メニュー」、表紙の控えめな「設定」ボタンの2か所から開く)。中身: 目次を開く/再生速度/フリガナ/背景イメージ/設定(バックアップ・インストール方法・バージョン)。バックアップ等は表紙からメニュー内へ移動した。
- **章背景**: `public/book/bg/ch1〜7.svg`(自作の淡い線画、画布 600×1300 で下部・隅にモチーフ)。`src/reader.ts` の layoutChapter が章ごとに `--chapter-bg` を差し込む(URL は document.baseURI 基準の絶対URLにすること。CSS 変数経由の url() はスタイルシート基準で解決され、dist では届かない)。設定は保存キー `bg`(既定オン)。オフでは `body.bg-off` で紙だけに戻る。
- **章背景のアニメーション**(v1.2.0〜): 線画の上に `#pageAnim`(`.page-anim`)の層を重ね、`src/reader.ts` の `buildPageAnim()` が章ごとに小さな動きの要素を作る。一章=雨、二章=まばらな雨+水たまりのきらめき、三章=埃の粒、四章=封筒付近の光のゆらぎ、五章=夕日の明滅+貼り紙の揺れ、六章=窓の光の帯、七章=雲+ときおり横切る鳥。動きは transform/opacity のみ・要素は最大14個。オン/オフは背景設定(`bg`)に連動し、`prefers-reduced-motion` では層ごと出さない。確認撮影は `work/shot-anim.mjs`(reducedMotion を切って撮る。`scripts/shots.mjs` は reduce なので写らない)。
- **バックグラウンド再生**(v1.2.0〜): 設定キー `bgplay`(既定オン、メニュー内「バックグラウンド再生」)。オンでは画面オフ・他アプリ切替でも朗読(`<audio>` 要素)と BGM を止めない(止める処理は元々なく、後押しとして Media Session と、BGM の AudioContext の開け直し `resumeBgmContext()` を入れた)。オフでは `visibilitychange` で隠れたら一時停止し、戻ったら(止める前が再生中だった場合だけ)再開する。BGM はバックグラウンドでタイマーが絞られても切れないよう、`src/sound.ts` の先読みを 30 秒分に広げてある。端末差: Android Chrome とホーム画面追加した PWA では画面オフでも概ね継続する。iOS Safari のタブでは Web Audio の BGM が止まることがある(朗読は比較的続く)。実機での最終確認は未実施。
- **Media Session**(v1.2.0〜): `src/reader.ts` の `setupMediaSession()` / `updateMediaMetadata()`。章ごとに title=章題、artist=著者、album=本の題、artwork=`icons/icon-192/512.png` を載せ、play/pause/前章/次章/±10秒シーク/seekto を割り当てた。playbackState と再生位置も `play`/`pause`/`timeupdate` 等で同期する。
- 資産の置き場所: 本文データは `public/book/data.json`(= `data/chapters.json` と同一内容)、表紙は `public/book/cover.svg`、音声は `public/book/audio/`。旧 `app/` は廃止した。
- 保存データは `src/storage.ts` 経由(接頭辞 `sound-novel-single-`)。旧実装のキー(`sora-yubin-*`)からは、起動時の移行処理でしおり・速度・ルビを引き継ぐ(旧キーは消さない)。
- テンプレートの共通機能: インストール方法・バージョン表示(5回タップでデバッグモード)・記録のバックアップは、いずれもメニューモーダルの中。更新バナー方式、起動失敗時の復旧(`public/boot.js`)。

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
- `src/sound.ts` は BGM 再生で使用中（効果音の beep は未使用のまま）。
- 横書き・左綴じは将来対応: `data.json` の `direction` と `src/logic.ts` の `DIR`、CSS の `body.dir-*` / `body.bound-*` が切り替え口。組版調整そのものは未実装。

## 再開のときの指示文

```
docs/HANDOVER.md と最近の変更(git log)を読んで、今の状態と最初の作業の案を出して。
```
