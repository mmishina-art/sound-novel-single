# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

PWA アプリ(ツール/ゲーム)の共通テンプレート。**新しいアプリはこのテンプレートから作り、下の共通ルールを守る。**

このリポジトリは、テンプレート(`mmishina-art/pwa-template`)に載せ替えた単行本アプリ。テンプレート由来のファイル(`src/storage.ts`・`src/backup.ts`・`src/debug.ts`・`src/install.ts`・`src/pwa.ts`・`public/boot.js`・`scripts/`・土台の設定)と、この本固有のファイル(`src/main.ts`・`src/reader.ts`・`src/logic.ts`・`public/book/`・`data/`・`manuscript/`・`work/`)を分けてある。

## このアプリの方針(新規作成時に記入)

- アプリの ID(`package.json` の `name`。**ほかのアプリと別の名前**にする。下の「同じサイトに載るアプリ」を参照): `sound-novel-single`
- アプリの概要: サウンド単行本(朗読つき電子書籍・分岐なし)のサンプル。『空の郵便が届くまで』(水瀬 葵)全7章。表紙タップで朗読開始、右綴じのページめくり表示、全文フリガナ、章ごとの音声、しおり(ページ位置まで保存)。
- 配色: 暗い固定(机の上に置いた本、という世界観。`src/style.css` と theme-color は机色 `#17130e`)
- 公開 URL: https://mmishina-art.github.io/sound-novel-single/
- 追加した拡張:
  - `vite.config.ts` の workbox: `globPatterns` に `json` を追加(本文データ `book/data.json` をオフライン用に持つため)。`maximumFileSizeToCacheInBytes` を 5MB に引き上げ(章音声が1ファイル約3〜4MBのため)。
  - `src/sound.ts` は読書用BGMの再生に使う(作曲データは本固有の `src/bgm-song.ts`。効果音の beep は未使用)。BGM の設定キーは `bgm`(既定オン)、音量は朗読の平均より約7dB下に固定(姉妹アプリ『サウンドノベル』のBGMの朗読比に合わせた値。根拠は `src/sound.ts` のコメントと `work/measure-bgm.mjs` / `work/measure-soundnovel-bgm.mjs`)。
  - 章背景にはアニメーション層(`#pageAnim`)があり、ノンブルは常時表示。バックグラウンド再生の設定(保存キー `bgplay`、既定オン)と Media Session 対応、画面を暗くしない設定(保存キー `wakelock`、既定オン。Screen Wake Lock で読書画面の間だけスリープを抑止)も `src/reader.ts` にある(詳細は `docs/HANDOVER.md`)。本を開いた直後は操作UIを自動表示しない(出すのは中央タップだけ)。
  - 男性パートの声は avocado_v2:MAI_03・speed 90 + 章ごとに決める atempo で、完成音声の実測300字/分にそろえる(`work/gen_mai.py`)。女性パートは Lily・speed 112、後処理なし。
  - デフォルトブランチは `master`(このリポジトリの従来どおり)。テンプレートの記述で `main` とあるところは `master` に読み替える。公開は GitHub Actions ではなく `gh-pages` ブランチへの手作業の反映(このリポジトリの Pages 設定がブランチ配信のため)。`pages.yml` は入れていない。
  - 本のデータ生成(`work/build_data.py` など)は Python の著作用パイプラインで、アプリのビルドとは別。生成物は `data/chapters.json` と `public/book/data.json`(同一内容)、音声は `audio/` と `public/book/audio/` に置く。音声を作り直したら `work/build_timings.py` で `unitTimes`(文ごとの実開始時刻)も作り直すこと(朗読位置の対応付けは実時刻が正で、無い場合は文字数比例の推定に落ちてずれる)。

## 基本方針

