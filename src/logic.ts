// ルール・計算は DOM に触れない純関数にして、tests/ で単体テストする。
// ここには単行本の組版まわりの純粋な処理（ルビ変換、文分割、ページの当て先の計算、方向設定）を置く。

/* ---- 本のデータ（public/book/data.json の形） ---- */

export interface ChapterData {
  num: string;
  title: string;
  narratorName: string;
  narrator: string;
  paragraphs: string[];
  ruby?: string[];
  spoken?: string;
  chars?: number;
  spokenChars?: number;
}

export interface BookData {
  title: string;
  author: string;
  direction?: string;
  totalChars?: number;
  chapters: ChapterData[];
}

/* ---- 本ごとの方向設定 ----
   data.json の "direction" で切り替える（未指定は 'vertical'）。
   方向に依存する判断（組版の writing-mode、綴じ側、ページ送り方向、はみ出しの測り方）は
   すべて DIR と CSS の body の dir 系／bound 系クラスに集約してある。
   'horizontal'（横書き・左綴じ）は将来対応：設定値と切り替え口だけ用意し、
   横書きの組版調整そのものは未実装。 */
export type DirectionName = 'vertical' | 'horizontal';

export interface Direction {
  mode: DirectionName;
  bound: 'right' | 'left';
  nextSide: 'left' | 'right';
}

export const DIRECTIONS: Record<DirectionName, Direction> = {
  vertical: { mode: 'vertical', bound: 'right', nextSide: 'left' },
  horizontal: { mode: 'horizontal', bound: 'left', nextSide: 'right' },
};

export function directionOf(name: string | undefined): Direction {
  return name === 'horizontal' ? DIRECTIONS.horizontal : DIRECTIONS.vertical;
}

/* ---- 再生速度 ---- */

export const SPEEDS = [0.8, 1.0, 1.25, 1.5, 2.0];
export const DEFAULT_SPEED_INDEX = 1; // 1.0

export function speedIndexOf(speed: number): number {
  const ix = SPEEDS.indexOf(speed);
  return ix >= 0 ? ix : DEFAULT_SPEED_INDEX;
}

export function speedLabel(speed: number): string {
  return speed.toFixed(2).replace(/0$/, '') + '×';
}

/* ---- しおり ---- */

export interface Bookmark {
  chapter: number;
  time: number;
  title: string;
  savedAt: number;
  anchor?: number;
  page?: number;
}

/* ---- ルビ（青空文庫式：｜本文《よみ》／本文《よみ》） ---- */

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function rubyToHtml(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '｜') {
      const open = text.indexOf('《', i);
      const close = open >= 0 ? text.indexOf('》', open) : -1;
      if (open > i && close > open) {
        out += '<ruby>' + esc(text.slice(i + 1, open)) + '<rt>' + esc(text.slice(open + 1, close)) + '</rt></ruby>';
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    if (text[i] === '《') {
      const close = text.indexOf('》', i);
      if (close > i) {
        i = close + 1;
        continue;
      }
    }
    let j = i;
    while (j < text.length && text[j] !== '｜' && text[j] !== '《') j++;
    if (j < text.length && text[j] === '《') {
      const close = text.indexOf('》', j);
      if (close > j) {
        out += '<ruby>' + esc(text.slice(i, j)) + '<rt>' + esc(text.slice(j + 1, close)) + '</rt></ruby>';
        i = close + 1;
        continue;
      }
    }
    out += esc(text.slice(i, j));
    i = j;
  }
  return out;
}

/** ルビ記法を取り除いた表示文字数 */
export function plainLen(rubyText: string): number {
  return rubyText.replace(/｜/g, '').replace(/《[^》]*》/g, '').length;
}

/** 段落を文単位に割る（ルビの内側では割らない。閉じ括弧類は前の文に付ける） */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inRuby = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    buf += c;
    if (c === '《') inRuby = true;
    else if (c === '》') inRuby = false;
    else if (c === '。' && !inRuby) {
      while (i + 1 < text.length && '」』）】〉・…'.indexOf(text[i + 1]) >= 0) {
        buf += text[++i];
      }
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/* ---- ページ割りの材料（文の単位） ---- */

export interface Unit {
  /** ルビ記法のままの文（描画時に rubyToHtml する） */
  html: string;
  /** 表示文字数（ルビ除く） */
  len: number;
  para: number;
  first: boolean;
  sep: boolean;
}

export function buildUnits(ch: ChapterData): Unit[] {
  const src = ch.ruby && ch.ruby.length ? ch.ruby : ch.paragraphs || [];
  const units: Unit[] = [];
  src.forEach((p, pi) => {
    if (p.trim() === '---') {
      units.push({ html: '＊＊＊', len: 0, para: pi, first: true, sep: true });
      return;
    }
    splitSentences(p).forEach((s, si) => {
      units.push({ html: s, len: plainLen(s), para: pi, first: si === 0, sep: false });
    });
  });
  return units;
}

/** 段落の途中から始まる文（字下げしない）かどうか等の、段落グループの種別 */
export function groupClass(u: Unit, paraBegun: ReadonlySet<number>): string {
  if (u.sep) return 'sep';
  return u.first && !paraBegun.has(u.para) ? '' : 'cont';
}

/* ---- ページ ---- */

export interface Page {
  startChar: number;
  units: Unit[];
}

/** 文字位置（章の先頭からの表示文字数）が、どのページに入るか */
export function pageForChar(pages: Page[], charPos: number): number {
  if (!pages.length) return 0;
  let p = 0;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].startChar <= charPos) p = i;
    else break;
  }
  return p;
}

/* ---- 時刻表示 ---- */

export function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
