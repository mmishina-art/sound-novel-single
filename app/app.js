'use strict';
/* 空の郵便が届くまで — single book app */
const LS_KEY = 'sora-yubin-bookmark-v1';
const LS_SPEED = 'sora-yubin-speed-v1';
const LS_RUBY = 'sora-yubin-ruby-v1';
const SPEEDS = [0.8, 1.0, 1.25, 1.5, 2.0];

let book = null;
let chapters = [];
let current = 0;
let speedIdx = 1; // 1.0
let gateTimer = null;
let pendingSeek = 0;
let isPlaying = false;

const $ = (id) => document.getElementById(id);
const coverView = $('coverView'), gateView = $('gateView'), readerView = $('readerView');
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
      // base is preceding run of kanji already emitted as plain text — handle by
      // looking back is complex; data always uses ｜, so treat stray as plain.
      const close = text.indexOf('》', i);
      if (close > i) { i = close + 1; continue; }
    }
    // plain run until next marker
    let j = i;
    while (j < text.length && text[j] !== '｜' && text[j] !== '《') j++;
    // check if this run is immediately followed by 《...》 without ｜ (fallback)
    if (j < text.length && text[j] === '《') {
      const close = text.indexOf('》', j);
      if (close > j) {
        // split last kanji sequence as base: take whole run as base for simplicity
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

/* ---------- bookmark ---------- */
function saveBookmark(){
  if (!chapters.length) return;
  // Do not save at very end of final chapter
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      chapter: current, time: audio.currentTime || 0,
      title: chapters[current].num + ' ' + chapters[current].title, savedAt: Date.now()
    }));
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
    info.textContent = 'しおり：' + chapters[bm.chapter].num + ' ' + chapters[bm.chapter].title + ' ／ ' + fmt(bm.time || 0);
    btn.textContent = 'しおりから再開（' + chapters[bm.chapter].num + '）';
  } else { btn.hidden = true; info.hidden = true; }
}

/* ---------- chapter flow ---------- */
function fillGate(prefix, ch){
  $(prefix + 'Num').textContent = ch.num;
  $(prefix + 'Title').textContent = ch.title;
  $(prefix + 'Narrator').textContent = '語り・' + ch.narratorName;
}
function renderChapter(idx){
  const ch = chapters[idx];
  fillGate('block', ch);
  $('readerChapterLabel').textContent = ch.num + ' ' + ch.title;
  const src = (ch.ruby && ch.ruby.length) ? ch.ruby : (ch.paragraphs || []);
  $('textBody').innerHTML = src.map((p) => {
    if (p.trim() === '---') return '<p class="sep">＊＊＊</p>';
    return '<p>' + rubyToHtml(p) + '</p>';
  }).join('');
  $('textBody').scrollLeft = $('textBody').scrollWidth; // vertical-rl starts at right
  $('endView').hidden = true;
  document.querySelectorAll('.toc-item').forEach((el, i) => el.classList.toggle('current', i === idx));
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
function enterChapter(idx, opts){
  opts = opts || {};
  current = idx;
  renderChapter(idx);
  showView('reader');
  audio.src = audioSrc(idx);
  audio.playbackRate = SPEEDS[speedIdx];
  audio.preservesPitch = true;
  pendingSeek = opts.seek || 0;
  $('audioError').hidden = true;
  const doPlay = () => {
    if (pendingSeek > 0) { try { audio.currentTime = pendingSeek; } catch (e) {} pendingSeek = 0; }
    if (opts.autoplay !== false) playAudio();
  };
  if (audio.readyState >= 1) doPlay();
  else audio.addEventListener('loadedmetadata', function h(){ audio.removeEventListener('loadedmetadata', h); doPlay(); });
  // If metadata never loads (missing file), still attempt play so error surfaces
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
    showGate(bm.chapter, { seek: bm.time || 0 });
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
  audio.addEventListener('timeupdate', () => {
    $('currentTime').textContent = fmt(audio.currentTime);
    $('durationTime').textContent = fmt(audio.duration);
    if (isFinite(audio.duration) && audio.duration > 0) $('progressBar').value = String((audio.currentTime / audio.duration) * 100);
    // throttled-ish save: every ~5s
    if (Math.floor(audio.currentTime) % 5 === 0) saveBookmark();
  });
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
    else {
      $('endView').hidden = false;
      $('endView').scrollIntoView({ behavior: 'smooth' });
      clearBookmark();
      updatePlayBtn();
    }
  });
}
function goCover(){ audio.pause(); saveBookmark(); showView('cover'); refreshResume(); }

/* ---------- init ---------- */
(function init(){
  // restore prefs
  try {
    const sp = parseFloat(localStorage.getItem(LS_SPEED)); const ix = SPEEDS.indexOf(sp); if (ix >= 0) speedIdx = ix;
    if (localStorage.getItem(LS_RUBY) === '0') { $('rubyToggle').checked = false; document.body.classList.add('ruby-off'); }
  } catch (e) {}
  fetch('data.json').then((r) => { if (!r.ok) throw new Error('data.json ' + r.status); return r.json(); })
    .then((data) => {
      book = data; chapters = data.chapters || [];
      document.title = data.title + ' — ' + data.author;
      buildToc(); bind(); refreshResume(); showView('cover'); updateNav();
    })
    .catch((err) => {
      document.body.insertAdjacentHTML('beforeend', '<p style="color:#fff;text-align:center;padding:20px">データの読み込みに失敗しました：' + esc(String(err)) + '</p>');
      bind();
    });
})();
