// 読書画面まわり（表紙・章扉・ページめくり・朗読・しおり）の DOM 操作。
// 純粋な計算は logic.ts、保存は storage.ts に寄せ、ここは画面と音声の段取りだけを持つ。
import {
  SPEEDS,
  buildUnits,
  directionOf,
  groupClass,
  pageForChar,
  rubyToHtml,
  speedIndexOf,
  speedLabel,
  type BookData,
  type Bookmark,
  type ChapterData,
  type Direction,
  type Page,
  type Unit,
} from './logic';
import { isBgmOn, resumeBgmContext, setBgmOn, startBgm, stopBgm } from './sound';
import { load, remove, save } from './storage';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

/** 第七章の背景で、ときおり横切る鳥（線画の鳥の形を塗ったもの） */
const BIRD_SVG =
  '<svg viewBox="-90 -60 180 110" aria-hidden="true"><path d="M -78 18 Q -30 -38 28 -22 Q 62 -52 88 -30 Q 48 -18 38 2 Q 70 8 78 28 Q 38 22 10 34 Q -28 52 -58 40 Q -30 28 -78 18 Z" fill="rgba(107,90,51,.5)"/></svg>';

/** Screen Wake Lock の最小限の型（lib.dom に無い環境でも使えるよう、必要分だけ宣言する） */
export interface WakeLockSentinelLike extends EventTarget {
  release(): Promise<void>;
}
export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** 本文の HTML は、自作の原稿データ（data.json）を rubyToHtml でエスケープしながら組み立てた固定のものだけを入れる */
function setHtml(el: HTMLElement, html: string): void {
  // eslint-disable-next-line no-restricted-syntax -- 理由: 上記のとおり、外部入力ではなく自作データからの固定 HTML のため
  el.innerHTML = html;
}

export interface Reader {
  /** デバッグ用: 最終章の扉へ飛ぶ */
  goLastChapter(): void;
  /** デバッグ用: しおりを消す */
  clearBookmark(): void;
}

