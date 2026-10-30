// 初回だけ効く設定の初期値が、利用者の保存値を上書きしない形で固定されていること。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const reader = readFileSync(resolve(root, 'src/reader.ts'), 'utf8');

describe('フリガナの初期値', () => {
  it('未保存のときだけオフになり、保存済みの値は load の fallback で上書きしない', () => {
    expect(reader).toMatch(/load<boolean>\('ruby', false\)/);
    expect(reader).not.toMatch(/load<boolean>\('ruby', true\)/);
  });

  it('HTML の初期状態でもフリガナはオフ', () => {
    const toggle = html.match(/<input[^>]*id="rubyToggle"[^>]*>/)?.[0] ?? '';
    expect(toggle).not.toMatch(/checked/);
  });
});
