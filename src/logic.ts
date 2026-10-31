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
  /** 文単位の実開始時刻（秒）。buildUnits の単位列と並行（区切り単位は次の文の開始時刻）。
      生成時の文セグメント尺から実測した値（work/build_timings.py）。無い本では
      アプリ側が文字数比例の推定にフォールバックする */
  unitTimes?: number[];
  /** この章の音声（本文＋章題コール）の実容量（バイト）。work/build_data.py が
      配信ファイルの実測で入れる。音声が揃っていない制作途中の本では無い */
  audioBytes?: number;
}

export interface BookData {
  title: string;
  author: string;
  direction?: string;
  totalChars?: number;
  /** 全章の音声の総容量（バイト）。初回ダウンロード案内の表示に使う。
      work/build_data.py が全章そろっているときだけ入れる（無い本では案内文に
      容量を出さない） */
  totalAudioBytes?: number;
  chapters: ChapterData[];
}

/** 音声の総容量を、初回案内に出す「約◯MB」の形にする（10進MB・小数1桁まで）。
    バイト数が分からない（undefined）場合は null（容量を出さない判断に使う） */
export function formatAudioSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = (bytes / 1_000_000).toFixed(1).replace(/\.0$/, '');
  return `約${mb}MB`;
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

/* ---- タップのゾーン判定 ----
   画面幅に対するタップ位置の割合（0=左端、1=右端）から、ページ送りの
   方向を決める純関数。次側の40%＝次へ（1）、反対側の40%＝前へ（-1）、
   中央20%は無反応（0）。境界（ちょうど0.4／0.6）は中央側に含める。
   v1.13.6 でタップめくりを廃止したが、v1.13.9 でユーザー決定により復活。
   半分判定だった旧仕様と違い、中央に無反応帯を置くことで、左右どちらへ
   倒れるか曖昧なタップを拾わない */
export function tapDirection(ratio: number, nextSide: 'left' | 'right'): 1 | -1 | 0 {
  if (!Number.isFinite(ratio)) return 0;
  const onNextSide = nextSide === 'left' ? ratio < 0.4 : ratio > 0.6;
  const onPrevSide = nextSide === 'left' ? ratio > 0.6 : ratio < 0.4;
  if (onNextSide) return 1;
  if (onPrevSide) return -1;
  return 0;
}

/* ---- 朗読の速さ ---- */

export const SPEEDS = [0.8, 1.0, 1.25, 1.5, 2.0];
export const DEFAULT_SPEED_INDEX = 1; // 1.0

