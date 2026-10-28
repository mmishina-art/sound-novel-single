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

/** 表紙からメニュー（入口は「メニュー」ボタン1つだけ）を開く */
async function openMenuOnCover(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#coverMenuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
}

/** 読書画面から表紙へ戻る（画面上のボタンはなく、メニューの「表紙に戻る」から） */
async function backToCover(page: import('@playwright/test').Page): Promise<void> {
  await openMenuInReader(page);
  await page.locator('#toCoverFromMenuBtn').click();
  await expect(page.locator('#coverView')).toBeVisible();
}

test('表紙が開き、タイトルと著者が見える', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#coverView')).toBeVisible();
  await expect(page.locator('.cover-vtitle')).toContainText('空の郵便が');
  await expect(page).toHaveTitle(/空の郵便が届くまで/);
});

test('表紙の常時表示は表紙と入口だけ。ヒント文は初回だけで、読み始めると出なくなる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#coverHint')).toBeVisible(); // 初回だけの案内
  await expect(page.locator('#coverMenuBtn')).toBeVisible(); // 入口は1つ
  await expect(page.locator('#resumeBtn')).toBeHidden(); // しおりはまだない
  await expect(page.locator('#coverBookmarkNote')).toHaveCount(0); // しおりの案内行は置かない（廃止）
  await expect(page.locator('#coverTocBtn')).toHaveCount(0); // 表紙に目次ボタンは置かない（メニューに一本化）
  // 読み始めて表紙に戻ると、ヒントは消え、再開ボタンだけが出る
  await page.locator('#coverTap').click();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await backToCover(page);
  await expect(page.locator('#coverHint')).toBeHidden();
  await expect(page.locator('#resumeBtn')).toBeVisible();
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

test('章扉では語り手名が「語り・」なしで、タイトルと同じ列に続けて表示される', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page.locator('#coverTap').click();
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNarrator')).toHaveText('柏木 遥'); // 「語り・柏木 遥」ではない
  // 縦書きでは「同じ列」＝ x の帯が重なり、「続く」＝ 題より下（y が大きい）に名前がある
  const titleBox = await page.locator('#gateTitle').boundingBox();
  const nameBox = await page.locator('#gateNarrator').boundingBox();
  if (!titleBox || !nameBox) throw new Error('bounding box not found');
  const titleCx = titleBox.x + titleBox.width / 2;
  expect(titleCx).toBeGreaterThanOrEqual(nameBox.x - 2);
  expect(titleCx).toBeLessThanOrEqual(nameBox.x + nameBox.width + 2);
  expect(nameBox.y).toBeGreaterThan(titleBox.y + titleBox.height - 2);
});

test('章扉の要素（章番号・題・語り手）は、かたまりとしてページの中央に置かれる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  const expectCentered = async (): Promise<void> => {
    const sheet = await page.locator('.gate-sheet').boundingBox();
    const text = await page.locator('.gate-text').boundingBox();
    if (!sheet || !text) throw new Error('bounding box not found');
    const sheetCx = sheet.x + sheet.width / 2;
    const textCx = text.x + text.width / 2;
    expect(Math.abs(textCx - sheetCx)).toBeLessThanOrEqual(4);
  };
  // 短い題（第一章）
  await page.locator('#coverTap').click();
  await expect(page.locator('#gateView')).toBeVisible();
  await expectCentered();
  // 長い題（第七章）：目次ページから開く
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await page.locator('.toc-item').nth(6).click();
  await expect(page.locator('#gateNum')).toHaveText('第七章');
  await expectCentered();
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

test('ページめくりで章をまたぐときも、必ず章扉に止まる（行きも帰りも）', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  // 第一章の最後のページまでめくり、もう1回めくると第二章の扉に止まるはず
  for (let i = 0; i < 20 && (await page.locator('#gateView').isHidden()); i++) {
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.waitForTimeout(120);
  }
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第二章');
  await page.locator('#gateView').click(); // 扉タップで本文へ
  await expect(page.locator('#readerChapterLabel')).toHaveText(/第二章/);
  // 第二章の先頭ページで前へめくると、第一章の扉に止まるはず
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
});