export function createReader(book: BookData): Reader {
  const chapters: ChapterData[] = book.chapters || [];
  const DIR: Direction = directionOf(book.direction);
  document.body.classList.add('dir-' + DIR.mode, 'bound-' + DIR.bound);
  document.title = book.title + ' — ' + book.author;

  const coverView = $('coverView');
  const gateView = $('gateView');
  const tocView = $('tocView');
  const readerView = $('readerView');
  const pageWrap = $('pageWrap');
  const pageEl = $('pageEl');
  const pageAnim = $<HTMLDivElement>('pageAnim');
  const pageContent = $('pageContent');
  const audio = $<HTMLAudioElement>('audioEl');
  /* 章題コール専用の要素（扉で「第N章・題・語り手名」を読む短い音声）。
     本文音声とは別要素で鳴らすため、本文の文字位置⇔時刻の対応やしおりの時刻には
     一切影響しない。音声ファイルは事前生成（work/gen_title_calls.py） */
  const gateAudio = $<HTMLAudioElement>('gateAudio');
  function stopGateCall(): void {
    gateAudio.onended = null;
    gateAudio.onerror = null;
    if (!gateAudio.paused) gateAudio.pause();
  }
  const audioError = $('audioError');
  const headerEl = document.querySelector<HTMLElement>('.reader-header');
  const playerEl = document.querySelector<HTMLElement>('.player');

  /* ---- 状態 ---- */
  let current = 0;
  let speedIdx = speedIndexOf(load<number>('speed', 1.0));
  let gateTimer: ReturnType<typeof setTimeout> | undefined;
  let gateOpen = false; // 章扉を表示中かどうか（旧章の音声の 'ended' で二重に進まないための番兵）
  // 「前へ辿る」モードの扉（showGateBack）は専用フラグを持たず、自動タイマーを
  // 張らないことと、専用の onclick で通常の扉と区別する
  let pendingSeek = 0;
  const UNITS: Unit[][] = chapters.map((ch) => buildUnits(ch));
  const CH_CHARS: number[] = UNITS.map((us) => us.reduce((a, u) => a + u.len, 0));
  /* 本文の最終ページで、最後の文のあとに改列して置く「おわり」。
     流れに混ぜると列をまたいで割れるため、独立したブロックとして置き、
     その列の中央に寄せる */
  const END_MARK_HTML = '<p class="story-end">おわり</p>';
  /* 独立した奥付ページを開いているかどうか。本文の最終ページの次に置く、
     本のいちばん最後のページで、扉と同じく非本文ページの扱い */
  let endOpen = false;
  /* 文単位の描画（朗読中の文の強調に使う。ページ計測と描画で同じHTMLにする） */
  function unitHtml(u: Unit): string {
    return '<span class="unit">' + rubyToHtml(u.html) + '</span>';
  }
  let PAGES: Page[][] = [];
  let CUM_PAGES: number[] = [];
  let TOTAL_PAGES = 0;
  let pageSizeKey = '';
  let curPage = 0;

  let lastManualTurn = 0;
  /* 表示方式：'page'＝ページ形式（従来）／'karaoke'＝カラオケ方式。
     カラオケ方式は、ページ割りはページ形式と共通のまま、朗読の進行に合わせて
     文が1つずつ姿を現す（まだ読まれていない文は完全に見えない）。
     ページ割りが共通なので、切り替えても読んでいる位置（章・文・しおり）は失われない。
     ※ v1.6.0 のセンテンス形式（2〜3文の塊）は v1.7.0 で廃止し、カラオケ方式に置き換えた */
  let displayMode: 'page' | 'karaoke' = 'page';
  function setDisplayMode(mode: 'page' | 'karaoke'): void {
    if (mode === displayMode) return;
    let anchor = currentAnchorChar();
    const total = CH_CHARS[current] || 0;
    if (total && isFinite(audio.duration) && audio.duration > 0) {
      anchor = Math.floor((audio.currentTime / audio.duration) * total);
    }
    displayMode = mode;
    save('display', mode);
    document.body.classList.toggle('mode-karaoke', mode === 'karaoke');
    $('displayModeBtn').textContent = mode === 'page' ? 'ページ形式' : 'カラオケ方式';
    if (!readerView.hidden && PAGES.length) {
      curPage = pageForChar(PAGES[current], anchor);
      if (mode === 'karaoke') karaokeIdx = unitIndexForChar(current, anchor);
      renderPage(0);
      refreshTocCurrent();
      saveBookmark();
    }
  }
  /* ---------- カラオケ方式の状態 ----------
     karaokeIdx＝いま読まれている文の、章通しでの番号。表示中のページの各文は、
     この番号より後なら隠し（.k-hide）、以前と本人は見せる */
  let karaokeIdx = 0;
  let pageUnitIdx: number[] = []; // 表示中ページの各文の、章通しでの番号（renderPage が埋める）
  function unitIndexForChar(chIdx: number, charPos: number): number {
    const units = UNITS[chIdx];
    let pos = 0;
    for (let i = 0; i < units.length; i++) {
      if (charPos < pos + units[i].len) return i;
      pos += units[i].len;
    }
    return units.length - 1;
  }
  function unitStartChar(chIdx: number, unitIdx: number): number {
    const units = UNITS[chIdx];
    let pos = 0;
    for (let i = 0; i < unitIdx && i < units.length; i++) pos += units[i].len;
    return pos;
  }
  /* 朗読位置から karaokeIdx を更新し、出現状態を画面へ反映する。
     ただし、手動ステップのシークが保留中（デバウンスの間）は、音声位置から
     逆算しない（連打した分が、まだ古い位置にいる音声に上書きされて消えてしまうため） */
  let karaokeSeekPending = false;
  function updateKaraoke(): void {
    if (displayMode !== 'karaoke') return;
    if (!karaokeSeekPending && isFinite(audio.duration) && audio.duration > 0) {
      const total = CH_CHARS[current] || 0;
      if (total) {
        const target = Math.floor((audio.currentTime / audio.duration) * total) + 1; // 境界の往復誤差対策（他と同）
        karaokeIdx = unitIndexForChar(current, Math.min(target, total - 1));
      }
    }
    applyKaraokeReveal();
  }
  function applyKaraokeReveal(): void {
    if (displayMode !== 'karaoke') return;
    const spans = pageContent.querySelectorAll('.unit');
    spans.forEach((sp, i) => {
      sp.classList.toggle('k-hide', (pageUnitIdx[i] ?? 0) > karaokeIdx);
    });
    // 「おわり」は、最後の文が読まれるまで隠す
    const end = pageContent.querySelector('.story-end');
    if (end) end.classList.toggle('k-hide', karaokeIdx < UNITS[current].length - 1);
  }
  /* 朗読中の文の強調：現ページの各文の文字範囲と、強調中の文番号 */
  let pageUnitRanges: { start: number; len: number }[] = [];
  let nowUnitIdx = -1;
  function updateNowHighlight(): void {
    if (!pageUnitRanges.length || !isFinite(audio.duration) || audio.duration <= 0) return;
    const total = CH_CHARS[current] || 0;
    if (!total) return;
    const target = Math.floor((audio.currentTime / audio.duration) * total) + 1; // 境界の往復誤差対策に +1（syncPageToAudio と同じ）
    let idx = -1;
    for (let i = 0; i < pageUnitRanges.length; i++) {
      const r = pageUnitRanges[i];
      if (target >= r.start && target < r.start + r.len) {
        idx = i;
        break;
      }
    }
    if (idx === nowUnitIdx) return;
    const prev = pageContent.querySelector('.unit.now');
    if (prev) prev.classList.remove('now');
    nowUnitIdx = idx;
    if (idx >= 0) {
      const spans = pageContent.querySelectorAll('.unit');
      if (spans[idx]) spans[idx].classList.add('now');
    }
  }
  let enterStamp = 0;
  let measurer: HTMLDivElement | null = null;

  function setPreservesPitch(): void {
    audio.preservesPitch = true;
    const a = audio as HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
    if ('mozPreservesPitch' in a) a.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = true;
  }
  setPreservesPitch();

  function showView(name: 'cover' | 'gate' | 'toc' | 'reader'): void {
    coverView.hidden = name !== 'cover';
    gateView.hidden = name !== 'gate';
    tocView.hidden = name !== 'toc';
    readerView.hidden = name !== 'reader';
    window.scrollTo(0, 0);
    syncWakeLock();
  }

  /* ---------- 操作UI（クローム）の表示・自動消去 ----------
     普段は本文だけ。中央タップで出し、数秒で消える。モーダルを開いている間は消さない */
  let chromeTimer: ReturnType<typeof setTimeout> | undefined;
  function showChrome(autoHide = true): void {
    readerView.classList.add('chrome-on');
    if (chromeTimer !== undefined) clearTimeout(chromeTimer);
    chromeTimer = undefined;
    if (autoHide) chromeTimer = setTimeout(hideChrome, 3500);
  }
  function hideChrome(): void {
    readerView.classList.remove('chrome-on');
    if (chromeTimer !== undefined) clearTimeout(chromeTimer);
    chromeTimer = undefined;
  }
  function toggleChrome(): void {
    if (readerView.classList.contains('chrome-on')) hideChrome();
    else showChrome();
  }
  function openMenu(): void {
    showChrome(false);
    // 「表紙に戻る」は読書画面から開いたときだけ出す（表紙で開いたメニューには不要）
    $('toCoverFromMenuBtn').hidden = readerView.hidden;
    $('menuModal').hidden = false;
  }
  function closeMenu(): void {
    $('menuModal').hidden = true;
    if (!readerView.hidden) showChrome();
  }
  function audioSrc(idx: number): string {
    return 'book/audio/ch' + (idx + 1) + '.mp3';
  }

  /* ================= pagination =================
     本文は縦書き。1ページ＝紙の枠に収まる分だけを、文単位で流し込んで測る。
     ページ送りは右綴じ：次ページは左方向。 */
  function ensureMeasurer(w: number, h: number): void {
    if (!measurer) {
      measurer = document.createElement('div');
      measurer.className = 'page-content measurer';
      measurer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(measurer);
    }
    measurer.style.width = w + 'px';
    measurer.style.height = h + 'px';
  }
  function paginateChapter(chIdx: number): Page[] {
    const units = UNITS[chIdx];
    const pages: Page[] = [];
    const paraBegun = new Set<number>();
    let pageUnits: Unit[] = [];
    let pageStart = 0;
    let charCount = 0;
    let curPara = -1;
    let savedHtml: string;
    const m = measurer;
    if (!m) return pages;
    m.replaceChildren();
    // はみ出しの測る軸は方向で変わる（縦書き＝幅、横書き＝高さ）
    const fits = (): boolean =>
      DIR.mode === 'vertical' ? m.scrollWidth <= m.clientWidth + 1 : m.scrollHeight <= m.clientHeight + 1;
    const startGroup = (u: Unit): HTMLParagraphElement => {
      const g = document.createElement('p');
      const cls = groupClass(u, paraBegun);
      if (cls) g.className = cls;
      m.appendChild(g);
      curPara = u.para;
      paraBegun.add(u.para);
      return g;
    };
    const closePage = (): void => {
      pages.push({ startChar: pageStart, units: pageUnits });
      pageUnits = [];
      pageStart = charCount;
      m.replaceChildren();
      curPara = -1;
    };
    let group: HTMLParagraphElement | null = null;
    /* 「おわり」は最後の文のあとに改列した独立ブロックとして、一緒に測る
       （収まらないときは最終文ごと次のページへ送る） */
    const mark: { el: HTMLParagraphElement | null } = { el: null };
    const addMark = (): void => {
      mark.el = document.createElement('p');
      mark.el.className = 'story-end';
      mark.el.textContent = 'おわり';
      m.appendChild(mark.el);
    };
    for (const u of units) {
      if (!group || curPara !== u.para) group = startGroup(u);
      const isFinalUnit = chIdx === chapters.length - 1 && u === units[units.length - 1];
      const uHtml = unitHtml(u);
      savedHtml = group.innerHTML;
      setHtml(group, savedHtml + uHtml);
      if (isFinalUnit) addMark();
      if (!fits() && pageUnits.length) {
        // この文は次のページへ（最終文のときは「おわり」も一緒に連れていく）
        setHtml(group, savedHtml);
        if (mark.el) {
          mark.el.remove();
          mark.el = null;
        }
        if (!group.textContent) {
          group.remove();
          paraBegun.delete(u.para);
        }
        closePage();
        group = startGroup(u);
        setHtml(group, uHtml);
        if (isFinalUnit) addMark();
      }
      pageUnits.push(u);
      charCount += u.len;
    }
    if (pageUnits.length) pages.push({ startChar: pageStart, units: pageUnits });
    return pages;
  }
  function paginateAll(): boolean {
    const w = pageContent.clientWidth;
    const h = pageContent.clientHeight;
    if (!w || !h) return false;
    ensureMeasurer(w, h);
    // ページ割りは表示方式によらず共通（カラオケ方式も同じページ割りの上で文を出し分ける）
    PAGES = chapters.map((_, i) => paginateChapter(i));
    CUM_PAGES = [];
    TOTAL_PAGES = 0;
    PAGES.forEach((p) => {
      CUM_PAGES.push(TOTAL_PAGES);
      TOTAL_PAGES += p.length;
    });
    pageSizeKey = sizeKeyNow();
    return true;
  }
  function sizeKeyNow(): string {
    return pageContent.clientWidth + 'x' + pageContent.clientHeight;
  }
  function bookPageOf(chIdx: number, pageIdx: number): number {
    return CUM_PAGES[chIdx] + pageIdx + 1;
  }
  function currentAnchorChar(): number {
    const pages = PAGES[current];
    if (!pages || !pages.length) return 0;
    return pages[Math.min(curPage, pages.length - 1)].startChar;
  }
  function renderPage(animDir: number): void {
    const pages = PAGES[current];
    const ch = chapters[current];
    if (!pages || !pages.length) return;
    curPage = Math.max(0, Math.min(curPage, pages.length - 1));
    const page = pages[curPage];
    const paraBegun = new Set<number>();
    // この章で、現ページより前に始まっている段落を把握する
    for (let i = 0; i < curPage; i++) pages[i].units.forEach((u) => paraBegun.add(u.para));
    let html = '';
    let openPara = -1;
    const closeP = (): void => {
      if (openPara >= 0) {
        html += '</p>';
        openPara = -1;
      }
    };
    pageUnitRanges = [];
    pageUnitIdx = [];
    // このページの最初の文の、章通しでの番号（前のページまでの文数の合計）
    let unitBase = 0;
    for (let i = 0; i < curPage; i++) unitBase += pages[i].units.length;
    let runStart = page.startChar;
    for (const u of page.units) {
      if (u.para !== openPara) {
        closeP();
        const cls = groupClass(u, paraBegun);
        html += '<p' + (cls ? ' class="' + cls + '"' : '') + '>';
        openPara = u.para;
        paraBegun.add(u.para);
      }
      html += unitHtml(u);
      pageUnitRanges.push({ start: runStart, len: u.len });
      pageUnitIdx.push(unitBase++);
      runStart += u.len;
    }
    // 本文の最終ページでは、段落を閉じたあとに改列して「おわり」を置く
    const isFinalPage = current === chapters.length - 1 && curPage === pages.length - 1;
    closeP();
    if (isFinalPage) html += END_MARK_HTML;
    setHtml(pageContent, html);
    nowUnitIdx = -1;
    updateNowHighlight();
    applyKaraokeReveal(); // カラオケ方式では、まだ読まれていない文を隠す（ページ形式では無動作）
    $('pageFolio').textContent = '― ' + bookPageOf(current, curPage) + ' ―';
    $('pageChapterPos').textContent = curPage + 1 + ' / ' + pages.length;
    $('readerChapterLabel').textContent = ch.num + ' ' + ch.title;
    $('readProgressFill').style.width = TOTAL_PAGES ? (bookPageOf(current, curPage) / TOTAL_PAGES) * 100 + '%' : '0%';
    if (animDir) {
      pageEl.classList.remove('turn-next', 'turn-prev');
      void pageEl.offsetWidth;
      pageEl.classList.add(animDir > 0 ? 'turn-next' : 'turn-prev');
    }
  }
  /* ---------- ページ→音声の追従（ページが主、音声が従） ----------
     手でページをめくったら、朗読もそのページの先頭へ移す。連打されても
     currentTime の書き換えが重ならないよう、落ち着いてから（260ms）最終ページへ
     1回だけシークする（ページ送り自体の応答は即時のまま）。停止中にめくった場合は
     位置だけ先に合わせておき、次に再生したときそのページから読まれるようにする */
  let pageSeekTimer: ReturnType<typeof setTimeout> | undefined;
  let pageSeekPending = false;
  function pageStartTime(): number | null {
    if (!isFinite(audio.duration) || audio.duration <= 0) return null;
    const total = CH_CHARS[current] || 0;
    const pages = PAGES[current];
    if (!total || !pages || !pages.length) return null;
    // ページ先頭きっかりではなく1文字分だけ内側に落とす（境界の往復誤差対策）
    return ((pages[curPage].startChar + 1) / total) * audio.duration;
  }
  function applyPageSeek(): void {
    const t = pageStartTime();
    if (t === null) {
      pageSeekPending = true;
      return;
    }
    pageSeekPending = false;
    try {
      audio.currentTime = t;
    } catch {
      // 位置指定できなくても続行する
    }
  }
  function schedulePageSeek(): void {
    if (pageSeekTimer !== undefined) clearTimeout(pageSeekTimer);
    pageSeekTimer = setTimeout(() => {
      pageSeekTimer = undefined;
      applyPageSeek();
    }, 260);
  }

  /* ---------- カラオケ方式の手動ステップ ----------
     送る/戻すは文単位。表示は即時に切り替え、音声はページ主導のときと同じく
     260ms デバウンスして最終位置へ1回だけシークする（連打で音が乱れないように）。
     章の境目ではページ形式と同じ扉の連鎖に入る（次章の扉／前章の扉／第一章では前へ辿る連鎖） */
  let karaokeSeekTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleKaraokeSeek(): void {
    karaokeSeekPending = true;
    if (karaokeSeekTimer !== undefined) clearTimeout(karaokeSeekTimer);
    karaokeSeekTimer = setTimeout(() => {
      karaokeSeekTimer = undefined;
      karaokeSeekPending = false;
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      const total = CH_CHARS[current] || 0;
      if (!total) return;
      try {
        audio.currentTime = ((unitStartChar(current, karaokeIdx) + 1) / total) * audio.duration;
      } catch {
        // 位置指定できなくても続行する
      }
    }, 260);
  }
  function stepKaraoke(dir: number): void {
    const units = UNITS[current];
    if (dir > 0) {
      if (karaokeIdx < units.length - 1) {
        karaokeIdx++;
      } else if (current < chapters.length - 1) {
        showGate(current + 1, { autoplay: !audio.paused });
        return;
      } else {
        openEndPage(false); // 最終章の最後の文の次は、独立した奥付ページ
        return;
      }
    } else {
      if (karaokeIdx > 0) {
        karaokeIdx--;
      } else if (current > 0) {
        showGate(current - 1, { page: 'last', autoplay: !audio.paused });
        return;
      } else {
        showGateBack(); // 第一章の先頭の文から前へ：扉→目次→表紙の連鎖
        return;
      }
    }
    // 文の属するページを表示し、出現状態と強調を合わせる
    const pages = PAGES[current];
    if (pages && pages.length) {
      const p = pageForChar(pages, unitStartChar(current, karaokeIdx));
      if (p !== curPage) curPage = p;
    }
    renderPage(dir);
    scheduleKaraokeSeek();
    saveBookmark();
  }

  function turnPage(dir: number): void {
    if (!PAGES.length || readerView.hidden) return;
    lastManualTurn = Date.now();
    if (endOpen) {
      // 奥付ページにいる間は、前へで本文の最終ページへ戻るだけ（先はない）
      if (dir < 0) closeEndPage();
      return;
    }
    if (displayMode === 'karaoke') {
      stepKaraoke(dir);
      return;
    }
    const pages = PAGES[current];
    if (dir > 0) {
      // 次ページ（左へ）
      if (curPage < pages.length - 1) {
        curPage++;
        renderPage(1);
        schedulePageSeek();
      } else if (current < chapters.length - 1) {
        // 章をまたぐときも必ず章扉に止まる（扉を素通りして本文に入らない）
        showGate(current + 1, { autoplay: !audio.paused });
        return;
      } else {
        // 本文の最終ページの次は、独立した奥付ページ
        openEndPage(false);
        return;
      }
    } else {
      // 前ページ（右へ）
      if (curPage > 0) {
        curPage--;
        renderPage(-1);
        schedulePageSeek();
      } else if (current > 0) {
        // 前章へ戻るときも章扉に止まる
        showGate(current - 1, { page: 'last', autoplay: !audio.paused });
        return;
      } else {
        // 第一章の先頭ページでさらに前へ：本の前側（扉→目次→表紙）へ辿る連鎖に入る
        showGateBack();
        return;
      }
    }
    saveBookmark();
  }
  /* 朗読の進行にページを合わせる（音声→ページの追従）。
     手でめくった場合は上のページ→音声シークで位置が合うため、ここが手で開いた
     ページを勝手に引き戻すことはない。念のため、手動操作直後は干渉しない */
  function syncPageToAudio(force: boolean): void {
    if (!PAGES.length || !isFinite(audio.duration) || audio.duration <= 0) return;
    const total = CH_CHARS[current] || 0;
    if (!total) return;
    // +1 は、ページ先頭へシークした直後の往復変換誤差で1つ前のページに
    // 戻ってしまうのを防ぐための僅かな遊び（1文字分≒0.2秒）
    const target = Math.floor((audio.currentTime / audio.duration) * total) + 1;
    const p = pageForChar(PAGES[current], target);
    if (p === curPage) return;
    if (force) {
      curPage = p;
      renderPage(0);
      return;
    }
    if (audio.paused) return;
    if (Date.now() - lastManualTurn < 12000) return;
    if (p > curPage) {
      curPage = p;
      renderPage(1);
    }
  }

  /* ---------- bookmark ---------- */
  function saveBookmark(): void {
    if (!chapters.length) return;
    const bm: Bookmark = {
      chapter: current,
      time: audio.currentTime || 0,
      title: chapters[current].num + ' ' + chapters[current].title,
      savedAt: Date.now(),
    };
    if (PAGES.length) {
      bm.anchor = currentAnchorChar();
      bm.page = bookPageOf(current, curPage);
    }
    save('bookmark', bm);
  }
  function loadBookmark(): Bookmark | null {
    return load<Bookmark | null>('bookmark', null);
  }
  /* 表紙は「表紙だけが静かに出ている」状態が原則。常時出すのは入口の「メニュー」だけで、
     しおりがあるときは、表紙に再開ボタンを出す（再開は表紙に置き、メニューには入れない）。
     しおりの案内行は出さない（章の情報は再開ボタンの文言と重なるため）。
     ヒント文は初回（しおりがなく、まだ読み始めた記録もないとき）だけの控えめな案内 */
  function refreshResume(): void {
    const bm = loadBookmark();
    const has = !!(bm && chapters[bm.chapter]);
    const resumeBtn = $('resumeBtn');
    resumeBtn.hidden = !has;
    if (has && bm) {
      resumeBtn.textContent = 'しおりから再開（' + chapters[bm.chapter].num + '）';
    }
    $('coverHint').hidden = has || load<boolean>('seen', false);
  }

  function resumeFromBookmark(): void {
    const bm = loadBookmark();
    if (!bm || !chapters[bm.chapter]) return;
    showGate(bm.chapter, { seek: bm.time || 0, anchor: bm.anchor != null ? bm.anchor : null });
  }

  /* ---------- 章背景のアニメーション ----------
     線画（--chapter-bg）の上に、章に合う小さな動きだけを重ねる（CSS の .page-anim 配下）。
     要素は章ごとに作り直す。配置は章番号で種をまいた決定的な乱数で決め、
     開くたびに同じ景色になるようにしている。
     静かさの基準（v1.2.1〜）: あくまで雰囲気。本文より主張しないよう、動きは薄く・
     ゆっくり・少なくし、配置もページの端や隅の帯に寄せて本文の中央域は極力空ける */
  function buildPageAnim(idx: number): void {
    pageAnim.replaceChildren();
    pageAnim.dataset.chapter = String(idx + 1);
    let seed = 1234567 + idx * 7919;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const put = (cls: string, styles: Record<string, string>): void => {
      const el = document.createElement('span');
      el.className = cls;
      for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v);
      pageAnim.appendChild(el);
    };
    // 水平位置を左右の端の帯（2〜24%／72〜97%）から選ぶ。本文の中央域には置かない
    const edgeX = (): string => (rand() < 0.5 ? 2 + rand() * 22 : 72 + rand() * 25).toFixed(1) + '%';
    const rain = (count: number, dim: boolean, slow: boolean): void => {
      for (let i = 0; i < count; i++) {
        put('anim-rain' + (dim ? ' dim' : ''), {
          left: edgeX(),
          '--d': (slow ? 3.6 + rand() * 1.6 : 2.7 + rand() * 1.2).toFixed(2) + 's',
          '--dl': (-rand() * 5).toFixed(2) + 's',
        });
      }
    };
    const motes = (count: number): void => {
      for (let i = 0; i < count; i++) {
        // 四隅まわりの帯に寄せる（横は端の帯、縦は上端か下端の帯）
        put('anim-mote', {
          left: edgeX(),
          top: (rand() < 0.5 ? 6 + rand() * 22 : 64 + rand() * 26).toFixed(1) + '%',
          '--d': (13 + rand() * 8).toFixed(1) + 's',
          '--dl': (-rand() * 10).toFixed(1) + 's',
          '--dx': (rand() * 14 - 7).toFixed(0) + 'px',
          '--dy': (-(6 + rand() * 8)).toFixed(0) + 'px',
        });
      }
    };
    switch (idx) {
      case 0: // 第一章：雨の日の古本屋。細い雨が両端に静かに落ち続ける
        rain(7, false, false);
        break;
      case 1: // 第二章：雨上がり。雨はさらにまばらで弱く、水たまりがかすかにきらめく
        rain(4, true, true);
        for (let i = 0; i < 2; i++) {
          put('anim-glint', {
            left: edgeX(),
            bottom: (4 + rand() * 4).toFixed(1) + '%',
            '--d': (7 + rand() * 3.5).toFixed(1) + 's',
            '--dl': (-rand() * 7).toFixed(1) + 's',
          });
        }
        break;
      case 2: // 第三章：本棚の埃のような粒が、隅のほうでごくゆっくり漂う
        motes(5);
        break;
      case 3: // 第四章：封筒とメモのあたりで、光が静かにゆらぐ
        put('anim-glow', { right: '4%', bottom: '3%', width: '58%', height: '27%', '--d': '14s' });
        motes(2);
        break;
      case 4: // 第五章：夕日の光がゆっくり明滅し、貼り紙がかすかに揺れる
        put('anim-glow sunset', { right: '2%', bottom: '15%', width: '48%', height: '23%', '--d': '16s' });
        put('anim-sway', { left: '21%', bottom: '12.5%' });
        break;
      case 5: // 第六章：窓の光の帯がゆっくり揺れる
        put('anim-band', { bottom: '1%' });
        motes(1);
        break;
      case 6: {
        // 第七章：雲がゆっくり流れ、鳥がときおり上部を横切る
        put('anim-cloud', { left: '6%', top: '5%', width: '36%', '--d': '46s' });
        put('anim-cloud', { right: '5%', top: '34%', width: '27%', '--d': '58s', '--dl': '-20s' });
        const bird = document.createElement('span');
        bird.className = 'anim-bird';
        setHtml(bird, BIRD_SVG);
        pageAnim.appendChild(bird);
        break;
      }
      default:
        break;
    }
  }

  /* ---------- chapter flow ---------- */
  interface EnterOptions {
    seek?: number;
    anchor?: number | null;
    page?: number | 'last';
    autoplay?: boolean;
  }
  function fillGate(ch: ChapterData): void {
    $('gateNum').textContent = ch.num;
    $('gateTitle').textContent = ch.title;
    $('gateNarrator').textContent = ch.narratorName;
  }
  function showGate(idx: number, opts: EnterOptions = {}): void {
    save('seen', true); // 一度読み始めたら、表紙のヒント文は二度と出さない
    stopGateCall(); // 前の扉のコールが残っていたら止める
    current = idx;
    gateOpen = true;
    $('gateHint').textContent = 'タップで本文へ';
    fillGate(chapters[idx]);
    showView('gate');
    if (gateTimer !== undefined) clearTimeout(gateTimer);
    let started = false;
    const start = (): void => {
      if (started) return;
      started = true;
      if (gateTimer !== undefined) clearTimeout(gateTimer);
      stopGateCall();
      gateOpen = false;
      enterChapter(idx, opts);
    };
    gateView.onclick = start;
    if (opts.autoplay === false) {
      // 朗読を自動で始めない入り方（停止中にページ送りで章をまたいだ等）は、
      // コールも鳴らさず、従来どおり少し置いて本文へ進む
      gateTimer = setTimeout(start, 1800);
      return;
    }
    /* 章題コール：扉の内容（第N章・題・語り手名）を、その章の語り手の声で読む
       短い音声（book/audio/ch{N}-title.mp3）を鳴らし、読み終わってから本文を始める。
       鳴らせない・読み込めない場合は従来の待ち時間で進み、長くても上限で打ち切る。
       扉をタップすればコールを止めてすぐ本文へ進む */
    gateTimer = setTimeout(start, 10000);
    gateAudio.src = 'book/audio/ch' + (idx + 1) + '-title.mp3';
    gateAudio.playbackRate = SPEEDS[speedIdx];
    const gp = gateAudio as HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
    gp.preservesPitch = true;
    if ('mozPreservesPitch' in gp) gp.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in gp) gp.webkitPreservesPitch = true;
    gateAudio.onended = start;
    const fallback = (): void => {
      if (gateTimer !== undefined) clearTimeout(gateTimer);
      gateTimer = setTimeout(start, 1800);
    };
    gateAudio.onerror = fallback;
    const p = gateAudio.play();
    if (p && p.catch) p.catch(fallback);
  }
  /* 第一章の先頭ページから「前へ」を続けたときの扉（本の前側へ辿る連鎖の入口）。
     通常の扉と違い、自動でもタップでもすぐ本文へは進まない：
     前側（綴じ側と反対）のタップで目次ページへ、本文側のタップで第一章の本文へ入る。
     朗読は止める（扉・目次・表紙にいる間に音声が勝手に進まないように）。
     位置はしおりに残っているので、表紙の再開から元の場所へ戻れる */
  function showGateBack(): void {
    save('seen', true);
    stopGateCall(); // 前へ辿る扉は無音が原則（コールは鳴らさない）
    audio.pause();
    updatePlayBtn();
    saveBookmark();
    current = 0;
    gateOpen = true;
    if (gateTimer !== undefined) clearTimeout(gateTimer);
    $('gateHint').textContent = 'タップで本文へ ／ 前へめくると目次へ';
    fillGate(chapters[0]);
    showView('gate');
    gateView.onclick = (e: MouseEvent) => {
      const r = gateView.getBoundingClientRect();
      const ratio = (e.clientX - r.left) / r.width;
      const onPrevSide = DIR.nextSide === 'left' ? ratio > 0.58 : ratio < 0.42;
      if (onPrevSide) {
        openTocPage('gate');
      } else {
        gateOpen = false;
        enterChapter(0, { autoplay: false });
      }
    };
  }
  function layoutChapter(opts: EnterOptions): void {
    // 章ごとの背景イメージを差し込む（オフ設定のときは CSS 側で紙だけになる）。
    // URL は文書基準の絶対URLにする（CSS 変数経由の url() はスタイルシート基準で
    // 解決されてしまい、dist の assets/ から見た相対パスでは画像に届かないため）
    const bgUrl = new URL('book/bg/ch' + (current + 1) + '.svg', document.baseURI).href;
    pageWrap.style.setProperty('--chapter-bg', 'url("' + bgUrl + '")');
    buildPageAnim(current);
    // リーダーが表示された状態でページ割りをする
    if (!PAGES.length || sizeKeyNow() !== pageSizeKey) paginateAll();
    if (!PAGES.length) return;
    if (opts.anchor != null) curPage = pageForChar(PAGES[current], opts.anchor);
    else if (opts.page === 'last') curPage = PAGES[current].length - 1;
    else if (typeof opts.page === 'number') curPage = opts.page;
    else curPage = 0;
    if (displayMode === 'karaoke') {
      // 出現の frontier は、入った位置（アンカー／ページ先頭）の文に合わせる。
      // 時刻指定のシーク（再開など）がある場合は、seeked／timeupdate で音声位置に追いつく
      karaokeIdx = unitIndexForChar(current, opts.anchor != null ? opts.anchor : PAGES[current][curPage].startChar);
    }
    renderPage(0);
    refreshTocCurrent();
  }
  function enterChapter(idx: number, opts: EnterOptions = {}): void {
    if (gateTimer !== undefined) clearTimeout(gateTimer);
    stopGateCall(); // 本文に入るときはコールを必ず止める（二重に鳴らさない）
    gateOpen = false;
    closeEndPage(); // 章へ入るときは奥付ページを閉じる
    current = idx;
    enterStamp = Date.now();
    showView('reader');
    // 本を開いた直後は、操作UIを自動では出さない（出すのは中央タップだけ）。
    // 自動で出すと、その間だけ有効になる右上の「メニュー」ボタンに、続くタップ
    // （前ページ側のタップなど）が当たって、意図せずメニューが開くことがあるため
    audio.src = audioSrc(idx);
    audio.playbackRate = SPEEDS[speedIdx];
    setPreservesPitch();
    pendingSeek = opts.seek || 0;
    audioError.hidden = true;
    requestAnimationFrame(() => layoutChapter(opts));
    const doPlay = (): void => {
      if (pendingSeek > 0) {
        try {
          audio.currentTime = pendingSeek;
        } catch {
          // 位置指定できなくても続行する
        }
        pendingSeek = 0;
      }
      if (opts.page === 'last' && isFinite(audio.duration) && audio.duration > 0) {
        // 前章へ戻ったときは、末尾ページに見合う位置から
        const pages = PAGES[current];
        if (pages && pages.length) {
          try {
            audio.currentTime = (pages[pages.length - 1].startChar / (CH_CHARS[current] || 1)) * audio.duration;
          } catch {
            // 同上
          }
        }
      }
      if (opts.autoplay !== false) playAudio();
      // ページ指定（しおりのアンカー等）があるとき／章に入ってから手でめくったときは、
      // 音声位置への吸着でページを上書きしない（メタデータ到着が遅れた場合の誤爆防止）
      if (opts.anchor == null && lastManualTurn < enterStamp) syncPageToAudio(true);
    };
    if (audio.readyState >= 1) doPlay();
    else {
      const h = (): void => {
        audio.removeEventListener('loadedmetadata', h);
        doPlay();
      };
      audio.addEventListener('loadedmetadata', h);
    }
    if (opts.autoplay !== false) {
      setTimeout(() => {
        if (audio.paused && audio.readyState === 0) playAudio();
      }, 600);
    }
    updatePlayBtn();
    updateNav();
    updateMediaMetadata();
    syncMediaState();
  }
  function playAudio(): void {
    // 停止中にめくって位置合わせが保留になっていたら、再生前にそのページへ合わせる
    if (pageSeekPending) applyPageSeek();
    audio.playbackRate = SPEEDS[speedIdx];
    setPreservesPitch();
    const p = audio.play();
    if (p && p.catch) {
      p.catch(() => {
        audioError.hidden = false;
        audioError.textContent =
          '音声ファイル（' + audioSrc(current) + '）を再生できませんでした。本文はそのままお読みいただけます。';
        updatePlayBtn();
      });
    }
  }
  function updatePlayBtn(): void {
    $('playPauseBtn').textContent = !audio.paused && !audio.ended ? '⏸ 停止' : '▶ 再生';
  }
  function updateNav(): void {
    $('speedBtn').textContent = speedLabel(SPEEDS[speedIdx]);
  }
  function goCover(): void {
    stopGateCall();
    audio.pause();
    closeEndPage();
    saveBookmark();
    hideChrome();
    showView('cover');
    refreshResume();
  }

  /* ---------- 独立した奥付ページ（本のいちばん最後のページ） ----------
     本文の最終ページから「次へ」で開き、「前へ」で本文の最終ページへ戻る。
     朗読が最終章を読み終えたときも、ここへ進む。開いている間は朗読を止める */
  function openEndPage(finished: boolean): void {
    if (endOpen) return;
    endOpen = true;
    audio.pause();
    updatePlayBtn();
    $('endPage').hidden = false;
    if (finished) {
      // 読了：しおりは消す（表紙の再開ボタンも消える）
      remove('bookmark');
      refreshResume();
    } else {
      saveBookmark();
    }
  }
  function closeEndPage(): void {
    if (!endOpen) return;
    endOpen = false;
    $('endPage').hidden = true;
  }

  /* ---------- Media Session（ロック画面・コントロールセンターの操作に乗る） ----------
     章ごとに「いま読んでいる章・著者・本の題」を OS に伝え、端末側の
     再生／停止・前後の章・シークを、このアプリの操作に割り当てる。
     バックグラウンド再生の後押しにもなる（OS がメディア再生として扱うため） */
  const mediaSession: MediaSession | undefined = 'mediaSession' in navigator ? navigator.mediaSession : undefined;
  function updateMediaMetadata(): void {
    if (!mediaSession) return;
    const ch = chapters[current];
    if (!ch) return;
    mediaSession.metadata = new MediaMetadata({
      title: ch.num + ' ' + ch.title,
      artist: book.author,
      album: book.title,
      artwork: [
        { src: new URL('icons/icon-192.png', document.baseURI).href, sizes: '192x192', type: 'image/png' },
        { src: new URL('icons/icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' },
      ],
    });
  }
  function syncMediaState(): void {
    if (!mediaSession) return;
    mediaSession.playbackState = audio.paused || audio.ended ? 'paused' : 'playing';
  }
  function syncMediaPosition(): void {
    if (!mediaSession || typeof mediaSession.setPositionState !== 'function') return;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      mediaSession.setPositionState({
        duration: audio.duration,
        position: Math.min(Math.max(audio.currentTime || 0, 0), audio.duration),
        playbackRate: audio.playbackRate || 1,
      });
    } catch {
      // 位置を伝えられなくても続行する
    }
  }
  function setupMediaSession(): void {
    if (!mediaSession) return;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler): void => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // 対応していない操作は割り当てない
      }
    };
    set('play', () => playAudio());
    set('pause', () => audio.pause());
    set('previoustrack', () => {
      if (current > 0) showGate(current - 1);
    });
    set('nexttrack', () => {
      if (current < chapters.length - 1) showGate(current + 1);
    });
    set('seekbackward', (d) => {
      audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
    });
    set('seekforward', (d) => {
      if (isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, audio.currentTime + (d.seekOffset || 10));
    });
    set('seekto', (d) => {
      if (typeof d.seekTime === 'number') audio.currentTime = d.seekTime;
    });
  }

  /* ---------- 画面を暗くしない（Screen Wake Lock） ----------
     設定オン（既定）かつ読書画面を開いている間だけ、Screen Wake Lock を取って、
     無操作でも画面が暗くならないようにする。表紙・扉へ移る／画面が隠れると解放する。
     Wake Lock は「画面が見えている間」しか効かない仕様なので、画面を消して聞く
     使い方の担当ではない（それは下のバックグラウンド再生設定の役割で、両者は独立）。
     API が無い環境では何もしない（設定トグルは残るが無効）。状態はテストや確認の
     ために body[data-wakelock]（on=取得中 / off=それ以外）にも出す */
  const wakeLockApi: WakeLockLike | undefined = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
  let wakeLockOn = load<boolean>('wakelock', true);
  let wakeLockSentinel: WakeLockSentinelLike | null = null;
  let wakeLockRequesting = false;
  document.body.dataset.wakelock = 'off';

  function wakeLockWanted(): boolean {
    return wakeLockOn && !readerView.hidden && document.visibilityState === 'visible';
  }
  function syncWakeLock(): void {
    if (!wakeLockApi) return;
    if (!wakeLockWanted()) {
      if (wakeLockSentinel) {
        const s = wakeLockSentinel;
        wakeLockSentinel = null;
        document.body.dataset.wakelock = 'off';
        void s.release().catch(() => undefined);
      }
      return;
    }
    if (wakeLockSentinel || wakeLockRequesting) return;
    wakeLockRequesting = true;
    wakeLockApi
      .request('screen')
      .then((s) => {
        wakeLockRequesting = false;
        // 取得を待つ間に条件が変わっていたら、持たずに手放す
        if (!wakeLockWanted()) {
          document.body.dataset.wakelock = 'off';
          void s.release().catch(() => undefined);
          return;
        }
        wakeLockSentinel = s;
        document.body.dataset.wakelock = 'on';
        s.addEventListener('release', () => {
          if (wakeLockSentinel === s) {
            wakeLockSentinel = null;
            document.body.dataset.wakelock = 'off';
          }
        });
      })
      .catch(() => {
        // 取れなくても読書は続ける（スリープ抑制は後押しであり、本筋ではない）
        wakeLockRequesting = false;
      });
  }

  /* ---------- バックグラウンド再生 ----------
     設定オン（既定）: 画面を消しても・他アプリに切り替えても、朗読と BGM を止めない。
     朗読は <audio> 要素なので元々バックグラウンドでも鳴り続ける作りで、止める処理は
     入れていない。ここでやる後押しは、(1) Media Session で OS のメディア扱いに乗せる、
     (2) BGM の AudioContext がブラウザに止められていたら開け直す、の2つ。
     設定オフ: バックグラウンドに入ったら一時停止し、戻ってきたら（止める前が再生中
     だった場合だけ）再開する、従来型の挙動にする */
  let bgPlay = load<boolean>('bgplay', true);
  let hiddenPausedAudio = false;
  let hiddenStoppedBgm = false;
  function onVisibilityChange(): void {
    // Wake Lock は隠れると OS に解放される。戻ってきたら、条件が合えば取り直す
    syncWakeLock();
    if (document.hidden) {
      if (bgPlay) {
        resumeBgmContext();
        return;
      }
      hiddenPausedAudio = !audio.paused && !audio.ended;
      if (hiddenPausedAudio) audio.pause();
      hiddenStoppedBgm = document.body.dataset.bgm === 'on';
      if (hiddenStoppedBgm) stopBgm();
    } else {
      if (hiddenPausedAudio) playAudio();
      if (hiddenStoppedBgm && isBgmOn()) startBgm();
      hiddenPausedAudio = false;
      hiddenStoppedBgm = false;
      if (bgPlay) resumeBgmContext();
    }
  }

  /* ---------- 目次ページ（モーダルではなく本の1ページとして独立させる） ----------
     目次は本文ページとは別画面のままにしているが、組み方は本文に寄せてある：
     列を実測して収まる分だけを1ページにし、章が増えたら次の目次ページへ送る
     （本文の「文単位で測ってページに分ける」に対する「列単位で測って分ける」）。
     ページ送りは本文と同じ作法（次側タップで次ページ／前側タップで前ページ、スワイプも同じ向き）。
     項目は「章と題」だけにする（語り手名は各章の扉で分かるため、目次には載せない） */
  let tocReturn: 'cover' | 'reader' | 'gate' = 'cover';
  let tocPages: number[][] = [];
  let tocPage = 0;
  let tocMeasurer: HTMLDivElement | null = null;

  function makeTocItem(i: number): HTMLLIElement {
    const c = chapters[i];
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'toc-item';
    btn.dataset.idx = String(i);
    const num = document.createElement('span');
    num.className = 'toc-num';
    num.textContent = c.num;
    const ttl = document.createElement('span');
    ttl.className = 'toc-title';
    ttl.textContent = c.title;
    btn.append(num, ttl);
    btn.addEventListener('click', () => {
      showGate(i);
    });
    li.appendChild(btn);
    return li;
  }
  function refreshTocCurrent(): void {
    document.querySelectorAll<HTMLElement>('#tocList .toc-item').forEach((el) => {
      el.classList.toggle('current', Number(el.dataset.idx) === current);
    });
  }
  /* 列を実測して目次ページに分ける。本文の paginateChapter と同じく、隠し
     measurer に実際の列を流し込み、はみ出した分を次のページへ送る。
     見出し（目次）は先頭ページにだけ付ける */
  function paginateToc(): void {
    const all = chapters.map((_, i) => i);
    const sheet = document.querySelector<HTMLElement>('.toc-sheet');
    if (!sheet || !sheet.clientWidth) {
      tocPages = [all];
      return;
    }
    if (!tocMeasurer) {
      tocMeasurer = document.createElement('div');
      tocMeasurer.className = 'toc-measurer';
      tocMeasurer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(tocMeasurer);
    }
    const cs = getComputedStyle(sheet);
    const innerW = sheet.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    tocMeasurer.style.width = sheet.clientWidth + 'px';
    tocMeasurer.style.height = sheet.clientHeight + 'px';
    tocMeasurer.replaceChildren();
    const inner = document.createElement('div');
    inner.className = 'toc-inner';
    inner.style.width = innerW + 'px';
    const head = document.createElement('h2');
    head.className = 'toc-heading';
    head.textContent = '目次';
    const ul = document.createElement('ul');
    ul.className = 'toc-list';
    inner.append(head, ul);
    tocMeasurer.appendChild(inner);
    // はみ出しの測る軸は本文と同じ（縦書き＝幅）
    const fits = (): boolean => inner.scrollWidth <= inner.clientWidth + 1;
    const groups: number[][] = [];
    let group: number[] = [];
    for (const i of all) {
      const li = makeTocItem(i);
      ul.appendChild(li);
      if (!fits() && group.length) {
        li.remove();
        groups.push(group);
        group = [];
        head.hidden = true; // 2ページ目以降は見出しを付けない
        ul.style.marginBlockStart = '0px'; // 見出しとの間の余白も消す（描画側の .no-head と一致させる）
        ul.replaceChildren();
        ul.appendChild(li);
      }
      group.push(i);
    }
    if (group.length) groups.push(group);
    tocPages = groups.length ? groups : [all];
  }
  function renderTocPage(): void {
    const list = $('tocList');
    list.replaceChildren();
    (tocPages[tocPage] || []).forEach((i) => list.appendChild(makeTocItem(i)));
    $('tocHeading').hidden = tocPage !== 0;
    document.querySelector('.toc-sheet .toc-inner')?.classList.toggle('no-head', tocPage !== 0);
    const pager = $('tocPager');
    pager.hidden = tocPages.length <= 1;
    pager.textContent = tocPages.length > 1 ? String(tocPage + 1) + ' / ' + String(tocPages.length) : '';
    refreshTocCurrent();
  }
  function tocPageIndexOf(chIdx: number): number {
    const p = tocPages.findIndex((g) => g.includes(chIdx));
    return p >= 0 ? p : 0;
  }
  function turnTocPage(dir: number): boolean {
    const next = tocPage + dir;
    if (next < 0 || next >= tocPages.length) return false;
    tocPage = next;
    renderTocPage();
    return true;
  }
  function openTocPage(from?: 'cover' | 'reader' | 'gate'): void {
    /* 開いた元の画面を覚えておき、「戻る」でそこへ帰る。
       'gate' は、第一章から前へ辿る連鎖（扉→目次→表紙）で開いた場合 */
    tocReturn = from ?? (readerView.hidden ? 'cover' : 'reader');
    showView('toc');
    // 開くたびに実測し直し、今読んでいる章のあるページから出す
    paginateToc();
    tocPage = tocPageIndexOf(current);
    renderTocPage();
  }
  function closeTocPage(): void {
    if (tocReturn === 'gate') {
      showGateBack();
      return;
    }
    showView(tocReturn);
  }

  /* ---------- events ---------- */
  function bind(): void {
    $('coverTap').addEventListener('click', () => showGate(0));
    /* メニュー（入口は読書画面の「メニュー」と表紙の「メニュー」の2か所、中身は1つ。
       目次・設定はこの中にある。再開だけは表紙のボタン） */
    $('menuBtn').addEventListener('click', openMenu);
    $('coverMenuBtn').addEventListener('click', openMenu);
    /* 再開は表紙のボタンから（メニューの中には入れない） */
    $('resumeBtn').addEventListener('click', resumeFromBookmark);
    $('menuCloseBtn').addEventListener('click', closeMenu);
    $('menuBackdrop').addEventListener('click', closeMenu);
    /* 目次ページへの入口はメニューの「目次を開く」に一本化（表紙にも読書中にも共通） */
    $('tocFromMenuBtn').addEventListener('click', () => {
      closeMenu();
      openTocPage();
    });
    $('tocBackBtn').addEventListener('click', closeTocPage);
    /* 目次のページ送りは本文と同じ作法：次側タップで次の目次ページ、前側タップで
       前の目次ページ（スワイプも同じ向き）。目次ページの端では、前へ辿る連鎖
       （扉→目次→表紙）で開いた場合に限り、その先へつなぐ：先頭ページの前側で表紙へ、
       末尾ページの次側で第一章の扉へ（扉は通常モードで開き、本文へ続く） */
    const tocTapNav = (dir: number): void => {
      if (turnTocPage(dir)) return;
      if (tocReturn !== 'gate') return;
      if (dir < 0) goCover();
      else showGate(0);
    };
    let tocSwipedAt = 0;
    tocView.addEventListener('click', (e) => {
      if (Date.now() - tocSwipedAt < 350) return; // スワイプ直後のクリックでは送らない（本文側と同じ）
      if ((e.target as HTMLElement).closest('button')) return;
      const r = tocView.getBoundingClientRect();
      const ratio = (e.clientX - r.left) / r.width;
      const onPrevSide = DIR.nextSide === 'left' ? ratio > 0.58 : ratio < 0.42;
      const onNextSide = DIR.nextSide === 'left' ? ratio < 0.42 : ratio > 0.58;
      if (onPrevSide) tocTapNav(-1);
      else if (onNextSide) tocTapNav(1);
    });
    let tocSwipeX: number | null = null;
    tocView.addEventListener('pointerdown', (e) => {
      tocSwipeX = e.clientX;
    });
    tocView.addEventListener('pointerup', (e) => {
      if (tocSwipeX === null) return;
      const dx = e.clientX - tocSwipeX;
      tocSwipeX = null;
      if (Math.abs(dx) <= 48) return;
      tocSwipedAt = Date.now();
      const towardNext = DIR.nextSide === 'left' ? dx < 0 : dx > 0;
      tocTapNav(towardNext ? 1 : -1);
    });
    /* 操作UIに触れている間は、自動消去のタイマーを仕切り直す */
    if (headerEl) headerEl.addEventListener('pointerdown', () => showChrome());
    if (playerEl) playerEl.addEventListener('pointerdown', () => showChrome());
    $('finalToCoverBtn').addEventListener('click', goCover);
    $('toCoverFromMenuBtn').addEventListener('click', () => {
      closeMenu();
      goCover();
    });
    $('playPauseBtn').addEventListener('click', () => {
      if (audio.paused) playAudio();
      else {
        audio.pause();
        saveBookmark();
      }
    });
    /* 章移動の入口は画面上のボタンではなく、ページめくり（章またぎ）と目次に一本化した。
       前章／次章は Media Session の previoustrack / nexttrack でも行える */
    $('speedBtn').addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      audio.playbackRate = SPEEDS[speedIdx];
      setPreservesPitch();
      save('speed', SPEEDS[speedIdx]);
      updateNav();
    });
    $<HTMLInputElement>('rubyToggle').addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      document.body.classList.toggle('ruby-off', !checked);
      save('ruby', checked);
    });
    $<HTMLInputElement>('bgToggle').addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      document.body.classList.toggle('bg-off', !checked);
      save('bg', checked);
    });
    $('displayModeBtn').addEventListener('click', () => {
      setDisplayMode(displayMode === 'page' ? 'karaoke' : 'page');
    });
    $<HTMLInputElement>('hlToggle').addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      document.body.classList.toggle('hl-off', !checked);
      save('hl', checked);
    });
    $<HTMLInputElement>('bgmToggle').addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      // オフは即停止、オンは（この操作自体がジェスチャなので）すぐ鳴らし始める
      setBgmOn(checked);
      if (checked) startBgm();
    });
    $<HTMLInputElement>('bgPlayToggle').addEventListener('change', (e) => {
      bgPlay = (e.target as HTMLInputElement).checked;
      save('bgplay', bgPlay);
    });
    $<HTMLInputElement>('wakeLockToggle').addEventListener('change', (e) => {
      wakeLockOn = (e.target as HTMLInputElement).checked;
      save('wakelock', wakeLockOn);
      syncWakeLock(); // 読書画面で切り替えたら、その場で取得／解放が効く
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    /* BGM は最初のタップ以降に鳴らせる（ブラウザの自動再生の制約）。
       表紙・扉・本文のどこで触れても、設定がオンなら流れ始めて画面をまたいで続く */
    document.addEventListener('pointerdown', () => {
      if (isBgmOn()) startBgm();
    });
    /* ページめくり：タップ（小口側＝次／綴じ側＝前）とスワイプ。
       「どちらが次か」は DIR.nextSide が決める（右綴じ＝左、左綴じ＝右） */
    let pDown: { x: number; y: number } | null = null;
    let swipedAt = 0;
    pageWrap.addEventListener('pointerdown', (e) => {
      pDown = { x: e.clientX, y: e.clientY };
    });
    pageWrap.addEventListener('pointerup', (e) => {
      if (!pDown) return;
      const dx = e.clientX - pDown.x;
      const dy = e.clientY - pDown.y;
      pDown = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        swipedAt = Date.now();
        const towardNext = DIR.nextSide === 'left' ? dx < 0 : dx > 0;
        turnPage(towardNext ? 1 : -1);
      }
    });
    pageWrap.addEventListener('click', (e) => {
      if (Date.now() - swipedAt < 350) return;
      if ((e.target as HTMLElement).closest('button')) return;
      const r = pageWrap.getBoundingClientRect();
      const ratio = (e.clientX - r.left) / r.width;
      const onNextSide = DIR.nextSide === 'left' ? ratio < 0.42 : ratio > 0.58;
      const onPrevSide = DIR.nextSide === 'left' ? ratio > 0.58 : ratio < 0.42;
      if (onNextSide) turnPage(1);
      else if (onPrevSide) turnPage(-1);
      else toggleChrome(); // 中央タップは操作UIの表示・非表示
    });
    document.addEventListener('keydown', (e) => {
      if (readerView.hidden) return;
      const nextKey = DIR.nextSide === 'left' ? 'ArrowLeft' : 'ArrowRight';
      const prevKey = DIR.nextSide === 'left' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === nextKey) turnPage(1);
      else if (e.key === prevKey) turnPage(-1);
    });
    let resizeT: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener('resize', () => {
      if (resizeT !== undefined) clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (!tocView.hidden) {
          // 目次を開いたまま画面が変わったら、実測し直して同じ章が見えるページに戻す
          const first = (tocPages[tocPage] || [])[0] ?? current;
          paginateToc();
          tocPage = tocPageIndexOf(first);
          renderTocPage();
        }
        if (readerView.hidden) {
          pageSizeKey = '';
          return;
        }
        if (sizeKeyNow() === pageSizeKey) return;
        const anchor = currentAnchorChar();
        if (paginateAll()) {
          curPage = pageForChar(PAGES[current], anchor);
          renderPage(0);
        }
      }, 250);
    });

    /* 画面上にシークバーや時刻は出さない。ここでは、しおりの保存・Media Session への
       位置同期・朗読位置へのページ追従だけを行う */
    audio.addEventListener('timeupdate', () => {
      if (Math.floor(audio.currentTime) % 5 === 0) {
        saveBookmark();
        syncMediaPosition();
      }
      syncPageToAudio(false);
      updateNowHighlight();
      updateKaraoke();
    });
    audio.addEventListener('seeked', () => {
      syncPageToAudio(true);
      syncMediaPosition();
      updateNowHighlight();
      updateKaraoke();
    });
    audio.addEventListener('loadedmetadata', () => {
      syncMediaPosition();
      if (pageSeekPending) applyPageSeek();
    });
    audio.addEventListener('play', updatePlayBtn);
    audio.addEventListener('play', syncMediaState);
    audio.addEventListener('pause', syncMediaState);
    audio.addEventListener('pause', () => {
      updatePlayBtn();
      saveBookmark();
    });
    audio.addEventListener(
      'error',
      () => {
        if (!audio.src) return;
        audioError.hidden = false;
        audioError.textContent =
          '音声ファイル（' + audioSrc(current) + '）が見つかりません。本文はそのままお読みいただけます。';
        updatePlayBtn();
      },
      true,
    );
    audio.addEventListener('ended', () => {
      // 章扉を表示中なら、旧章の音声の終了では進まない（扉の先へ二重に飛んでしまうため）
      if (gateOpen) return;
      if (current < chapters.length - 1) {
        showGate(current + 1);
      } else {
        // 最終章の朗読が終わったら、本文の最終ページを経て奥付ページへ進む（読了）
        syncPageToAudio(true);
        openEndPage(true);
        updatePlayBtn();
      }
    });
  }

  /* ---------- 初期化 ---------- */
  const rubyOn = load<boolean>('ruby', true);
  $<HTMLInputElement>('rubyToggle').checked = rubyOn;
  document.body.classList.toggle('ruby-off', !rubyOn);
  const bgOn = load<boolean>('bg', true);
  $<HTMLInputElement>('bgToggle').checked = bgOn;
  document.body.classList.toggle('bg-off', !bgOn);
  const hlOn = load<boolean>('hl', true);
  $<HTMLInputElement>('hlToggle').checked = hlOn;
  document.body.classList.toggle('hl-off', !hlOn);
  // v1.6.0 で保存された 'sentence' は廃止した方式なので、ページ形式として読み直す
  displayMode = load<string>('display', 'page') === 'karaoke' ? 'karaoke' : 'page';
  document.body.classList.toggle('mode-karaoke', displayMode === 'karaoke');
  $('displayModeBtn').textContent = displayMode === 'page' ? 'ページ形式' : 'カラオケ方式';
  $<HTMLInputElement>('bgmToggle').checked = isBgmOn();
  $<HTMLInputElement>('bgPlayToggle').checked = bgPlay;
  $<HTMLInputElement>('wakeLockToggle').checked = wakeLockOn;
  setupMediaSession();
  // 初期表示用に全章を1ページとして描いておく（開くときに実測して分け直す）
  tocPages = [chapters.map((_, i) => i)];
  renderTocPage();
  bind();
  refreshResume();
  showView('cover');
  updateNav();

  return {
    goLastChapter(): void {
      if (chapters.length) showGate(chapters.length - 1);
    },
    clearBookmark(): void {
      remove('bookmark');
      refreshResume();
    },
  };
}
