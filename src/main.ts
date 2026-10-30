import './style.css';
import { setupDebug } from './debug';
import { showDownloadNoticeIfFirst } from './download-notice';
import { setupInstallGuide } from './install';
import type { BookData } from './logic';
import { setupUpdateBanner } from './pwa';
import { createReader, type Reader } from './reader';
import { migrateStorage, requestPersist } from './storage';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

migrateStorage();

let reader: Reader | null = null;

$('version').textContent = __APP_VERSION__;
// デバッグモード: バージョンの表示を続けて 5 回タップで切り替え。
// 操作はこの本用（最終章へ飛ぶ／しおりを消す。どちらも確認用で、読書の記録としては扱わない）
setupDebug($('debug-panel'), $('version-line'), [
  { label: '末章', title: '最終章の扉へ飛ぶ', run: () => reader?.goLastChapter() },
  { label: '消去', title: 'しおりを消す', run: () => reader?.clearBookmark() },
]);
requestPersist();
setupInstallGuide($<HTMLButtonElement>('install-open'), $<HTMLDialogElement>('install-dialog'), $<HTMLButtonElement>('install-now'));

/** Service Worker の登録と更新バナーの用意。登録すると初回の一括ダウンロード
    （音声を含む precache）が始まるため、初回案内を出す回では案内が閉じられて
    から呼ぶ（startServiceWorker 経由） */
function setupServiceWorker(): void {
  setupUpdateBanner($('update-banner'), $('update-button'), $('update-later'));
}

let swStarted = false;
function startServiceWorker(data: BookData): void {
  if (swStarted) return;
  swStarted = true;
  // 初回だけ、登録の前に「音声の総容量と Wi-Fi 推奨」の案内を挟む
  const shown = showDownloadNoticeIfFirst(
    data,
    { root: $('dlNotice'), body: $('dlNoticeBody'), close: $('dlNoticeClose') },
    setupServiceWorker,
  );
  if (!shown) setupServiceWorker();
}

// 本のデータを読み込んで、読書画面を組み立てる
fetch('book/data.json')
  .then((r) => {
    if (!r.ok) throw new Error('book/data.json ' + r.status);
    return r.json() as Promise<BookData>;
  })
  .then((data) => {
    reader = createReader(data);
    startServiceWorker(data);
  })
  .catch((err: unknown) => {
    const p = document.createElement('p');
    p.className = 'load-error';
    p.textContent = 'データの読み込みに失敗しました：' + String(err);
    document.body.appendChild(p);
    setupServiceWorker(); // データが取れなくても、更新の経路だけは生かしておく
  });

// ここまで来たら起動成功（public/boot.js が見ている）
window.__appStarted = true;