- オーナーは Claude Code での開発を学習中。変更は小さく、理由を添えて説明する。
- **実装の前に、要望の解釈を見せて、OK をもらってから進める。** 要望を受けたら、次の4つを短く示す: ①**解釈**（要望をどう受け取ったか、1〜3 行）②**やること / やらないこと**（変える範囲と、変えない範囲）③**決めた仮定**（曖昧なところに置く仮の答え。数値・名前・表示の場所など）④**確認したいこと**（なければ「なし」）。OK が出てから実装に入る。
  - **④ の確認したいことは、選択式（AskUserQuestion のボタン）で聞く**（オーナーがタッチで選んで、すぐ進められるように。おすすめを最初に置き「(Recommended)」を付ける。①〜③ は文章で短く示す）。選択式が使えないときは、「1. ○○ / 2. △△」と番号で並べて、番号で答えてもらう。
  - 例外（確認せずに進める）: 誤字の修正など解釈の余地がないもの、「そのまま進めて」と言われたとき、「マージして」「PR を作って」のような手順の指示。
- **アプリの動作・見た目が変わる実装をしたら、作業中の状態をプレビュー（Artifact）に置いて、リンクを報告に載せる。** 実装のたびに置き直し、オーナーがすぐに触って確認できるようにする。
  - `npm run build:preview` で、アプリを 1 つの HTML（`dist-preview/preview.html`）にまとめて、それを置く（画像・音・アイコンも中に入る。Service Worker は登録しない）。
  - プレビューは、本番とは別のコピーで、保存データも別。マージしたら、最新の `main` を置き直す。
  - ドキュメント（`CLAUDE.md`・README）・テスト・ツール・依存パッケージだけの変更は、置かなくてよい。
- ユーザー向けの文言・説明は日本語。コードの識別子とコミットメッセージは英語(命令形、1コミット1目的)。
- 作業は feature ブランチ → PR → CI が通ったら main にマージ。main に直接 push しない。
- **作業の状態は `docs/HANDOVER.md`(引き継ぎメモ)に残す。** 作業を始めるときに読み、区切りで書き直す(会話の記憶は途中で消えることがあるため)。
- **PR は1つの目的にする。** 他の PR の上に積まない(積むと、マージの順序と向き先の管理が大変になる)。どうしても積むときは、PR の本文に「どの PR の上か」を書き、下の PR から順にマージする。
- **デフォルトブランチは `main`。** `claude/...` などの作業ブランチを既定にしない(公開や CI の対象がずれるため)。
- 配信は GitHub Pages(サブパス配信)。参照パスは相対(`./`)にし、`/` から始めない。

## 技術スタック

Vite + TypeScript + vite-plugin-pwa + Vitest + Playwright + ESLint。UI フレームワークやバックエンドは**必要になるまで入れない**(入れたら上の「追加した拡張」に理由を書く)。

| やりたいこと | コマンド |
|---|---|
| 開発サーバー | `npm run dev` |
| 型チェック + ビルド | `npm run build`(成果物は `dist/`) |
| Lint | `npm run lint` |
| 単体テスト | `npm test` |
| 画面テスト | `npm run test:e2e`(初回は `npx playwright install chromium`) |
| PWA 成立チェック | `npm run check:dist`(build のあと) |
| まとめて確認 | `npm run verify`(lint → test → build → check:dist) |
| アイコン再生成 | `npm run icons`(色・形は `scripts/make-icons.mjs` を編集) |
| 画面の一括撮影 | `npm run shots`(`shots/` に、スマホの幅・iPhone SE・ダークモードで撮る。一覧は `shots/all.png`) |
| プレビュー(1 つの HTML) | `npm run build:preview`(`dist-preview/preview.html`。作業中の状態を Artifact に置くとき) |

**変更を終える前に `npm run verify` を通す。** 画面に関わる変更は `npm run test:e2e` も通し、`npm run dev` で実際に動かして確認する。

## 構成

- `src/logic.ts`: ルール・計算。DOM に触れない純関数にして `tests/` で単体テストする。
- `src/main.ts`: DOM の操作だけ。`src/sound.ts`(効果音)、`src/storage.ts`(保存)、`src/pwa.ts`(更新ボタン)、`src/install.ts`(インストール方法の説明)、`src/debug.ts`(デバッグモード)。
- `vite.config.ts`: アプリ名・色・manifest。`index.html` の `theme-color`・タイトルと合わせて書き換える。
- `scripts/check-dist.mjs`: ビルド成果物が PWA として成立しているかの検査。
- `scripts/shots.mjs`: 画面の一括撮影。**画面を足したら、`SCREENS` に足す**(`open` で、その画面まで操作する)。
- `scripts/build-preview.mjs`: プレビュー用に、アプリを 1 つの HTML にまとめる(本番の `dist/` とは別)。
- 画面の部品や機能を足すときは、ファイルを `src/` に分ける。Service Worker のファイル一覧は**自動生成**なので手で更新しない。

