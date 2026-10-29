// 画面が上下に引っ張られない（オーバースクロール・引っ張って更新の防止）設定が、
// 元に戻っていないこと。iPhone Safari/PWA では overscroll-behavior だけでは
// バウンスが止まらないため、body の固定化が本体になっている
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const css = readFileSync(resolve(root, 'src/style.css'), 'utf8');

describe('画面の固定（引っ張れない）', () => {
  it('html と body の両方に overscroll-behavior: none がある', () => {
    const matches = css.match(/overscroll-behavior:\s*none/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('body がビューポートに固定され、ドキュメントのスクロールがなくなっている', () => {
    const bodyBlock = css.match(/body\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bodyBlock).toMatch(/position:\s*fixed/);
    expect(bodyBlock).toMatch(/overflow:\s*hidden/);
  });

  it('各ビューは min-height ではなく height: 100dvh で画面に収めている', () => {
    expect(css).not.toMatch(/min-height:\s*100dvh/);
    for (const view of ['.view-cover', '.view-gate', '.view-toc', '.view-reader']) {
      const block = css.match(new RegExp(view.replace('.', '\\.') + '\\s*\\{[^}]*\\}'))?.[0] ?? '';
      expect(block, view).toMatch(/height:\s*100dvh/);
    }
  });

  it('内部スクロールの要素は連鎖を止める（overscroll-behavior: contain）', () => {
    const panel = css.match(/\.modal-panel\s*\{[^}]*\}/)?.[0] ?? '';
    expect(panel).toMatch(/overscroll-behavior:\s*contain/);
    const dialog = css.match(/\.install-dialog\s*\{[^}]*\}/)?.[0] ?? '';
    expect(dialog).toMatch(/overscroll-behavior:\s*contain/);
  });
});