export function speedIndexOf(speed: number): number {
  const ix = SPEEDS.indexOf(speed);
  if (ix >= 0) return ix;
  /* 候補に無い保存値（旧版で保存された 0.75 等）は、最も近い候補へ寄せる。
     同距離なら既定（1.0×）を優先する */
  let best = DEFAULT_SPEED_INDEX;
  for (let i = 0; i < SPEEDS.length; i++) {
    if (Math.abs(SPEEDS[i] - speed) < Math.abs(SPEEDS[best] - speed)) best = i;
  }
  return best;
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

/** 時刻 t（秒）に読まれている文の番号。unitTimes は単調非減少で、
    時刻ちょうどに次の文が始まっていれば、その文を返す（区間は [開始, 次の開始)）。
    先頭より前は 0、最後の文より後は最後の文に留まる */
export function unitIndexAtTime(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
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

/* ---- 画面遷移の決定（本の中の連鎖の規則） ----
   「いまどこにいて、次／前へ進むと、どこへ行くか」の決定は、すべてここに
   一本化する。reader.ts は現在の状態（NavState）を渡して行き先（NavTarget）を
   受け取り、実行するだけ。連鎖の規則を変えるときはここだけを変える。
   連鎖（後方）：本文 → 自章の後方扉 → 前章の最終本文ページ → … →
   第1章の後方扉 → 目次 → 表紙。前方も同じ道を逆に辿る。
   扉には2種類ある：通常扉（前方向の入口。次＝そのまま入章で、開始処理は
   扉自身の非同期な続き＝章題コールやタイマーが持つため、行き先としては
   'gate-enter' とだけ表す）と、後方扉（前へ辿る連鎖の途中の止まり場。
   次＝自章の本文先頭、前＝前章の最終本文ページ／第1章では目次） */

/** 目次を開いた元の画面 */
export type TocReturn = 'cover' | 'reader' | 'gate';

export type NavState =
  /* 本文（reader）。endOpen は奥付ページが本文の上に重なって開いている状態 */
  | { kind: 'body'; chapter: number; page: number; pageCount: number; chapterCount: number; endOpen: boolean }
  /* 章扉（gate）。back は後方扉かどうか */
  | { kind: 'gate'; chapter: number; chapterCount: number; back: boolean }
  /* 目次ページ（toc）。returnTo は開いた元の画面 */
  | { kind: 'toc'; page: number; pageCount: number; returnTo: TocReturn };

export type NavTarget =
  | { type: 'page'; page: number }
  | { type: 'gate'; chapter: number }
  | { type: 'gate-back'; chapter: number }
  | { type: 'gate-enter' }
  | { type: 'chapter-first'; chapter: number }
  | { type: 'chapter-last'; chapter: number }
  | { type: 'end-open' }
  | { type: 'end-close' }
  | { type: 'toc-gate' }
  | { type: 'toc-page'; page: number }
  | { type: 'view'; view: 'cover' | 'reader' }
  | { type: 'cover' };

export function decideNav(state: NavState, dir: 1 | -1): NavTarget {
  switch (state.kind) {
    case 'body': {
      if (state.endOpen) {
        // 奥付（本の最終ページの上に重なる独立ページ）：前へ＝本文の最終
        // ページへ戻る、次へ＝本を閉じて表紙へ戻る
        return dir < 0 ? { type: 'end-close' } : { type: 'cover' };
      }
      if (dir > 0) {
        if (state.page < state.pageCount - 1) return { type: 'page', page: state.page + 1 };
        // 章をまたぐときも必ず通常扉に止まる（扉を素通りして本文に入らない）
        if (state.chapter < state.chapterCount - 1) return { type: 'gate', chapter: state.chapter + 1 };
        // 本文の最終ページの次は、独立した奥付ページ
        return { type: 'end-open' };
      }
      if (state.page > 0) return { type: 'page', page: state.page - 1 };
      // 先頭ページでさらに前へ：自章の後方扉に止まる。そこからもう一度
      // 前へで、前章の最終本文ページへ直接戻る（前章の扉へは飛ばない）
      return { type: 'gate-back', chapter: state.chapter };
    }
    case 'gate': {
      if (!state.back) {
        // 通常扉：次へ＝そのまま入章（開始は扉自身の続きが行う）
        if (dir > 0) return { type: 'gate-enter' };
        // 前へ＝前章の最終本文ページへ直接（前章の扉には止まらない）。
        // 第1章の扉だけは後方扉へ切り替わり、連鎖（目次→表紙）を続ける
        return state.chapter > 0
          ? { type: 'chapter-last', chapter: state.chapter - 1 }
          : { type: 'gate-back', chapter: 0 };
      }
      // 後方扉：次へ＝自章の本文先頭、前へ＝前章の最終本文ページへ直接
      // （第1章では目次へ。目次は本の並び順で最終ページに着地する）
      if (dir > 0) return { type: 'chapter-first', chapter: state.chapter };
      return state.chapter > 0
        ? { type: 'chapter-last', chapter: state.chapter - 1 }
        : { type: 'toc-gate' };
    }
    case 'toc': {
      if (dir > 0) {
        if (state.page < state.pageCount - 1) return { type: 'toc-page', page: state.page + 1 };
        // 末尾ページでの次へ＝第1章の通常扉（本文へ続く）
        return { type: 'gate', chapter: 0 };
      }
      if (state.page > 0) return { type: 'toc-page', page: state.page - 1 };
      // 先頭ページでの前へ＝開いた元へ戻る。読書中（設定）から開いた
      // 目次なら本文へ帰り、それ以外（表紙から／後方連鎖から）は表紙へ進む
      // （扉へは次方向の操作で戻れるので、後方だけで表紙まで辿り着ける
      // 連鎖は途切れない）
      return state.returnTo === 'reader' ? { type: 'view', view: 'reader' } : { type: 'cover' };
    }
  }
}

/** 目次を閉じるときの行き先（後方連鎖で開いた目次は第1章の後方扉へ帰り、
    それ以外は開いた元の画面へそのまま戻る） */
export function decideTocClose(returnTo: TocReturn): NavTarget {
  return returnTo === 'gate' ? { type: 'gate-back', chapter: 0 } : { type: 'view', view: returnTo };
}

/* ---- 時刻表示 ---- */

export function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}
