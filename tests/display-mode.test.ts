// 表示方式の切替（カラオケ方式）が廃止され、ページ形式だけになっていること。
// 旧設定（キー display に 'karaoke' 等）が残る端末でも壊れないよう、起動時の
// 移行（読み捨てて消す）が残っていることも確かめる
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const css = readFileSync(resolve(root, 'src/style.css'), 'utf8');
const reader = readFileSync(resolve(root, 'src/reader.ts'), 'utf8');

describe('表示方式（ページ形式のみ）', () => {
  it('メニューに表示方式の項目がない', () => {
    expect(html).not.toMatch(/displayModeBtn/);
    expect(html).not.toMatch(/表示方式/);
  });

  it('カラオケ固有の実装（未読文を隠す処理・モード切替）が残っていない', () => {
    // 移行コメント内の言及は除き、実装の識別子が残っていないことを見る
    expect(reader).not.toMatch(/displayMode|setDisplayMode|updateKaraoke|stepKaraoke|karaokeIdx/);
    expect(css).not.toMatch(/k-hide/);
    expect(css).not.toMatch(/mode-karaoke/);
  });

  it('保存済みの方式指定は起動時に消す移行がある', () => {
    expect(reader).toMatch(/remove\('display'\)/);
  });

  it('ハイライト（朗読中の文の強調）の設定は残っている', () => {
    expect(html).toMatch(/hlToggle/);
    expect(reader).toMatch(/updateNowHighlight/);
  });
});
