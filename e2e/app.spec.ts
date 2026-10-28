import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// アプリの ID（package.json の name）。保存データのキーの接頭辞になる
const APP_ID = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name;

/** 表紙 → 章扉（自動で進む）→ 本文まで開く */
async function openReader(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' }); // 本のデータが届いてから
  await page.locator('#coverTap').click();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#pageFolio')).not.toHaveText('');
}

/** 操作UI（クローム）が消えているときだけ、中央タップで出す */
async function ensureChrome(page: import('@playwright/test').Page): Promise<void> {
  if ((await page.locator('#readerView.chrome-on').count()) === 0) {
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.locator('#readerView')).toHaveClass(/chrome-on/);
  }
}

/** 読書画面からメニューを開く */
async function openMenuInReader(page: import('@playwright/test').Page): Promise<void> {
  await ensureChrome(page);
  await page.locator('#menuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
}

/** 表紙からメニュー（設定）を開く */
async function openMenuOnCover(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#settingsFromCoverBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
}

test('表紙が開き、タイトルと著者が見える', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#coverView')).toBeVisible();
  await expect(page.locator('.cover-vtitle')).toContainText('空の郵便が');
  await expect(page).toHaveTitle(/空の郵便が届くまで/);
});

test('表紙タップで章扉が出て、本文へ進む', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page.locator('#coverTap').click();
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  await expect(page.locator('#gateTitle')).toHaveText('雨の日の客');
  await page.locator('#gateView').click(); // 扉タップで即本文へ
  await expect(page.locator('#readerView')).toBeVisible();
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
});

test('ページめくり: 左側タップで次ページ（右綴じ）へ進み、ノンブルが増える', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  // 右側タップで前ページへ戻る
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
});

test('目次から章を選べる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page.locator('#tocFromCoverBtn').click();
  await expect(page.locator('#tocModal')).toBeVisible();
  await expect(page.locator('.toc-item')).toHaveCount(7);
  await page.locator('.toc-item').nth(2).click();
  await expect(page.locator('#gateNum')).toHaveText('第三章');
});

test('しおりが残り、表紙から再開できる', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await ensureChrome(page);
  await page.locator('#toCoverBtn').click();
  await expect(page.locator('#coverView')).toBeVisible();
  await expect(page.locator('#resumeBtn')).toBeVisible();
  await expect(page.locator('#bookmarkInfo')).toContainText('ページ');
  const bm = await page.evaluate((id) => localStorage.getItem(`${id}-bookmark`), APP_ID);
  expect(JSON.parse(bm as string)).toMatchObject({ chapter: 0, page: 2 });
});

test('速度ボタンで再生速度が切り替わる', async ({ page }) => {
  await openReader(page);
  await openMenuInReader(page);
  const btn = page.locator('#speedBtn');
  await expect(btn).toHaveText('1.0×');
  await btn.click();
  await expect(btn).toHaveText('1.25×');
});

test('フリガナのオン/オフが切り替わる', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('body')).not.toHaveClass(/ruby-off/);
  await openMenuInReader(page);
  await page.locator('#rubyToggle').click();
  await expect(page.locator('body')).toHaveClass(/ruby-off/);
});

test('中央タップで操作UIの表示・非表示が切り替わり、放っておくと消える', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  const cx = box.x + box.width * 0.5;
  const cy = box.y + box.height * 0.5;
  await page.mouse.click(cx, cy); // 表示中 → 消える
  await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/);
  await expect(page.locator('#toCoverBtn')).toBeHidden();
  await page.mouse.click(cx, cy); // 消えている → 出る
  await expect(page.locator('#readerView')).toHaveClass(/chrome-on/);
  await expect(page.locator('#toCoverBtn')).toBeVisible();
  // 数秒で自動的に消える
  await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/, { timeout: 8000 });
});

test('背景イメージのオン/オフが切り替わる', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('body')).not.toHaveClass(/bg-off/); // 既定はオン
  await openMenuInReader(page);
  await page.locator('#bgToggle').click();
  await expect(page.locator('body')).toHaveClass(/bg-off/);
  await page.locator('#bgToggle').click();
  await expect(page.locator('body')).not.toHaveClass(/bg-off/);
});

test('BGMは最初のタップで流れ始め、設定でオン/オフが切り替わる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('body')).not.toHaveAttribute('data-bgm', 'on'); // まだ操作していないので鳴らない
  await page.locator('#coverTap').click(); // 最初のタップで流れ始める
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on');
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await openMenuInReader(page);
  await expect(page.locator('#bgmToggle')).toBeChecked(); // 既定はオン
  await page.locator('#bgmToggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'off'); // オフで即止まる
  await page.locator('#bgmToggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on');
});

