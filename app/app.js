'use strict';
/* 空の郵便が届くまで — single book app （右綴じ・ページめくり） */
const LS_KEY = 'sora-yubin-bookmark-v1';
const LS_SPEED = 'sora-yubin-speed-v1';
const LS_RUBY = 'sora-yubin-ruby-v1';
const SPEEDS = [0.8, 1.0, 1.25, 1.5, 2.0];

/* ---- 本ごとの方向設定 ----
   data.json の "direction" で切り替える（未指定は 'vertical'）。
   方向に依存する判断（組版の writing-mode、綴じ側、ページ送り方向、はみ出しの測り方）は
   すべて DIR と CSS の body の dir 系／bound 系クラスに集約してある。
   'horizontal'（横書き・左綴じ）は将来対応：設定値と切り替え口だけ用意し、
   横書きの組版調整そのものは未実装。 */
const DIRECTIONS = {
  vertical:   { mode: 'vertical',   bound: 'right', nextSide: 'left'  },
  horizontal: { mode: 'horizontal', bound: 'left',  nextSide: 'right' }
};
let DIR = DIRECTIONS.vertical;

let book = null;
let chapters = [];
let current = 0;
let speedIdx = 1; // 1.0
let gateTimer = null;
let pendingSeek = 0;
let isPlaying = false;

/* ---- pagination state ---- */
let UNITS = [];      // per chapter: [{html,len,para,first,sep}]
let CH_CHARS = [];   // per chapter: 表示文字数（ルビ除く）
let PAGES = [];      // per chapter: [{startChar, units:[unit,...]}]
let CUM_PAGES = [];  // per chapter: その章の前に何ページあるか
let TOTAL_PAGES = 0;
let pageSizeKey = '';
let curPage = 0;
let endShown = false;
let lastManualTurn = 0;
let enterStamp = 0;
let measurer = null;

const $ = (id) => document.getElementById(id);
const coverView = $('coverView'), gateView = $('gateView'), readerView = $('readerView');
const pageWrap = $('pageWrap'), pageEl = $('pageEl'), pageContent = $('pageContent'), endView = $('endView');
const audio = $('audioEl');
audio.preservesPitch = true;
if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;

