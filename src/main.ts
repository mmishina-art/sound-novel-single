import './style.css';
import { setupDebug } from './debug';
import { setupInstallGuide } from './install';
import type { BookData } from './logic';
import { setupUpdateBanner } from './pwa';
import { createReader, type Reader } from './reader';
import { exportBackup, importBackup, migrateStorage, requestPersist } from './storage';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

migrateStorage();

let reader: Reader | null = null;

$('backup-export').addEventListener('click', () => {
  const blob = new Blob([exportBackup()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${__APP_ID__}-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$<HTMLInputElement>('backup-import').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const message = $('backup-message');
  try {
    const n = importBackup(await file.text());
    reader?.reloadSettings();
    message.textContent = `${n} 件の記録を読み込みました`;
  } catch (err) {
    message.textContent = err instanceof Error ? err.message : '読み込めませんでした';
  }
  input.value = '';
});

$('version').textContent = __APP_VERSION__;
// デバッグモード: バージョンの表示を続けて 5 回タップで切り替え。
// 操作はこの本用（最終章へ飛ぶ／しおりを消す。どちらも確認用で、読書の記録としては扱わない）
setupDebug($('debug-panel'), $('version-line'), [
  { label: '末章', title: '最終章の扉へ飛ぶ', run: () => reader?.goLastChapter() },
  { label: '消去', title: 'しおりを消す', run: () => reader?.clearBookmark() },
]);
requestPersist();
setupUpdateBanner($('update-banner'), $('update-button'), $('update-later'));
setupInstallGuide($<HTMLButtonElement>('install-open'), $<HTMLDialogElement>('install-dialog'), $<HTMLButtonElement>('install-now'));

// 本のデータを読み込んで、読書画面を組み立てる
fetch('book/data.json')
  .then((r) => {
    if (!r.ok) throw new Error('book/data.json ' + r.status);
    return r.json() as Promise<BookData>;
  })
  .then((data) => {
    reader = createReader(data);
  })
  .catch((err: unknown) => {
    const p = document.createElement('p');
    p.className = 'load-error';
    p.textContent = 'データの読み込みに失敗しました：' + String(err);
    document.body.appendChild(p);
  });

// ここまで来たら起動成功（public/boot.js が見ている）
window.__appStarted = true;
