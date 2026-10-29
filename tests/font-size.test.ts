// 文字サイズの選択肢（標準／大）が、設定・保存・組版への効き方まで含めて
// 残っていること。標準は従来どおり（倍率1）、大は本文だけを1.2倍にする
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const css = readFileSync(resolve(root, 'src/style.css'), 'utf8');
const reader = readFileSync(resolve(root, 'src/reader.ts'), 'utf8');

describe('文字サイズ（標準／大）', () => {
  it('メニューの表示グループに文字サイズの項目がある', () => {
    expect(html).toMatch(/id="fontSizeBtn"/);
    expect(html).toMatch(/文字サイズ/);
  });

  it('倍率は標準＝1、大＝1.2 で、本文の font-size に効いている', () => {
    expect(css).toMatch(/--font-scale:\s*1;/);
    expect(css).toMatch(/body\.font-large\s*\{\s*--font-scale:\s*1\.2;/);
    expect(css).toMatch(/font-size:\s*calc\(1\.12rem \* var\(--font-scale\)\)/);
  });

  it('保存キー font で読み書きし、未保存は標準に倒れる', () => {
    expect(reader).toMatch(/save\('font', size\)/);
    expect(reader).toMatch(/load<string>\('font', 'std'\)/);
  });

  it('ページ割りの再計算キーに文字サイズが含まれている', () => {
    const sizeKey = reader.match(/function sizeKeyNow\(\)[^}]*\}/)?.[0] ?? '';
    expect(sizeKey).toMatch(/fontSize/);
  });
});