test('章扉の枠と本文ページの枠の大きさ・位置が一致する', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page.locator('#coverTap').click();
  await expect(page.locator('#gateView')).toBeVisible();
  const gate = await page.locator('.gate-sheet').boundingBox();
  await page.locator('#gateView').click();
  await expect(page.locator('#readerView')).toBeVisible();
  const paper = await page.locator('#pageEl').boundingBox();
  if (!gate || !paper) throw new Error('bounding box not found');
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(gate[k] - paper[k])).toBeLessThanOrEqual(2);
  }
});

test('目次はモーダルではなく本の目次ページとして開き、章を選べる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#tocModal')).toHaveCount(0); // モーダルは廃止
  // 表紙のメニュー「目次を開く」から目次ページへ（入口はメニューに一本化）
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await expect(page.locator('.toc-item')).toHaveCount(7);
  await page.locator('.toc-item').nth(2).click();
  await expect(page.locator('#gateNum')).toHaveText('第三章');
});

test('読書中のメニューから目次ページを開き、「戻る」で読書画面に帰る', async ({ page }) => {
  await openReader(page);
  await openMenuInReader(page);
  await page.locator('#tocFromMenuBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await page.locator('#tocBackBtn').click();
  await expect(page.locator('#readerView')).toBeVisible();
  await expect(page.locator('#tocView')).toBeHidden();
});

test('読書画面の操作は再生／停止とメニューだけ。前章／次章・シークバー・表紙ボタンは画面にない', async ({ page }) => {
  await openReader(page);
  // 画面から外した要素は、DOM にも残っていない
  await expect(page.locator('#prevChapterBtn')).toHaveCount(0);
  await expect(page.locator('#nextChapterBtn')).toHaveCount(0);
  await expect(page.locator('#progressBar')).toHaveCount(0);
  await expect(page.locator('#toCoverBtn')).toHaveCount(0);
  // 残した操作：操作UIを出すと、再生／停止とメニューが使える
  await ensureChrome(page);
  await expect(page.locator('#playPauseBtn')).toBeVisible();
  await expect(page.locator('#menuBtn')).toBeVisible();
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
  // 「表紙に戻る」は、表紙で開いたメニューには出ず、読書画面のメニューにだけ出る
  await page.locator('#menuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
  await expect(page.locator('#toCoverFromMenuBtn')).toBeVisible();
  await page.locator('#menuCloseBtn').click();
});

test('表紙で開いたメニューには「表紙に戻る」が出ない', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await openMenuOnCover(page);
  await expect(page.locator('#toCoverFromMenuBtn')).toBeHidden();
});

test('音声をシークすると本文ページが朗読位置に追従する（シークバー撤去後も）', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  await page.evaluate(async () => {
    const a = document.getElementById('audioEl') as HTMLAudioElement;
    // メタデータ（duration）が届くまで待ってからシークする
    for (let i = 0; i < 50 && !(isFinite(a.duration) && a.duration > 0); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isFinite(a.duration) && a.duration > 0) a.currentTime = a.duration * 0.5;
  });
  // seeked でページが中ほどまで進む
  await expect(page.locator('#pageFolio')).not.toHaveText('― 1 ―', { timeout: 5000 });
});

test('しおりが残り、表紙から再開できる', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await backToCover(page);
  // 表紙の常時表示は入口と再開ボタンだけ。しおりの案内行は置かない
  await expect(page.locator('#coverBookmarkNote')).toHaveCount(0);
  const bm = await page.evaluate((id) => localStorage.getItem(`${id}-bookmark`), APP_ID);
  expect(JSON.parse(bm as string)).toMatchObject({ chapter: 0, page: 2 });
  // 再開は表紙のボタンから（メニューの中には入れない）
  await expect(page.locator('#resumeBtn')).toBeVisible();
  await expect(page.locator('#resumeBtn')).toContainText('第一章');
  await page.locator('#resumeBtn').click();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
});

