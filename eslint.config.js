import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // work/ は本の生成・検証用スクリプト置き場（アプリ本体ではない）ので、lint の対象外にする
  { ignores: ['dist', 'dist-preview', 'shots', 'dev-dist', 'node_modules', 'playwright-report', 'test-results', 'work'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts'], languageOptions: { globals: globals.browser } },
  {
    // 利用者が入力した文字を innerHTML に入れると、意図しないタグが動く。textContent を使う。
    // HTML の固定の組み立てが必要なときは、その行に eslint-disable を付けて理由を書く。
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'innerHTML への代入は使わず、textContent か DOM の組み立てを使ってください' },
        { selector: "AssignmentExpression[left.property.name='outerHTML']", message: 'outerHTML への代入は使わないでください' },
      ],
    },
  },
  // public/ のスクリプトは、ビルドを通さずにそのまま配信される（普通の <script>）
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  { files: ['tests/**/*.ts', 'scripts/**/*.mjs', 'vite.config.ts', 'playwright.config.ts', '*.js'], languageOptions: { globals: globals.node } },
  // page.evaluate() のコールバックはブラウザで動くので、両方の globals を許可する
  { files: ['e2e/**/*.ts'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
);
