// デバッグモード（画面の確認・バランス調整用）。ふだんは隠れていて、バージョンの表示を続けて 5 回タップすると切り替わる。
// オンのときだけ、画面の左下に操作パネル（DEBUG）が出る。パネルの操作は、アプリごとに main.ts で決める。
// 保存キーは記録と分ける（`<アプリID>.debug`）。

/** デバッグモードのオン/オフの保存キー（記録のキー `<アプリID>-...` とは別の形）。 */
export const DEBUG_KEY = `${__APP_ID__}.debug`;
/** バージョンの表示を、この回数だけ続けてタップすると切り替わる（間があきすぎたら数え直す）。 */
export const DEBUG_TAPS = 5;
const TAP_GAP_MS = 1500;

let on = false;
try {
  on = localStorage.getItem(DEBUG_KEY) === '1';
} catch {
  // 使えなくても動く（オフのまま）
}

export function isDebug(): boolean {
  return on;
}

export function setDebug(value: boolean): void {
  on = value;
  try {
    if (value) localStorage.setItem(DEBUG_KEY, '1');
    else localStorage.removeItem(DEBUG_KEY);
  } catch {
    // 保存できなくても、この回は切り替わる
  }
}

/** パネルのボタン 1 つ。label は短く（1〜3 文字）、title は何をするかの説明（読み上げにも使う）。 */
export interface DebugAction {
  label: string;
  title: string;
  run(): void;
}

/**
 * デバッグモードをつなぐ。trigger（バージョンの表示）を続けて DEBUG_TAPS 回タップすると切り替わり、
 * オンのあいだだけ panel に actions のボタンと「終了」を出す。onChange は切り替わったときに呼ぶ。
 */
export function setupDebug(panel: HTMLElement, trigger: HTMLElement, actions: DebugAction[], onChange?: (on: boolean) => void): void {
  const toggle = (value: boolean): void => {
    setDebug(value);
    render();
    onChange?.(value);
  };
  const render = (): void => {
    panel.hidden = !on;
    panel.replaceChildren();
    if (!on) return;
    const title = document.createElement('span');
    title.className = 'debug-panel__title';
    title.textContent = 'DEBUG';
    panel.append(title);
    for (const a of [...actions, { label: '終了', title: 'デバッグモードを終える', run: () => toggle(false) }]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'debug-panel__button';
      b.textContent = a.label;
      b.title = a.title;
      b.setAttribute('aria-label', a.title);
      b.addEventListener('click', () => a.run());
      panel.append(b);
    }
  };

  let taps = 0;
  let last = 0;
  trigger.addEventListener('click', () => {
    const now = Date.now();
    taps = now - last > TAP_GAP_MS ? 1 : taps + 1;
    last = now;
    if (taps >= DEBUG_TAPS) {
      taps = 0;
      toggle(!on);
    }
  });
  render();
}
