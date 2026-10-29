import { describe, expect, it } from 'vitest';
import {
  SPEEDS,
  buildUnits,
  directionOf,
  fmt,
  groupClass,
  pageForChar,
  plainLen,
  rubyToHtml,
  splitSentences,
  speedIndexOf,
  unitIndexAtTime,
  type ChapterData,
} from '../src/logic';

describe('rubyToHtml', () => {
  it('｜本文《よみ》 を ruby にする', () => {
    expect(rubyToHtml('｜雨《あめ》の日')).toBe('<ruby>雨<rt>あめ</rt></ruby>の日');
  });

  it('｜なしの 本文《よみ》 も ruby にする', () => {
    expect(rubyToHtml('柏木《かしわぎ》さん')).toBe('<ruby>柏木<rt>かしわぎ</rt></ruby>さん');
  });

  it('HTML として危ない文字はエスケープする', () => {
    expect(rubyToHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });
});

describe('plainLen', () => {
  it('ルビ記法を取り除いた文字数を返す', () => {
    expect(plainLen('｜雨《あめ》の｜日《ひ》は')).toBe(4);
  });
});

describe('splitSentences', () => {
  it('。で文を割り、閉じ括弧は前の文に付ける', () => {
    expect(splitSentences('「行こう。」彼は言った。次へ。')).toEqual(['「行こう。」', '彼は言った。', '次へ。']);
  });

  it('ルビの内側では割らない', () => {
    const s = '｜何《なに》か。次。';
    expect(splitSentences(s)).toEqual(['｜何《なに》か。', '次。']);
  });

  it('末尾に。がなくても残りを返す', () => {
    expect(splitSentences('あ。い')).toEqual(['あ。', 'い']);
  });
});

describe('buildUnits', () => {
  const ch = (ruby: string[]): ChapterData => ({
    num: '第一章',
    title: 't',
    narratorName: 'n',
    narrator: 'female',
    paragraphs: ruby,
    ruby,
  });

  it('段落を文単位にし、段落の先頭に first を付ける', () => {
    const units = buildUnits(ch(['一文目。二文目。', '次段落。']));
    expect(units.map((u) => [u.html, u.first, u.para])).toEqual([
      ['一文目。', true, 0],
      ['二文目。', false, 0],
      ['次段落。', true, 1],
    ]);
  });

  it('--- は区切り（sep）になる', () => {
    const units = buildUnits(ch(['前。', '---', '後。']));
    expect(units[1]).toMatchObject({ sep: true, html: '＊＊＊' });
  });

  it('ruby がなければ paragraphs を使う', () => {
    const units = buildUnits({ num: '第一章', title: 't', narratorName: 'n', narrator: 'male', paragraphs: ['文。'] });
    expect(units).toHaveLength(1);
  });
});

describe('groupClass', () => {
  it('段落の途中から始まる文は cont（字下げなし）', () => {
    const u = { html: '', len: 0, para: 0, first: true, sep: false };
    expect(groupClass(u, new Set([0]))).toBe('cont');
    expect(groupClass(u, new Set())).toBe('');
    expect(groupClass({ ...u, sep: true }, new Set())).toBe('sep');
  });
});

describe('pageForChar', () => {
  const pages = [
    { startChar: 0, units: [] },
    { startChar: 100, units: [] },
    { startChar: 250, units: [] },
  ];
  it('文字位置が入るページを返す', () => {
    expect(pageForChar(pages, 0)).toBe(0);
    expect(pageForChar(pages, 99)).toBe(0);
    expect(pageForChar(pages, 100)).toBe(1);
    expect(pageForChar(pages, 9999)).toBe(2);
    expect(pageForChar([], 10)).toBe(0);
  });
});

describe('directionOf', () => {
  it('未指定・vertical は右綴じ（次ページは左）', () => {
    expect(directionOf(undefined)).toMatchObject({ mode: 'vertical', bound: 'right', nextSide: 'left' });
    expect(directionOf('vertical')).toMatchObject({ bound: 'right' });
  });
  it('horizontal は左綴じ（次ページは右）', () => {
    expect(directionOf('horizontal')).toMatchObject({ mode: 'horizontal', bound: 'left', nextSide: 'right' });
  });
});

describe('unitIndexAtTime', () => {
  const times = [0, 4.2, 9.5, 15.0];
  it('文の区間 [開始, 次の開始) で現在の文を返す', () => {
    expect(unitIndexAtTime(times, 0)).toBe(0);
    expect(unitIndexAtTime(times, 4.19)).toBe(0);
    expect(unitIndexAtTime(times, 4.2)).toBe(1); // ちょうど始まった文が現在
    expect(unitIndexAtTime(times, 12.3)).toBe(2);
  });
  it('最後の文より後は最後の文に留まり、先頭より前は 0', () => {
    expect(unitIndexAtTime(times, 999)).toBe(3);
    expect(unitIndexAtTime(times, -5)).toBe(0);
  });
  it('同じ開始時刻が続く（区切り単位）場合は後の単位を返す', () => {
    // 区切り単位は次の文と同じ開始時刻を持つ。読まれているのは実文のほう
    expect(unitIndexAtTime([0, 5, 5, 11], 5)).toBe(2);
    expect(unitIndexAtTime([0, 5, 5, 11], 4.9)).toBe(0);
  });
});

describe('fmt / speed', () => {
  it('秒を m:ss にする', () => {
    expect(fmt(0)).toBe('0:00');
    expect(fmt(65)).toBe('1:05');
    expect(fmt(NaN)).toBe('0:00');
  });
  it('速度の位置を引く（知らない速度は 1.0 の位置）', () => {
    expect(SPEEDS[speedIndexOf(1.25)]).toBe(1.25);
    expect(SPEEDS[speedIndexOf(3)]).toBe(1.0);
  });
});