test('しおりがないときは表紙に再開ボタンが出ず、メニューにも再開の項目はない', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#resumeBtn')).toBeHidden();
  await openMenuOnCover(page);
  await expect(page.locator('#resumeFromMenuBtn')).toHaveCount(0);
  await expect(page.locator('#menuModal #version-line')).toHaveCount(0); // バージョン表記はメニューではなく表紙にある
});

test('本文の最終ページには改列・中央の「おわり」があり、その次に独立した奥付ページが来る', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  // 目次ページから最終章（第七章）へ（入口は表紙のメニュー）
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await page.locator('.toc-item').nth(6).click();
  await expect(page.locator('#gateNum')).toHaveText('第七章');
  await page.locator('#gateView').click();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  // 最終ページまで送る
  for (let i = 0; i < 80; i++) {
    const pos = await page.locator('#pageChapterPos').textContent();
    const m = /(\d+) \/ (\d+)/.exec(pos || '');
    if (m && m[1] === m[2]) break;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.waitForTimeout(50);
  }
  // 「おわり」は本文の最終ページの中に、最後の文とは別の列（左隣の列）で、列の中央に置かれる
  const endMark = page.locator('#pageContent .story-end');
  await expect(endMark).toHaveText('おわり');
  await expect(page.locator('#endPage')).toBeHidden(); // 奥付ページはまだ先
  const units = page.locator('#pageContent .unit');
  const lastUnitBox = await units.nth((await units.count()) - 1).boundingBox();
  const markBox = await endMark.boundingBox();
  const contentBox = await page.locator('#pageContent').boundingBox();
  if (!lastUnitBox || !markBox || !contentBox) throw new Error('bounding box not found');
  expect(markBox.x).toBeLessThan(lastUnitBox.x); // 縦書きで別の列＝左隣に改列している
  const markCy = markBox.y + markBox.height / 2;
  const contentCy = contentBox.y + contentBox.height / 2;
  expect(Math.abs(markCy - contentCy)).toBeLessThanOrEqual(90); // 列の中央付近
  // もう1つ送ると、独立した奥付ページ（ノンブルなし・奥付と表紙への導線）が開く
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#endPage')).toBeVisible();
  await expect(page.locator('.end-colophon')).toContainText('水瀬 葵');
  await expect(page.locator('.end-colophon')).toContainText('サウンド単行本');
  await expect(page.locator('.end-colophon')).toContainText('Lily');
  // 奥付は枠の中に完全に収まる（はみ出し・見切れがない）
  const endBox = await page.locator('#endPage').boundingBox();
  const colophonBox = await page.locator('.end-colophon').boundingBox();
  if (!endBox || !colophonBox) throw new Error('bounding box not found');
  expect(colophonBox.y).toBeGreaterThanOrEqual(endBox.y);
  expect(colophonBox.y + colophonBox.height).toBeLessThanOrEqual(endBox.y + endBox.height + 1);
  // 前へ戻ると本文の最終ページへ帰り、そこから表紙へも行ける
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect(page.locator('#endPage')).toBeHidden();
  await expect(endMark).toBeVisible();
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#endPage')).toBeVisible();
  await page.locator('#finalToCoverBtn').click();
  await expect(page.locator('#coverView')).toBeVisible();
});

test('再生中にページをめくると、朗読がそのページの先頭へ移り、引き戻されない', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  await page.mouse.click(78, 400); // 次ページへ
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await page.waitForTimeout(700); // ページ→音声シーク（260msデバウンス＋反映）
  const t = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime);
  expect(t).toBeGreaterThan(2); // 2ページ目の先頭は冒頭より後
  await page.waitForTimeout(1500);
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―'); // 音声側に引き戻されない
});

