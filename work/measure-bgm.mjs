// BGM の音量実測：src/bgm-song.ts のイベントを OfflineAudioContext で描画し、
// WAV にして平均音量（ffmpeg volumedetect の mean_volume）を測る。
// 合成の音作り（pianoTone / bassTone）は src/sound.ts と同一の式を写したもの。
// 使い方: node work/measure-bgm.mjs [masterGain]
//   masterGain を渡すと、その倍率を掛けた状態の平均音量も出す（再生時の実効値）。
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { BGM_BPM, BGM_LOOP_BEATS, buildBgmEvents } from '../src/bgm-song.ts';

const events = buildBgmEvents();
const masterGain = process.argv[2] ? Number(process.argv[2]) : 1;

const browser = await chromium.launch();
const page = await browser.newPage();
const wavBase64 = await page.evaluate(
  async ({ events, masterGain }) => {
    const beatSec = 60 / 60; // BGM_BPM = 60
    const dur = 192 * beatSec; // BGM_LOOP_BEATS
    const c = new OfflineAudioContext(2, Math.ceil(44100 * (dur + 2)), 44100);
    const master = c.createGain();
    master.gain.value = masterGain;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.Q.value = 0.3;
    master.connect(lp).connect(c.destination);
    const midiFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
    function pianoTone(dest, midi, at, durSec, gain, pan) {
      const f = midiFreq(midi);
      const panner = c.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(dest);
      const harm = (mult, peak, tau) => {
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
    function bassTone(dest, midi, at, durSec, gain) {
      const f = midiFreq(midi);
      const harm = (mult, peak, tau) => {
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
    for (const ev of events) {
      const at = 0.15 + ev.beat * beatSec;
      if (ev.kind === 'bass') bassTone(master, ev.midi, at, ev.durBeats * beatSec, ev.gain);
      else if (ev.kind === 'pad') pianoTone(master, ev.midi, at + ev.staggerSec, 3.2, ev.gain, -0.03);
      else pianoTone(master, ev.midi, at, Math.max(2.0, ev.lenBeats * beatSec * 1.05), ev.gain, 0.05);
    }
    const buf = await c.startRendering();
    // WAV (16bit PCM stereo) にエンコード
    const n = buf.length;
    const bytes = new DataView(new ArrayBuffer(44 + n * 4));
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); bytes.setUint32(4, 36 + n * 4, true); wstr(8, 'WAVEfmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
    bytes.setUint32(24, 44100, true); bytes.setUint32(28, 44100 * 4, true);
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
  },
  { events, masterGain },
);
await browser.close();

const out = new URL('./bgm-render.wav', import.meta.url).pathname;
writeFileSync(out, Buffer.from(wavBase64, 'base64'));
const res = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
const err = res.stderr ?? '';
const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err)?.[1];
const max = /max_volume:\s*(-?[\d.]+) dB/.exec(err)?.[1];
console.log(JSON.stringify({ bpm: BGM_BPM, loopBeats: BGM_LOOP_BEATS, events: events.length, masterGain, mean_volume_dB: mean, max_volume_dB: max, wav: out }));
