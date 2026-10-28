// サウンドノベル（simple_visual_novel）の生成型BGMの音量実測。
// src/sound.ts の startBgm の合成（master 0.9、ドローン/風/パッド/ベル/エコー）を
// OfflineAudioContext で再現描画し、ffmpeg volumedetect の mean_volume を測る。
// 使い方: node work/measure-soundnovel-bgm.mjs
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

// literary / normal（『日曜日、井戸の底で』のテーマ）の設定をそのまま転記
const CFG = {
  chords: [
    [87.31, 130.81, 220.0, 329.63],
    [82.41, 123.47, 196.0, 293.66],
    [65.41, 130.81, 246.94, 293.66],
    [110.0, 164.81, 246.94, 261.63],
  ],
  bells: [523.25, 587.33, 659.25, 783.99],
  drone: [43.65, 87.31],
  chordSec: 11, bellChance: 0.3, bellGain: 0.028, wind: 0.001, padGain: 0.014,
  droneGain: 0.008, padWave: 'sine', padCutoff: 1100, bellDecay: 5.0,
};
const MASTER = 0.9; // startBgm の master は 0.9 までランプする
const DUR = 180;

const browser = await chromium.launch();
const page = await browser.newPage();
const wavBase64 = await page.evaluate(
  async ({ cfg, masterGain, dur }) => {
    // 決定的な乱数（mulberry32）
    let seed = 1234567;
    const rand = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const sr = 44100;
    const c = new OfflineAudioContext(2, Math.ceil(sr * (dur + 6)), sr);
    const master = c.createGain();
    master.gain.value = masterGain;
    master.connect(c.destination);
    // エコー（ベルがつながる）
    const delay = c.createDelay(1);
    delay.delayTime.value = 0.42;
    const feedback = c.createGain();
    feedback.gain.value = 0.34;
    const echoGain = c.createGain();
    echoGain.gain.value = 0.3;
    delay.connect(feedback).connect(delay);
    delay.connect(echoGain).connect(master);
    // ドローン
    const droneFilter = c.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 240;
    const droneGain = c.createGain();
    droneGain.gain.value = cfg.droneGain ?? 0.038;
    droneFilter.connect(droneGain).connect(master);
    for (const f of cfg.drone) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(droneFilter);
      o.start(0);
      o.stop(dur + 6);
    }
    // 風
    const noiseBuffer = c.createBuffer(1, sr * 4, sr);
    const nd = noiseBuffer.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = rand() * 2 - 1;
    const wind = c.createBufferSource();
    wind.buffer = noiseBuffer;
    wind.loop = true;
    const windFilter = c.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 460;
    windFilter.Q.value = 0.5;
    const windGain = c.createGain();
    windGain.gain.value = cfg.wind;
    const windLfo = c.createOscillator();
    windLfo.frequency.value = 0.06;
    const windLfoGain = c.createGain();
    windLfoGain.gain.value = cfg.wind * 0.6;
    windLfo.connect(windLfoGain).connect(windGain.gain);
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start(0);
    windLfo.start(0);
    // パッド和音
    const playChord = (at, chord) => {
      for (const f of chord) {
        for (const detune of [-4, 4]) {
          const o = c.createOscillator();
          o.type = cfg.padWave ?? 'triangle';
          o.frequency.value = f;
          o.detune.value = detune;
          const g = c.createGain();
          g.gain.setValueAtTime(0, at);
          g.gain.linearRampToValueAtTime(cfg.padGain, at + cfg.chordSec * 0.35);
          g.gain.setValueAtTime(cfg.padGain, at + cfg.chordSec * 0.7);
          g.gain.linearRampToValueAtTime(0, at + cfg.chordSec * 1.15);
          const lp = c.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = cfg.padCutoff ?? 850;
          o.connect(lp).connect(g).connect(master);
          o.start(at);
          o.stop(at + cfg.chordSec * 1.2);
        }
      }
    };
    // ベル
    const decay = cfg.bellDecay ?? 2.8;
    const playBell = (at) => {
      const f = cfg.bells[Math.floor(rand() * cfg.bells.length)];
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(cfg.bellGain, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      o.connect(g).connect(master);
      g.connect(delay);
      o.start(at);
      o.stop(at + decay + 0.3);
    };
    // スケジュール（実物は setInterval 1200ms で和音とベルを進める）
    let chordIndex = 0;
    let nextChordAt = 0.1;
    for (let t = 0; t < dur; t += 1.2) {
      if (t >= nextChordAt) {
        playChord(nextChordAt, cfg.chords[chordIndex % cfg.chords.length]);
        chordIndex += 1;
        nextChordAt += cfg.chordSec;
      }
      if (rand() < cfg.bellChance) playBell(t + 0.05);
    }
    const buf = await c.startRendering();
    const n = buf.length;
    const bytes = new DataView(new ArrayBuffer(44 + n * 4));
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); bytes.setUint32(4, 36 + n * 4, true); wstr(8, 'WAVEfmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
    bytes.setUint32(24, sr, true); bytes.setUint32(28, sr * 4, true);
    bytes.setUint16(32, 4, true); bytes.setUint16(34, 16, true);
    wstr(36, 'data'); bytes.setUint32(40, n * 4, true);
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    for (let i = 0; i < n; i++) {
      bytes.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      bytes.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    let bin = '';
    const u8 = new Uint8Array(bytes.buffer);
    for (let i = 0; i < u8.length; i += 32768) bin += String.fromCharCode(...u8.subarray(i, i + 32768));
    return btoa(bin);
  },
  { cfg: CFG, masterGain: MASTER, dur: DUR },
);
await browser.close();
const wavPath = '/tmp/soundnovel-bgm.wav';
writeFileSync(wavPath, Buffer.from(wavBase64, 'base64'));
const r = spawnSync('ffmpeg', ['-i', wavPath, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
const m = (r.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
const mx = (r.stderr || '').match(/max_volume:\s*(-?[\d.]+) dB/);
console.log(`sound-novel story BGM (literary/normal, master ${MASTER}): mean_volume = ${m ? m[1] : '?'} dB, max_volume = ${mx ? mx[1] : '?'} dB`);
