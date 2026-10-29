#!/usr/bin/env node
// 内容の整合チェック: 正本のデータと、その派生物（コピー・生成物・二か所に書く設定など）が食い違っていないかを確かめる。
// 使い方: npm run check:content（npm run verify にも入っている）
// 検査の中身はアプリごとに scripts/content-checks.mjs に足す。このファイルは枠組みだけ。
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKS_PATH = join(ROOT, 'scripts', 'content-checks.mjs');

if (!existsSync(CHECKS_PATH)) {
  console.log('check:content — scripts/content-checks.mjs がないので、検査する内容がありません');
  process.exit(0);
}

const { checks } = await import(pathToFileURL(CHECKS_PATH).href);

const errors = [];
if (!Array.isArray(checks)) {
  errors.push('scripts/content-checks.mjs は checks（配列）を export してください');
} else {
  const ids = new Set();
  for (const [i, check] of checks.entries()) {
    if (!check || typeof check.id !== 'string' || check.id === '' || typeof check.run !== 'function') {
      errors.push(`content-checks[${i}] の形が違います（{ id, title, run } で書いてください）`);
      continue;
    }
    if (ids.has(check.id)) errors.push(`検査の id が重なっています: ${check.id}`);
    ids.add(check.id);
  }
}

if (errors.length === 0) {
  for (const check of checks) {
    let found;
    try {
      found = await check.run({ root: ROOT });
    } catch (err) {
      found = [`実行中にエラーになりました: ${err instanceof Error ? err.message : String(err)}`];
    }
    for (const message of found ?? []) errors.push(`[${check.id}] ${message}`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  console.error(`check:content — 検査 ${Array.isArray(checks) ? checks.length : 0} 件、エラー ${errors.length} 件`);
  process.exit(1);
}
console.log(`check:content — 検査 ${checks.length} 件、エラー 0 件`);
