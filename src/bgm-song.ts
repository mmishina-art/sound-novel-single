/**
 * 読書用BGM（書き下ろしの静かなピアノバラード）。
 * 姉妹アプリ『サウンドノベル』のタイトルBGMと同じ流儀：固定の作曲データを
 * Web Audio で合成して鳴らす（再生は src/sound.ts）。音のファイルは持たない。
 *
 * 構成：8拍（2小節）のコードを24個つないだ全192拍、BPM 60＝3分12秒のループ。
 * 古本屋と雨の静けさを思わせる、穏やかな進行（C系→F系→解決はドミナントで
 * ループ頭の C に戻る）。ビブラート・トレモロ・スウィングは使わず、
 * まっすぐで柔らかいピアノとベースだけにする（朗読の邪魔をしないため、
 * 旋律は薄く間を置いて置く）。
 */

export const BGM_BPM = 60;
export const BGM_LOOP_BEATS = 192;

/** コード進行（bass=ルートのMIDI、fifth=5度、pad=和音の構成音）。各8拍。 */
export const BGM_BLOCKS: { bass: number; fifth: number; pad: number[] }[] = [
  // A：静かに始まる
  { bass: 36, fifth: 43, pad: [55, 59, 60, 64] }, // Cmaj9
  { bass: 45, fifth: 52, pad: [57, 60, 64, 67] }, // Am9
  { bass: 41, fifth: 48, pad: [57, 60, 64, 67] }, // Fmaj9
  { bass: 40, fifth: 47, pad: [55, 59, 62, 66] }, // Em9
  { bass: 41, fifth: 48, pad: [57, 60, 64, 67] }, // Fmaj9
  { bass: 43, fifth: 50, pad: [53, 59, 62, 65] }, // G
  { bass: 45, fifth: 52, pad: [57, 60, 64, 67] }, // Am9
  { bass: 38, fifth: 45, pad: [53, 57, 60, 64] }, // Dm9
  // A'：少しだけ高く、同じ景色をもう一度
  { bass: 36, fifth: 43, pad: [55, 59, 60, 64] }, // Cmaj9
  { bass: 45, fifth: 52, pad: [57, 60, 64, 67] }, // Am9
  { bass: 41, fifth: 48, pad: [57, 60, 64, 67] }, // Fmaj9
  { bass: 40, fifth: 47, pad: [55, 59, 62, 66] }, // Em9
  { bass: 41, fifth: 48, pad: [57, 60, 64, 67] }, // Fmaj9
  { bass: 38, fifth: 45, pad: [53, 57, 60, 64] }, // Dm9
  { bass: 40, fifth: 47, pad: [55, 59, 62, 66] }, // Em9
  { bass: 45, fifth: 52, pad: [57, 60, 64, 69] }, // Am9
  // B：窓の外が明るくなる
  { bass: 41, fifth: 48, pad: [57, 60, 64, 67] }, // Fmaj9
  { bass: 43, fifth: 50, pad: [55, 59, 62, 67] }, // G
  { bass: 40, fifth: 47, pad: [55, 59, 62, 66] }, // Em9
  { bass: 45, fifth: 52, pad: [57, 60, 64, 67] }, // Am9
  { bass: 41, fifth: 48, pad: [57, 60, 64, 67] }, // Fmaj9
  { bass: 40, fifth: 47, pad: [55, 59, 62, 66] }, // Em9
  { bass: 38, fifth: 45, pad: [53, 57, 60, 64] }, // Dm9
  { bass: 43, fifth: 50, pad: [53, 59, 62] }, //     G（ループ頭の C へ解決）
];

/** 旋律：[始まる拍, MIDI, 長さ（拍）]。間を広く取り、朗読と競らない密度にする */
export const BGM_MELODY: [number, number, number][] = [
  // A
  [0, 72, 4], [4, 69, 2], [6, 67, 2],
  [10, 69, 4], [14, 71, 2],
  [16, 69, 4], [20, 65, 2], [22, 64, 2],
  [24, 62, 6],
  [32, 65, 4], [36, 64, 2], [38, 62, 2],
  [40, 59, 4], [44, 62, 2],
  [48, 64, 4], [52, 67, 2], [54, 69, 2],
  [56, 65, 6],
  // A'
  [64, 69, 4], [68, 72, 2], [70, 74, 2],
  [74, 72, 4], [78, 69, 2],
  [80, 67, 4], [84, 69, 2], [86, 65, 2],
  [88, 64, 6],
  [96, 65, 4], [100, 69, 2], [102, 67, 2],
  [104, 64, 4], [108, 62, 2],
  [112, 59, 4], [116, 62, 2], [118, 64, 2],
  [120, 69, 6],
  // B
  [128, 72, 4], [132, 69, 2], [134, 67, 2],
  [136, 71, 4], [140, 74, 2], [142, 71, 2],
  [144, 67, 6],
  [152, 67, 4], [156, 64, 2], [158, 65, 2],
  [160, 69, 4], [164, 72, 2],
  [168, 64, 4], [172, 62, 2], [174, 59, 2],
  [176, 65, 6],
  [184, 62, 3], [188, 59, 3],
];

export type BgmEvent =
  | { kind: 'bass'; beat: number; midi: number; durBeats: number; gain: number }
  | { kind: 'pad'; beat: number; midi: number; staggerSec: number; gain: number }
  | { kind: 'melody'; beat: number; midi: number; lenBeats: number; gain: number };

/** 曲データを、再生しやすいイベント列（拍順）に展開する */
export function buildBgmEvents(): BgmEvent[] {
  const events: BgmEvent[] = [];
  BGM_BLOCKS.forEach((c, bi) => {
    const start = bi * 8;
    // ベース：ルート→5度→ルート（5度上）→オクターブ、と静かに歩く
    events.push({ kind: 'bass', beat: start, midi: c.bass, durBeats: 2.0, gain: 0.088 });
    events.push({ kind: 'bass', beat: start + 2, midi: c.fifth, durBeats: 1.8, gain: 0.067 });
    events.push({ kind: 'bass', beat: start + 4, midi: c.bass + 7 <= 52 ? c.bass + 7 : c.bass, durBeats: 1.8, gain: 0.062 });
    events.push({ kind: 'bass', beat: start + 7, midi: c.bass + 12, durBeats: 1.0, gain: 0.056 });
    // 和音：4か所で柔らかく打つ。構成音は少しずつずらして重ねる
    for (const off of [0, 2.5, 4, 6.5])
      c.pad.forEach((midi, i) => events.push({ kind: 'pad', beat: start + off, midi, staggerSec: i * 0.015, gain: 0.021 }));
  });
  for (const [beat, midi, lenBeats] of BGM_MELODY)
    events.push({ kind: 'melody', beat, midi, lenBeats, gain: 0.062 });
  return events.sort((a, b) => a.beat - b.beat);
}
