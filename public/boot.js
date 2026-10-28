// アプリの「起動係」。メインのスクリプト（Vite がまとめた assets/*.js）とは別の、ふつうのスクリプトなので、
// メインが読み込めなくても必ず動く。
// 起動できなかったとき（キャッシュのファイルの食い違いなど）に、キャッシュを消して読み込み直す。
//  ・保存データ（localStorage）は消さない
//  ・1回目は自動でなおす。2分以内の2回目は、ボタン（#boot-repair）を出す
//  ・消すのは、このアプリの Service Worker とキャッシュだけ。
//    GitHub Pages では、すべてのアプリが同じサイトに載り、Service Worker とキャッシュはサイトの単位で見えるので、
//    範囲を絞らないと、ほかのアプリのオフライン用のキャッシュまで消してしまう。
// アプリが起動できたら、main.ts が window.__appStarted = true にする。
(function () {
  'use strict';
  // このアプリの置き場所（boot.js と同じ場所）と ID（index.html の <meta name="app-id">。package.json の name）
  var BASE = new URL('./', document.currentScript ? document.currentScript.src : location.href).href;
  var meta = document.querySelector('meta[name="app-id"]');
  var APP_ID = (meta && meta.content) || '';
  var REPAIR_KEY = APP_ID + ':repaired-at';
  var WAIT_MS = window.__bootWaitMs || 8000; // テストでは短くできる
  var failed = false;

  // このアプリの Service Worker か（scope がこのアプリの置き場所と同じ）
  function isMyRegistration(reg) { return reg.scope === BASE; }
  // このアプリのキャッシュか: 名前が「ID-」で始まる（手で書いた Service Worker）、
  // または、名前が置き場所で終わる（Workbox の precache は、名前の最後に scope が付く）
  function isMyCache(name) {
    return (APP_ID !== '' && name.indexOf(APP_ID + '-') === 0) || name.slice(-BASE.length) === BASE;
  }

  function repair() {
    var jobs = [];
    if ('serviceWorker' in navigator) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.filter(isMyRegistration).map(function (r) { return r.unregister(); }));
      }));
    }
    if (window.caches) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(isMyCache).map(function (k) { return caches.delete(k); }));
      }));
    }
    return Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }

  function showBox() {
    var box = document.getElementById('boot-error');
    if (!box) return;
    box.hidden = false;
    document.getElementById('boot-repair').onclick = function () {
      box.textContent = 'なおしています…';
      repair();
    };
  }

  function onStartFailed() {
    if (failed || window.__appStarted) return;
    failed = true;
    var last = 0;
    try { last = Number(sessionStorage.getItem(REPAIR_KEY)) || 0; } catch { /* 保存できなくても続ける */ }
    if (Date.now() - last > 2 * 60 * 1000) {
      try { sessionStorage.setItem(REPAIR_KEY, String(Date.now())); } catch { /* 同上 */ }
      repair();
    } else {
      showBox();
    }
  }

  // 読み込みエラーが起きたとき
  window.addEventListener('error', function () {
    if (!window.__appStarted) setTimeout(onStartFailed, 300);
  });
  // エラーが出なくても、しばらく待って起動していなければ
  window.addEventListener('load', function () { setTimeout(onStartFailed, WAIT_MS); });
})();