test('停止中にめくると位置がそのページに合い、再生はそこから始まる', async ({ page }) => {
  await openReader(page);
  await ensureChrome(page);
  await page.locator('#playPauseBtn').click(); // 停止
  await page.mouse.click(78, 400); // 次ページへ
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await page.waitForTimeout(700);
  const t1 = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime);
  expect(t1).toBeGreaterThan(2); // 停止中でも位置はページに合っている
  await ensureChrome(page);
  await page.locator('#playPauseBtn').click(); // 再生
  await page.waitForTimeout(600);
  const t2 = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime);
  expect(t2).toBeGreaterThan(2); // 冒頭に戻らず、そのページから読む
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
});

test('朗読中の文が1つだけ強調される', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('.unit.now')).toHaveCount(1, { timeout: 8000 });
});

test('表示方式をカラオケ方式に切り替えると、まだ読まれていない文が見えなくなり、文単位で送れる', async ({ page }) => {
  await openReader(page);
  // 止めてから確かめる（再生の進行で frontier が動くと数が定まらないため）
  await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).pause());
  await expect(page.locator('.unit.k-hide')).toHaveCount(0); // ページ形式では隠さない
  await openMenuInReader(page);
  const btn = page.locator('#displayModeBtn');
  await expect(btn).toHaveText('ページ形式');
  await btn.click();
  await expect(btn).toHaveText('カラオケ方式');
  await page.locator('#menuCloseBtn').click();
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
  // まだ読まれていない文は見えない（.k-hide が付く）。読んでいる文は見えて強調される
  const hiddenBefore = await page.locator('.unit.k-hide').count();
  expect(hiddenBefore).toBeGreaterThan(0);
  await expect(page.locator('.unit.now')).toHaveCount(1);
  await expect(page.locator('.unit.now')).not.toHaveClass(/k-hide/);
  const nowIndex = (): Promise<number> =>
    page.evaluate(() => [...document.querySelectorAll('#pageContent .unit')].findIndex((e) => e.classList.contains('now')));
  const nowBefore = await nowIndex();
  expect(nowBefore).toBeGreaterThanOrEqual(0);
  const tBefore = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime);
  // 次側タップで1文送る：強調が次の文へ移り、隠れている文が1つ減り、音声もその文へ移る
  // （音声シークは260msデバウンスのあと。固定待ちではなく条件で待つ）
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect.poll(nowIndex, { timeout: 8000 }).toBe(nowBefore + 1);
  expect(await page.locator('.unit.k-hide').count()).toBe(hiddenBefore - 1);
  const tAfter = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime);
  expect(tAfter).toBeGreaterThan(tBefore);
  // 前側タップで1文戻る：強調が戻り、隠れている文が1つ増える
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect.poll(nowIndex, { timeout: 8000 }).toBe(nowBefore);
  expect(await page.locator('.unit.k-hide').count()).toBe(hiddenBefore);
  // ページ形式へ戻すと、隠れている文はなくなり、読んでいる章は失われない
  await openMenuInReader(page);
  await page.locator('#displayModeBtn').click();
  await expect(page.locator('#displayModeBtn')).toHaveText('ページ形式');
  await page.locator('#menuCloseBtn').click();
  await expect(page.locator('.unit.k-hide')).toHaveCount(0);
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
});

test('カラオケ方式で連打して送っても、手動ステップが音声位置に上書きされず進み続ける', async ({ page }) => {
  await openReader(page);
  await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).pause());
  await openMenuInReader(page);
  await page.locator('#displayModeBtn').click();
  await expect(page.locator('#displayModeBtn')).toHaveText('カラオケ方式');
  await page.locator('#menuCloseBtn').click();
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  const t0 = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime);
  // 間隔を空けずに6回送る（シークのデバウンスが切れる前に押し続ける）
  for (let i = 0; i < 6; i++) {
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.waitForTimeout(60);
  }
  // 6文ぶん先の位置へ音声が移っている（止めたままなので、自然な進行では増えない）
  await expect
    .poll(() => page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime), { timeout: 8000 })
    .toBeGreaterThan(t0 + 8);
  await expect(page.locator('.unit.now')).toHaveCount(1);
});

