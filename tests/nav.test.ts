import { describe, expect, it } from 'vitest';
import { decideNav, decideTocClose, type NavState, type NavTarget } from '../src/logic';

/* 画面遷移の連鎖仕様の固定（logic.decideNav）。
   連鎖（後方）：本文 → 自章の後方扉 → 前章の最終本文ページ → … →
   第1章の後方扉 → 目次 → 表紙。前方も同じ道を逆に辿る */

const CH = 3; // 章数（テスト用）
const body = (chapter: number, page: number, pageCount = 3, endOpen = false): NavState => ({
  kind: 'body',
  chapter,
  page,
  pageCount,
  chapterCount: CH,
  endOpen,
});
const gate = (chapter: number, back = false): NavState => ({ kind: 'gate', chapter, chapterCount: CH, back });
const toc = (page: number, pageCount = 2, returnTo: 'cover' | 'reader' | 'gate' = 'cover'): NavState => ({
  kind: 'toc',
  page,
  pageCount,
  returnTo,
});

describe('decideNav: 本文', () => {
  it('章の途中では前後のページへ', () => {
    expect(decideNav(body(1, 1), 1)).toEqual({ type: 'page', page: 2 });
    expect(decideNav(body(1, 1), -1)).toEqual({ type: 'page', page: 0 });
  });

  it('最終ページの次は次章の通常扉（扉を素通りしない）', () => {
    expect(decideNav(body(1, 2), 1)).toEqual({ type: 'gate', chapter: 2 });
  });

  it('最終章の最終ページの次は奥付', () => {
    expect(decideNav(body(2, 2), 1)).toEqual({ type: 'end-open' });
  });

  it('先頭ページの前は自章の後方扉（前章の扉へは飛ばない）', () => {
    expect(decideNav(body(2, 0), -1)).toEqual({ type: 'gate-back', chapter: 2 });
    expect(decideNav(body(0, 0), -1)).toEqual({ type: 'gate-back', chapter: 0 });
  });

  it('奥付が開いているとき：前は奥付を閉じ、次は表紙へ', () => {
    expect(decideNav(body(2, 2, 3, true), -1)).toEqual({ type: 'end-close' });
    expect(decideNav(body(2, 2, 3, true), 1)).toEqual({ type: 'cover' });
  });
});

describe('decideNav: 通常扉', () => {
  it('次はそのまま入章（gate-enter）', () => {
    expect(decideNav(gate(1), 1)).toEqual({ type: 'gate-enter' });
  });

  it('前は前章の最終本文ページへ直接（前章の扉に止まらない）', () => {
    expect(decideNav(gate(2), -1)).toEqual({ type: 'chapter-last', chapter: 1 });
    expect(decideNav(gate(1), -1)).toEqual({ type: 'chapter-last', chapter: 0 });
  });

  it('第1章の扉の前は後方扉へ切り替わる', () => {
    expect(decideNav(gate(0), -1)).toEqual({ type: 'gate-back', chapter: 0 });
  });
});

describe('decideNav: 後方扉', () => {
  it('次は自章の本文先頭', () => {
    expect(decideNav(gate(2, true), 1)).toEqual({ type: 'chapter-first', chapter: 2 });
  });

  it('前は前章の最終本文ページへ直接', () => {
    expect(decideNav(gate(2, true), -1)).toEqual({ type: 'chapter-last', chapter: 1 });
  });

  it('第1章の後方扉の前は目次（後方連鎖）', () => {
    expect(decideNav(gate(0, true), -1)).toEqual({ type: 'toc-gate' });
  });
});

describe('decideNav: 目次', () => {
  it('目次の中ではページ送り', () => {
    expect(decideNav(toc(0), 1)).toEqual({ type: 'toc-page', page: 1 });
    expect(decideNav(toc(1), -1)).toEqual({ type: 'toc-page', page: 0 });
  });

  it('末尾ページの次は第1章の通常扉', () => {
    expect(decideNav(toc(1), 1)).toEqual({ type: 'gate', chapter: 0 });
  });

  it('先頭ページの前は開いた元で決まる（本文から＝本文へ、それ以外＝表紙へ）', () => {
    expect(decideNav(toc(0, 2, 'reader'), -1)).toEqual({ type: 'view', view: 'reader' });
    expect(decideNav(toc(0, 2, 'cover'), -1)).toEqual({ type: 'cover' });
    expect(decideNav(toc(0, 2, 'gate'), -1)).toEqual({ type: 'cover' });
  });
});

