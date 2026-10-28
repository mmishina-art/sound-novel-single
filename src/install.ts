// 最初の画面に置く「インストール方法」の説明。
// iPhone は自動のインストール案内が出ないので、手順を見せる必要がある。
// Android / パソコンの Chrome・Edge は `beforeinstallprompt` が使えるときだけ「今すぐインストール」を出す。

export type Platform = 'ios' | 'android' | 'pc';

/** 端末の種類を判定する。iPadOS は Mac を名乗るので、タッチ操作できる Mac は iPad とみなす。 */
export function detectPlatform(userAgent: string, platform = '', maxTouchPoints = 0): Platform {
  if (/iphone|ipad|ipod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  if (/android/i.test(userAgent)) return 'android';
  return 'pc';
}

/** すでにインストールされ、アプリとして開かれているか */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function setupInstallGuide(
  openButton: HTMLButtonElement,
  dialog: HTMLDialogElement,
  installNowButton: HTMLButtonElement,
): void {
  // インストール済みのアプリの中では、入口を出さない
  if (isStandalone()) {
    openButton.hidden = true;
    return;
  }

  let deferred: BeforeInstallPromptEvent | null = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    installNowButton.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installNowButton.hidden = true;
    openButton.hidden = true;
    if (dialog.open) dialog.close();
  });
  installNowButton.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    installNowButton.hidden = true;
  });

  openButton.addEventListener('click', () => {
    // 今使っている端末の説明を最初から開いておく
    const mine = detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    dialog.querySelectorAll<HTMLDetailsElement>('details[data-platform]').forEach((d) => {
      d.open = d.dataset.platform === mine;
    });
    dialog.showModal();
  });
  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
}
