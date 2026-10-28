// 効果音・BGM は Web Audio で合成する（音声ファイルは持たない）。オン/オフ設定は必ず用意する。
import { BGM_BPM, BGM_LOOP_BEATS, buildBgmEvents, type BgmEvent } from './bgm-song';
import { load, save } from './storage';

let ctx: AudioContext | undefined;
let enabled = load('sound', true);

function ac(): AudioContext {
  ctx ??= new AudioContext();
  // iPhone では操作のあとに resume が必要
  void ctx.resume();
  return ctx;
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

// ---- BGM：書き下ろしの静かなピアノバラード（src/bgm-song.ts）をループ再生する ----
// 朗読の邪魔にならないよう、マスター音量は朗読の平均音量より約21dB下に置く。
// 根拠（どちらも ffmpeg の mean_volume 実測）：朗読は ch1 -26.2dB / ch2 -24.7dB。
// BGM単体を OfflineAudioContext で描画すると平均 -31.0dB で、下の
// BGM_MASTER_GAIN(0.17 = -15.4dB) を掛けた再生時の平均は約 -46.4dB になる
// （朗読比 約-21dB。work/measure-bgm.mjs で再測定できる）。
const BGM_MASTER_GAIN = 0.17;

let bgmOn = load('bgm', true);
let bgmNodes: { master: GainNode; timer: ReturnType<typeof setInterval> } | undefined;
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

/** 1イベントを鳴らす（オフライン描画での音量測定と作りをそろえるため、引数は時刻渡し） */
export function scheduleBgmEvent(c: BaseAudioContext, dest: AudioNode, ev: BgmEvent, at: number, beatSec: number): void {
  if (ev.kind === 'bass') bassTone(c, dest, ev.midi, at, ev.durBeats * beatSec, ev.gain);
  else if (ev.kind === 'pad') pianoTone(c, dest, ev.midi, at + ev.staggerSec, 3.2, ev.gain, -0.03);
  else pianoTone(c, dest, ev.midi, at, Math.max(2.0, ev.lenBeats * beatSec * 1.05), ev.gain, 0.05);
}

export function startBgm(): void {
  bgmWanted = true;
  if (!bgmOn || bgmNodes) {
    if (bgmNodes) ac(); // 既に鳴っている場合も、止まっていたら出口を開け直す
    return;
  }
  try {
    const c = ac();
    const master = c.createGain();
    master.gain.setValueAtTime(0, c.currentTime);
    master.gain.linearRampToValueAtTime(BGM_MASTER_GAIN, c.currentTime + 2.5);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.Q.value = 0.3;
    master.connect(lp).connect(c.destination);

    const events = buildBgmEvents();
    const beatSec = 60 / BGM_BPM;
    let idx = 0;
    let loopStart = c.currentTime + 0.15;
    const timer = setInterval(() => {
      if (c.state === 'suspended') void c.resume();
      const horizon = c.currentTime + 0.9;
      for (;;) {
        const ev = events[idx];
        const at = loopStart + ev.beat * beatSec;
        if (at > horizon) break;
        if (at >= c.currentTime - 0.3) scheduleBgmEvent(c, master, ev, at, beatSec);
        idx += 1;
        if (idx >= events.length) {
          idx = 0;
          loopStart += BGM_LOOP_BEATS * beatSec;
        }
      }
    }, 300);

    bgmNodes = { master, timer };
    document.body.dataset.bgm = 'on';
    document.dispatchEvent(new CustomEvent('app:bgm', { detail: { on: true } }));
  } catch {
    // 音が出せなくても続行する
  }
}

export function stopBgm(): void {
  bgmWanted = false;
  document.body.dataset.bgm = 'off';
  document.dispatchEvent(new CustomEvent('app:bgm', { detail: { on: false } }));
  if (!bgmNodes) return;
  const { master, timer } = bgmNodes;
  bgmNodes = undefined;
  try {
    clearInterval(timer);
    const c = ac();
    master.gain.cancelScheduledValues(c.currentTime);
    master.gain.setValueAtTime(master.gain.value, c.currentTime);
    master.gain.linearRampToValueAtTime(0, c.currentTime + 0.4);
    window.setTimeout(() => master.disconnect(), 600);
  } catch {
    // 止められなくても続行する
  }
}