test('ページを戻っていくと、第一章の扉→目次→表紙まで辿り着ける', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  // 第一章の先頭ページで前へめくる → 第一章の扉（前へ辿るモード：自動では本文へ進まない）
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  await page.waitForTimeout(2200); // 通常の扉の自動送り（1.8秒）を過ぎても、扉に留まる
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#readerView')).toBeHidden();
  const gateBox = await page.locator('#gateView').boundingBox();
  if (!gateBox) throw new Error('gateView not found');
  // 扉で前へめくる → 目次ページ
  await page.mouse.click(gateBox.x + gateBox.width * 0.8, gateBox.y + gateBox.height * 0.5);
  await expect(page.locator('#tocView')).toBeVisible();
  // 目次の「戻る」は扉へ帰る
  await page.locator('#tocBackBtn').click();
  await expect(page.locator('#gateView')).toBeVisible();
  // 再び前へ：扉 → 目次 →（目次で前へ）→ 表紙
  await page.mouse.click(gateBox.x + gateBox.width * 0.8, gateBox.y + gateBox.height * 0.5);
  await expect(page.locator('#tocView')).toBeVisible();
  const tocBox = await page.locator('#tocView').boundingBox();
  if (!tocBox) throw new Error('tocView not found');
  await page.mouse.click(tocBox.x + tocBox.width * 0.85, tocBox.y + tocBox.height * 0.1);
  await expect(page.locator('#coverView')).toBeVisible();
});

test('前へ辿る連鎖の目次から、次側タップで扉→本文へ進める', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5); // → 扉（前へ辿るモード）
  await expect(page.locator('#gateView')).toBeVisible();
  const gateBox = await page.locator('#gateView').boundingBox();
  if (!gateBox) throw new Error('gateView not found');
  await page.mouse.click(gateBox.x + gateBox.width * 0.8, gateBox.y + gateBox.height * 0.5); // → 目次
  await expect(page.locator('#tocView')).toBeVisible();
  const tocBox = await page.locator('#tocView').boundingBox();
  if (!tocBox) throw new Error('tocView not found');
  // 目次で次側タップ → 第一章の扉（通常モード）→ 自動で本文へ
  await page.mouse.click(tocBox.x + tocBox.width * 0.15, tocBox.y + tocBox.height * 0.1);
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#readerChapterLabel')).toHaveText(/第一章/);
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
  // 本を開いた直後は操作UIは出ていない（出すのは中央タップだけ）
  await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/);
  await page.mouse.click(cx, cy); // 消えている → 出る
  await expect(page.locator('#readerView')).toHaveClass(/chrome-on/);
  await expect(page.locator('#playPauseBtn')).toBeVisible();
  await page.mouse.click(cx, cy); // 表示中 → 消える
  await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/);
  await expect(page.locator('#playPauseBtn')).toBeHidden();
  await page.mouse.click(cx, cy); // また出す
  await expect(page.locator('#readerView')).toHaveClass(/chrome-on/);
  // 数秒で自動的に消える
  await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/, { timeout: 8000 });
});

test('本を開いた直後は、操作UIもメニューも勝手に出ない', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#menuModal')).toBeHidden(); // 起動直後
  await page.locator('#coverTap').click();
  await page.locator('#gateView').click(); // 扉を即タップして本文へ（実機の速い操作を再現）
  await expect(page.locator('#readerView')).toBeVisible();
  await expect(page.locator('#pageFolio')).not.toHaveText('');
  // 開いた直後は本文だけ。少し待っても、勝手に出てこない
  await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/);
  await expect(page.locator('#menuModal')).toBeHidden();
  await page.waitForTimeout(1200);
  await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/);
  await expect(page.locator('#menuModal')).toBeHidden();
  // メニューは、入口を明示的に押したときだけ開く
  await openMenuInReader(page);
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
  await expect(page.locator('#resumeBtn')).toBeVisible(); // しおりが残っている（再開ボタンが出る）
  await expect(page.locator('#boot-error')).toBeHidden();
  expect(await page.evaluate(() => caches.has('other-app-v1'))).toBe(true);
});

