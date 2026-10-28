import { describe, expect, it } from 'vitest';
import { BACKUP_APP, SCHEMA_VERSION, createBackup, parseBackup } from '../src/backup';

const NOW = new Date('2026-10-12T00:00:00Z');

describe('バックアップの書き出しと読み込み', () => {
  it('書き出した内容を、そのまま読み込める', () => {
    const data = { 'pwa-app-best': '7', 'pwa-app-sound': 'true' };
    expect(parseBackup(createBackup(data, NOW))).toEqual(data);
  });

  it('app 名と schemaVersion と日時が入っている', () => {
    const file = JSON.parse(createBackup({}, NOW));
    expect(file).toMatchObject({ app: BACKUP_APP, schemaVersion: SCHEMA_VERSION, exportedAt: NOW.toISOString() });
  });

  it('JSON ではないファイルは読み込まない', () => {
    expect(() => parseBackup('これは JSON ではない')).toThrow('バックアップファイルではありません');
  });

  it('別のアプリのバックアップは読み込まない', () => {
    const other = JSON.stringify({ app: 'other-app', schemaVersion: 1, data: {} });
    expect(() => parseBackup(other)).toThrow('このアプリのバックアップではありません');
  });

  it('新しすぎる版のバックアップは、アプリの更新を促して読み込まない', () => {
    const newer = JSON.stringify({ app: BACKUP_APP, schemaVersion: SCHEMA_VERSION + 1, data: {} });
    expect(() => parseBackup(newer)).toThrow('アプリを更新');
  });

  it('中身が文字列でない値は、壊れているとして読み込まない', () => {
    const broken = JSON.stringify({ app: BACKUP_APP, schemaVersion: SCHEMA_VERSION, data: { 'pwa-app-best': 7 } });
    expect(() => parseBackup(broken)).toThrow('壊れています');
  });
});
