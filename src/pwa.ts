// Service Worker の登録と「更新」ボタン。新版は待機させ、ボタンが押されたときだけ切り替える。
//
// 更新の検知は2経路ある:
//  1. 主経路: 版数ファイル（dist/version.json）の直接確認。SW の管理外のファイルを
//     cache: 'no-store' で取りに行き、自分の版数（__APP_VERSION__）と比べる。
//     SW 経由の検知（registerSW の onNeedRefresh）は、Safari が sw.js をキャッシュから
//     返して「変化なし」になることがあり、実機でバナーが出なかったため、この経路を主にした。
//  2. 副経路: 従来どおり registerSW の onNeedRefresh（待機中 SW ができたら即バナー）。
// どちらか先に気づいた方でバナーを出す（表示自体は hidden を外すだけなので重複しない）。
//
// 確認のタイミング: 起動時／前面に戻ったとき／表紙が表示されたとき（checkForUpdate）／15分ごと。
// しおり等の読書データは localStorage にある（src/storage.ts）ので、
// 更新の切り替えで再読み込みしても失われない。キャッシュ全消しも Cache Storage だけが対象。
//
// v1.13.1 の修正: 実機（iOS）で「更新ボタンが押せない」報告への対応。切り分けの結論は、
// バナーの重なり（z-index／pointer-events）は実測で正常で、タップ自体は届いていたが、
// 適用処理の最初の await registration.update() が新しい SW のインストール完了
// （precache 全体のダウンロード）まで返らず、その間は後段の保険（待機待ち・
// キャッシュ全消し再読み込み）が一切始まらず、ボタンにも何の反応も出なかったため、
// 無反応に見えていた、というもの。対策は applyUpdate 側に集約した:
// 押した瞬間のフィードバック（文言変更＋無効化）、update() の上限つき待ち、
// そして全体を覆う最後の砦のタイマー（WATCHDOG_MS）。
import { registerSW } from 'virtual:pwa-register';

/** 確認どうしの間隔の下限（切り替えのたびに問い合わせないように）。 */
const CHECK_GAP_MS = 60_000;
/** 開いたままのときの定期確認の間隔。 */
const PERIODIC_CHECK_MS = 15 * 60_000;
/** 「更新」を押したあと、SW 側の更新確認（registration.update()）を待つ上限。
    update() は新しい SW のインストール完了まで返らないことがあり、インストールは
    precache 全体のダウンロードを伴う。iOS ではここで長時間止まる（あるいは実質
    止まったままになる）ことがあり、無制限に待つと後段の保険が一切始まらず、
    ボタンが無反応に見える（v1.13.0 までの実機報告）。待つのはこの上限までで、
    見切りをつけたら待機中 SW の確認・最終手段へ進む。 */
const UPDATE_RACE_MS = 2_500;
/** 「更新」を押したあと、待機中 SW が現れるのを待つ上限。 */
const WAITING_TIMEOUT_MS = 2_500;
/** 待機中 SW へ切り替えたあと、再読み込みが起きない場合に最終手段へ進むまでの待ち。 */
const SWITCH_FALLBACK_MS = 5_000;
/** 最後の砦: 「更新」を押してからこの時間が経っても再読み込みが起きていなければ、
    どこで止まっていても最終手段（キャッシュ全消し＋再読み込み）へ強制的に進む。 */
const WATCHDOG_MS = 9_000;

let bannerEl: HTMLElement | null = null;
let applyButtonEl: HTMLButtonElement | null = null;
let laterButtonEl: HTMLButtonElement | null = null;
let registration: ServiceWorkerRegistration | undefined;
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
let lastCheckAt = 0;
let checking = false;
let applying = false;
let reloading = false;

function showBanner(): void {
  if (bannerEl) bannerEl.hidden = false;
}

