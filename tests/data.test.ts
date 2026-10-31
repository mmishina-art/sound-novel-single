// 本のデータ（public/book/data.json）の検証。データ駆動のアプリなので、壊れたデータを公開前に止める。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUnits, type BookData } from '../src/logic';

const root = resolve(__dirname, '..');
const book = JSON.parse(readFileSync(resolve(root, 'public/book/data.json'), 'utf8')) as BookData;

describe('本のデータ', () => {
  it('タイトル・著者・方向が入っている', () => {
    expect(book.title).toBe('空の郵便が届くまで');
    expect(book.author).toBe('桜井 みゅう');
    expect(book.direction).toBe('vertical');
  });

  it('全7章あり、各章に必須項目とルビ・読み上げ文がある', () => {
    expect(book.chapters).toHaveLength(7);
    for (const ch of book.chapters) {
      expect(ch.num).toBeTruthy();
      expect(ch.title).toBeTruthy();
      expect(ch.narratorName).toBeTruthy();
      expect(ch.paragraphs.length).toBeGreaterThan(0);
      expect(ch.ruby).toHaveLength(ch.paragraphs.length);
      expect(ch.spoken).toBeTruthy();
      expect(ch.chars).toBe(ch.paragraphs.reduce((a, p) => a + p.length, 0));
    }
  });

  it('総字数が章の合計と合う', () => {
    const total = book.chapters.reduce((a, ch) => a + (ch.chars ?? 0), 0);
    expect(book.totalChars).toBe(total);
  });

  it('章ごとの音声ファイル（public/book/audio/chN.mp3）がある', () => {
    book.chapters.forEach((_, i) => {
      const p = resolve(root, `public/book/audio/ch${i + 1}.mp3`);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(1_000_000);
    });
    expect(existsSync(resolve(root, 'public/book/cover-art.webp'))).toBe(true);
  });

  it('unitTimes（文ごとの実開始時刻）が全章にあり、単位列と対応する', () => {
    for (const ch of book.chapters) {
      const units = buildUnits(ch);
      expect(ch.unitTimes, ch.num).toHaveLength(units.length);
      const times = ch.unitTimes as number[];
      expect(times[0]).toBe(0);
      for (let i = 1; i < times.length; i++) {
        expect(times[i], ch.num).toBeGreaterThanOrEqual(times[i - 1]);
      }
    }
  });

  it('生成元（data/chapters.json）と配信データが一致する', () => {
    const src = readFileSync(resolve(root, 'data/chapters.json'), 'utf8');
    const pub = readFileSync(resolve(root, 'public/book/data.json'), 'utf8');
    expect(JSON.parse(pub)).toEqual(JSON.parse(src));
  });
});
