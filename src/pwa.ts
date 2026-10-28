// Service Worker の登録と「更新」ボタン。新版は待機させ、ボタンが押されたときだけ切り替える。
import { registerSW } from 'virtual:pwa-register';

/** 前面に戻ったときに新しい版を確かめる間隔の下限（切り替えのたびに問い合わせないように）。 */
const CHECK_GAP_MS = 60_000;

export function setupUpdateBanner(banner: HTMLElement, button: HTMLElement, later: HTMLElement): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      banner.hidden = false;
    },
    // ホーム画面アプリ（特に iPhone）は、閉じたつもりでも裏で開いたままのことが多く、
    // 開いたときにしか確かめないと、何日も古い版のままになる。前面に戻ったときにも確かめる
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      let last = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || Date.now() - last < CHECK_GAP_MS) return;
        last = Date.now();
        registration.update().catch(() => {
          // オフラインなどで確かめられなくても、いまの版のまま動く
        });
      });
    },
  });
  button.addEventListener('click', () => {
    void updateSW(true);
  });
  // 「あとで」: この回は閉じる（次に開いたとき、また出る）
  later.addEventListener('click', () => {
    banner.hidden = true;
  });
}
