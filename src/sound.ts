// 効果音・BGM は Web Audio で合成する（音声ファイルは持たない）。オン/オフ設定は必ず用意する。
import { BGM_BPM, BGM_LOOP_BEATS, buildBgmEvents, type BgmEvent } from './bgm-song';
import { load, save } from './storage';

let ctx: AudioContext | undefined;
let enabled = load('sound', true);

function ac(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    // OS に割り込まれて（着信・他アプリの音声など）コンテキストが止まり、
    // 1秒以上たってから戻ってきたら、BGM の世代を作り直す。割り込み中は
    // 予約済みの音が描画されずに滞留し、復帰時にまとめて鳴って「大きな音」に
    // なることがあるため、滞留分は旧世代ごと捨てる（restartBgmTimeline）。
    let leftRunningAt: number | null = null;
    ctx.addEventListener('statechange', () => {
      if (!ctx) return;
      if (ctx.state !== 'running') {
        if (leftRunningAt === null) leftRunningAt = performance.now();
      } else {
        const gap = leftRunningAt === null ? 0 : performance.now() - leftRunningAt;
        leftRunningAt = null;
        if (gap >= 1000 && bgmNodes && bgmWanted && bgmOn) restartBgmTimeline();
      }
    });
  }
  // iPhone では操作のあとに resume が必要。ただし、鳴っている最中（running）に
  // resume を繰り返し呼ぶと iOS では音が乱れることがある。ページ送りの連打の
  // たびに pointerdown から呼ばれて resume が連打される実機報告への対策として、
  // 止まっているときだけ開け直す
  if (ctx.state !== 'running') void ctx.resume();
  return ctx;
}

/** 音の出口が OS に止められていたら開け直す（存在するときだけ）。タップなど
    ユーザー操作のたびに呼んで、BGM・効果音の両方の復帰を早める */
export function ensureAudioRunning(): void {
  try {
    if (ctx && ctx.state !== 'running') void ctx.resume();
  } catch {
    // 開け直せなくても続行する
  }
}

export const isSoundOn = (): boolean => enabled;

export function setSound(on: boolean): void {
  enabled = on;
  save('sound', on);
}

export function beep(frequency = 660, seconds = 0.08): void {
  if (!enabled) return;
  try {
    const ctx = ac();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + seconds);
    // テストが「どの音が鳴ったか」を確認できるようにイベントを出す
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { frequency } }));
  } catch {
    // 音が出せなくても続行する
  }
}

/* ページめくり音：紙が擦れる音を、ノイズ＋帯域掃引でその場で合成する（実ファイルは持たない）。
   短く（約0.3秒）柔らかく、朗読の邪魔をしない「気配程度」の音量に抑える
   （下げ方の履歴：v1.11.1 で包絡全体を約0.4倍＝ピーク 0.13→0.052、v1.13.2 で
   さらに約0.6倍＝ピーク 0.031。実機の感想を受けての段階調整で、最終的な
   塩梅はユーザーの耳の確認待ち）。オン/オフは効果音の
   設定（保存キー 'sound'）に従い、BGM とは独立に切れる。連打・高速めくりでも
   音が重なって破綻しないよう、前回から 120ms 以内の再発音はしない */
let lastPageTurnAt = 0;

export function playPageTurn(): void {
  if (!enabled) return;
  const nowMs = performance.now();
  if (nowMs - lastPageTurnAt < 120) return;
  lastPageTurnAt = nowMs;
  try {
    const c = ac();
    const t = c.currentTime;
    const dur = 0.3;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    // 紙擦れは左右で別のノイズにする（紙の音はもともと左右で相関が低く、
    // そのまま広がりになる）。定位はめくるたびにわずかに振る
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    // 紙擦れの「シュッ」という動き：バンドパスの中心を時間で掃引する
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(850, t);
    bp.frequency.exponentialRampToValueAtTime(2500, t + dur * 0.5);
    bp.frequency.exponentialRampToValueAtTime(1100, t + dur);
    // 角を取るローパスで柔らかくする
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.031, t + 0.045); // 立ち上がり（ピーク）
    g.gain.linearRampToValueAtTime(0.013, t + 0.13); // 紙が離れかける谷
    g.gain.linearRampToValueAtTime(0.024, t + 0.19); // めくり終わりの小さな盛り上がり
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // 定位は静止したわずかな振りだけ（時間で揺らす要素は付けない）
    const pan = c.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.18;
    src.connect(bp).connect(lp).connect(g).connect(pan).connect(c.destination);
    src.start(t);
    src.stop(t + dur + 0.05);
    // テストが発音を確認できるようにイベントを出す（beep と同じ作法）
    document.dispatchEvent(new CustomEvent('app:sound', { detail: { kind: 'page-turn' } }));
  } catch {
    // 音が出せなくても続行する
  }
}