test('manifest と Service Worker が使える', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(registered).toBe(true);
});

test('更新バナーは通常は隠れている', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#update-banner')).toBeHidden();
});

test('更新バナーは「あとで」で閉じられる', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('update-banner')!.hidden = false;
  });
  await page.getByRole('button', { name: 'あとで' }).click();
  await expect(page.locator('#update-banner')).toBeHidden();
});

test('最初の画面からインストール方法を開ける（使っている端末の説明が開いている）', async ({ page }) => {
  await page.goto('/');
  await openMenuOnCover(page);
  await page.getByRole('button', { name: /インストールする方法/ }).click();
  const dialog = page.locator('#install-dialog');
  await expect(dialog).toBeVisible();
  // Pixel 7 のプロファイルなので Android の説明が開いている
  await expect(dialog.locator('details[data-platform="android"]')).toHaveJSProperty('open', true);
  await expect(dialog.locator('details[data-platform="ios"]')).toHaveJSProperty('open', false);
  await dialog.getByRole('button', { name: 'とじる' }).click();
  await expect(dialog).toBeHidden();
});

test('最初の画面にバージョンが表示される', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#version')).toHaveText(/^\d+\.\d+\.\d+$/);
});

test('記録をファイルに書き出し、消えたあとに読み込んで戻せる', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await ensureChrome(page);
  await page.locator('#toCoverBtn').click();
  await openMenuOnCover(page);
  await page.getByText('記録のバックアップ').click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ファイルに書き出す' }).click()]);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(path, 'utf8');
  expect(JSON.parse(text).data[`${APP_ID}-bookmark`]).toBeTruthy();

  // 記録を消す → 読み込んで戻す
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#resumeBtn')).toBeHidden();
  await openMenuOnCover(page);
  await page.getByText('記録のバックアップ').click();
  await page.locator('#backup-import').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.locator('#resumeBtn')).toBeVisible();
  await expect(page.locator('#backup-message')).toContainText('読み込みました');
});

test('おかしいバックアップファイルは、理由を表示して読み込まない', async ({ page }) => {
  await page.goto('/');
  await openMenuOnCover(page);
  await page.getByText('記録のバックアップ').click();
  await page.locator('#backup-import').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"other"}') });
  await expect(page.locator('#backup-message')).toContainText('このアプリのバックアップではありません');
});

test('起動できないときは「なおす」ボタンが出て、押すと起動できる（記録と、ほかのアプリのキャッシュは消えない）', async ({ page }) => {
  await page.addInitScript((id) => {
    (window as unknown as { __bootWaitMs: number }).__bootWaitMs = 500;
    // 1回目の自動修復は済んだことにして、ボタンが出る側の動きを確かめる
    sessionStorage.setItem(`${id}:repaired-at`, String(Date.now()));
    if (!localStorage.getItem(`${id}-bookmark`)) {
      localStorage.setItem(`${id}-bookmark`, JSON.stringify({ chapter: 0, time: 12, title: '第一章 雨の日の客', savedAt: 1, anchor: 0, page: 1 }));
    }
  }, APP_ID);
  // 同じサイトにある、ほかのアプリのキャッシュ（なおすときに消えてはいけない）を用意する
  await page.goto('/');
  await page.evaluate(async () => {
    await caches.open('other-app-v1');
  });
  // メインのスクリプトが読み込めない状況を作る
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#boot-error')).toBeVisible();

  await page.unroute('**/assets/*.js');
  await page.getByRole('button', { name: 'なおす' }).click();
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#resumeBtn')).toBeVisible(); // しおりが残っている
  await expect(page.locator('#boot-error')).toBeHidden();
  expect(await page.evaluate(() => caches.has('other-app-v1'))).toBe(true);
});

test('デバッグモード: バージョンを 5 回タップで操作パネルが出る', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('#debug-panel');
  await expect(panel).toBeHidden();
  await openMenuOnCover(page);
  for (let i = 0; i < 5; i++) await page.locator('#version-line').click();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: '最終章の扉へ飛ぶ' }).click();
  await expect(page.locator('#gateNum')).toHaveText('第七章');
  await page.getByRole('button', { name: 'デバッグモードを終える' }).click();
  await expect(panel).toBeHidden();
});
