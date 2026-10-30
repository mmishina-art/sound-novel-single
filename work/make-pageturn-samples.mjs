// ページめくり音の聞き比べサンプル生成（v1.13.2 の音量一段階下げの確認用）。
// めくり音は src/sound.ts の playPageTurn と同じ合成を、種固定ノイズで
// 「変更前（ピーク 0.052）」「変更後（ピーク 0.031）」の両包絡で描画する。
// BGM は work/measure-bgm.mjs と同じ写しの合成で冒頭約8秒を描画し、
// その上にめくり音を重ねた版も作る。出力は ~/workspace/your_files/ へ。
// 使い方: node work/make-pageturn-samples.mjs
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { buildBgmEvents } from '../src/bgm-song.ts';

const events = buildBgmEvents();
const browser = await chromium.launch();
const page = await browser.newPage();
const wavs = await page.evaluate(async ({ events }) => {
  const SR = 44100;
  const mulberry32 = (seed) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const encodeWav = (buf) => {
    const n = buf.length;
    const bytes = new DataView(new ArrayBuffer(44 + n * 4));
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); bytes.setUint32(4, 36 + n * 4, true); wstr(8, 'WAVEfmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
    bytes.setUint32(24, SR, true); bytes.setUint32(28, SR * 4, true);
    bytes.setUint16(32, 4, true); bytes.setUint16(34, 16, true); wstr(36, 'data');
    bytes.setUint32(40, n * 4, true);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) {
      bytes.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 0x7fff, true);
      bytes.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 0x7fff, true);
    }
    let bin = '';
    const u8 = new Uint8Array(bytes.buffer);
    for (let i = 0; i < u8.length; i += 32768) bin += String.fromCharCode(...u8.subarray(i, i + 32768));
    return btoa(bin);
  };
  // ---- めくり音（playPageTurn の写し。定位は比較のため 0 に固定） ----
  const renderTurn = async (peak, valley, swell) => {
    const dur = 0.3;
    const c = new OfflineAudioContext(2, Math.ceil(SR * (dur + 0.1)), SR);
    const rand = mulberry32(42);
    const len = Math.floor(SR * dur);
    const buf = c.createBuffer(2, len, SR);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] = rand() * 2 - 1;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(850, 0);
    bp.frequency.exponentialRampToValueAtTime(2500, dur * 0.5);
    bp.frequency.exponentialRampToValueAtTime(1100, dur);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5200;
    const g = c.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(peak, 0.045);
    g.gain.linearRampToValueAtTime(valley, 0.13);
    g.gain.linearRampToValueAtTime(swell, 0.19);
    g.gain.exponentialRampToValueAtTime(0.0001, dur);
    const pan = c.createStereoPanner();
    pan.pan.value = 0;
    src.connect(bp).connect(lp).connect(g).connect(pan).connect(c.destination);
    src.start(0);
    src.stop(dur + 0.05);
    return c.startRendering();
  };
  // ---- BGM 冒頭（measure-bgm.mjs の写し。マスター 0.84） ----
  const renderBgm = async (sec) => {
    const beatSec = 1; // BGM_BPM = 60
    const c = new OfflineAudioContext(2, Math.ceil(SR * sec), SR);
    const master = c.createGain();
    master.gain.value = 0.84;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4200; lp.Q.value = 0.3;
    master.connect(lp).connect(c.destination);
    const midiFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
    function pianoTone(dest, midi, at, durSec, gain, pan) {
      const f = midiFreq(midi);
      const panner = c.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(dest);
      const harm = (mult, peak, tau) => {
        const o = c.createOscillator();
        o.type = 'sine'; o.frequency.value = f * mult;
        const g = c.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(peak, at + 0.014);
        g.gain.setTargetAtTime(0, at + 0.014, tau);
        o.connect(g).connect(panner);
        o.start(at); o.stop(at + durSec + 1.6);
      };
      harm(1, gain, 0.69); harm(2, gain * 0.3, 0.22); harm(3, gain * 0.09, 0.125);
    }
    function bassTone(dest, midi, at, durSec, gain) {
      const f = midiFreq(midi);
      const harm = (mult, peak, tau) => {
        const o = c.createOscillator();
        o.type = 'sine'; o.frequency.value = f * mult;
        const g = c.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(peak, at + 0.011);
        g.gain.setTargetAtTime(0, at + 0.011, tau);
        o.connect(g).connect(dest);
        o.start(at); o.stop(at + durSec + 1.4);
      };
      harm(1, gain, 1.0); harm(2, gain * 0.13, 0.33);
    }
    for (const ev of events) {
      const at = 0.15 + ev.beat * beatSec;
      if (at > sec - 1) continue;
      if (ev.kind === 'bass') bassTone(master, ev.midi, at, ev.durBeats * beatSec, ev.gain);
      else if (ev.kind === 'pad') pianoTone(master, ev.midi, at + ev.staggerSec, 3.2, ev.gain, -0.03);
      else pianoTone(master, ev.midi, at, Math.max(2.0, ev.lenBeats * beatSec * 1.05), ev.gain, 0.05);
    }
    return c.startRendering();
  };
  const mixOver = async (bgmBuf, turnBuf, atSec, totalSec) => {
    const c = new OfflineAudioContext(2, Math.ceil(SR * totalSec), SR);
    const b = c.createBufferSource();
    b.buffer = bgmBuf;
    b.connect(c.destination);
    b.start(0);
    const t = c.createBufferSource();
    t.buffer = turnBuf;
    t.connect(c.destination);
    t.start(atSec);
    return c.startRendering();
  };
  const before = await renderTurn(0.052, 0.022, 0.04);
  const after = await renderTurn(0.031, 0.013, 0.024);
  const bgm = await renderBgm(8);
  const beforeMix = await mixOver(bgm, before, 3.0, 8);
  const afterMix = await mixOver(bgm, after, 3.0, 8);
  return {
    before: encodeWav(before),
    after: encodeWav(after),
    beforeMix: encodeWav(beforeMix),
    afterMix: encodeWav(afterMix),
  };
}, { events });
await browser.close();

const dir = '/home/hatch/workspace/your_files/';
const files = {
  'pageturn-sample-before-alone.wav': wavs.before,
  'pageturn-sample-after-alone.wav': wavs.after,
  'pageturn-sample-before-on-bgm.wav': wavs.beforeMix,
  'pageturn-sample-after-on-bgm.wav': wavs.afterMix,
};
for (const [name, b64] of Object.entries(files)) {
  const wavPath = dir + name;
  writeFileSync(wavPath, Buffer.from(b64, 'base64'));
  const mp3Path = wavPath.replace('.wav', '.mp3');
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '128k', mp3Path]);
  console.log(name, '->', mp3Path, r.status === 0 ? 'ok' : 'ffmpeg failed');
  const v = spawnSync('ffmpeg', ['-hide_banner', '-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(v.stderr ?? '')?.[1];
  console.log('   max_volume:', max, 'dB');
}