// ---- BGM：書き下ろしの静かなピアノバラード（src/bgm-song.ts）をループ再生する ----
// マスター音量は、姉妹アプリ『サウンドノベル』と同じ聞こえ方にそろえる
// （2026-10-28 ユーザー指定。当初は朗読比 約-21dB に置いていたが小さすぎた）。
// 根拠（どちらも ffmpeg の mean_volume 実測）：
// ・サウンドノベルの朗読は平均 約-25.2dB。生成型BGM（master 0.9、朗読は素通し）を
//   OfflineAudioContext で再現描画すると、literary -32.9dB（朗読比 約-7.7dB）、
//   romance -31.6dB（約-6.4dB）、horror -27.7dB（約-2.5dB）。
//   再現描画は work/measure-soundnovel-bgm.mjs。
// ・この本の朗読は ch1 -26.2dB / ch2 -24.7dB（平均 約-25.5dB）。BGM単体を
//   描画すると平均 -31.0dB なので、上の literary〜romance 並みの朗読比 約-7dB に
//   合わせると実効平均は約 -32.5dB となり、下の BGM_MASTER_GAIN(0.84 = -1.5dB)
//   が要る（ピークは -15.8dB で余裕あり。work/measure-bgm.mjs で再測定できる）。
const BGM_MASTER_GAIN = 0.84;

let bgmOn = load('bgm', true);

/* BGM は「世代」単位で管理する：1世代 = マスターゲイン1つ＋先読みスケジューラ1つ。
   世代は同時に1つだけが生きていて、作り直すときは旧世代を必ず畳んでから
   新世代を立てる（ゲインやスケジューラが積み重なって音量が増える経路を作らない）。
   復帰時の「大きな音」対策の要：OS の割り込みや時計のジャンプで予約済みの音が
   滞留したら、その世代ごと捨てて現在位置から組み直す（restartBgmTimeline）。 */
interface BgmGeneration {
  master: GainNode;
  timer: ReturnType<typeof setInterval>;
  events: BgmEvent[];
  beatSec: number;
  idx: number;
  loopStart: number;
  /* スケジューラの最終実行時点（コンテキスト時計と実時間）。両者の進み方の
     ズレが「時計だけが先行した＝予約が滞留した」ことの検出に使う */
  lastTickCtx: number;
  lastTickWall: number;
}

let bgmNodes: BgmGeneration | undefined;
let bgmWanted = false;

export const isBgmOn = (): boolean => bgmOn;

export function setBgmOn(on: boolean): void {
  bgmOn = on;
  save('bgm', on);
  if (!on) stopBgm();
  else if (bgmWanted) startBgm();
}

const midiFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** 柔らかいピアノ：基音＋倍音を、打鍵直後から指数で減衰させる（ビブラート等は付けない） */
function pianoTone(c: BaseAudioContext, dest: AudioNode, midi: number, at: number, durSec: number, gain: number, pan: number): void {
  const f = midiFreq(midi);
  const panner = c.createStereoPanner();
  panner.pan.value = pan;
  panner.connect(dest);
  const harm = (mult: number, peak: number, tau: number): void => {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = f * mult;
    const g = c.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.014);
    g.gain.setTargetAtTime(0, at + 0.014, tau);
    o.connect(g).connect(panner);
    o.start(at);
    o.stop(at + durSec + 1.6);
  };
  harm(1, gain, 0.69);
  harm(2, gain * 0.3, 0.22);
  harm(3, gain * 0.09, 0.125);
}

/** 静かなベース：基音中心で長く減衰させる */
function bassTone(c: BaseAudioContext, dest: AudioNode, midi: number, at: number, durSec: number, gain: number): void {
  const f = midiFreq(midi);
  const harm = (mult: number, peak: number, tau: number): void => {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = f * mult;
    const g = c.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.011);
    g.gain.setTargetAtTime(0, at + 0.011, tau);
    o.connect(g).connect(dest);
    o.start(at);
    o.stop(at + durSec + 1.4);
  };
  harm(1, gain, 1.0);
  harm(2, gain * 0.13, 0.33);
}

/** ピアノの定位: 鍵盤の並びに見立てて、低い音はわずかに左・高い音はわずかに
    右へ寄せる。静止した定位だけで、時間で揺らす要素（ビブラート／トレモロ）は
    いっさい付けない（朗読がモノラルになった分、BGM 側にだけ少し広がりを出す） */