/** 版数ファイルをキャッシュなしで取りに行き、自分の版数と違えばバナーを出す。取れなければ静かに諦める。 */
async function checkVersionFile(): Promise<void> {
  let latest: string | null = null;
  try {
    const res = await fetch(new URL('version.json', document.baseURI), { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as { version?: unknown };
      latest = typeof data.version === 'string' ? data.version : null;
    }
  } catch {
    // オフラインなど。いまの版のまま動く
    return;
  }
  if (latest !== null && latest !== __APP_VERSION__) {
    showBanner();
    // 適用のときに待機中 SW が居る確率を上げるため、SW 側の更新確認も促しておく
    void registration?.update().catch(() => undefined);
  }
}

/**
 * 新しい版がないか確かめる（間隔の下限つき）。
 * 起動時・前面復帰・表紙表示（reader.ts の showView）・定期タイマーから呼ばれる。
 */
export function checkForUpdate(): void {
  const now = Date.now();
  if (checking || now - lastCheckAt < CHECK_GAP_MS) return;
  lastCheckAt = now;
  checking = true;
  void checkVersionFile().finally(() => {
    checking = false;
  });
  // SW 側の検知も並行して促す（sw.js が新しくなっていれば待機中 SW ができ、onNeedRefresh が出る）
  void registration?.update().catch(() => undefined);
}

/** 待機中 SW が現れるのを待つ。既に居ればすぐ true。 */
function waitForWaitingWorker(reg: ServiceWorkerRegistration): Promise<boolean> {
  if (reg.waiting) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(!!reg.waiting), WAITING_TIMEOUT_MS);
    const done = (ok: boolean): void => {
      window.clearTimeout(timer);
      resolve(ok);
    };
    const watch = (worker: ServiceWorker | null): void => {
      if (!worker) return;
      if (worker.state === 'installed' && navigator.serviceWorker.controller) done(true);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) done(true);
      });
    };
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
  });
}

/** 最終手段: Cache Storage を全部消して再読み込みする（localStorage のしおり等は消えない）。
    古い SW が残っていても、precache はキャッシュが無ければネットワークから取り直すので新しい版になる。 */
async function hardReload(): Promise<void> {
  if (reloading) return;
  reloading = true;
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // 消せなくても再読み込みはする
  }
  window.location.reload();
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** 「更新」ボタン: まず待機中 SW への切り替えを試し、無理なら最終手段で新しい版へ移る。
    どの段でも無制限には待たない: タップした瞬間に見た目で知らせ（文言変更＋無効化）、
    最後の砦のタイマーが、どこで止まっても WATCHDOG_MS 以内に再読み込みまで運ぶ。 */
async function applyUpdate(): Promise<void> {
  if (applying) return;
  applying = true;
  // 押せたことがその場で分かるようにする（無反応と誤解されないため）
  if (applyButtonEl) {
    applyButtonEl.textContent = '更新しています…';
    applyButtonEl.disabled = true;
  }
  if (laterButtonEl) laterButtonEl.disabled = true;
  // 最後の砦: 以後の処理がどこで滞っても、時間切れで最終手段へ進む
  window.setTimeout(() => void hardReload(), WATCHDOG_MS);
  const reg = registration;
  if (reg) {
    // 更新確認は上限つきで待つ（インストール完了まで返らないことがあるため）
    await Promise.race([reg.update().catch(() => undefined), delay(UPDATE_RACE_MS)]);
    if ((await waitForWaitingWorker(reg)) && updateSW) {
      // 待機中 SW へ切り替える（切り替えが完了すると自動で再読み込みされる）
      void updateSW(true);
      // 切り替えの合図（controllerchange）が来ない環境向けの保険
      window.setTimeout(() => void hardReload(), SWITCH_FALLBACK_MS);
      return;
    }
  }
  await hardReload();
}

export function setupUpdateBanner(banner: HTMLElement, button: HTMLElement, later: HTMLElement): void {
  bannerEl = banner;
  applyButtonEl = button as HTMLButtonElement;
  laterButtonEl = later as HTMLButtonElement;
  updateSW = registerSW({
    onNeedRefresh() {
      showBanner();
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      registration = reg;
    },
  });
  button.addEventListener('click', () => {
    void applyUpdate();
  });
  // 「あとで」: この回は閉じる（次に開いたとき、また出る）
  later.addEventListener('click', () => {
    banner.hidden = true;
  });
  // ホーム画面アプリ（特に iPhone）は、閉じたつもりでも裏で開いたままのことが多く、
  // 開いたときにしか確かめないと、何日も古い版のままになる。前面に戻ったときにも確かめる
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  // 開いたままのときも定期的に確かめる
  window.setInterval(checkForUpdate, PERIODIC_CHECK_MS);
  // 起動時にまず1回
  checkForUpdate();
}