test('デバッグモード: 表紙のバージョン表記を 5 回タップで操作パネルが出る', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('#debug-panel');
  await expect(panel).toBeHidden();
  // バージョン表記は表紙画面の下部中央にある（メニューは開かない）
  await expect(page.locator('#version-line')).toBeVisible();
  const verBox = await page.locator('#version-line').boundingBox();
  const viewport = page.viewportSize();
  if (!verBox || !viewport) throw new Error('bounding box / viewport not found');
  const verCx = verBox.x + verBox.width / 2;
  expect(Math.abs(verCx - viewport.width / 2)).toBeLessThanOrEqual(3); // 画面中央
  for (let i = 0; i < 5; i++) await page.locator('#version-line').click();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: '最終章の扉へ飛ぶ' }).click();
  await expect(page.locator('#gateNum')).toHaveText('第七章');
  await page.getByRole('button', { name: 'デバッグモードを終える' }).click();
  await expect(panel).toBeHidden();
});

/* 背景アニメーションは「視覚効果を減らす」設定では層自体を出さない作りなので、
   この一連のテストだけ reducedMotion を解除して、表示の切り替えまで確かめる */
test.describe('背景アニメーション・ノンブル・バックグラウンド再生', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('背景アニメーションの層が章ごとに切り替わる', async ({ page }) => {
    await openReader(page);
    const anim = page.locator('#pageAnim');
    await expect(anim).toHaveAttribute('data-chapter', '1');
    await expect(anim.locator('.anim-rain')).toHaveCount(7); // 第一章は雨（v1.2.1で静か側に半減）
    await openMenuInReader(page);
    await page.locator('#tocFromMenuBtn').click();
    await page.locator('.toc-item').nth(1).click();
    await expect(page.locator('#gateNum')).toHaveText('第二章');
    await page.locator('#gateView').click();
    await expect(page.locator('#readerChapterLabel')).toHaveText(/第二章/);
    await expect(anim).toHaveAttribute('data-chapter', '2');
    await expect(anim.locator('.anim-rain')).toHaveCount(4); // 第二章は雨上がりでさらにまばら
    await expect(anim.locator('.anim-glint')).toHaveCount(2);
  });

  test('背景をオフにするとアニメーションの層も消える', async ({ page }) => {
    await openReader(page);
    await expect(page.locator('#pageAnim')).toBeVisible();
    await openMenuInReader(page);
    await page.locator('#bgToggle').click();
    await expect(page.locator('body')).toHaveClass(/bg-off/);
    await expect(page.locator('#pageAnim')).toBeHidden();
    await page.locator('#bgToggle').click();
    await expect(page.locator('#pageAnim')).toBeVisible();
  });

  test('ノンブル（ページ数）は操作UIが消えていても常時表示される', async ({ page }) => {
    await openReader(page);
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5); // 中央タップで操作UIを消す
    await expect(page.locator('#readerView')).not.toHaveClass(/chrome-on/);
    await expect(page.locator('#pageFolio')).toBeVisible();
    await expect(page.locator('#pageFolio')).toHaveText(/― \d+ ―/);
    await expect(page.locator('#pageFolio')).toHaveCSS('opacity', '1');
    // 章内位置は操作の目安なので、操作表示中だけ出す
    await expect(page.locator('#pageChapterPos')).toHaveCSS('opacity', '0');
  });

  test('Media Session に章・著者・本の題と表紙画像が載る', async ({ page }) => {
    await openReader(page);
    const meta = await page.evaluate(() => {
      const m = navigator.mediaSession?.metadata;
      return m ? { title: m.title, artist: m.artist, album: m.album, artwork: m.artwork?.length ?? 0 } : null;
    });
    expect(meta).not.toBeNull();
    expect(meta?.title).toContain('第一章');
    expect(meta?.title).toContain('雨の日の客');
    expect(meta?.artist).toBe('水瀬 葵');
    expect(meta?.album).toBe('空の郵便が届くまで');
    expect(meta?.artwork).toBeGreaterThan(0);
  });

  test('バックグラウンド再生: 既定オンでは隠れても止めず、オフでは一時停止して戻ると再開する', async ({ page }) => {
    await openReader(page);
    // 音声の再生状態は端末・コーデックで変わるので、要素の play/pause を観察用の物に差し替えて確かめる
    await page.evaluate(() => {
      const a = document.getElementById('audioEl') as HTMLAudioElement;
      const state = { paused: false, calls: [] as string[] };
      (window as unknown as { __bgTest: typeof state }).__bgTest = state;
      a.pause = () => {
        state.calls.push('pause');
        state.paused = true;
        a.dispatchEvent(new Event('pause'));
      };
      a.play = () => {
        state.calls.push('play');
        state.paused = false;
        a.dispatchEvent(new Event('play'));
        return Promise.resolve();
      };
      Object.defineProperty(a, 'paused', { configurable: true, get: () => state.paused });
    });
    const calls = (): Promise<string[]> =>
      page.evaluate(() => (window as unknown as { __bgTest: { calls: string[] } }).__bgTest.calls);
    const setHidden = (hidden: boolean): Promise<void> =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);

    // 既定はオン: 隠れても止めない
    await setHidden(true);
    expect(await calls()).not.toContain('pause');
    await setHidden(false);

    // オフに切り替える（切り替えは即座に効く）
    await openMenuInReader(page);
    await expect(page.locator('#bgPlayToggle')).toBeChecked();
    await page.locator('#bgPlayToggle').click();
    await expect(page.locator('#bgPlayToggle')).not.toBeChecked();
    await page.locator('#menuCloseBtn').click();

    await setHidden(true);
    expect(await calls()).toContain('pause'); // バックグラウンドで一時停止
    await setHidden(false);
    expect((await calls()).at(-1)).toBe('play'); // 戻ったら再開
  });
});