function pianoPan(midi: number, spread = 1): number {
  const p = (midi - 66) * 0.016 * spread;
  return Math.max(-0.22, Math.min(0.22, p));
}

/** 1イベントを鳴らす（オフライン描画での音量測定と作りをそろえるため、引数は時刻渡し） */
export function scheduleBgmEvent(c: BaseAudioContext, dest: AudioNode, ev: BgmEvent, at: number, beatSec: number): void {
  if (ev.kind === 'bass') bassTone(c, dest, ev.midi, at, ev.durBeats * beatSec, ev.gain);
  else if (ev.kind === 'pad') pianoTone(c, dest, ev.midi, at + ev.staggerSec, 3.2, ev.gain, pianoPan(ev.midi, 0.6));
  else pianoTone(c, dest, ev.midi, at, Math.max(2.0, ev.lenBeats * beatSec * 1.05), ev.gain, pianoPan(ev.midi));
}

/** BGM の残響の混ぜ量（原音に対して）。部屋の気配が分かる程度に低く抑える */
const BGM_WET_GAIN = 0.12;

/** 短い部屋の残響のインパルス応答をその場で生成する（約0.8秒のノイズ減衰。
    左右で減衰の速さをわずかに変え、その差が空間の広がりになる。揺らす要素はない） */
function makeRoomImpulse(c: BaseAudioContext): AudioBuffer {
  const len = Math.max(1, Math.floor(c.sampleRate * 0.8));
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const tau = ch === 0 ? 0.14 : 0.115;
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-(i / c.sampleRate) / tau);
    }
  }
  return buf;
}

/** 世代を1つ立てる（呼び出し側で「生きている世代は無い」ことを保証する）。
    fadeInSec かけて設定音量まで上げるので、作り直しの直後でも素の大きな
    音がそのまま出ることはない */
function startGeneration(fadeInSec: number): void {
  const c = ac();
  const master = c.createGain();
  master.gain.setValueAtTime(0, c.currentTime);
  master.gain.linearRampToValueAtTime(BGM_MASTER_GAIN, c.currentTime + fadeInSec);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4200;
  lp.Q.value = 0.3;
  master.connect(lp).connect(c.destination);
  // 残響は世代の一部として master から分岐させる（世代を畳むとき master の
  // 切り離しで一緒に無音になる。残響側のノードが単独で残ることはない）
  const verb = c.createConvolver();
  verb.buffer = makeRoomImpulse(c);
  const wet = c.createGain();
  wet.gain.value = BGM_WET_GAIN;
  master.connect(verb);
  verb.connect(wet).connect(lp);

  const gen: BgmGeneration = {
    master,
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    events: buildBgmEvents(),
    beatSec: 60 / BGM_BPM,
    idx: 0,
    loopStart: c.currentTime + 0.15,
    lastTickCtx: c.currentTime,
    lastTickWall: performance.now(),
  };
  gen.timer = setInterval(() => {
    if (c.state !== 'running') void c.resume();
    const now = c.currentTime;
    gen.lastTickCtx = now;
    gen.lastTickWall = performance.now();
    // 先読みは広めに取る：バックグラウンドではタイマーが絞られ（数秒〜分単位に
    // 間引かれる）ても、予約済みの音が続くようにするため
    const horizon = now + 30;
    for (;;) {
      const ev = gen.events[gen.idx];
      const at = gen.loopStart + ev.beat * gen.beatSec;
      if (at > horizon) break;
      // 過去の音は絶対に予約しない。割り込みや時計のジャンプでスケジューラが
      // 遅れても、過ぎた分は捨てて現在位置から続ける（遅れた音が復帰時に
      // まとめて鳴る「大きな音」の経路をここで断つ）
      if (at >= now + 0.02) scheduleBgmEvent(c, gen.master, ev, at, gen.beatSec);
      gen.idx += 1;
      if (gen.idx >= gen.events.length) {
        gen.idx = 0;
        gen.loopStart += BGM_LOOP_BEATS * gen.beatSec;
      }
    }
  }, 300);

  bgmNodes = gen;
  document.body.dataset.bgm = 'on';
  document.dispatchEvent(new CustomEvent('app:bgm', { detail: { on: true } }));
}

/** 世代を畳む：スケジューラを止め、マスターを fadeSec で絞ってから切り離す。
    予約済みでまだ鳴っていない音も、切り離しと一緒に destination へ届かなくなる */