function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function rubyToHtml(text){
  // Aozora ruby: ｜base《reading》 or base《reading》
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '｜') {
      const open = text.indexOf('《', i);
      const close = open >= 0 ? text.indexOf('》', open) : -1;
      if (open > i && close > open) {
        out += '<ruby>' + esc(text.slice(i + 1, open)) + '<rt>' + esc(text.slice(open + 1, close)) + '</rt></ruby>';
        i = close + 1; continue;
      }
      i++; continue;
    }
    if (text[i] === '《') {
      const close = text.indexOf('》', i);
      if (close > i) { i = close + 1; continue; }
    }
    let j = i;
    while (j < text.length && text[j] !== '｜' && text[j] !== '《') j++;
    if (j < text.length && text[j] === '《') {
      const close = text.indexOf('》', j);
      if (close > j) {
        out += '<ruby>' + esc(text.slice(i, j)) + '<rt>' + esc(text.slice(j + 1, close)) + '</rt></ruby>';
        i = close + 1; continue;
      }
    }
    out += esc(text.slice(i, j)); i = j;
  }
  return out;
}
function fmt(t){
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function showView(name){
  coverView.hidden = name !== 'cover';
  gateView.hidden = name !== 'gate';
  readerView.hidden = name !== 'reader';
  window.scrollTo(0, 0);
}
function audioSrc(idx){ return 'audio/ch' + (idx + 1) + '.mp3'; }

/* ================= pagination =================
   本文は縦書き。1ページ＝紙の枠に収まる分だけを、文単位で流し込んで測る。
   ページ送りは右綴じ：次ページは左方向。 */
function plainLen(rubyText){
  return rubyText.replace(/｜/g, '').replace(/《[^》]*》/g, '').length;
}
function splitSentences(text){
  const out = [];
  let buf = '', inRuby = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    buf += c;
    if (c === '《') inRuby = true;
    else if (c === '》') inRuby = false;
    else if (c === '。' && !inRuby) {
      while (i + 1 < text.length && '」』）】〉・…'.indexOf(text[i + 1]) >= 0) { buf += text[++i]; }
      out.push(buf); buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}
function buildUnits(ch){
  const src = (ch.ruby && ch.ruby.length) ? ch.ruby : (ch.paragraphs || []);
  const units = [];
  src.forEach((p, pi) => {
    if (p.trim() === '---') { units.push({ html: '＊＊＊', len: 0, para: pi, first: true, sep: true }); return; }
    splitSentences(p).forEach((s, si) => {
      units.push({ html: s, len: plainLen(s), para: pi, first: si === 0, sep: false });
    });
  });
  return units;
}
function groupClass(u, paraBegun){
  if (u.sep) return 'sep';
  return (u.first && !paraBegun.has(u.para)) ? '' : 'cont';
}
function ensureMeasurer(w, h){
  if (!measurer) {
    measurer = document.createElement('div');
    measurer.className = 'page-content measurer';
    measurer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(measurer);
  }
  measurer.style.width = w + 'px';
  measurer.style.height = h + 'px';
}
function paginateChapter(ch){
  const units = UNITS[chapters.indexOf(ch)];
  const pages = [];
  const paraBegun = new Set();
  let pageUnits = [], pageStart = 0, charCount = 0;
  let curGroup = null, curPara = -1, savedHtml = '';
  measurer.innerHTML = '';
  // はみ出しの測る軸は方向で変わる（縦書き＝幅、横書き＝高さ）
  const fits = () => DIR.mode === 'vertical'
    ? measurer.scrollWidth <= measurer.clientWidth + 1
    : measurer.scrollHeight <= measurer.clientHeight + 1;
  const startGroup = (u) => {
    curGroup = document.createElement('p');
    const cls = groupClass(u, paraBegun);
    if (cls) curGroup.className = cls;
    measurer.appendChild(curGroup);
    curPara = u.para;
    paraBegun.add(u.para);
  };
  const closePage = () => {
    pages.push({ startChar: pageStart, units: pageUnits });
    pageUnits = []; pageStart = charCount;
    measurer.innerHTML = ''; curGroup = null; curPara = -1;
  };
  for (const u of units) {
    if (!curGroup || curPara !== u.para) startGroup(u);
    savedHtml = curGroup.innerHTML;
    curGroup.innerHTML = savedHtml + rubyToHtml(u.html);
    if (!fits() && pageUnits.length) {
      // この文は次のページへ
      curGroup.innerHTML = savedHtml;
      if (!curGroup.textContent) { measurer.removeChild(curGroup); paraBegun.delete(u.para); }
      closePage();
      startGroup(u);
      curGroup.innerHTML = rubyToHtml(u.html);
    }
    pageUnits.push(u);
    charCount += u.len;
  }
  if (pageUnits.length) pages.push({ startChar: pageStart, units: pageUnits });
  return pages;
}
function paginateAll(){
  const w = pageContent.clientWidth, h = pageContent.clientHeight;
  if (!w || !h) return false;
  ensureMeasurer(w, h);
  PAGES = chapters.map((ch) => paginateChapter(ch));
  CUM_PAGES = [];
  TOTAL_PAGES = 0;
  PAGES.forEach((p) => { CUM_PAGES.push(TOTAL_PAGES); TOTAL_PAGES += p.length; });
  pageSizeKey = w + 'x' + h;
  return true;
}
function sizeKeyNow(){ return pageContent.clientWidth + 'x' + pageContent.clientHeight; }
function bookPageOf(chIdx, pageIdx){ return CUM_PAGES[chIdx] + pageIdx + 1; }
function pageForChar(chIdx, charPos){
  const pages = PAGES[chIdx];
  if (!pages || !pages.length) return 0;
  let p = 0;
  for (let i = 0; i < pages.length; i++) { if (pages[i].startChar <= charPos) p = i; else break; }
  return p;
}
function currentAnchorChar(){
  const pages = PAGES[current];
  if (!pages || !pages.length) return 0;
  return pages[Math.min(curPage, pages.length - 1)].startChar;
}
function renderPage(animDir){
  const pages = PAGES[current];
  const ch = chapters[current];
  if (!pages || !pages.length) return;
  curPage = Math.max(0, Math.min(curPage, pages.length - 1));
  const page = pages[curPage];
  const paraBegun = new Set();
  // この章で、現ページより前に始まっている段落を把握する
  for (let i = 0; i < curPage; i++) pages[i].units.forEach((u) => paraBegun.add(u.para));
  let html = '', openPara = -1;
  const closeP = () => { if (openPara >= 0) { html += '</p>'; openPara = -1; } };
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
  pageContent.innerHTML = html;
  $('pageFolio').textContent = '― ' + bookPageOf(current, curPage) + ' ―';
  $('pageChapterPos').textContent = (curPage + 1) + ' / ' + pages.length;
  $('readerChapterLabel').textContent = ch.num + ' ' + ch.title;
  document.querySelector('.hint-next').style.visibility =
    (current === chapters.length - 1 && curPage === pages.length - 1 && endShown) ? 'hidden' : 'visible';
  document.querySelector('.hint-prev').style.visibility =
    (current === 0 && curPage === 0 && !endShown) ? 'hidden' : 'visible';
  if (animDir) {
    pageEl.classList.remove('turn-next', 'turn-prev');
    void pageEl.offsetWidth;
    pageEl.classList.add(animDir > 0 ? 'turn-next' : 'turn-prev');
  }
}
function showEndPage(){
  endShown = true;
  pageEl.hidden = true;
  endView.hidden = false;
  $('readerChapterLabel').textContent = chapters[current].num + ' ' + chapters[current].title;
}
function hideEndPage(){
  endShown = false;
  endView.hidden = true;
  pageEl.hidden = false;
}
function turnPage(dir){
  if (!PAGES.length || readerView.hidden) return;
  lastManualTurn = Date.now();
  const pages = PAGES[current];
  if (dir > 0) { // 次ページ（左へ）
    if (endShown) return;
    if (curPage < pages.length - 1) { curPage++; renderPage(1); }
    else if (current < chapters.length - 1) { enterChapter(current + 1, { autoplay: !audio.paused }); return; }
    else { showEndPage(); return; }
  } else { // 前ページ（右へ）
    if (endShown) { hideEndPage(); curPage = pages.length - 1; renderPage(-1); }
    else if (curPage > 0) { curPage--; renderPage(-1); }
    else if (current > 0) { enterChapter(current - 1, { page: 'last', autoplay: !audio.paused }); return; }
    else return;
  }
  saveBookmark();
}
/* 朗読の進行にページを合わせる（手動でめくった直後は干渉しない） */
function syncPageToAudio(force){
  if (!PAGES.length || !isFinite(audio.duration) || audio.duration <= 0) return;
  const total = CH_CHARS[current] || 0;
  if (!total) return;
  const target = Math.floor((audio.currentTime / audio.duration) * total);
  const p = pageForChar(current, target);
  if (p === curPage) return;
  if (force) { if (!endShown) { curPage = p; renderPage(0); } return; }
  if (audio.paused) return;
  if (Date.now() - lastManualTurn < 12000) return;
  if (p > curPage && !endShown) { curPage = p; renderPage(1); }
}

/* ---------- bookmark ---------- */
function saveBookmark(){
  if (!chapters.length) return;
  try {
    const bm = {
      chapter: current, time: audio.currentTime || 0,
      title: chapters[current].num + ' ' + chapters[current].title, savedAt: Date.now()
    };
    if (PAGES.length) { bm.anchor = currentAnchorChar(); bm.page = bookPageOf(current, curPage); }
    localStorage.setItem(LS_KEY, JSON.stringify(bm));
  } catch (e) {}
}
function loadBookmark(){
  try { const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function clearBookmark(){ try { localStorage.removeItem(LS_KEY); } catch (e) {} refreshResume(); }
function refreshResume(){
  const bm = loadBookmark();
  const btn = $('resumeBtn'), info = $('bookmarkInfo');
  if (bm && chapters[bm.chapter]) {
    btn.hidden = false;
    info.hidden = false;
    info.textContent = 'しおり：' + chapters[bm.chapter].num + ' ' + chapters[bm.chapter].title +
      (bm.page ? ' ／ ' + bm.page + 'ページ' : '') + ' ／ ' + fmt(bm.time || 0);
    btn.textContent = 'しおりから再開（' + chapters[bm.chapter].num + '）';
  } else { btn.hidden = true; info.hidden = true; }
}

/* ---------- chapter flow ---------- */
function fillGate(prefix, ch){
  $(prefix + 'Num').textContent = ch.num;
  $(prefix + 'Title').textContent = ch.title;
  $(prefix + 'Narrator').textContent = '語り・' + ch.narratorName;
}
function showGate(idx, opts){
  opts = opts || {};
  current = idx;
  fillGate('gate', chapters[idx]);
  showView('gate');
  clearTimeout(gateTimer);
  const start = () => { clearTimeout(gateTimer); enterChapter(idx, opts); };
  gateView.onclick = start;
  gateTimer = setTimeout(start, 1800);
}
function layoutChapter(opts){
  // リーダーが表示された状態でページ割りをする
  if (!PAGES.length || sizeKeyNow() !== pageSizeKey) paginateAll();
  if (!PAGES.length) return;
  hideEndPage();
  if (opts.anchor != null) curPage = pageForChar(current, opts.anchor);
  else if (opts.page === 'last') curPage = PAGES[current].length - 1;
  else if (typeof opts.page === 'number') curPage = opts.page;
  else curPage = 0;
  renderPage(0);
  document.querySelectorAll('.toc-item').forEach((el, i) => el.classList.toggle('current', i === current));
}
function enterChapter(idx, opts){
  opts = opts || {};
  current = idx;
  enterStamp = Date.now();
  showView('reader');
  audio.src = audioSrc(idx);
  audio.playbackRate = SPEEDS[speedIdx];
  audio.preservesPitch = true;
  pendingSeek = opts.seek || 0;
  $('audioError').hidden = true;
  requestAnimationFrame(() => layoutChapter(opts));
  const doPlay = () => {
    if (pendingSeek > 0) { try { audio.currentTime = pendingSeek; } catch (e) {} pendingSeek = 0; }
    if (opts.page === 'last' && isFinite(audio.duration) && audio.duration > 0) {
      // 前章へ戻ったときは、末尾ページに見合う位置から
      const pages = PAGES[current];
      if (pages && pages.length) {
        try { audio.currentTime = (pages[pages.length - 1].startChar / (CH_CHARS[current] || 1)) * audio.duration; } catch (e) {}
      }
    }
    if (opts.autoplay !== false) playAudio();
    // ページ指定（しおりのアンカー等）があるとき／章に入ってから手でめくったときは、
    // 音声位置への吸着でページを上書きしない（メタデータ到着が遅れた場合の誤爆防止）
    if (opts.anchor == null && lastManualTurn < enterStamp) syncPageToAudio(true);
  };
  if (audio.readyState >= 1) doPlay();
  else audio.addEventListener('loadedmetadata', function h(){ audio.removeEventListener('loadedmetadata', h); doPlay(); });
  if (opts.autoplay !== false) setTimeout(() => { if (audio.paused && audio.readyState === 0) playAudio(); }, 600);
  updatePlayBtn(); updateNav();
}
function playAudio(){
  audio.playbackRate = SPEEDS[speedIdx];
  audio.preservesPitch = true;
  const p = audio.play();
  if (p && p.catch) p.catch(() => {
    $('audioError').hidden = false;
    $('audioError').textContent = '音声ファイル（' + audioSrc(current) + '）を再生できませんでした。本文はそのままお読みいただけます。';
    updatePlayBtn();
  });
}
function updatePlayBtn(){ $('playPauseBtn').textContent = (!audio.paused && !audio.ended) ? '⏸ 停止' : '▶ 再生'; isPlaying = !audio.paused; }
function updateNav(){
  $('prevChapterBtn').disabled = current <= 0;
  $('nextChapterBtn').disabled = current >= chapters.length - 1;
  $('speedBtn').textContent = SPEEDS[speedIdx].toFixed(2).replace(/0$/, '') + '×';
}

/* ---------- TOC ---------- */
function buildToc(){
  $('tocList').innerHTML = chapters.map((c, i) =>
    '<li><button class="toc-item" data-idx="' + i + '"><span class="toc-num">' + esc(c.num) + '</span>' +
    '<span class="toc-title">' + esc(c.title) + '</span>' +
    '<span class="toc-narr">語り・' + esc(c.narratorName) + '</span></button></li>').join('');
  $('tocList').querySelectorAll('.toc-item').forEach((el) => {
    el.addEventListener('click', () => { $('tocModal').hidden = true; showGate(Number(el.dataset.idx)); });
  });
}

/* ---------- events ---------- */
function bind(){
  $('coverTap').addEventListener('click', () => showGate(0));
  $('resumeBtn').addEventListener('click', () => {
    const bm = loadBookmark(); if (!bm) return;
    showGate(bm.chapter, { seek: bm.time || 0, anchor: (bm.anchor != null ? bm.anchor : null) });
  });
  $('tocFromCoverBtn').addEventListener('click', () => { $('tocModal').hidden = false; });
  $('tocBtn').addEventListener('click', () => { $('tocModal').hidden = false; });
  $('tocCloseBtn').addEventListener('click', () => { $('tocModal').hidden = true; });
  $('tocBackdrop').addEventListener('click', () => { $('tocModal').hidden = true; });
  $('toCoverBtn').addEventListener('click', goCover);
  $('endToCoverBtn').addEventListener('click', goCover);
  $('playPauseBtn').addEventListener('click', () => { if (audio.paused) playAudio(); else { audio.pause(); saveBookmark(); } });
  $('prevChapterBtn').addEventListener('click', () => { if (current > 0) showGate(current - 1); });
  $('nextChapterBtn').addEventListener('click', () => { if (current < chapters.length - 1) showGate(current + 1); });
  $('speedBtn').addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    audio.playbackRate = SPEEDS[speedIdx]; audio.preservesPitch = true;
    try { localStorage.setItem(LS_SPEED, String(SPEEDS[speedIdx])); } catch (e) {}
    updateNav();
  });
  $('rubyToggle').addEventListener('change', (e) => {
    document.body.classList.toggle('ruby-off', !e.target.checked);
    try { localStorage.setItem(LS_RUBY, e.target.checked ? '1' : '0'); } catch (err) {}
  });
  $('progressBar').addEventListener('input', (e) => {
    if (isFinite(audio.duration) && audio.duration > 0) { audio.currentTime = (Number(e.target.value) / 100) * audio.duration; saveBookmark(); }
  });

  /* ページめくり：タップ（小口側＝次／綴じ側＝前）とスワイプ。
     「どちらが次か」は DIR.nextSide が決める（右綴じ＝左、左綴じ＝右） */
  let pDown = null, swipedAt = 0;
  pageWrap.addEventListener('pointerdown', (e) => { pDown = { x: e.clientX, y: e.clientY }; });
  pageWrap.addEventListener('pointerup', (e) => {
    if (!pDown) return;
    const dx = e.clientX - pDown.x, dy = e.clientY - pDown.y;
    pDown = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      swipedAt = Date.now();
      const towardNext = DIR.nextSide === 'left' ? dx < 0 : dx > 0;
      turnPage(towardNext ? 1 : -1);
    }
  });
  pageWrap.addEventListener('click', (e) => {
    if (Date.now() - swipedAt < 350) return;
    if (e.target.closest('button')) return;
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
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (readerView.hidden) { pageSizeKey = ''; return; }
      if (sizeKeyNow() === pageSizeKey) return;
      const anchor = currentAnchorChar();
      if (paginateAll()) { curPage = pageForChar(current, anchor); if (!endShown) renderPage(0); }
    }, 250);
  });

  audio.addEventListener('timeupdate', () => {
    $('currentTime').textContent = fmt(audio.currentTime);
    $('durationTime').textContent = fmt(audio.duration);
    if (isFinite(audio.duration) && audio.duration > 0) $('progressBar').value = String((audio.currentTime / audio.duration) * 100);
    if (Math.floor(audio.currentTime) % 5 === 0) saveBookmark();
    syncPageToAudio(false);
  });
  audio.addEventListener('seeked', () => syncPageToAudio(true));
  audio.addEventListener('loadedmetadata', () => { $('durationTime').textContent = fmt(audio.duration); });
  audio.addEventListener('play', updatePlayBtn);
  audio.addEventListener('pause', () => { updatePlayBtn(); saveBookmark(); });
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    $('audioError').hidden = false;
    $('audioError').textContent = '音声ファイル（' + audioSrc(current) + '）が見つかりません。本文はそのままお読みいただけます。';
    updatePlayBtn();
  }, true);
  audio.addEventListener('ended', () => {
    if (current < chapters.length - 1) { showGate(current + 1); }
    else { showEndPage(); clearBookmark(); updatePlayBtn(); }
  });
}
function goCover(){ audio.pause(); saveBookmark(); showView('cover'); refreshResume(); }