## PWA 要件(完了の定義)

- インストール可能(manifest、192/512 アイコン、**本物の maskable**、apple-touch-icon)。`npm run check:dist` が通ること。
- オフラインで起動して遊べる。
- **最初の画面(タイトル/ホーム)に、インストール方法の説明への入口を置く。** iPhone は自動のインストール案内が出ないため、手順を見せる必要がある。
  - iPhone / iPad(Safari: 共有 → ホーム画面に追加)、Android(Chrome: メニュー → アプリをインストール)、パソコン(Chrome / Edge: アドレスバーのインストールのマーク)の3つの手順を載せ、今使っている端末の説明を最初から開いておく。
  - Android / パソコンで `beforeinstallprompt` が使えるときは「今すぐインストール」ボタンも出す。
  - すでにインストールされて開いている(`display-mode: standalone`)ときは、入口を出さない。
  - テンプレートの `src/install.ts` と `index.html` の `#install-open` / `#install-dialog` を使う。`npm run check:dist` が入口の有無を確認する。
- 更新は**「更新」ボタン方式**(`registerType: 'prompt'`)。プレイ中に勝手に切り替えない。「あとで」で閉じられる(次に開いたとき、また出る)。開いたときに加えて、**アプリが前面に戻ったときにも新しい版を確かめる**(ホーム画面アプリは裏で開いたままのことが多く、開いたときだけだと古い版のままになる。`src/pwa.ts`)。
- **タイトル画面(最初の画面)にバージョンを表示する**(例: `v0.1.0`)。更新が反映されたかを、利用者がひと目で確認できるようにするため。
  - バージョンの元は `package.json` の `version` の1か所(`vite.config.ts` が `__APP_VERSION__` として埋め込み、`index.html` の `#version` に表示する)。
  - 公開のたびに `version` を上げる。Service Worker のキャッシュ名は自動生成なので、手で合わせる番号はない。
  - `npm run check:dist` が `#version` の有無を確認する。
- ユーザーデータは `src/storage.ts` 経由(`localStorage` を `try/catch` で囲む)。**保存キー名は変更しない**(記録が消える)。
  - **保存データには版番号(`schemaVersion`、`src/storage.ts` の `SCHEMA_VERSION`)を持たせる。** 保存の形を変えるときは版を上げ、`src/storage.ts` の `migrate()` に移行処理を書く(キー名を変えたまま古い記録を捨てない)。
  - **記録を残すアプリは、ファイルへの書き出し / 読み込みを用意する**(テンプレートの「記録のバックアップ」)。`localStorage` は、ブラウザの都合で消えることがある(特に iPhone)。読み込みは、別のアプリや新しすぎる版のファイルを、理由を示して断る。
    - **例外（このアプリ）**：サウンド単行本は、納品される本に記録の持ち出し機能は不要というユーザー判断により、バックアップ機能を持たない（v1.5.0 で撤去、`src/backup.ts` は無い）。保存は localStorage のまま、データ形式・版番号の扱いは上のとおり。