test('進み具合ラインは縦書き（右綴じ）では右から左へ伸びる', async ({ page }) => {
  await openReader(page);
  const track = await page.locator('.read-progress').boundingBox();
  const fill = await page.locator('#readProgressFill').boundingBox();
  if (!track || !fill) throw new Error('bounding box not found');
  expect(fill.width).toBeGreaterThan(0);
  expect(fill.width).toBeLessThan(track.width); // まだ途中なので満ちていない
  // 右端がそろい、左へ伸びる（右端一致・左端は内側）
  expect(Math.abs(fill.x + fill.width - (track.x + track.width))).toBeLessThanOrEqual(1);
  expect(fill.x).toBeGreaterThan(track.x);
});

/* 安全領域のある端末（iPhone Air 相当：420×912、Dynamic Island 上59px／ホームインジケータ下34px）では、
   本の枠の角も進捗ラインも、安全領域の内側に収まって見切れないことを確かめる */
test.describe('安全領域のある画面（iPhone Air 相当）', () => {
  test.use({ viewport: { width: 420, height: 912 } });

  async function applySafeAreaInsets(page: import('@playwright/test').Page): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 59, left: 0, bottom: 34, right: 0 },
    });
  }

  test('本文ページと章扉の枠が安全領域の内側に収まり、角が見切れない', async ({ page }) => {
    await applySafeAreaInsets(page);
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await page.locator('#coverTap').click();
    await expect(page.locator('#gateView')).toBeVisible();
    const gate = await page.locator('.gate-sheet').boundingBox();
    if (!gate) throw new Error('gate box not found');
    expect(gate.y).toBeGreaterThanOrEqual(59);
    expect(gate.y + gate.height).toBeLessThanOrEqual(912 - 34);
    await page.locator('#gateView').click();
    await expect(page.locator('#readerView')).toBeVisible();
    await expect(page.locator('#pageFolio')).not.toHaveText('');
    const paper = await page.locator('#pageEl').boundingBox();
    if (!paper) throw new Error('paper box not found');
    expect(paper.y).toBeGreaterThanOrEqual(59);
    expect(paper.y + paper.height).toBeLessThanOrEqual(912 - 34);
    expect(paper.x).toBeGreaterThan(0);
    expect(paper.x + paper.width).toBeLessThan(420);
    // 扉と本文の枠は同じ位置・大きさのまま
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(gate[k] - paper[k])).toBeLessThanOrEqual(2);
    }
  });

  test('進み具合ラインが画面最下部に張り付かず、安全領域の内側にある', async ({ page }) => {
    await applySafeAreaInsets(page);
    await openReader(page);
    const line = await page.locator('.read-progress').boundingBox();
    if (!line) throw new Error('progress box not found');
    expect(line.y + line.height).toBeLessThanOrEqual(912 - 34); // ホームインジケータ帯より上
    expect(line.y + line.height).toBeLessThan(912); // 画面端に張り付いていない
  });
});