/* ---------- init ---------- */
(function init(){
  try {
    const sp = parseFloat(localStorage.getItem(LS_SPEED)); const ix = SPEEDS.indexOf(sp); if (ix >= 0) speedIdx = ix;
    if (localStorage.getItem(LS_RUBY) === '0') { $('rubyToggle').checked = false; document.body.classList.add('ruby-off'); }
  } catch (e) {}
  fetch('data.json').then((r) => { if (!r.ok) throw new Error('data.json ' + r.status); return r.json(); })
    .then((data) => {
      book = data; chapters = data.chapters || [];
      DIR = DIRECTIONS[data.direction] || DIRECTIONS.vertical;
      document.body.classList.add('dir-' + DIR.mode, 'bound-' + DIR.bound);
      // ページ送りの合図（三角）の向きも方向に合わせる
      document.querySelector('.hint-next').textContent = DIR.nextSide === 'left' ? '◀' : '▶';
      document.querySelector('.hint-prev').textContent = DIR.nextSide === 'left' ? '▶' : '◀';
      document.title = data.title + ' — ' + data.author;
      UNITS = chapters.map((ch) => buildUnits(ch));
      CH_CHARS = UNITS.map((us) => us.reduce((a, u) => a + u.len, 0));
      buildToc(); bind(); refreshResume(); showView('cover'); updateNav();
    })
    .catch((err) => {
      document.body.insertAdjacentHTML('beforeend', '<p style="color:#fff;text-align:center;padding:20px">データの読み込みに失敗しました：' + esc(String(err)) + '</p>');
      bind();
    });
})();