- **起動に失敗したときの復旧を用意する。** キャッシュ優先の Service Worker は、ファイルが食い違うと起動しなくなることがある。`public/boot.js`(メインとは別の普通のスクリプト)が、起動できなかったとき、キャッシュを消して読み込み直す(1回目は自動、2分以内の2回目は「なおす」ボタン)。保存データは消さない。**消すのは、このアプリの Service Worker とキャッシュだけ**(範囲を絞らないと、同じサイトのほかのアプリのキャッシュまで消える)。`src/main.ts` の最後で `window.__appStarted = true` にする。`npm run check:dist` が確認する。
- **同じサイトに載るアプリ: 名前をアプリごとに別にする。** GitHub Pages では、すべてのアプリが同じサイト(`mmishina-art.github.io`)に載る。`localStorage`・`sessionStorage`・Service Worker・キャッシュは、サイトの単位で共有されるので、アプリの ID(`package.json` の `name`)を、保存データのキーの接頭辞(`src/storage.ts`)・復旧の範囲(`public/boot.js`)に使い、ほかのアプリと混ざらないようにする（このアプリにはバックアップが無いので、その分の分離は不要）。**新しいアプリでは `name` を変え、テンプレート用の印 `"pwaTemplate": true` を `package.json` から削除する**(`npm run check:dist` が、どちらも確認する)。
- **外部のリソース(Web フォント、CDN のスクリプトなど)に頼らない。** オフラインで動かなくなるため。フォント・音・画像のファイルは、アプリの中に入れてキャッシュ対象(`vite.config.ts` の `globPatterns`)にし、ライセンスを README に書けば使ってよい。
- **画像・音・問題文・文章は、自作するか、ライセンスを README に明記する。** 公開するアプリなので、あとで困らないようにする。
- iPhone の安全領域(`env(safe-area-inset-*)`)を考慮する。

## デザイン

- 色は `src/style.css` の `:root` 変数に集約する。色の直書きをしない。
- 配色方針はアプリごとに1つ選ぶ(上の「このアプリの方針」)。中途半端にしない。
  - 端末設定に従う: `prefers-color-scheme: dark` で変数を再定義(テンプレートの既定)
  - 明るい固定: `color-scheme: light only` と `<meta name="color-scheme" content="light only">`
  - 暗い固定: 世界観重視のゲーム向け。`theme-color` / `background_color` も暗い色に
- `[hidden] { display: none !important; }` を残す。
- スマホ縦画面を基準(`max-width` 480px で中央寄せ)。タップ領域は 44px 以上。
- ズーム: ピンチ拡大は許可し、ダブルタップ拡大だけ `touch-action: manipulation` で防ぐ。viewport に `user-scalable=no` / `maximum-scale` を入れない(`check:dist` が検出する)。
- `prefers-reduced-motion: reduce` でアニメーションを無効化する。
- アクセシビリティ: 結果は `aria-live` 領域でも読み上げる。ボタンに `aria-label` / `aria-pressed`。色だけで状態を伝えない。
- 効果音は Web Audio で合成するのが基本(音のファイルを使うなら、上の「外部のリソース」のとおり)。オン/オフ設定を必ず用意する。
- **iPhone の画面の上端(ぼかしの帯)を避ける。** ホーム画面アプリで、ステータスバーの下に内容が入り込むと、iOS がそこをぼかして、上端の文字が読みにくくなる(`simple_chess`・`simple_blackjack`・`simple_shogi` で起きた)。
  - `index.html` の `apple-mobile-web-app-status-bar-style` は、**不透明**にする(暗い固定・端末設定に従う: `black` / 明るい固定: `default`)。**`black-translucent` にしない。**
  - 上端の余白は、`src/style.css` の `--safe-top`(`env(safe-area-inset-top)` + `--top-gap` の 24px)を使う。**`env(safe-area-inset-top)` だけにしない。**
  - `min-height: calc(100dvh - …)` のように、画面の高さから上の余白を引いて計算しているところは、**上端の余白と同じ式で連動させる**(忘れると、ぴったり収まっていた画面がはみ出して、スクロールするようになる)。
  - `npm run check:dist` と `tests/top-edge.test.ts` が確認する。
  - ブラウザでは、ステータスバーまわりを再現できない。**実機の iPhone で、上端の文字がぼやけていないか確認する。** 画面は、小さい画面(iPhone SE の大きさ)と iPhone 14 の大きさで、スクロールが増えていないことも確認する。

## デバッグモード

