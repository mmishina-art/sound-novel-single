// 初回だけの案内: この本の音声の総容量と、Wi-Fi 環境でのダウンロードの推奨。
//
// 配信は「初回に全部取り込む」一括方式で、取り込みは Service Worker の登録と
// 一緒に始まる。そのため案内は登録より前に出し、閉じられてから登録する
// （main.ts がこの関数の戻り値で setupUpdateBanner の呼び方を変える）。
// 一度見たら保存キー 'dl-notice-seen' を立て、二度と出さない。
// この端末を既に SW が制御している（＝以前の版で取り込み済み）なら出さない。
import { formatAudioSize, type BookData } from './logic';
import { load, save } from './storage';

export interface DownloadNoticeEls {
  root: HTMLElement;
  body: HTMLElement;
  close: HTMLElement;
}

/** 案内を出すべき初回かどうか（保存済みの「見た」と、SW の制御状態で判定する） */
export function shouldShowDownloadNotice(): boolean {
  if (load<boolean>('dl-notice-seen', false)) return false;
  if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) return false;
  return true;
}

/**
 * 初回なら案内を出し、閉じられたら onClosed を呼ぶ。出す場合は true を返す
 * （呼び出し側は onClosed まで Service Worker の登録を遅らせること）。
 * 出さない場合は何もせず false を返す。
 */
export function showDownloadNoticeIfFirst(data: BookData, els: DownloadNoticeEls, onClosed: () => void): boolean {
  if (!shouldShowDownloadNotice()) return false;
  const size = formatAudioSize(data.totalAudioBytes);
  els.body.textContent =
    `この本は、朗読の音声といっしょにお届けします。はじめて開くときに、音声${size ? `（${size}）` : ''}をまとめて取り込みますので、` +
    'Wi-Fiにつながった環境で開かれることをおすすめします。一度取り込めば、電波の届かないところでもお読みいただけます。';
  els.root.hidden = false;
  els.close.addEventListener(
    'click',
    () => {
      els.root.hidden = true;
      save('dl-notice-seen', true);
      onClosed();
    },
    { once: true },
  );
  return true;
}
