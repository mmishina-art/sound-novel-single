// 読書画面まわり（表紙・章扉・ページめくり・朗読・しおり）の DOM 操作。
// 純粋な計算は logic.ts、保存は storage.ts に寄せ、ここは画面と音声の段取りだけを持つ。
import {
  SPEEDS,
  buildUnits,
  directionOf,
  fmt,
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
import { load, remove, save } from './storage';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

/** 本文の HTML は、自作の原稿データ（data.json）を rubyToHtml でエスケープしながら組み立てた固定のものだけを入れる */
function setHtml(el: HTMLElement, html: string): void {
  // eslint-disable-next-line no-restricted-syntax -- 理由: 上記のとおり、外部入力ではなく自作データからの固定 HTML のため
  el.innerHTML = html;
}

export interface Reader {
  /** バックアップ読み込み後などに、保存済みの設定（速度・ルビ・しおり）を読み直す */
  reloadSettings(): void;
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
  const readerView = $('readerView');
  const pageWrap = $('pageWrap');
  const pageEl = $('pageEl');
  const pageContent = $('pageContent');
  const endView = $('endView');
  const audio = $<HTMLAudioElement>('audioEl');
  const audioError = $('audioError');
  const hintNext = document.querySelector<HTMLElement>('.hint-next');
  const hintPrev = document.querySelector<HTMLElement>('.hint-prev');
  if (hintNext) hintNext.textContent = DIR.nextSide === 'left' ? '◀' : '▶';
  if (hintPrev) hintPrev.textContent = DIR.nextSide === 'left' ? '▶' : '◀';

  /* ---- 状態 ---- */
  let current = 0;
  let speedIdx = speedIndexOf(load<number>('speed', 1.0));
  let gateTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSeek = 0;
  const UNITS: Unit[][] = chapters.map((ch) => buildUnits(ch));
  const CH_CHARS: number[] = UNITS.map((us) => us.reduce((a, u) => a + u.len, 0));
  let PAGES: Page[][] = [];
  let CUM_PAGES: number[] = [];
  let TOTAL_PAGES = 0;
  let pageSizeKey = '';
  let curPage = 0;
  let endShown = false;
  let lastManualTurn = 0;
  let enterStamp = 0;
  let measurer: HTMLDivElement | null = null;
  const tocItems: HTMLButtonElement[] = [];

  function setPreservesPitch(): void {
    audio.preservesPitch = true;
    const a = audio as HTMLAudioElement & { mozPreservesPitch?: boolean; webkitPreservesPitch?: boolean };
    if ('mozPreservesPitch' in a) a.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = true;
  }
  setPreservesPitch();

  function showView(name: 'cover' | 'gate' | 'reader'): void {
    coverView.hidden = name !== 'cover';
    gateView.hidden = name !== 'gate';
    readerView.hidden = name !== 'reader';
    window.scrollTo(0, 0);
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
    for (const u of units) {
      if (!group || curPara !== u.para) group = startGroup(u);
      savedHtml = group.innerHTML;
      setHtml(group, savedHtml + rubyToHtml(u.html));
      if (!fits() && pageUnits.length) {
        // この文は次のページへ
        setHtml(group, savedHtml);
        if (!group.textContent) {
          group.remove();
          paraBegun.delete(u.para);
        }
        closePage();
        group = startGroup(u);
        setHtml(group, rubyToHtml(u.html));
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
    pageSizeKey = w + 'x' + h;
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
    for (const u of page.units) {
      if (u.para !== openPara) {
        closeP();
        const cls = groupClass(u, paraBegun);
        html += '<p' + (cls ? ' class="' + cls + '"' : '') + '>';
        openPara = u.para;
        paraBegun.add(u.para);
      }
      html += rubyToHtml(u.html);
    }
    closeP();
    setHtml(pageContent, html);
    $('pageFolio').textContent = '― ' + bookPageOf(current, curPage) + ' ―';
    $('pageChapterPos').textContent = curPage + 1 + ' / ' + pages.length;
    $('readerChapterLabel').textContent = ch.num + ' ' + ch.title;
    if (hintNext) {
      hintNext.style.visibility =
        current === chapters.length - 1 && curPage === pages.length - 1 && endShown ? 'hidden' : 'visible';
    }
    if (hintPrev) {
      hintPrev.style.visibility = current === 0 && curPage === 0 && !endShown ? 'hidden' : 'visible';
    }
    if (animDir) {
      pageEl.classList.remove('turn-next', 'turn-prev');
      void pageEl.offsetWidth;
      pageEl.classList.add(animDir > 0 ? 'turn-next' : 'turn-prev');
    }
  }
  function showEndPage(): void {
    endShown = true;
    pageEl.hidden = true;
    endView.hidden = false;
    $('readerChapterLabel').textContent = chapters[current].num + ' ' + chapters[current].title;
  }
  function hideEndPage(): void {
    endShown = false;
    endView.hidden = true;
    pageEl.hidden = false;
  }
  function turnPage(dir: number): void {
    if (!PAGES.length || readerView.hidden) return;
    lastManualTurn = Date.now();
    const pages = PAGES[current];
    if (dir > 0) {
      // 次ページ（左へ）
      if (endShown) return;
      if (curPage < pages.length - 1) {
        curPage++;
        renderPage(1);
      } else if (current < chapters.length - 1) {
        enterChapter(current + 1, { autoplay: !audio.paused });
        return;
      } else {
        showEndPage();
        return;
      }
    } else {
      // 前ページ（右へ）
      if (endShown) {
        hideEndPage();
        curPage = pages.length - 1;
        renderPage(-1);
      } else if (curPage > 0) {
        curPage--;
        renderPage(-1);
      } else if (current > 0) {
        enterChapter(current - 1, { page: 'last', autoplay: !audio.paused });
        return;
      } else return;
    }
    saveBookmark();
  }
  /* 朗読の進行にページを合わせる（手動でめくった直後は干渉しない） */
  function syncPageToAudio(force: boolean): void {
    if (!PAGES.length || !isFinite(audio.duration) || audio.duration <= 0) return;
    const total = CH_CHARS[current] || 0;
    if (!total) return;
    const target = Math.floor((audio.currentTime / audio.duration) * total);
    const p = pageForChar(PAGES[current], target);
    if (p === curPage) return;
    if (force) {
      if (!endShown) {
        curPage = p;
        renderPage(0);
      }
      return;
    }
    if (audio.paused) return;
    if (Date.now() - lastManualTurn < 12000) return;
    if (p > curPage && !endShown) {
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
  function refreshResume(): void {
    const bm = loadBookmark();
    const btn = $('resumeBtn');
    const info = $('bookmarkInfo');
    if (bm && chapters[bm.chapter]) {
      btn.hidden = false;
      info.hidden = false;
      info.textContent =
        'しおり：' +
        chapters[bm.chapter].num +
        ' ' +
        chapters[bm.chapter].title +
        (bm.page ? ' ／ ' + bm.page + 'ページ' : '') +
        ' ／ ' +
        fmt(bm.time || 0);
      btn.textContent = 'しおりから再開（' + chapters[bm.chapter].num + '）';
    } else {
      btn.hidden = true;
      info.hidden = true;
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
    $('gateNarrator').textContent = '語り・' + ch.narratorName;
  }
  function showGate(idx: number, opts: EnterOptions = {}): void {
    current = idx;
    fillGate(chapters[idx]);
    showView('gate');
    if (gateTimer !== undefined) clearTimeout(gateTimer);
    const start = (): void => {
      if (gateTimer !== undefined) clearTimeout(gateTimer);
      enterChapter(idx, opts);
    };
    gateView.onclick = start;
    gateTimer = setTimeout(start, 1800);
  }
  function layoutChapter(opts: EnterOptions): void {
    // リーダーが表示された状態でページ割りをする
    if (!PAGES.length || sizeKeyNow() !== pageSizeKey) paginateAll();
    if (!PAGES.length) return;
    hideEndPage();
    if (opts.anchor != null) curPage = pageForChar(PAGES[current], opts.anchor);
    else if (opts.page === 'last') curPage = PAGES[current].length - 1;
    else if (typeof opts.page === 'number') curPage = opts.page;
    else curPage = 0;
    renderPage(0);
    tocItems.forEach((el, i) => el.classList.toggle('current', i === current));
  }
  function enterChapter(idx: number, opts: EnterOptions = {}): void {
    current = idx;
    enterStamp = Date.now();
    showView('reader');
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
  }
  function playAudio(): void {
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
    $<HTMLButtonElement>('prevChapterBtn').disabled = current <= 0;
    $<HTMLButtonElement>('nextChapterBtn').disabled = current >= chapters.length - 1;
    $('speedBtn').textContent = speedLabel(SPEEDS[speedIdx]);
  }
  function goCover(): void {
    audio.pause();
    saveBookmark();
    showView('cover');
    refreshResume();
  }

  /* ---------- TOC ---------- */
  function buildToc(): void {
    const list = $('tocList');
    list.replaceChildren();
    tocItems.length = 0;
    chapters.forEach((c, i) => {
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
      const narr = document.createElement('span');
      narr.className = 'toc-narr';
      narr.textContent = '語り・' + c.narratorName;
      btn.append(num, ttl, narr);
      btn.addEventListener('click', () => {
        $('tocModal').hidden = true;
        showGate(i);
      });
      li.appendChild(btn);
      list.appendChild(li);
      tocItems.push(btn);
    });
  }

  /* ---------- events ---------- */
  function bind(): void {
    $('coverTap').addEventListener('click', () => showGate(0));
    $('resumeBtn').addEventListener('click', () => {
      const bm = loadBookmark();
      if (!bm) return;
      showGate(bm.chapter, { seek: bm.time || 0, anchor: bm.anchor != null ? bm.anchor : null });
    });
    $('tocFromCoverBtn').addEventListener('click', () => {
      $('tocModal').hidden = false;
    });
    $('tocBtn').addEventListener('click', () => {
      $('tocModal').hidden = false;
    });
    $('tocCloseBtn').addEventListener('click', () => {
      $('tocModal').hidden = true;
    });
    $('tocBackdrop').addEventListener('click', () => {
      $('tocModal').hidden = true;
    });
    $('toCoverBtn').addEventListener('click', goCover);
    $('endToCoverBtn').addEventListener('click', goCover);
    $('playPauseBtn').addEventListener('click', () => {
      if (audio.paused) playAudio();
      else {
        audio.pause();
        saveBookmark();
      }
    });
    $('prevChapterBtn').addEventListener('click', () => {
      if (current > 0) showGate(current - 1);
    });
    $('nextChapterBtn').addEventListener('click', () => {
      if (current < chapters.length - 1) showGate(current + 1);
    });
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
    $<HTMLInputElement>('progressBar').addEventListener('input', (e) => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = (Number((e.target as HTMLInputElement).value) / 100) * audio.duration;
        saveBookmark();
      }
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
        if (readerView.hidden) {
          pageSizeKey = '';
          return;
        }
        if (sizeKeyNow() === pageSizeKey) return;
        const anchor = currentAnchorChar();
        if (paginateAll()) {
          curPage = pageForChar(PAGES[current], anchor);
          if (!endShown) renderPage(0);
        }
      }, 250);
    });

    audio.addEventListener('timeupdate', () => {
      $('currentTime').textContent = fmt(audio.currentTime);
      $('durationTime').textContent = fmt(audio.duration);
      if (isFinite(audio.duration) && audio.duration > 0) {
        $<HTMLInputElement>('progressBar').value = String((audio.currentTime / audio.duration) * 100);
      }
      if (Math.floor(audio.currentTime) % 5 === 0) saveBookmark();
      syncPageToAudio(false);
    });
    audio.addEventListener('seeked', () => syncPageToAudio(true));
    audio.addEventListener('loadedmetadata', () => {
      $('durationTime').textContent = fmt(audio.duration);
    });
    audio.addEventListener('play', updatePlayBtn);
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
      if (current < chapters.length - 1) {
        showGate(current + 1);
      } else {
        showEndPage();
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
  buildToc();
  bind();
  refreshResume();
  showView('cover');
  updateNav();

  return {
    reloadSettings(): void {
      speedIdx = speedIndexOf(load<number>('speed', 1.0));
      audio.playbackRate = SPEEDS[speedIdx];
      const on = load<boolean>('ruby', true);
      $<HTMLInputElement>('rubyToggle').checked = on;
      document.body.classList.toggle('ruby-off', !on);
      updateNav();
      refreshResume();
    },
    goLastChapter(): void {
      if (chapters.length) showGate(chapters.length - 1);
    },
    clearBookmark(): void {
      remove('bookmark');
      refreshResume();
    },
  };
}
