// localStorage は使えない環境（プライベートブラウズなど）でもアプリが動くよう、必ず try/catch で囲む。
// 保存キー名を変えると利用者の記録が消える。変えるときは移行処理を書くこと。

/** 保存データの形（schemaVersion）。保存の形を変えるときは上げ、下の migrate() に移行処理を書く。
    値は従来どおり 1（記録のバックアップ機能を外したときも、保存データの形式は変えていない）。 */
export const SCHEMA_VERSION = 1;

// 保存データのキーの接頭辞。GitHub Pages では、すべてのアプリが同じサイトに載り、localStorage を共有するので、
// アプリごとに別の名前にする（package.json の name）。
const PREFIX = __APP_ID__;

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${PREFIX}-${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${PREFIX}-${key}`, JSON.stringify(value));
  } catch {
    // 保存できなくても続行する
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(`${PREFIX}-${key}`);
  } catch {
    // 消せなくても続行する
  }
}

// ブラウザに「保存データを消さないで」と頼む（消されにくくなる）
export function requestPersist(): void {
  void navigator.storage?.persist?.().catch(() => undefined);
}

// ---- 保存データの版番号と移行 ----

/** 旧・単体実装（app/）の保存キー。テンプレート構成に載せ替えるときに、記録を引き継ぐために読む。 */
const LEGACY_KEYS = {
  bookmark: 'sora-yubin-bookmark-v1',
  speed: 'sora-yubin-speed-v1',
  ruby: 'sora-yubin-ruby-v1',
} as const;

function legacyRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 保存データの形が変わったときの移行処理。from → from+1 の変換を、ここに足していく。 */
function migrate(from: number): void {
  if (from < 1) {
    // 版 0 → 1: 旧・単体実装のキー（sora-yubin-*）から、新しい接頭辞のキーへ引き継ぐ。
    // 旧キーは消さない（読み直しできるように残す）。
    const bm = legacyRaw(LEGACY_KEYS.bookmark);
    if (bm !== null && load<unknown>('bookmark', null) === null) {
      try {
        save('bookmark', JSON.parse(bm));
      } catch {
        // 壊れた旧しおりは引き継がない
      }
    }
    const sp = legacyRaw(LEGACY_KEYS.speed);
    if (sp !== null && load<unknown>('speed', null) === null) {
      const v = parseFloat(sp);
      if (isFinite(v)) save('speed', v);
    }
    const rb = legacyRaw(LEGACY_KEYS.ruby);
    if (rb !== null && load<unknown>('ruby', null) === null) {
      save('ruby', rb !== '0');
    }
  }
}

/** 起動時に一度呼ぶ。保存されている形の版が古ければ、移行してから版番号を書き直す。 */
export function migrateStorage(): void {
  const stored = load<number>('schema', 0);
  if (stored < SCHEMA_VERSION) {
    migrate(stored);
    save('schema', SCHEMA_VERSION);
  }
}