describe('decideTocClose: 目次を閉じる', () => {
  it('後方連鎖で開いた目次は第1章の後方扉へ帰る', () => {
    expect(decideTocClose('gate')).toEqual({ type: 'gate-back', chapter: 0 });
  });

  it('それ以外は開いた元の画面へそのまま戻る', () => {
    expect(decideTocClose('cover')).toEqual({ type: 'view', view: 'cover' });
    expect(decideTocClose('reader')).toEqual({ type: 'view', view: 'reader' });
  });
});

/* 行き先を「着地した状態」に読み替える（歩行テスト用）。
   ページ内移動は歩行では畳み込み、画面の節目だけを追う */
function land(target: NavTarget, pageCounts: number[], tocPageCount: number): NavState | 'cover' | 'end' {
  switch (target.type) {
    case 'page':
      throw new Error('page は歩行テストでは扱わない');
    case 'gate':
      return gate(target.chapter);
    case 'gate-back':
      return gate(target.chapter, true);
    case 'gate-enter':
      return body(0, 0); // 章番号は呼び出し側で補う（下の walkBack では使わない）
    case 'chapter-first':
      return { kind: 'body', chapter: target.chapter, page: 0, pageCount: pageCounts[target.chapter], chapterCount: pageCounts.length, endOpen: false };
    case 'chapter-last':
      return { kind: 'body', chapter: target.chapter, page: pageCounts[target.chapter] - 1, pageCount: pageCounts[target.chapter], chapterCount: pageCounts.length, endOpen: false };
    case 'end-open':
      return 'end';
    case 'end-close':
      throw new Error('end-close は歩行テストでは扱わない');
    case 'toc-gate':
      // 後方連鎖の目次は最終ページに着地する
      return { kind: 'toc', page: tocPageCount - 1, pageCount: tocPageCount, returnTo: 'gate' };
    case 'toc-page':
      throw new Error('toc-page は歩行テストでは扱わない');
    case 'view':
      return target.view === 'cover' ? 'cover' : body(0, 0);
    case 'cover':
      return 'cover';
  }
}

describe('連鎖の歩行（後方へ端から端まで）', () => {
  it('第3章の本文先頭から、前だけで表紙まで一貫して辿れる', () => {
    const pageCounts = [2, 3, 2]; // 各章のページ数
    const tocPageCount = 2;
    // 節目（画面の切り替わり）だけを記録する
    const landmarks: string[] = [];
    let state: NavState | 'cover' | 'end' = {
      kind: 'body',
      chapter: 2,
      page: 0,
      pageCount: pageCounts[2],
      chapterCount: 3,
      endOpen: false,
    };
    for (let step = 0; step < 50 && state !== 'cover'; step++) {
      const s = state as NavState;
      const t = decideNav(s, -1);
      if (t.type === 'page') {
        state = { ...s, page: t.page } as NavState;
        continue;
      }
      if (t.type === 'toc-page') {
        state = { ...(s as Extract<NavState, { kind: 'toc' }>), page: t.page };
        continue;
      }
      landmarks.push(t.type + (('chapter' in t && t.chapter !== undefined) ? ':' + t.chapter : ''));
      state = land(t, pageCounts, tocPageCount);
    }
    expect(state).toBe('cover');
    // 第3章の後方扉 → 第2章の最終ページ → 第2章の後方扉 → 第1章の最終ページ
    // → 第1章の後方扉 → 目次（後方連鎖）→ 表紙、の順で節目を辿る
    expect(landmarks).toEqual([
      'gate-back:2',
      'chapter-last:1',
      'gate-back:1',
      'chapter-last:0',
      'gate-back:0',
      'toc-gate',
      'cover',
    ]);
  });

  it('前方も同じ道を辿る：目次の末尾から第1章の扉、扉から本文へ', () => {
    // 目次（表紙から開いた）の末尾ページで次 → 第1章の通常扉
    expect(decideNav(toc(1, 2, 'cover'), 1)).toEqual({ type: 'gate', chapter: 0 });
    // 通常扉で次 → 入章
    expect(decideNav(gate(0), 1)).toEqual({ type: 'gate-enter' });
    // 後方扉で次 → 自章の本文先頭（後方連鎖の逆行）
    expect(decideNav(gate(0, true), 1)).toEqual({ type: 'chapter-first', chapter: 0 });
  });
});
