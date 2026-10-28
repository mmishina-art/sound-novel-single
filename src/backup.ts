// 記録のバックアップ（書き出し / 読み込み）。
// localStorage の記録は、ブラウザの都合で消えることがある（特に iPhone）ので、ファイルに残せるようにする。
// 書き出すファイルには app 名と schemaVersion を入れ、別のアプリや新しすぎる版のファイルは読み込まない。

/** 保存データの形（schemaVersion）。保存の形を変えるときは上げ、storage.ts の migrate() に移行処理を書く。 */
export const SCHEMA_VERSION = 1;
export const BACKUP_APP = __APP_ID__;

export interface BackupFile {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  data: Record<string, string>;
}

export function createBackup(data: Record<string, string>, now = new Date()): string {
  const file: BackupFile = { app: BACKUP_APP, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), data };
  return JSON.stringify(file, null, 2);
}

/** ファイルの中身を検査して、保存するデータを返す。おかしいときは理由つきで例外を投げる。 */
export function parseBackup(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('バックアップファイルではありません');
  }
  const file = parsed as Partial<BackupFile> | null;
  if (!file || typeof file !== 'object' || file.app !== BACKUP_APP) throw new Error('このアプリのバックアップではありません');
  if (typeof file.schemaVersion !== 'number' || file.schemaVersion > SCHEMA_VERSION) {
    throw new Error('新しい版のバックアップです。アプリを更新してから読み込んでください');
  }
  const data = file.data;
  if (!data || typeof data !== 'object') throw new Error('バックアップの中身がありません');
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string') throw new Error(`バックアップの中身が壊れています: ${k}`);
  }
  return data;
}
