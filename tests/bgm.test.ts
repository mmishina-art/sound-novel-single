import { describe, expect, test } from 'vitest';
import { BGM_BLOCKS, BGM_BPM, BGM_LOOP_BEATS, BGM_MELODY, buildBgmEvents } from '../src/bgm-song';

describe('BGMの作曲データ', () => {
  test('ループは24ブロック×8拍＝192拍で、BPM 60なら3分12秒', () => {
    expect(BGM_BLOCKS).toHaveLength(24);
    expect(BGM_LOOP_BEATS).toBe(24 * 8);
    expect((BGM_LOOP_BEATS * 60) / BGM_BPM).toBe(192);
  });

  test('イベントは拍順に並び、すべてループの中に収まる', () => {
    const events = buildBgmEvents();
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) expect(events[i].beat).toBeGreaterThanOrEqual(events[i - 1].beat);
    for (const ev of events) expect(ev.beat).toBeLessThan(BGM_LOOP_BEATS);
  });

  test('音域は低すぎず高すぎない範囲（MIDI 30〜80）', () => {
    for (const [, midi] of BGM_MELODY) {
      expect(midi).toBeGreaterThanOrEqual(30);
      expect(midi).toBeLessThanOrEqual(80);
    }
    for (const b of BGM_BLOCKS) {
      expect(b.bass).toBeGreaterThanOrEqual(30);
      for (const m of b.pad) expect(m).toBeLessThanOrEqual(80);
    }
  });

  test('旋律はすべて拍の頭か半拍に置く（スウィングや揺れを持ち込まない）', () => {
    for (const [beat] of BGM_MELODY) expect((beat * 2) % 1).toBe(0);
  });
});