test('ページ送りを連打しても AudioContext.resume を連打しない（実機の音声ノイズ対策）', async ({ page }) => {
  // resume の呼び出しを、アプリのスクリプトより先に数えられるようにしておく
  await page.addInitScript(() => {
    const state = { resumeCalls: 0 };
    (window as unknown as { __resumeProbe: typeof state }).__resumeProbe = state;
    const orig = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function (...args: Parameters<AudioContext['resume']>): ReturnType<AudioContext['resume']> {
      state.resumeCalls += 1;
      return orig.apply(this, args);
    };
  });
  const resumeCalls = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __resumeProbe: { resumeCalls: number } }).__resumeProbe.resumeCalls);

  await openReader(page);
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on'); // BGM が鳴っている状態で
  const before = await resumeCalls();
  const folioBefore = await page.locator('#pageFolio').textContent();
  // 次ページ側を高速で連打する（章内に収まる回数）
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  for (let i = 0; i < 6; i++) {
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.waitForTimeout(50);
  }
  // ページは軽快に進み（応答性は落とさない）、resume は増えていない
  await expect(page.locator('#pageFolio')).not.toHaveText(folioBefore as string);
  expect(await resumeCalls()).toBe(before);
});

test('画面を暗くしない: 読書画面では Wake Lock を取り、表紙では解放する。設定でオフにもできる', async ({ page }) => {
  // Screen Wake Lock API の物まねを、アプリのスクリプトより先に差し込む
  await page.addInitScript(() => {
    const state = { held: false };
    (window as unknown as { __wl: typeof state }).__wl = state;
    const makeSentinel = (): object => {
      const listeners = new Set<() => void>();
      return {
        get released() {
          return !state.held;
        },
        release: async () => {
          if (!state.held) return;
          state.held = false;
          listeners.forEach((f) => f());
        },
        addEventListener: (_t: string, f: () => void) => listeners.add(f),
        removeEventListener: (_t: string, f: () => void) => listeners.delete(f),
      };
    };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          state.held = true;
          return makeSentinel();
        },
      },
    });
  });
  const wlHeld = (): Promise<boolean> => page.evaluate(() => (window as unknown as { __wl: { held: boolean } }).__wl.held);
  const wlState = (): Promise<string | undefined> => page.evaluate(() => document.body.dataset.wakelock);

  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  expect(await wlHeld()).toBe(false); // 表紙では取らない
  expect(await wlState()).toBe('off');

  await page.locator('#coverTap').click();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#pageFolio')).not.toHaveText('');
  await expect.poll(wlHeld).toBe(true); // 読書画面では取得する
  await expect.poll(wlState).toBe('on');

  // 表紙に戻ると解放する
  await backToCover(page);
  await expect.poll(wlHeld).toBe(false);
  await expect.poll(wlState).toBe('off');

  // 設定でオフにすると、読書画面でも取らない
  await openMenuOnCover(page);
  await expect(page.locator('#wakeLockToggle')).toBeChecked(); // 既定はオン
  await page.locator('#wakeLockToggle').click();
  await expect(page.locator('#wakeLockToggle')).not.toBeChecked();
  await page.locator('#menuCloseBtn').click();
  await page.locator('#coverTap').click();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(600);
  expect(await wlHeld()).toBe(false);
  expect(await wlState()).toBe('off');
});