- 画面の確認やバランス調整のための、隠れた操作(`src/debug.ts`)。**バージョンの表示を続けて 5 回タップ**で切り替わり、オンのあいだだけ左下に操作パネル(DEBUG)が出る。「終了」で消える。
- パネルの操作は、アプリごとに `src/main.ts` の `setupDebug(...)` に足す(例: 所持金を最大にする、すぐ勝つ、次の画面へ飛ぶ)。
- **デバッグの操作を使った回は、記録を残さない**(ふつうに遊んだ記録と混ざらないように。テンプレートの `cheated`)。
- オン/オフの保存キーは `<アプリID>.debug` で、記録(`<アプリID>-...`)とは別（このアプリにはバックアップ機能自体が無い）。バージョン表示（デバッグ入口）は表紙画面の下部中央に置く（v1.5.0〜v1.6.0 は右下隅、v1.7.0 で中央へ移設）。
- README に入り方を書く。

## 画面の確認

- 画面を変えたら、**スマホの幅**・**小さい画面(iPhone SE の大きさ)**・**ダークモード**(対応しているアプリ)で、実際に表示して確認する(スクリーンショットを見る)。`npm run shots` で、主な画面をまとめて撮れる(`shots/all.png` で見比べる。画面でエラーが出たら失敗する)。文字の折り返し、はみ出し、ボタンの表示崩れは、コードを読むだけでは気づきにくい。
- `hidden` 属性で隠す要素は、`display` を指定したクラスに負けないか確認する(`[hidden] { display: none !important; }` を残す)。
- PR の本文に、確認したこと(画面サイズ、実機か、していないか)を書く。実機で確認できていないことは、そう書く。

## テスト

- ロジックは純関数にして Vitest で単体テストする(`tests/*.test.ts`)。
- 画面操作は Playwright(Pixel 7、`reducedMotion: 'reduce'` が既定)。build 済みの成果物を `vite preview` で配信してテストする。乱数は固定する。アニメーションを見るテストだけ `test.use({ reducedMotion: 'no-preference' })` で解除し、短命な中間状態は直接 assert せず `MutationObserver` で記録する。効果音は `app:sound` イベントで確認する。
- データ駆動のアプリ(クイズなど)は、データの検証テストを書く(件数、重複、必須項目)。

## 入力と表示

- **利用者が入力した文字(名前など)は、`textContent` で表示する。`innerHTML` に入れない。** 意図しないタグが動くのを防ぐ。ESLint が `src/` での `innerHTML` / `outerHTML` への代入を止める。固定の HTML を組み立てる必要があるときは、その行に `eslint-disable` と理由を書く。
- 外部へ送信しない。個人情報を扱わない(記録は端末の中だけ)。

## CI(GitHub Actions)

- `test.yml`: main への push と全 PR で lint / 単体テスト / build / check:dist / E2E。
- `pages.yml`: main への push で、**テストが通ったときだけ** `dist/` を公開。作業ブランチは公開されない。
- GitHub の Settings → Pages で Source を「GitHub Actions」にしておく(初回のみ)。
- `main` はブランチ保護(Rulesets)で守る: PR を通すこと、`check` と `e2e` が通ることを必須にする(手順は README の「新しいアプリの作り方」)。
- **依存パッケージと Actions の更新は Dependabot に任せる**(`.github/dependabot.yml`)。更新の PR は、CI が緑なのを確認してからマージする。
  - 同時に更新しないと組み合わせられないパッケージ(`vite`・`vitest`・`vite-plugin-pwa`)は、1つの PR にまとめる設定になっている。別々の PR だと CI が失敗する。
  - `typescript` のメジャー更新は、typescript-eslint が対応する(peer の範囲に入る)まで見送る(`dependabot.yml` の `ignore`。対応したら外す)。`@types/node` のメジャーは、CI の Node のメジャーに合わせる(Node を上げるときにいっしょに上げる)。
  - 更新の PR が失敗したら、閉じる前に、失敗の理由(`gh run view --log-failed`)を確認する。依存の順序の問題のこともある。

## Lint

ESLint(flat config)+ typescript-eslint。フォーマッタは入れない(オーナーの方針)。

## README

アプリの公開 URL、遊び方/機能、起動方法、ファイル構成、デバッグモードの入り方(ある場合)を書く。