function teardownGeneration(gen: BgmGeneration, fadeSec: number): void {
  clearInterval(gen.timer);
  try {
    const c = ac();
    gen.master.gain.cancelScheduledValues(c.currentTime);
    gen.master.gain.setValueAtTime(gen.master.gain.value, c.currentTime);
    gen.master.gain.linearRampToValueAtTime(0, c.currentTime + fadeSec);
    window.setTimeout(() => gen.master.disconnect(), fadeSec * 1000 + 200);
  } catch {
    // 止められなくても続行する
  }
}

export function startBgm(): void {
  bgmWanted = true;
  if (!bgmOn || bgmNodes) {
    if (bgmNodes) ensureAudioRunning(); // 既に鳴っている場合も、止まっていたら出口を開け直す
    return;
  }
  try {
    startGeneration(2.5);
  } catch {
    // 音が出せなくても続行する
  }
}

export function stopBgm(): void {
  bgmWanted = false;
  document.body.dataset.bgm = 'off';
  document.dispatchEvent(new CustomEvent('app:bgm', { detail: { on: false } }));
  if (!bgmNodes) return;
  const gen = bgmNodes;
  bgmNodes = undefined;
  teardownGeneration(gen, 0.4);
}

/** コンテキストを少し遅れて自分から suspend する（背面化の仕上げ）。
    遅延はフェードが描画されるのを待つため。前面に戻っていたら何もしない
    （復帰経路の resume と競合させない） */
function suspendContextSoon(c: AudioContext, delayMs: number): void {
  window.setTimeout(() => {
    if (document.hidden && c.state === 'running') void c.suspend().catch(() => {});
  }, delayMs);
}

/** バックグラウンドへ移る瞬間専用の止め方（実機報告：移行時にノイズが鳴る）。
    通常の stopBgm（0.4秒の線形フェード＋壁時計タイマーでの disconnect）は、
    移行直後に OS がコンテキストを止めたりタイマーを凍結したりすると、
    鳴っている音が途中で切れてクリック／ノイズ化しうる。ここでは：
    (1) 時定数の小さい指数フェードで速やかに無音へ落とす（約0.15秒で実質無音。
        途中で描画が止まっても、残っている音量はごく小さく、切れても聞こえない）
    (2) 無音になった頃合いを見て、自分から suspend する（OS に「鳴ったまま
        切られる」状態を作らない。順序＝フェード→suspend をここで保証する）
    復帰時は従来の経路（ensureAudioRunning／スケジューラの resume）で戻る */
export function stopBgmForBackground(): void {
  bgmWanted = false;
  document.body.dataset.bgm = 'off';
  document.dispatchEvent(new CustomEvent('app:bgm', { detail: { on: false } }));
  if (!ctx) return;
  const c = ctx;
  if (!bgmNodes) {
    suspendContextSoon(c, 250);
    return;
  }
  const gen = bgmNodes;
  bgmNodes = undefined;
  clearInterval(gen.timer);
  try {
    const now = c.currentTime;
    gen.master.gain.cancelScheduledValues(now);
    gen.master.gain.setValueAtTime(Math.max(gen.master.gain.value, 0.0001), now);
    gen.master.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    window.setTimeout(() => gen.master.disconnect(), 500);
    suspendContextSoon(c, 220);
  } catch {
    // 止められなくても続行する
  }
}

let lastRestartWall = 0;

/** BGM の世代を作り直す：滞留した予約は旧世代ごと捨て、新世代は現在位置から
    短いフェードインで始める。復帰直後の「大きな音」への主対策。
    短時間に何度も走らないよう 2 秒に 1 回まで */
export function restartBgmTimeline(): void {
  if (!bgmNodes || !bgmOn) return;
  const now = performance.now();
  if (now - lastRestartWall < 2000) return;
  lastRestartWall = now;
  const old = bgmNodes;
  bgmNodes = undefined;
  teardownGeneration(old, 0.15);
  try {
    startGeneration(1.0);
  } catch {
    // 音が出せなくても続行する
  }
}

/** 前面復帰時に呼ぶ：出口を開け直し、BGM の時計がスケジューラより先行していたら
    （＝割り込み等で予約が滞留していたら）世代を作り直す。世代が消えていたら
    鳴らす意思がある場合に限って立て直す（復帰時の無音への自己回復） */
export function resyncBgmIfDesynced(): void {
  ensureAudioRunning();
  if (!bgmOn) return;
  if (!bgmNodes) {
    if (bgmWanted) {
      try {
        startGeneration(1.0);
      } catch {
        // 音が出せなくても続行する
      }
    }
    return;
  }
  if (!ctx) return;
  const gen = bgmNodes;
  const jump = ctx.currentTime - gen.lastTickCtx - (performance.now() - gen.lastTickWall) / 1000;
  if (jump > 1.0) restartBgmTimeline();
}
