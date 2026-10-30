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
  unitIndexAtTime,
  type BookData,
  type Bookmark,
  type ChapterData,
  type Direction,
  type Page,
  type Unit,
} from './logic';
import { checkForUpdate } from './pwa';
import { ensureAudioRunning, isBgmOn, isSoundOn, playPageTurn, resyncBgmIfDesynced, setBgmOn, setSound, startBgm, stopBgm } from './sound';
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
    // 必ず止める。「再生中なら」という条件にすると、play() の完了が保留中の
    // ときに止め損ね、後からコールが鳴り出して本文と重なる（実機の2重再生）。
    // ソースも外し、保留中の読み込みごと打ち切る（次に鳴らすときは
    // showGate が必ずソースを入れ直す）
    gateAudio.pause();
    if (gateAudio.getAttribute('src')) {
      gateAudio.removeAttribute('src');
      gateAudio.load();
    }
  }
  const audioError = $('audioError');

  /* ---- 状態 ---- */
  let current = 0;
  let speedIdx = speedIndexOf(load<number>('speed', 1.0));
  let gateTimer: ReturnType<typeof setTimeout> | undefined;
  let gateOpen = false; // 章扉を表示中かどうか（旧章の音声の 'ended' で二重に進まないための番兵）
  /* 表示中の扉の世代。扉が差し替わるたびに増やし、旧い扉の非同期な続き
     （play() の失敗時フォールバックやタイマー）が新しい扉に割り込んで前へ進めて
     しまわないようにする（実機報告：扉で戻るスワイプをしたのに次の章へ
     スキップした。原因は、旧い扉の play() の中断が遅れて届き、その
     フォールバックが新しい扉のタイマーを上書きして旧い章への入章を予約したこと。
     gateOpen だけでは「どの扉か」を区別できない） */
  let gateSeq = 0;
  // 扉でのスワイプ遷移先（showGate／showGateBack が表示のたびに差し替える）
  let gateNav: { next: () => void; prev: () => void } | null = null;
  /* 扉の再生アイコンの動作（表示中の扉が決める）：コールや待ち時間を飛ばして、
     その章へ入り朗読を始める。showGate / showGateBack が入るたびに差し替える */
  let gatePlay: (() => void) | null = null;
  // 「前へ辿る」モードの扉（showGateBack）は専用フラグを持たず、自動タイマーを
  // 張らないことと、gateNav の中身で通常の扉と区別する
  /* 読書モード（v1.12.0）：'ear'＝耳で読む（朗読あり、従来どおり）／'eye'＝目で
     読む（人の声だけを止める：朗読・章題コールなし、手動送りのみ、ハイライト
     追随なし、再生ボタンを出さない。BGM とページめくり音は設定どおり鳴る
     ――v1.12.2 で仕様変更）。表紙で選ぶ、その場かぎりの選択で、設定には
     保存しない（表紙に戻れば選び直せる） */
  let readMode: 'ear' | 'eye' = 'ear';
  const isEye = (): boolean => readMode === 'eye';
  /* めくり音は両モード共通（呼び出し側はこのラッパーを使う） */
  const turnSound = (): void => {
    playPageTurn();
  };
  let pendingSeek = 0;
  const UNITS: Unit[][] = chapters.map((ch) => buildUnits(ch));
  const CH_CHARS: number[] = UNITS.map((us) => us.reduce((a, u) => a + u.len, 0));
  /* ---------- 朗読位置の対応付け（時刻⇔文） ----------
     章データに unitTimes（文ごとの実開始時刻、work/build_timings.py が実測）が
     ある章では、時刻⇔文の対応を実時刻で決める。無い章では文字数比例の推定に
     落とす（推定は文間の無音や読み速度のばらつきで実位置から数秒ずれることが
     実測で分かっているため、あくまで予備）。
     ハイライト・ページ追従は、すべてここの関数を通して位置を
     決める（別々に推定すると、操作の組み合わせで互いにずれていくため） */
  const UNIT_TIMES: (number[] | null)[] = chapters.map((ch, i) => {
    const t = ch.unitTimes;
    if (!t || t.length !== UNITS[i].length) return null;
    for (let j = 1; j < t.length; j++) if (t[j] < t[j - 1]) return null;
    return t;
  });
  const UNIT_START_CHARS: number[][] = UNITS.map((us) => {
    const out: number[] = [];
    let pos = 0;
    for (const u of us) {
      out.push(pos);
      pos += u.len;
    }
    return out;
  });
  /** 時刻（秒）に読まれている文の、章通しの番号 */
  function unitIndexAtPos(chIdx: number, t: number): number {
    const times = UNIT_TIMES[chIdx];
    if (times) return unitIndexAtTime(times, t);
    const total = CH_CHARS[chIdx] || 0;
    if (!total || !isFinite(audio.duration) || audio.duration <= 0) return 0;
    const target = Math.floor((t / audio.duration) * total) + 1; // 境界の往復誤差対策（推定時のみ）
    return unitIndexForChar(chIdx, Math.min(target, total - 1));
  }
  /** 文の開始時刻（秒）。実時刻が無い章では文字位置からの推定。分からない場合は null */
  function timeAtUnitStart(chIdx: number, unitIdx: number): number | null {
    const times = UNIT_TIMES[chIdx];
    if (times) return times[Math.max(0, Math.min(unitIdx, times.length - 1))];
    return timeAtCharPos(chIdx, UNIT_START_CHARS[chIdx][unitIdx] ?? 0);
  }
  /** 文字位置に対応する時刻（秒）。文の内側は、その文の区間の中で比例させる */
  function timeAtCharPos(chIdx: number, charPos: number): number | null {
    const times = UNIT_TIMES[chIdx];
    if (times) {
      const ui = unitIndexForChar(chIdx, charPos);
      const start = times[ui];
      const end =
        ui + 1 < times.length
          ? times[ui + 1]
          : isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : start;
      const u = UNITS[chIdx][ui];
      const frac =
        u && u.len > 0 ? Math.max(0, Math.min(1, (charPos - UNIT_START_CHARS[chIdx][ui]) / u.len)) : 0;
      return start + frac * Math.max(0, end - start);
    }
    const total = CH_CHARS[chIdx] || 0;
    if (!total || !isFinite(audio.duration) || audio.duration <= 0) return null;
    return (charPos / total) * audio.duration;
  }
  /** 文の属するページ番号（ページ割りが済んでいる前提） */
  function pageOfUnit(chIdx: number, unitIdx: number): number {
    const pages = PAGES[chIdx];
    if (!pages || !pages.length) return 0;
    let acc = 0;
    for (let p = 0; p < pages.length; p++) {
      acc += pages[p].units.length;
      if (unitIdx < acc) return p;
    }
    return pages.length - 1;
  }
  /** ページの先頭の文の、章通しの番号 */
  function firstUnitOfPage(chIdx: number, pageIdx: number): number {
    const pages = PAGES[chIdx];
    if (!pages) return 0;
    let acc = 0;
    for (let p = 0; p < pageIdx && p < pages.length; p++) acc += pages[p].units.length;
    return acc;
  }
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
  /* 表示はページ形式のみ。表示方式の切替は廃止した（v1.6.0 のセンテンス形式、
     v1.7.0〜のカラオケ方式はいずれも廃止）。保存済みの方式指定（キー display）が
     残っている端末でもページ形式で開くよう、起動時に読み捨てて消す（初期化側） */
  /* 文字サイズ：'std'＝標準（従来どおり）／'large'＝大（本文を1.2倍）。
     body.font-large で CSS 変数（--font-scale）を切り替えると、本文と計測用が
     同じ倍率になる。ページ割りは sizeKeyNow に設定を含めて再計算させ、
     読んでいる位置は文字アンカーで保つ */
  let fontSize: 'std' | 'large' = 'std';
  function setFontSize(size: 'std' | 'large'): void {
    if (size === fontSize) return;
    fontSize = size;
    save('font', size);
    document.body.classList.toggle('font-large', size === 'large');
    $('fontSizeBtn').textContent = size === 'large' ? '大' : '標準';
    if (!readerView.hidden && PAGES.length) {
      const anchor = currentAnchorChar();
      pageSizeKey = '';
      if (paginateAll()) {
        curPage = pageForChar(PAGES[current], anchor);
        renderPage(0);
        refreshTocCurrent();
        saveBookmark();
      }
    }
  }
  /* 表示中ページの各文の、章通しでの番号（renderPage が埋める。強調の対応付けに使う） */
  let pageUnitIdx: number[] = [];
  function unitIndexForChar(chIdx: number, charPos: number): number {
    const units = UNITS[chIdx];
    let pos = 0;
    for (let i = 0; i < units.length; i++) {
      if (charPos < pos + units[i].len) return i;
      pos += units[i].len;
    }
    return units.length - 1;
  }
  /* 朗読中の文の強調：現ページの各文の文字範囲（renderPage が埋める）と、
     ページ内の文番号→章通しの文番号の対応（同じく renderPage が埋める） */
  let pageUnitRanges: { start: number; len: number }[] = [];
  /* 強調の付け替えは冪等にする：「現在の音声位置から決まる1文だけに .now が
     付いている」状態を正とし、DOM がそれと食い違っていたら（消し残し・付け残し・
     再描画直後など）すべて外してから付け直す。位置は unitIndexAtPos（実時刻）で
     一意に決める。
     ページ主導シークの保留中（260msデバウンスの間）は音声位置がまだ旧ページを
     指すので付け替えず、シーク確定（seeked）で正しい文に付ける */
  function updateNowHighlight(): void {
    const spans = pageContent.querySelectorAll('.unit');
    if (isEye()) {
      // 目で読むモードでは文ハイライトを使わない
      spans.forEach((sp) => sp.classList.remove('now'));
      return;
    }
    let desired = -1;
    if (pageUnitRanges.length && isFinite(audio.duration) && audio.duration > 0) {
      if (pageSeekTimer === undefined) {
        desired = pageUnitIdx.indexOf(unitIndexAtPos(current, audio.currentTime));
      }
    }
    const marked: number[] = [];
    spans.forEach((sp, i) => {
      if (sp.classList.contains('now')) marked.push(i);
    });
    if (marked.length === 1 && marked[0] === desired) return;
    if (marked.length === 0 && desired === -1) return;
    marked.forEach((i) => spans[i].classList.remove('now'));
    if (desired >= 0 && spans[desired]) spans[desired].classList.add('now');
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
    // 表紙に戻るたびに、新しい版がないか確かめる（間隔の下限つき。src/pwa.ts）
    if (name === 'cover') checkForUpdate();
  }

  /* ---------- メニュー（入口はボタンだけ） ----------
     操作UIの出し隠しはしない。再生／停止とメニューはページ下の帯に常時置き、
     本文タップはページめくり専用。本文タップでメニューが開くことはない */
  /* メニューの組み替え（v1.12.0〜）：開いた場所と読書モードで、行の所属と見出しを
     変える。表紙では全項目を見せ、所属が分かる見出しを付ける（共通／「耳で読む」
     の設定／「目で読む」の設定）。BGM とページめくり音は両モード共通なので共通側
     （v1.12.2 で「耳で読む」から移動）。「画面を暗くしない」も共通側。
     本文中はモード別：耳で読むは従来どおり（見出しは 音／表示）、目で読むでは
     音のグループに BGM とめくり音だけを残し、朗読に紐づく項目（再生速度・
     バックグラウンド再生・朗読中の文を強調）は出さない */
  function arrangeMenu(ctx: 'cover' | 'ear' | 'eye'): void {
    const nav = $('menuGroupNav');
    const aud = $('menuGroupAudio');
    const dis = $('menuGroupDisplay');
    const headNav = $('menuHeadNav');
    const headAud = $('menuHeadAudio');
    const headDis = $('menuHeadDisplay');
    const rows = {
      toc: $('tocFromMenuBtn'),
      toCover: $('toCoverFromMenuBtn'),
      speed: $('rowSpeed'),
      pageSound: $('rowPageSound'),
      bgm: $('rowBgm'),
      bgPlay: $('rowBgPlay'),
      font: $('rowFont'),
      ruby: $('rowRuby'),
      hl: $('rowHl'),
      bg: $('rowBg'),
      wake: $('rowWake'),
    };
    const put = (parent: HTMLElement, els: HTMLElement[]): void => {
      els.forEach((el) => parent.appendChild(el));
    };
    // 目で読むで隠した行は、他の文脈で開き直したら必ず戻す
    rows.speed.hidden = false;
    rows.bgPlay.hidden = false;
    rows.hl.hidden = false;
    if (ctx === 'cover') {
      headNav.hidden = false;
      headNav.textContent = '共通';
      headAud.hidden = false;
      headAud.textContent = '「耳で読む」の設定';
      headDis.textContent = '「目で読む」の設定';
      aud.hidden = false;
      put(nav, [rows.toc, rows.toCover, rows.wake, rows.pageSound, rows.bgm]);
      put(aud, [rows.speed, rows.bgPlay, rows.hl]);
      put(dis, [rows.font, rows.ruby, rows.bg]);
    } else if (ctx === 'ear') {
      headNav.hidden = true;
      headAud.hidden = false;
      headAud.textContent = '音';
      headDis.textContent = '表示';
      aud.hidden = false;
      put(nav, [rows.toc, rows.toCover]);
      put(aud, [rows.speed, rows.pageSound, rows.bgm, rows.bgPlay]);
      put(dis, [rows.font, rows.ruby, rows.hl, rows.bg, rows.wake]);
    } else {
      headNav.hidden = true;
      headAud.hidden = false;
      headAud.textContent = '音';
      headDis.textContent = '表示';
      aud.hidden = false;
      put(nav, [rows.toc, rows.toCover]);
      put(aud, [rows.pageSound, rows.bgm]);
      put(dis, [rows.font, rows.ruby, rows.bg, rows.wake]);
      // 朗読に紐づく項目は目で読むでは出さない（置き場所ではなく行ごと隠す）
      rows.speed.hidden = true;
      rows.bgPlay.hidden = true;
      rows.hl.hidden = true;
    }
  }
  function openMenu(): void {
    // 表紙から開いたら全項目＋見出し、本文中（扉・目次を含む）はモード別の構成にする
    arrangeMenu(coverView.hidden ? readMode : 'cover');
    // 「表紙に戻る」は表紙以外から開いたときだけ出す（表紙で開いたメニューには不要）
    $('toCoverFromMenuBtn').hidden = !coverView.hidden;
    $('menuModal').hidden = false;
  }
  function closeMenu(): void {
    $('menuModal').hidden = true;
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
    // 文字サイズも含める（変わったらページ割りをやり直すため）
    return pageContent.clientWidth + 'x' + pageContent.clientHeight + 'x' + fontSize;
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
    updateNowHighlight();
    $('pageFolio').textContent = '― ' + bookPageOf(current, curPage) + ' ―';
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
    const pages = PAGES[current];
    if (!pages || !pages.length) return null;
    // ページ先頭の文の開始時刻（実時刻がある章ではそのもの、無い章では推定）
    return timeAtUnitStart(current, firstUnitOfPage(current, curPage));
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

  /* animDir は描画アニメーションの向き（0 でアニメーションなし）。
     スワイプ確定時は指の動きに合わせた滑り込みをジェスチャ側で行うため、
     通常のキーフレーム（タップ用）を重ねないよう 0 を渡す */
  function turnPage(dir: number, animDir: number = dir): void {
    if (!PAGES.length || readerView.hidden) return;
    lastManualTurn = Date.now();
    if (endOpen) {
      // 奥付ページ（本の最終ページ）での操作：前へ＝本文の最終ページへ戻る、
      // 次へ＝本を閉じて表紙へ戻る（v1.12.4 で追加。以前は次へが無反応で、
      // スワイプでは戻ることもできなかった）
      if (dir < 0) closeEndPage();
      else goCover();
      return;
    }
    const pages = PAGES[current];
    if (dir > 0) {
      // 次ページ（左へ）
      if (curPage < pages.length - 1) {
        curPage++;
        renderPage(animDir);
        schedulePageSeek();
      } else if (current < chapters.length - 1) {
        // 章をまたぐときも必ず章扉に止まる（扉を素通りして本文に入らない）
        showGate(current + 1, { autoplay: !audio.paused });
        return;
      } else {
        // 本文の最終ページの次は、独立した奥付ページ
        openEndPage();
        return;
      }
    } else {
      // 前ページ（右へ）
      if (curPage > 0) {
        curPage--;
        renderPage(animDir);
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
    // 目で読むモードでは音声位置でページを決めない（位置の正は手動送りと
    // 文字アンカー。音声は鳴っていないので、seeked 等に引きずられない）
    if (isEye()) return;
    if (!PAGES.length || !isFinite(audio.duration) || audio.duration <= 0) return;
    const total = CH_CHARS[current] || 0;
    if (!total) return;
    // 実時刻がある章では「いま読まれている文の属するページ」へ合わせる。
    // ページ先頭へシークした直後でも、その文は同じページの先頭の文なので戻らない。
    // 実時刻が無い章では従来の推定（+1 は往復変換誤差で1つ前のページに戻るのを
    // 防ぐ僅かな遊び、1文字分≒0.2秒）
    const p = UNIT_TIMES[current]
      ? pageOfUnit(current, unitIndexAtPos(current, audio.currentTime))
      : pageForChar(PAGES[current], Math.floor((audio.currentTime / audio.duration) * total) + 1);
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
    if (isEye() && PAGES.length) {
      // 目で読むモードでは音声位置が無いので、ページ先頭の文字位置から
      // 対応する朗読時刻を引いて保存する（耳で読むで再開しても同じ場所に来る。
      // 位置の正は従来どおり文字アンカー）
      const t = timeAtCharPos(current, currentAnchorChar());
      if (t !== null) bm.time = t;
    }
    if (PAGES.length) {
      bm.anchor = currentAnchorChar();
      bm.page = bookPageOf(current, curPage);
    }
    save('bookmark', bm);
  }
  function loadBookmark(): Bookmark | null {
    return load<Bookmark | null>('bookmark', null);
  }
  /* 表紙は「表紙だけが静かに出ている」状態が原則。入り口はモードの2ボタンと
     「メニュー」だけ（v1.12.2 で表紙タップでの開始と「しおりから再開」ボタンを
     廃止し、2ボタンに一本化した）。しおりの案内行は出さない（情報は2ボタンの
     補足文と重なるため）。
     ヒント文は初回（しおりがなく、まだ読み始めた記録もないとき）だけの控えめな案内 */
  function refreshResume(): void {
    const bm = loadBookmark();
    const has = !!(bm && chapters[bm.chapter]);
    // 入り口はモードの2ボタンに一本化した（v1.12.2 で「しおりから再開」ボタンを
    // 廃止）。しおりがある間は、2ボタンの補足文で「つづきから」だと分かるようにする
    const suffix = has && bm ? '・つづきから（' + chapters[bm.chapter].num + '）' : '';
    $('earModeSub').textContent = '朗読つき' + suffix;
    $('eyeModeSub').textContent = '朗読なし' + suffix;
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
    const myGate = ++gateSeq; // この扉の世代（旧い扉の非同期な続きを無効化する）
    save('seen', true); // 一度読み始めたら、表紙のヒント文は二度と出さない
    stopGateCall(); // 前の扉のコールが残っていたら止める
    // 扉にいる間、本文の朗読は必ず止める。止めないと、再生中のままページ送りで
    // 章をまたいだときに、前の章の朗読と章題コールが重なって2重に聞こえる
    // （実機報告の2重再生の主因）。再生中だったかは opts.autoplay に引き継がれ、
    // 本文は enterChapter が改めて再生する
    audio.pause();
    updatePlayBtn();
    current = idx;
    gateOpen = true;
    fillGate(chapters[idx]);
    showView('gate');
    if (gateTimer !== undefined) clearTimeout(gateTimer);
    let started = false;
    const start = (): void => {
      if (started || myGate !== gateSeq) return; // 既に進んだ／既に別の扉に替わった
      started = true;
      if (gateTimer !== undefined) clearTimeout(gateTimer);
      stopGateCall();
      gateOpen = false;
      enterChapter(idx, opts);
    };
    // タップ・スワイプは共通ジェスチャー側が gateNav を呼ぶ（次＝この start）
    // スワイプ：右へ払う＝入章（タップと同じ start）、左へ払う＝後方遷移の規則で
    // 戻る（前の章の扉を最終ページ指定で開く。第一章の扉では後方モードの扉へ）
    gateNav = {
      next: start,
      prev: () => {
        if (idx > 0) showGate(idx - 1, { page: 'last', autoplay: false });
        else showGateBack();
      },
    };
    // 扉の再生アイコン：コールや待ち時間を飛ばし、その章の朗読をすぐ始める
    gatePlay = (): void => {
      if (started || myGate !== gateSeq) return;
      started = true;
      if (gateTimer !== undefined) clearTimeout(gateTimer);
      stopGateCall();
      gateOpen = false;
      enterChapter(idx, { ...opts, autoplay: true });
    };
    syncPlayChrome();
    if (isEye()) {
      // 目で読むモードの扉は無音で、自動でも進まない（後方扉と同じく、
      // タップ／スワイプの操作でだけ本文へ入る）
      return;
    }
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
      // 扉をすでに進んだ後／別の扉に替わった後の打ち切り（止めたことによる
      // play() の中断など）では、進み直さない。世代も見るのは、替わった先の
      // 扉が開いている間（gateOpen は真に戻る）に旧い扉のフォールバックが
      // 割り込んで、タイマーを上書きしてしまうため
      if (!gateOpen || myGate !== gateSeq) return;
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
    gateSeq++; // 前の扉の非同期な続き（フォールバック等）を無効化する
    save('seen', true);
    stopGateCall(); // 前へ辿る扉は無音が原則（コールは鳴らさない）
    audio.pause();
    updatePlayBtn();
    saveBookmark();
    current = 0;
    gateOpen = true;
    if (gateTimer !== undefined) clearTimeout(gateTimer);
    fillGate(chapters[0]);
    showView('gate');
    // タップ・スワイプは共通ジェスチャー側が gateNav を呼ぶ（半分判定に統一。
    // 以前この扉だけ 0.58/0.42 の帯で分けていた）
    // スワイプ：右へ払う＝第一章の本文へ、左へ払う＝目次へ（タップの作法と同じ）
    gateNav = {
      next: () => {
        gateOpen = false;
        enterChapter(0, { autoplay: false });
      },
      prev: () => openTocPage('gate'),
    };
    // 後方扉の再生アイコン：第一章へ入り、朗読を始める
    gatePlay = (): void => {
      gateOpen = false;
      enterChapter(0, { autoplay: true });
    };
    syncPlayChrome();
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
    // 目で読むモードでは再生ボタンを出さない（音の入口を画面に残さない）
    syncPlayChrome();
    // 操作ボタンはページ下の帯に常時あるため、開いた直後に特別な表示はしない
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
            const t = timeAtCharPos(current, pages[pages.length - 1].startChar);
            if (t !== null) audio.currentTime = t;
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
    if (isEye()) return; // 目で読むモードでは、どの経路からも朗読を始めない
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
  /* 再生ボタンはアイコンだけ（文字ラベルは置かない）。図柄は updatePlayBtn が
     再生／一時停止で差し替える（innerHTML は使わず DOM で組み立てる） */
  const iconSvg = (paths: string): SVGSVGElement => {
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>',
      'image/svg+xml',
    );
    return document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  };
  /* 再生の図柄は「スピーカー＋波紋」（v1.13.1〜、ユーザー決定）：右向き三角（▶）は
     右綴じの本では綴じ方向と競合して進む／戻るの誤読を招くため、向きを持たない
     音の記号にした。線画（家マークと同じ stroke 1.6 の作法）で描く。
     一時停止は従来どおり二本線（塗り）のまま */
  const SPEAKER_ATTRS = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  const ICON_PLAY_PATHS =
    `<path d="M4 9.8v4.4c0 .3.2.5.5.5H7l4.5 3.8c.3.3.9.1.9-.3V5.7c0-.4-.6-.6-.9-.3L7 9.3H4.5c-.3 0-.5.2-.5.5z" ${SPEAKER_ATTRS}/>` +
    `<path d="M15.3 9.4a3.8 3.8 0 0 1 0 5.2" ${SPEAKER_ATTRS}/>` +
    `<path d="M17.8 6.9a7.2 7.2 0 0 1 0 10.2" ${SPEAKER_ATTRS}/>`;
  const ICON_PAUSE_PATHS = '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor"/>';
  /* 再生アイコンは本文・扉・目次の3画面で共通の家具（v1.12.2）。図柄と
     ラベルは全部まとめて現在の再生状態に合わせる */
  const PLAY_BTN_IDS = ['playPauseBtn', 'gatePlayBtn', 'tocPlayBtn'];
  function updatePlayBtn(): void {
    const playing = !audio.paused && !audio.ended;
    for (const id of PLAY_BTN_IDS) {
      const btn = $(id);
      btn.replaceChildren(iconSvg(playing ? ICON_PAUSE_PATHS : ICON_PLAY_PATHS));
      btn.setAttribute('aria-label', playing ? '一時停止' : '再生');
    }
  }
  /* 再生アイコンの出し分け：耳で読むでは3画面とも出す、目で読むでは3画面とも
     出さない（家マーク＝メニューは両モード・3画面とも常時出す） */
  function syncPlayChrome(): void {
    for (const id of PLAY_BTN_IDS) $(id).hidden = isEye();
    // 文送りは本文専用・耳で読むときだけ（v1.12.4）
    $('prevSentBtn').hidden = isEye();
    $('nextSentBtn').hidden = isEye();
  }
  /* 文単位の送り（v1.12.4、本文・耳で読む専用）：朗読位置を文の頭へ移す。
     ページとハイライトは、シーク確定後の既存の追従（seeked → syncPageToAudio /
     updateNowHighlight）がその文に合わせてくれる。一時停止中に押しても
     再生は始めず、位置だけが移る（一般的なプレイヤーの作法）。
     章はまたがない：章の最初／最後の文では、その文の頭に留まる */
  function stepSentence(dir: 1 | -1): void {
    if (isEye() || !chapters.length) return;
    const count = UNITS[current]?.length ?? 0;
    if (!count) return;
    const idx = unitIndexAtPos(current, audio.currentTime);
    let target: number;
    if (dir > 0) target = Math.min(count - 1, idx + 1);
    else if (audio.currentTime - (timeAtUnitStart(current, idx) ?? 0) > 1) {
      // 前へ：文の途中（1秒より先）なら、まずその文の頭に戻す
      target = idx;
    } else target = Math.max(0, idx - 1);
    const t = timeAtUnitStart(current, target);
    if (t === null) return;
    try {
      audio.currentTime = t;
    } catch {
      // 位置指定できなくても続行する
    }
  }
  function updateNav(): void {
    $('speedBtn').textContent = speedLabel(SPEEDS[speedIdx]);
  }
  function goCover(): void {
    stopGateCall();
    audio.pause();
    closeEndPage();
    saveBookmark();
    showView('cover');
    refreshResume();
  }

  /* ---------- 独立した奥付ページ（本のいちばん最後のページ） ----------
     本文の最終ページから「次へ」で開き、「前へ」で本文の最終ページへ戻る。
     朗読が最終章を読み終えても自動では開かない（v1.13.1〜。最終ページに
     留まる）。開いている間は朗読を止める */
  function openEndPage(): void {
    if (endOpen) return;
    endOpen = true;
    audio.pause();
    updatePlayBtn();
    $('endPage').hidden = false;
    // 手動で開いた奥付ではしおりを保存する（位置の記録として残す）。
    // 読了時のしおり消去は、朗読の ended ハンドラ側で行う（v1.13.1〜）
    saveBookmark();
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
  // 隠れる直前に朗読が鳴っていたか（バックグラウンド再生の経路用）。
  // OS が割り込みで朗読を強制停止していても、戻ったときに再開できるよう覚える
  let hiddenNarrationWasPlaying = false;
  function onVisibilityChange(): void {
    // Wake Lock は隠れると OS に解放される。戻ってきたら、条件が合えば取り直す
    syncWakeLock();
    if (document.hidden) {
      /* バックグラウンド再生が効くのは「耳で読むモードで朗読を再生している間」
         だけ（v1.12.2 で仕様変更）。表紙にいる間や目で読むモード中は、オンでも
         BGM を止める（前面に戻ったら設定どおり再開する） */
      const narrationPlaying = !isEye() && !audio.paused && !audio.ended;
      hiddenNarrationWasPlaying = narrationPlaying;
      if (bgPlay && narrationPlaying) {
        ensureAudioRunning();
        return;
      }
      hiddenPausedAudio = !audio.paused && !audio.ended;
      if (hiddenPausedAudio) audio.pause();
      hiddenStoppedBgm = document.body.dataset.bgm === 'on';
      if (hiddenStoppedBgm) stopBgm();
    } else {
      /* 復帰時の音の再開はここに一本化する。朗読：止めていた分を再開し、
         バックグラウンド再生中だったのに OS に強制停止されていた分も再開する。
         BGM：止めていた分は立て直し（フェードイン付き）、鳴らし続けていた分は
         時計のズレを見て、ズレていれば世代を作り直す（滞留した予約の一斉発音を
         防ぐ。sound.ts の restartBgmTimeline）。あわせて出口を開け直し、BGM と
         効果音（どちらも同じ AudioContext）が揃って戻るようにする */
      if (hiddenPausedAudio) playAudio();
      else if (hiddenNarrationWasPlaying && bgPlay && !isEye() && audio.paused && !audio.ended) playAudio();
      if (hiddenStoppedBgm && isBgmOn()) startBgm();
      else resyncBgmIfDesynced();
      hiddenPausedAudio = false;
      hiddenStoppedBgm = false;
      hiddenNarrationWasPlaying = false;
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
    // ノンブルは本文と同じ体裁（― N ―）・帯の中央に置く（v1.12.4）
    pager.textContent = tocPages.length > 1 ? '― ' + String(tocPage + 1) + ' / ' + String(tocPages.length) + ' ―' : '';
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
    /* 開いた元の画面を覚えておく（先頭ページでの後方操作が、そこへ帰るため。
       旧「戻る」ボタンの役目を v1.12.4 で後方操作へ統合した）。
       'gate' は、第一章から前へ辿る連鎖（扉→目次→表紙）で開いた場合 */
    tocReturn = from ?? (readerView.hidden ? 'cover' : 'reader');
    showView('toc');
    syncPlayChrome();
    // 開くたびに実測し直して出す。着地するページは開き方で決まる：
    // 後方連鎖（扉から前へ）で開いたら、本の並び順で扉の直前にある
    // 目次の最終ページに着地する（v1.12.4 で修正：以前は第一章のある
    // 1枚目に着地してしまい、扉の直前に戻れなかった）。
    // それ以外（表紙・メニューから）は、今読んでいる章のあるページ
    paginateToc();
    tocPage = from === 'gate' ? tocPages.length - 1 : tocPageIndexOf(current);
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
    /* 表紙タップでは本を開かない（v1.12.2 で廃止）。入り口はモードの2ボタンだけ */
    /* 読書モードの入口（表紙）：モードを決めてから本へ入る。しおりがあれば、
       どちらの入口でも続きから再開する（位置は文字アンカーで保持されるので、
       モードをまたいでも同じ場所に来る） */
    const enterFromCover = (mode: 'ear' | 'eye'): void => {
      readMode = mode;
      // BGM は両モード共通なので、目で読むで入るときも止めない
      if (loadBookmark()) resumeFromBookmark();
      // 初めて読むとき（しおりが無い）は、まず目次ページを開く（v1.12.4）。
      // 章を選ぶ／前方向の操作で第一章の扉へ進む流れは、目次の既存の規則どおり。
      // 「しおりが無い」には読了後も含まれる：読了でしおりは消える
      // （朗読の ended ハンドラ）ため、読み直しも目次から始まる
      else openTocPage('cover');
    };
    $('earModeBtn').addEventListener('click', () => enterFromCover('ear'));
    $('eyeModeBtn').addEventListener('click', () => enterFromCover('eye'));
    /* メニュー（入口は本文・扉・目次の家マークと表紙の「メニュー」、中身は1つ。
       目次・設定はこの中にある） */
    $('menuBtn').addEventListener('click', openMenu);
    $('gateMenuBtn').addEventListener('click', openMenu);
    $('tocMenuBtn').addEventListener('click', openMenu);
    $('coverMenuBtn').addEventListener('click', openMenu);
    $('endMenuBtn').addEventListener('click', openMenu); // 奥付の家マークも他画面と同じくメニューを開く
    /* 扉の再生アイコン：表示中の扉が決めた gatePlay（入章して朗読開始） */
    $('gatePlayBtn').addEventListener('click', () => {
      if (gatePlay) gatePlay();
    });
    /* 目次の再生アイコン：現在位置の章から朗読を始める。戻り先が本文なら
       その場で再生、扉（後方連鎖）なら扉の gatePlay、表紙からなら現在位置
       （しおり、無ければ第一章）から入る */
    $('tocPlayBtn').addEventListener('click', () => {
      const from = tocReturn;
      closeTocPage();
      if (from === 'reader') playAudio();
      else if (from === 'gate') {
        if (gatePlay) gatePlay();
      } else if (loadBookmark()) resumeFromBookmark();
      else {
        showGate(0);
        if (gatePlay) gatePlay();
      }
    });
    $('menuCloseBtn').addEventListener('click', closeMenu);
    $('menuBackdrop').addEventListener('click', closeMenu);
    /* ---------- ページ操作の共通ジェスチャー（本文・扉・目次で完全共通） ----------
       3画面で別々に実装していた頃は、目次だけフリックも追随も無く、扉だけ確定時の
       アニメーションが無いなど、画面ごとに挙動がずれていた（実機指摘）。ここに
       一本化し、向き・確定量・フリック・追随・アニメーション・タップの半分判定
       まで、すべて同じ規則で動かす。
       - スワイプ：次側と反対へ払うと次、前へ払うと前（タップの半分判定とは逆向き。
         どちらが次側かは DIR.nextSide が決める）。確定は「幅の9%か28pxの大きい方」
         まで動かすか、速いフリック（14px以上かつ0.4px/ms以上、同方向）。
       - 追随：指の移動をゴム状に減衰させたうえで 0.45 倍に抑え、最大24pxまでに
         留める。旧実装はゴム追随のまま大きく動き「ちらつく」印象だったため、
         v1.11.1 で遊びを小さくし（最大48px）、v1.12.2 でさらに半減させた
         （実機で「もっと少なくていい」）。確定時の滑りも画面幅ではなく最大28px
         に留め、差し替え後は反対側14pxから .18s で静かに収める。未満は .22s
         で戻す（行き過ぎ＝オーバーシュートは付けない）。
       - タップ：左右の半分で次／前（中央の無反応帯なし）。端ぎわ12pxは誤爆防止の
         無反応帯。ボタン上の操作と、スワイプ直後の click は対象にしない。
       - めくりが確定した瞬間に、ページめくり音を1回鳴らす（スワイプ・タップ共通）。
       - prefers-reduced-motion では追随もアニメーションもせず即時に切り替える */
    const SWIPE_COMMIT_RATIO = 0.09;
    const SWIPE_COMMIT_MIN_PX = 28;
    const SWIPE_FLICK_VELOCITY = 0.4; // px/ms（直近の指の速度）
    const SWIPE_FLICK_MIN_PX = 14; // フリックでも最低これだけは動いていること
    const SWIPE_FOLLOW_SCALE = 0.45; // 指の移動に対する追随の割合
    const SWIPE_FOLLOW_MAX_PX = 12; // 追随の最大移動量（実機フィードバックで段階的に縮小：48 → 24 → 12px。ページはほぼ動かさず、めくれる方向だけが感じられる最小限）
    const SWIPE_OUT_PX = 14; // 確定時に滑り出す量（56 → 28 → 14px と段階的に縮小）
    const SWIPE_IN_PX = 7; // 差し替え後に滑り込む量（28 → 14 → 7px と段階的に縮小）
    const swipeCommitPx = (w: number): number => Math.max(SWIPE_COMMIT_MIN_PX, w * SWIPE_COMMIT_RATIO);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    /* ゴムのような減衰（iOS のラバーバンドと同じ形。引っ張るほど鈍くなり、
       限界ではページ幅に漸近する） */
    const rubberDx = (d: number, w: number): number => {
      const a = Math.abs(d);
      return Math.sign(d) * w * (1 - 1 / ((a / w) * 0.55 + 1));
    };
    /* 実際の追随量：ゴム減衰をさらに SWIPE_FOLLOW_SCALE 倍し、上限を設ける */
    const followDx = (dx: number, w: number): number =>
      Math.sign(dx) * Math.min(Math.abs(rubberDx(dx, w)) * SWIPE_FOLLOW_SCALE, SWIPE_FOLLOW_MAX_PX);
    /* タップの半分判定（3画面共通）。端ぎわ12pxは 0（無反応）を返す */
    const tapDirFor = (view: HTMLElement, clientX: number): 1 | -1 | 0 => {
      const r = view.getBoundingClientRect();
      const x = clientX - r.left;
      if (x < 12 || x > r.width - 12) return 0;
      const onNextSide = DIR.nextSide === 'left' ? x / r.width < 0.5 : x / r.width > 0.5;
      return onNextSide ? 1 : -1;
    };
    interface SwipeHandle {
      swipedRecently: () => boolean;
    }
    function attachSwipeNav(o: {
      surface: HTMLElement;
      followEl: HTMLElement | null;
      onNav: (dir: 1 | -1) => void;
      canStart?: (e: PointerEvent) => boolean;
      onDragActive?: (active: boolean) => void;
    }): SwipeHandle {
      let swipedAt = 0;
      let seq = 0;
      let drag: { id: number; x: number; y: number; active: boolean; lastX: number; lastT: number; vx: number } | null = null;
      const el = o.followEl;
      const reset = (): void => {
        if (!el) return;
        el.style.transition = '';
        el.style.transform = '';
      };
      o.surface.addEventListener('pointerdown', (e) => {
        seq++;
        if (o.canStart && !o.canStart(e)) {
          drag = null;
          return;
        }
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false, lastX: e.clientX, lastT: performance.now(), vx: 0 };
        /* ポインタ捕捉はここではしない。捕捉すると click の宛先が表面に付け替わり、
           表面の中にあるボタン（目次項目・戻る等）の click が奪われてしまう。
           捕捉はドラッグが活性化した時点（pointermove）に遅らせる */
      });
      o.surface.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        // フリック判定用に、直近の指の速度（px/ms）を平滑化して持つ
        const nowT = performance.now();
        const dt = nowT - drag.lastT;
        if (dt > 0) {
          const inst = (e.clientX - drag.lastX) / dt;
          drag.vx = drag.vx * 0.35 + inst * 0.65;
          drag.lastX = e.clientX;
          drag.lastT = nowT;
        }
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.active) {
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            drag.active = true;
            o.onDragActive?.(true);
            try {
              o.surface.setPointerCapture(e.pointerId);
            } catch {
              // 捕捉できなくても、通常のイベントの流れで続行する
            }
          } else if (Math.abs(dy) > 10) {
            drag = null; // 縦方向の動きはジェスチャにしない
            return;
          } else {
            return;
          }
        }
        if (!reduceMotion.matches && el) {
          el.style.transform = 'translateX(' + followDx(dx, o.surface.clientWidth || 1) + 'px)';
        }
      });
      const finish = (e: PointerEvent, cancelled: boolean): void => {
        if (!drag || e.pointerId !== drag.id) return;
        const wasActive = drag.active;
        const dx = e.clientX - drag.x;
        // 離す直前に指が止まっていたら、速度はフリックとみなさない
        const vx = performance.now() - drag.lastT > 90 ? 0 : drag.vx;
        const mySeq = seq;
        drag = null;
        o.onDragActive?.(false);
        if (!wasActive) return; // ただのタップは click 側で処理する
        swipedAt = Date.now(); // 直後の click で二重にめくらない
        const w = o.surface.clientWidth || 1;
        const towardNext = DIR.nextSide === 'left' ? dx > 0 : dx < 0;
        const dir: 1 | -1 = towardNext ? 1 : -1;
        const dist = Math.abs(dx);
        const flick =
          dist >= SWIPE_FLICK_MIN_PX && Math.abs(vx) >= SWIPE_FLICK_VELOCITY && Math.sign(vx) === Math.sign(dx);
        const commit = !cancelled && (dist >= swipeCommitPx(w) || flick);
        if (commit) turnSound(); // 確定した瞬間に1回だけ鳴らす
        if (reduceMotion.matches || !el) {
          reset();
          if (commit) o.onNav(dir);
          return;
        }
        if (!commit) {
          // 確定量未満：静かに元の位置へ戻る
          el.style.transition = 'transform .22s ease-out';
          el.style.transform = '';
          setTimeout(() => {
            if (mySeq === seq) reset();
          }, 240);
          return;
        }
        // 確定：少しだけ滑り出してから差し替え、反対側から静かに滑り込ませる
        const sign = dx < 0 ? -1 : 1;
        el.style.transition = 'transform .14s ease-out';
        el.style.transform = 'translateX(' + sign * SWIPE_OUT_PX + 'px)';
        setTimeout(() => {
          if (mySeq !== seq) return; // 間際に次のジェスチャが始まっていたら邪魔しない
          o.onNav(dir);
          el.style.transition = '';
          el.style.transform = 'translateX(' + -sign * SWIPE_IN_PX + 'px)';
          void el.offsetWidth; // 反対側に置いた状態を確定させてから滑り込ませる
          el.style.transition = 'transform .18s ease-out';
          el.style.transform = '';
          setTimeout(() => {
            if (mySeq === seq) reset();
          }, 200);
        }, 150);
      };
      o.surface.addEventListener('pointerup', (e) => finish(e, false));
      o.surface.addEventListener('pointercancel', (e) => finish(e, true));
      return { swipedRecently: () => Date.now() - swipedAt < 350 };
    }
    /* 目次ページへの入口はメニューの「目次を開く」に一本化（表紙にも読書中にも共通） */
    $('tocFromMenuBtn').addEventListener('click', () => {
      closeMenu();
      openTocPage();
    });
    /* 目次のページ送りも共通ジェスチャーで本文・扉と揃える（v1.11.1 で統一）。
       目次ページの端での遷移（v1.12.4 で「戻る」ピルを廃止し、その役目を
       後方操作へ統合した）：
       - 先頭ページでの前へ＝「開いた元へ戻る」。読書中（メニュー）から開いた
         目次なら本文へ帰り、表紙から開いた目次なら表紙へ帰る。後方連鎖
         （扉から前へ）で開いた目次は、本の並び順どおり表紙へ進む
         （扉へは次方向の操作で戻れるので、後方だけで表紙まで辿り着ける
         連鎖は途切れない）
       - 末尾ページでの次へ＝第一章の扉（通常モードで開き、本文へ続く） */
    const tocTapNav = (dir: number): void => {
      if (turnTocPage(dir)) return;
      if (dir < 0) {
        if (tocReturn === 'reader') showView('reader');
        else goCover();
      } else showGate(0);
    };
    const tocSwipe = attachSwipeNav({
      surface: tocView,
      followEl: tocView.querySelector<HTMLElement>('.toc-sheet'),
      onDragActive: (a) => tocView.classList.toggle('toc-dragging', a),
      onNav: (dir) => tocTapNav(dir),
    });
    tocView.addEventListener('click', (e) => {
      if (tocSwipe.swipedRecently()) return; // スワイプ直後のクリックでは送らない
      if ((e.target as HTMLElement).closest('button')) return; // 章項目はボタン側の処理
      const dir = tapDirFor(tocView, e.clientX);
      if (!dir) return;
      turnSound();
      tocTapNav(dir);
    });
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
    $('prevSentBtn').addEventListener('click', () => stepSentence(-1));
    $('nextSentBtn').addEventListener('click', () => stepSentence(1));
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
    $('fontSizeBtn').addEventListener('click', () => {
      setFontSize(fontSize === 'std' ? 'large' : 'std');
    });
    $<HTMLInputElement>('hlToggle').addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      document.body.classList.toggle('hl-off', !checked);
      save('hl', checked);
    });
    $<HTMLInputElement>('pageSoundToggle').addEventListener('change', (e) => {
      // ページめくり音のオン/オフ（効果音の設定。BGM とは独立）
      setSound((e.target as HTMLInputElement).checked);
    });
    $<HTMLInputElement>('bgmToggle').addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      // オフは即停止、オンは（この操作自体がジェスチャなので）すぐ鳴らし始める
      // （BGM は両モード共通なので、目で読むモード中でも鳴らす）
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
       表紙・扉・本文のどこで触れても、設定がオンなら流れ始めて画面をまたいで続く
       （BGM は両モード共通。目で読むモードでも鳴る） */
    document.addEventListener('pointerdown', () => {
      // どのタップでも音の出口を開け直す（復帰後に BGM は鳴るのに効果音だけ
      // 出ない、といった食い違いを作らない。BGM の開始判定は従来どおり）
      ensureAudioRunning();
      if (isBgmOn()) startBgm();
    });
    /* 本文のページめくり（共通ジェスチャー）。役割は「進む／戻る」だけに統一し、
       メニューや再生はページ下の帯のボタンからのみ操作する（本文タップで
       メニューや操作 UI が出ることはない）。ボタンの上と奥付ページ表示中は
       めくりジェスチャの対象にしない */
    const bodySwipe = attachSwipeNav({
      surface: pageWrap,
      followEl: pageEl,
      canStart: (e) => !(e.target as HTMLElement).closest('button') && !endOpen,
      onDragActive: (a) => {
        pageEl.classList.toggle('dragging', a);
        if (a) pageEl.classList.remove('turn-next', 'turn-prev');
      },
      onNav: (dir) => turnPage(dir, 0),
    });
    pageWrap.addEventListener('click', (e) => {
      if (bodySwipe.swipedRecently()) return;
      if ((e.target as HTMLElement).closest('button')) return;
      // 奥付は pageWrap の内側に重なっているため、奥付のタップがここへ
      // 伝播してくる。奥付表示中は奥付側のハンドラに任せる（スワイプで
      // 奥付を閉じた直後の click が本文側で「次へ」と解釈され、奥付を
      // 開き直してしまう事故の防止）
      if (endOpen) return;
      const dir = tapDirFor(pageWrap, e.clientX);
      if (!dir) return;
      turnSound(); // タップめくりでも、確定した瞬間に1回鳴らす
      turnPage(dir);
    });
    /* 奥付ページにも、他のページと同じページ操作を効かせる（v1.12.4、実機
       報告「奥付まで行くとスワイプで戻れない」への対応）。奥付は本文の上に
       重なる独立レイヤーなので、共通ジェスチャーを奥付自身にも付ける。
       遷移先は turnPage の奥付中の規則どおり：前へ＝本文の最終ページ、
       次へ＝表紙。帯の家マークはボタンのため、ジェスチャーの対象から
       外れてメニューを開く（docs/DESIGN.md に記録） */
    const endPageEl = $('endPage');
    const endSwipe = attachSwipeNav({
      surface: endPageEl,
      followEl: endPageEl,
      canStart: (e) => !(e.target as HTMLElement).closest('button'),
      onNav: (dir) => turnPage(dir, 0),
    });
    endPageEl.addEventListener('click', (e) => {
      // 奥付は pageWrap の内側にあるため、処理したタップを本文側へ伝播させない
      // （奥付を閉じた直後に、同じタップで本文までめくれてしまう二重効きの防止）
      e.stopPropagation();
      if (endSwipe.swipedRecently()) return;
      if ((e.target as HTMLElement).closest('button')) return;
      const dir = tapDirFor(endPageEl, e.clientX);
      if (!dir) return;
      turnSound();
      turnPage(dir);
    });
    document.addEventListener('keydown', (e) => {
      if (readerView.hidden) return;
      const nextKey = DIR.nextSide === 'left' ? 'ArrowLeft' : 'ArrowRight';
      const prevKey = DIR.nextSide === 'left' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === nextKey) turnPage(1);
      else if (e.key === prevKey) turnPage(-1);
    });
    /* 扉（ゲート）のページ操作も共通ジェスチャーで本文・目次と揃える。遷移先は
       gateNav（表示中の扉が決める：通常扉は次＝入章／前＝前の扉か後方扉、後方扉は
       次＝第一章の本文／前＝目次）。タップも半分判定に統一した（以前は通常扉が
       「どこを押しても入章」、後方扉が 0.58/0.42 の非対称な帯だった） */
    const gateSwipe = attachSwipeNav({
      surface: gateView,
      followEl: gateView.querySelector<HTMLElement>('.gate-sheet'),
      onDragActive: (a) => gateView.classList.toggle('gate-dragging', a),
      onNav: (dir) => {
        if (!gateNav) return;
        if (dir > 0) gateNav.next();
        else gateNav.prev();
      },
    });
    gateView.addEventListener('click', (e) => {
      if (gateSwipe.swipedRecently()) return; // スワイプ直後のクリックでは遷移しない
      if ((e.target as HTMLElement).closest('button')) return;
      const dir = tapDirFor(gateView, e.clientX);
      if (!dir || !gateNav) return;
      turnSound();
      if (dir > 0) gateNav.next();
      else gateNav.prev();
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
    });
    audio.addEventListener('seeked', () => {
      syncPageToAudio(true);
      syncMediaPosition();
      updateNowHighlight();
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
        // 最終章の朗読が終わったら、本文の最終ページに留まる（v1.13.1 で変更。
        // 以前は自動で奥付ページへ進んでいたが、読み終わりの余韻を最終ページで
        // 楽しめるよう、自動では進まない。奥付へは手動の前進操作で従来どおり
        // 行ける）。再生は ended で自然に止まる。BGM は従来の終了時挙動どおり
        // 止めずに鳴らし続ける。読了の扱い（しおりを消す）も従来どおり
        syncPageToAudio(true);
        remove('bookmark');
        refreshResume();
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
  // 表示方式の切替は廃止した（ページ形式のみ）。旧設定で 'karaoke' や 'sentence' が
  // 保存されていてもページ形式で開くよう、保存済みの方式指定はここで消しておく
  remove('display');
  // 文字サイズ（未保存なら標準＝従来どおり）
  fontSize = load<string>('font', 'std') === 'large' ? 'large' : 'std';
  document.body.classList.toggle('font-large', fontSize === 'large');
  $('fontSizeBtn').textContent = fontSize === 'large' ? '大' : '標準';
  $<HTMLInputElement>('pageSoundToggle').checked = isSoundOn();
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
