import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// アプリの ID（package.json の name）。保存データのキーの接頭辞になる
const APP_ID = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }).name;

/** 表紙のモードボタンから入り、初めて読むときの目次（v1.12.4〜）で目的の章を
    選んで扉まで進む。しおりがある場合は目次を経由しないので、そのケースでは
    使わない（再開はモードボタンを直接押す） */
async function enterViaToc(
  page: import('@playwright/test').Page,
  btn: '#earModeBtn' | '#eyeModeBtn',
  idx = 0,
): Promise<void> {
  await page.locator(btn).click();
  await expect(page.locator('#tocView')).toBeVisible();
  await clickTocChapter(page, idx);
  await expect(page.locator('#gateView')).toBeVisible();
}

/** 表紙 → 目次 → 章扉（自動で進む）→ 本文まで開く。
    扉のタップは半分判定に統一されたので（v1.11.1〜）、各テストの扉クリックは
    次側（左寄り）を位置指定で押す */
async function openReader(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' }); // 本のデータが届いてから
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#pageFolio')).not.toHaveText('');
}

/** 読書画面からメニューを開く（入口はページ下の帯の「メニュー」ボタンだけ。
    本文タップでは開かない。ボタンは常時表示されている） */
async function openMenuInReader(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#menuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
}

/** 表紙からメニュー（入口は「メニュー」ボタン1つだけ）を開く */
async function openMenuOnCover(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#coverMenuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
}

/** 目次ページで目的の章を選ぶ。目次が複数ページに分かれている場合は、
    目的の章が出るまで次側タップで目次ページを送る */
async function clickTocChapter(page: import('@playwright/test').Page, idx: number): Promise<void> {
  const item = page.locator(`#tocList .toc-item[data-idx="${idx}"]`);
  const tocBox = await page.locator('#tocView').boundingBox();
  if (!tocBox) throw new Error('tocView not found');
  for (let i = 0; i < 6 && (await item.count()) === 0; i++) {
    await page.mouse.click(tocBox.x + tocBox.width * 0.15, tocBox.y + tocBox.height * 0.08);
    await page.waitForTimeout(200);
  }
  await item.click();
}

/** 読書画面から表紙へ戻る（画面上のボタンはなく、メニューの「表紙に戻る」から） */
async function backToCover(page: import('@playwright/test').Page): Promise<void> {
  await openMenuInReader(page);
  await page.locator('#toCoverFromMenuBtn').click();
  await expect(page.locator('#coverView')).toBeVisible();
}

/* 既存のテストは「2回目以降の訪問」として扱う：初回だけ出るダウンロード案内
   （v1.13.0〜）は見たことにしておく。案内そのもののテストは末尾の describe で、
   このプリセットを打ち消して初回として開く */
test.beforeEach(async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem(`${id}-dl-notice-seen`, JSON.stringify(true));
  }, APP_ID);
});

test('表紙が開き、タイトルと著者が見える', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#coverView')).toBeVisible();
  await expect(page.locator('.cover-vtitle')).toContainText('空の郵便が');
  await expect(page.locator('.cover-author')).toContainText('水瀬');
  await expect(page).toHaveTitle(/空の郵便が届くまで/);
});

test('表紙は新装丁：地絵の上に題字・著者名・線画ロゴを後付けし、刷り込み文字は置かない', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#coverView')).toBeVisible();
  // 地絵は生成イラスト（cover-art.webp）。旧装丁のベタ塗り cover.svg は使わない
  await expect(page.locator('.cover-img')).toHaveAttribute('src', /cover-art\.webp/);
  // 刷り込み文字「サウンド単行本」は廃止（印と重なるため）
  await expect(page.locator('.cover-colophon')).toHaveCount(0);
  // ロゴは公式の線画（藍）を小口側の上に後付け表示する
  const logo = page.locator('.cover-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', /logo-line-indigo\.svg/);
  // 位置と大きさを表紙ボックスに対する割合で固定する（決定モックの実測値）
  const geo = await page.evaluate(() => {
    const box = document.querySelector('.book-cover')!.getBoundingClientRect();
    const r = (sel: string) => {
      const b = document.querySelector(sel)!.getBoundingClientRect();
      return {
        top: (b.top - box.top) / box.height,
        left: (b.left - box.left) / box.width,
        right: (box.right - b.right) / box.width,
        bottom: (box.bottom - b.bottom) / box.height,
        width: b.width / box.width,
        centerX: (b.left + b.right) / 2 - box.left,
      };
    };
    const cover = { w: box.width, h: box.height };
    return { cover, logo: r('.cover-logo'), title: r('.cover-vtitle'), author: r('.cover-author') };
  });
  // ロゴ：左端 約5.8%・上端 約4.3%・幅 約7.1%（余白はロゴ幅の1/8以上）
  expect(geo.logo.left).toBeGreaterThan(0.045);
  expect(geo.logo.left).toBeLessThan(0.07);
  expect(geo.logo.top).toBeGreaterThan(0.03);
  expect(geo.logo.top).toBeLessThan(0.055);
  expect(geo.logo.width).toBeGreaterThan(0.06);
  expect(geo.logo.width).toBeLessThan(0.085);
  // 題字：上 12%・右余白 14%（要素ボックスの指定値。実描画は行間ぶん内側）
  expect(geo.title.top).toBeGreaterThan(0.10);
  expect(geo.title.top).toBeLessThan(0.14);
  expect(geo.title.right).toBeGreaterThan(0.03);
  expect(geo.title.right).toBeLessThan(0.15);
  // 著者名：中心が表紙幅の約45%（地絵の家に合わせる）、下部に置く
  expect(Math.abs(geo.author.centerX / geo.cover.w - 0.45)).toBeLessThan(0.03);
  expect(geo.author.bottom).toBeGreaterThan(0.02);
  expect(geo.author.bottom).toBeLessThan(0.08);
});

test('表紙の常時表示は表紙と入口だけ。ヒント文は初回だけで、読み始めると出なくなる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#coverHint')).toBeVisible(); // 初回だけの案内
  await expect(page.locator('#coverMenuBtn')).toBeVisible(); // 入口は1つ
  await expect(page.locator('#resumeBtn')).toHaveCount(0); // 「しおりから再開」ボタンは廃止（モードボタンに一本化）
  await expect(page.locator('#earModeSub')).toHaveText('朗読つき'); // 補足文は固定（v1.13.3）
  await expect(page.locator('#eyeModeSub')).toHaveText('朗読なし');
  await expect(page.locator('#coverResume')).toBeHidden(); // しおりがなければ再開の小行は出ない
  await expect(page.locator('#coverBookmarkNote')).toHaveCount(0); // 旧しおり案内行の要素は置かない（廃止のまま）
  await expect(page.locator('#coverTocBtn')).toHaveCount(0); // 表紙に目次ボタンは置かない（メニューに一本化）
  // 読み始めて表紙に戻ると、ヒントは消え、ボタン上の小行に「つづきから」が出る（補足文は固定のまま）
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await backToCover(page);
  await expect(page.locator('#coverHint')).toBeHidden();
  await expect(page.locator('#earModeSub')).toHaveText('朗読つき');
  await expect(page.locator('#eyeModeSub')).toHaveText('朗読なし');
  await expect(page.locator('#coverResume')).toBeVisible();
  await expect(page.locator('#coverResume')).toContainText('つづきから');
});

test('表紙タップでは開かず、「耳で読む」からは目次→章扉と進んで本文へ入る', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  // 表紙の絵をタップしても本は開かない（入り口はモードの2ボタンだけ）
  await page.locator('.cover-tap').click();
  await page.waitForTimeout(600);
  await expect(page.locator('#gateView')).toBeHidden();
  await expect(page.locator('#coverView')).toBeVisible();
  // 初めて読むときは、まず目次ページが開く（v1.12.4）
  await page.locator('#earModeBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await clickTocChapter(page, 0);
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  await expect(page.locator('#gateTitle')).toHaveText('雨の日の客');
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } }); // 扉タップで即本文へ
  await expect(page.locator('#readerView')).toBeVisible();
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
});

test('章扉では語り手名が「語り・」なしで、タイトルと同じ列に続けて表示される', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await enterViaToc(page, '#earModeBtn');
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
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#gateView')).toBeVisible();
  await expectCentered();
  // 長い題（第七章）：目次ページから開く
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await clickTocChapter(page, 6);
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
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } }); // 扉タップで本文へ
  await expect(page.locator('#readerChapterLabel')).toHaveText(/第二章/);
  // 第二章の先頭ページで前へめくると、第一章の扉に止まるはず
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
});

test('章扉の枠と本文ページの枠の大きさ・位置が一致する', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#gateView')).toBeVisible();
  const gate = await page.locator('.gate-sheet').boundingBox();
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
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
  await expect(page.locator('#tocList .toc-item').first()).toBeVisible();
  await clickTocChapter(page, 2);
  await expect(page.locator('#gateNum')).toHaveText('第三章');
});

test('読書中のメニューから目次ページを開き、後方操作で読書画面に帰る', async ({ page }) => {
  await openReader(page);
  await openMenuInReader(page);
  await page.locator('#tocFromMenuBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  // 「戻る」ピルは廃止（v1.12.4）。開いた元への帰りは後方操作に統合されている
  await expect(page.locator('#tocBackBtn')).toHaveCount(0);
  const tocBox = await page.locator('#tocView').boundingBox();
  if (!tocBox) throw new Error('tocView not found');
  // 目次を前へ送り切り、先頭ページでの前へで開いた元（本文）へ帰る
  for (let i = 0; i < 4 && (await page.locator('#readerView').isHidden()); i++) {
    await page.mouse.click(tocBox.x + tocBox.width * 0.85, tocBox.y + tocBox.height * 0.1);
    await page.waitForTimeout(250);
  }
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
  // 残した操作：再生／停止とメニューは、ページ下の帯に常時あって使える
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

test('文送りボタンで朗読位置とハイライトが文単位で移る（耳で読む・本文のみ）', async ({ page }) => {
  await openReader(page);
  const state = () =>
    page.evaluate(() => {
      const a = document.getElementById('audioEl') as HTMLAudioElement;
      const units = [...document.querySelectorAll('#pageContent .unit')];
      return {
        t: a.currentTime,
        paused: a.paused,
        nowIdx: units.findIndex((u) => u.classList.contains('now')),
        folio: document.getElementById('pageFolio')?.textContent || '',
      };
    });
  // 再生中は1文目がハイライトされている。止めて、先頭に戻してから文送りを確かめる
  await expect.poll(async () => (await state()).nowIdx).toBe(0);
  await page.locator('#playPauseBtn').click();
  await expect(page.locator('#playPauseBtn')).toHaveAttribute('aria-label', '再生');
  await page.evaluate(() => {
    (document.getElementById('audioEl') as HTMLAudioElement).currentTime = 0;
  });
  await expect.poll(async () => (await state()).t).toBeLessThan(0.3);
  const s0 = await state();
  expect(s0.paused).toBe(true);
  // 次の文へ：位置が2文目の頭へ移り、ハイライトも2文目へ。停止は保たれる
  await page.locator('#nextSentBtn').click();
  await expect.poll(async () => (await state()).nowIdx).toBe(1);
  const s1 = await state();
  expect(s1.t).toBeGreaterThan(s0.t + 0.5);
  expect(s1.paused).toBe(true);
  expect(s1.folio).toBe(s0.folio); // 2文目は同じページにある
  // もう1つ次へ → 3文目
  await page.locator('#nextSentBtn').click();
  await expect.poll(async () => (await state()).nowIdx).toBe(2);
  // 前の文へ：文の頭にいるので、前の文（2文目）の頭へ戻る
  await page.locator('#prevSentBtn').click();
  await expect.poll(async () => (await state()).nowIdx).toBe(1);
  const s2 = await state();
  expect(Math.abs(s2.t - s1.t)).toBeLessThan(0.6);
  // 文の途中から「前の文へ」は、その文の頭に戻す（一般的な作法）
  await page.evaluate(() => {
    const a = document.getElementById('audioEl') as HTMLAudioElement;
    a.currentTime = a.currentTime + 2.5; // 2文目の途中へ
  });
  await page.waitForTimeout(300);
  await page.locator('#prevSentBtn').click();
  await expect.poll(async () => Math.abs((await state()).t - s1.t)).toBeLessThan(0.6);
  await expect.poll(async () => (await state()).nowIdx).toBe(1);
  // 目で読むでは文送りボタンは出ない
  await backToCover(page);
  await page.locator('#eyeModeBtn').click();
  await expect(page.locator('#gateView')).toBeVisible(); // しおりから再開するので扉が直接出る
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
  await expect(page.locator('#readerView')).toBeVisible();
  await expect(page.locator('#prevSentBtn')).toBeHidden();
  await expect(page.locator('#nextSentBtn')).toBeHidden();
});

test('文送りボタンの並びはメディア標準（左=前の文／中央=再生／右=次の文）', async ({ page }) => {
  await openReader(page);
  // 画面上の実測順序：前の文 < 再生/停止 < 次の文（進むは右）。
  // 本の綴じ方向（右綴じ＝次ページは左）に寄せて反転させないことを座標で固定する
  const boxes = await page.evaluate(() => {
    const box = (id: string) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return { x: r.x, w: r.width };
    };
    return { prev: box('prevSentBtn'), play: box('playPauseBtn'), next: box('nextSentBtn') };
  });
  expect(boxes.prev.w).toBeGreaterThan(0);
  expect(boxes.prev.x).toBeLessThan(boxes.play.x);
  expect(boxes.play.x).toBeLessThan(boxes.next.x);
  // 図柄も並びに一致させる：前の文は棒+左向き三角（|◀）、次の文は右向き三角+棒（▶|）
  const glyphs = await page.evaluate(() => {
    const d = (id: string) =>
      [...document.getElementById(id)!.querySelectorAll('svg path')].map((p) => p.getAttribute('d'));
    return { prev: d('prevSentBtn'), next: d('nextSentBtn') };
  });
  expect(glyphs.prev).toEqual(['M4.5 5.5h2v13h-2z', 'M18.5 5.5v13L8 12z']);
  expect(glyphs.next).toEqual(['M5.5 5.5v13L16 12z', 'M17.5 5.5h2v13h-2z']);
  // 再生の図柄はスピーカー＋波紋（v1.13.1）：右向き三角（▶）は綴じ方向と競合する
  // ため廃止。止めて「再生」表示にしたうえで、本文・扉・目次の3ボタンとも
  // 同じ記号になっていることを確かめる（一時停止の二本線は従来のまま）
  await page.locator('#playPauseBtn').click();
  await expect(page.locator('#playPauseBtn')).toHaveAttribute('aria-label', '再生');
  const speaker = [
    'M4 9.8v4.4c0 .3.2.5.5.5H7l4.5 3.8c.3.3.9.1.9-.3V5.7c0-.4-.6-.6-.9-.3L7 9.3H4.5c-.3 0-.5.2-.5.5z',
    'M15.3 9.4a3.8 3.8 0 0 1 0 5.2',
    'M17.8 6.9a7.2 7.2 0 0 1 0 10.2',
  ];
  const playGlyphs = await page.evaluate(() => {
    const d = (id: string) =>
      [...document.getElementById(id)!.querySelectorAll('svg path')].map((p) => p.getAttribute('d'));
    return { body: d('playPauseBtn'), gate: d('gatePlayBtn'), toc: d('tocPlayBtn') };
  });
  expect(playGlyphs.body).toEqual(speaker);
  expect(playGlyphs.gate).toEqual(speaker);
  expect(playGlyphs.toc).toEqual(speaker);
});

test('しおりが残り、表紙から再開できる', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await backToCover(page);
  // 表紙の常時表示は入口だけ。旧しおり案内行の要素は置かない
  await expect(page.locator('#coverBookmarkNote')).toHaveCount(0);
  const bm = await page.evaluate((id) => localStorage.getItem(`${id}-bookmark`), APP_ID);
  expect(JSON.parse(bm as string)).toMatchObject({ chapter: 0, page: 2 });
  // 再開もモードボタンから（ボタン上の小行が「つづきから（第一章）」を示す。補足文は固定。メニューには入れない）
  await expect(page.locator('#coverResume')).toHaveText('つづきから（第一章）');
  await expect(page.locator('#earModeSub')).toHaveText('朗読つき');
  await page.locator('#earModeBtn').click();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
});

test('しおりがないときは再開の小行が出ず、メニューにも再開の項目はない', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#earModeSub')).toHaveText('朗読つき');
  await expect(page.locator('#coverResume')).toBeHidden();
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
  await clickTocChapter(page, 6);
  await expect(page.locator('#gateNum')).toHaveText('第七章');
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  // 最終ページまで送る（「おわり」の列が出るページが最終ページ）
  for (let i = 0; i < 80; i++) {
    if ((await page.locator('#pageContent .story-end').count()) > 0) break;
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
  await expect(page.locator('.end-colophon')).toContainText('Leda');
  await expect(page.locator('.end-colophon')).toContainText('Charon');
  await expect(page.locator('.end-colophon')).toContainText('Gemini 3.8 Flash');
  // 奥付は枠の中に完全に収まる（はみ出し・見切れがない）
  const endBox = await page.locator('#endPage').boundingBox();
  const colophonBox = await page.locator('.end-colophon').boundingBox();
  if (!endBox || !colophonBox) throw new Error('bounding box not found');
  expect(colophonBox.y).toBeGreaterThanOrEqual(endBox.y);
  expect(colophonBox.y + colophonBox.height).toBeLessThanOrEqual(endBox.y + endBox.height + 1);
  // 版元ロゴ（公式ロゴのパターン2＝アイコン＋文字の縦組み）が奥付文の上に表示される
  const logo = page.locator('.end-logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('alt', 'サウンド単行本');
  await expect(logo).toHaveAttribute('src', /logo-text-vertical\.svg$/);
  expect(await logo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  const logoBox = await logo.boundingBox();
  if (!logoBox) throw new Error('logo box not found');
  expect(logoBox.width).toBe(128); // 文字あり版の寸法（style.css の指定どおり。v1.13.1 で 56px のアイコンのみ版から差し替え）
  expect(logoBox.height).toBeGreaterThan(logoBox.width); // 縦組み（280×356）なので幅より高い
  expect(logoBox.y + logoBox.height).toBeLessThanOrEqual(colophonBox.y); // 奥付文より上にある
  expect(logoBox.y).toBeGreaterThanOrEqual(endBox.y);
  expect(logoBox.y + logoBox.height).toBeLessThanOrEqual(endBox.y + endBox.height);
  // 前へ戻ると本文の最終ページへ帰り、そこから表紙へも行ける
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect(page.locator('#endPage')).toBeHidden();
  await expect(endMark).toBeVisible();
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#endPage')).toBeVisible();
  // 「表紙に戻る」文字リンクは廃止（v1.12.4）。前方向のタップで表紙へ戻る
  await expect(page.locator('#finalToCoverBtn')).toHaveCount(0);
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#coverView')).toBeVisible();
});

test('最終章の朗読が終わっても、最終ページに留まり奥付へ自動で進まない', async ({ page }) => {
  // v1.13.1 の仕様変更（実機フィードバック：読み終わりの余韻を最終ページで
  // 楽しみたい）。以前は朗読終了で自動的に奥付ページへ進んでいた
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await enterViaToc(page, '#earModeBtn', 6); // 最終章（第七章）を耳で読む
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 15000 });
  // 朗読が始まっていることを確認してから、最終章の音声を末尾近くへ進めて
  // 自然に ended を迎える
  await page.waitForFunction(() => {
    const a = document.getElementById('audioEl') as HTMLAudioElement;
    return isFinite(a.duration) && a.duration > 0 && !a.paused;
  });
  await page.evaluate(() => {
    const a = document.getElementById('audioEl') as HTMLAudioElement;
    a.currentTime = a.duration - 0.4;
  });
  // ended 後も最終ページ（「おわり」のページ）に留まり、再生は止まる
  await page.waitForFunction(() => (document.getElementById('audioEl') as HTMLAudioElement).ended);
  await page.waitForTimeout(800); // 自動遷移があるなら起きる時間を置く
  await expect(page.locator('#endPage')).toBeHidden();
  await expect(page.locator('#pageContent .story-end')).toHaveText('おわり');
  const state = await page.evaluate(() => {
    const a = document.getElementById('audioEl') as HTMLAudioElement;
    return { paused: a.paused, ended: a.ended };
  });
  expect(state.ended).toBe(true);
  expect(state.paused).toBe(true);
  // 手動の前進では従来どおり奥付へ行ける（道は残っている）
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#endPage')).toBeVisible();
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
  await page.locator('#playPauseBtn').click(); // 停止
  await page.mouse.click(78, 400); // 次ページへ
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await page.waitForTimeout(700);
  const t1 = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).currentTime);
  expect(t1).toBeGreaterThan(2); // 停止中でも位置はページに合っている
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

/** 第一章から、旧来の「文字数比例」モデルでは強調を外す文を探す。
    実時刻（unitTimes）で文の真ん中を指しても、比例モデルでは別の文になる文。
    照合のため、ルビがなく本文がそのまま DOM のテキストになる文に限る */
async function pickDriftUnit(
  page: import('@playwright/test').Page,
): Promise<{ mid: number; text: string }> {
  await page.waitForFunction(() =>
    Number.isFinite((document.getElementById('audioEl') as HTMLAudioElement).duration),
  );
  return page.evaluate(async () => {
    const book = (await (await fetch('book/data.json')).json()) as {
      chapters: { ruby: string[]; unitTimes: number[] }[];
    };
    const ch = book.chapters[0];
    const times = ch.unitTimes;
    const duration = (document.getElementById('audioEl') as HTMLAudioElement).duration;
    const plainLen = (t: string): number => t.replace(/｜/g, '').replace(/《[^》]*》/g, '').length;
    const plainText = (t: string): string => t.replace(/｜([^《]*)《[^》]*》/g, '$1');
    const split = (text: string): string[] => {
      const out: string[] = [];
      let buf = '';
      let inRuby = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        buf += c;
        if (c === '《') inRuby = true;
        else if (c === '》') inRuby = false;
        else if (c === '。' && !inRuby) {
          while (i + 1 < text.length && '」』）】〉・…'.includes(text[i + 1])) buf += text[++i];
          out.push(buf);
          buf = '';
        }
      }
      if (buf) out.push(buf);
      return out;
    };
    const raws: string[] = [];
    const lens: number[] = [];
    for (const p of ch.ruby) {
      if (p.trim() === '---') {
        raws.push('');
        lens.push(0);
        continue;
      }
      for (const s of split(p)) {
        raws.push(s);
        lens.push(plainLen(s));
      }
    }
    const total = lens.reduce((a, b) => a + b, 0);
    const starts: number[] = [];
    let pos = 0;
    for (const l of lens) {
      starts.push(pos);
      pos += l;
    }
    const modelAt = (t: number): number => {
      const target = Math.floor((t / duration) * total) + 1;
      for (let i = 0; i < lens.length; i++) {
        if (target >= starts[i] && target < starts[i] + lens[i]) return i;
      }
      return lens.length - 1;
    };
    const plainCounts = new Map<string, number>();
    for (const r of raws) {
      const p = plainText(r);
      plainCounts.set(p, (plainCounts.get(p) ?? 0) + 1);
    }
    // 章の前半から探す（ページ送りの往復で章をまたがないように）
    for (let k = 2; k < Math.floor(times.length / 2); k++) {
      if (lens[k] === 0 || raws[k].includes('《') || times[k + 1] - times[k] < 1.2) continue;
      const text = plainText(raws[k]);
      if (text.length < 8 || plainCounts.get(text) !== 1) continue;
      const mid = (times[k] + times[k + 1]) / 2;
      if (modelAt(mid) !== k) return { mid, text };
    }
    throw new Error('比例モデルでずれる文が第一章の前半に見つからない');
  });
}

test('進む・戻るの連打やメニュー開閉を繰り返しても、ハイライトが音声位置の文とずれない', async ({ page }) => {
  await openReader(page);
  await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).pause());
  const nowText = (): Promise<string> =>
    page.evaluate(() => document.querySelector('#pageContent .unit.now')?.textContent ?? '');
  const seek = (t: number): Promise<void> =>
    page.evaluate((tt) => {
      (document.getElementById('audioEl') as HTMLAudioElement).currentTime = tt;
    }, t);
  const { mid, text } = await pickDriftUnit(page);
  // 比例モデルでは外れる文の真ん中へシーク：実時刻なら、その文が強調され、
  // ページもその文のページへ追従する（seeked の強制同期）
  await seek(mid);
  await expect.poll(nowText, { timeout: 8000 }).toBe(text);
  await expect(page.locator('.unit.now')).toHaveCount(1);
  // メニューを開いて閉じる操作を繰り返しても、強調は同じ文に留まる
  await openMenuInReader(page);
  await page.locator('#menuCloseBtn').click();
  await expect.poll(nowText, { timeout: 8000 }).toBe(text);
  await openMenuInReader(page);
  await page.locator('#menuCloseBtn').click();
  await expect.poll(nowText, { timeout: 8000 }).toBe(text);
  // 進む×2→戻る×2の連打（ページ主導シークのデバウンスを挟む）でも、
  // 強調は常に1つだけで、食い違った場所に残らない
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  for (let i = 0; i < 2; i++) {
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.waitForTimeout(60);
  }
  for (let i = 0; i < 2; i++) {
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(900); // 最後のページシークが確定するまで
  await expect(page.locator('.unit.now')).toHaveCount(1);
  // もう一度同じ文へシークしても、変わらずその文が強調される
  await seek(mid);
  await expect.poll(nowText, { timeout: 8000 }).toBe(text);
  await expect(page.locator('.unit.now')).toHaveCount(1);
});

test('文字サイズを「大」にすると本文が一回り大きくなり、ページ組みが追随する', async ({ page }) => {
  await openReader(page);
  const fontPx = (): Promise<number> =>
    page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('pageContent') as HTMLElement).fontSize));
  const stdPx = await fontPx();
  const pageTextLen = (): Promise<number> =>
    page.evaluate(() => (document.getElementById('pageContent') as HTMLElement).textContent?.length ?? 0);
  const lenBefore = await pageTextLen();
  // メニュー → 文字サイズを「大」へ（選択肢を文字で並べ、選択中は藍で示す）
  await openMenuInReader(page);
  await expect(page.locator('#fontStdBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#fontLargeBtn')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#fontLargeBtn').click();
  await expect(page.locator('#fontLargeBtn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#fontStdBtn')).toHaveAttribute('aria-pressed', 'false');
  // 選択中の色は藍（--indigo2）。未選択は薄いトーンのまま
  const choiceColors = await page.evaluate(() => ({
    large: getComputedStyle(document.getElementById('fontLargeBtn')!).color,
    std: getComputedStyle(document.getElementById('fontStdBtn')!).color,
  }));
  expect(choiceColors.large).toBe('rgb(30, 45, 82)');
  expect(choiceColors.std).not.toBe('rgb(30, 45, 82)');
  await page.locator('#menuCloseBtn').click();
  // 本文が 1.15〜1.25 倍になっている
  const largePx = await fontPx();
  expect(largePx / stdPx).toBeGreaterThanOrEqual(1.15);
  expect(largePx / stdPx).toBeLessThanOrEqual(1.25);
  // ページ組みが追随している（1ページに収まる文字数が減り、本文がはみ出していない）
  const lenAfter = await pageTextLen();
  expect(lenAfter).toBeLessThan(lenBefore);
  const overflow = await page.evaluate(() => {
    const el = document.getElementById('pageContent') as HTMLElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  // シークしても強調は1文だけ（unitTimes との整合は保たれる）
  await page.evaluate(() => {
    (document.getElementById('audioEl') as HTMLAudioElement).currentTime = 60;
  });
  await expect(page.locator('.unit.now')).toHaveCount(1, { timeout: 8000 });
  // 再読み込みしても「大」が保たれる
  await page.reload();
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page.locator('#earModeBtn').click();
  // しおりがあれば扉から再開し、無ければ目次経由で第一章へ（どちらでも本文に着く）
  await page.waitForSelector('#tocView:not([hidden]), #gateView:not([hidden])', { timeout: 5000 });
  if (await page.locator('#tocView').isVisible()) await clickTocChapter(page, 0);
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  expect(await fontPx()).toBeCloseTo(largePx, 0);
  // 標準へ戻すと元の大きさに戻る
  await openMenuInReader(page);
  await page.locator('#fontStdBtn').click();
  await expect(page.locator('#fontStdBtn')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#menuCloseBtn').click();
  expect(await fontPx()).toBeCloseTo(stdPx, 0);
});

test('旧設定でカラオケ方式が保存されていても、ページ形式で開き、設定項目も残っていない', async ({ page }) => {
  // 起動前に、旧バージョンが保存していた方式指定（カラオケ）を仕込む
  await page.addInitScript((appId) => {
    localStorage.setItem(`${appId}-display`, JSON.stringify('karaoke'));
  }, APP_ID);
  await openReader(page);
  // 文が隠れたりはせず（.k-hide は付かない）、本文がそのまま読める
  await expect(page.locator('.unit.k-hide')).toHaveCount(0);
  await expect(page.locator('#pageContent .unit').first()).toBeVisible();
  // 保存済みの方式指定は起動時の移行で消えている
  const saved = await page.evaluate((appId) => localStorage.getItem(`${appId}-display`), APP_ID);
  expect(saved).toBeNull();
  // メニューに「表示方式」の項目はない
  await openMenuInReader(page);
  await expect(page.locator('#displayModeBtn')).toHaveCount(0);
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
  // 扉で前へめくる → 目次ページ（本の並び順で扉の直前にある最終ページに着地する）
  await page.mouse.click(gateBox.x + gateBox.width * 0.8, gateBox.y + gateBox.height * 0.5);
  await expect(page.locator('#tocView')).toBeVisible();
  await expect(page.locator('#tocPager')).toHaveText('― 2 / 2 ―');
  const tocBox = await page.locator('#tocView').boundingBox();
  if (!tocBox) throw new Error('tocView not found');
  // 目次から次方向へ送ると、第一章の扉へ戻れる（扉は目次の次方向にある）
  for (let i = 0; i < 3 && (await page.locator('#gateView').isHidden()); i++) {
    await page.mouse.click(tocBox.x + tocBox.width * 0.15, tocBox.y + tocBox.height * 0.1);
    await page.waitForTimeout(250);
  }
  await expect(page.locator('#gateView')).toBeVisible();
  // 再び前へ：通常扉 → 後方扉 → 目次（最終ページ）→ 1枚目 → 表紙
  // （次方向から戻った扉は通常モードなので、後方扉を経てから目次へ入る）
  await page.mouse.click(gateBox.x + gateBox.width * 0.8, gateBox.y + gateBox.height * 0.5);
  await expect(page.locator('#gateView')).toBeVisible(); // 後方扉
  await page.mouse.click(gateBox.x + gateBox.width * 0.8, gateBox.y + gateBox.height * 0.5);
  await expect(page.locator('#tocView')).toBeVisible();
  await page.mouse.click(tocBox.x + tocBox.width * 0.85, tocBox.y + tocBox.height * 0.1);
  await expect(page.locator('#tocPager')).toHaveText('― 1 / 2 ―');
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
  // 目次で次側タップを続ける →（目次ページを送り切ると）第一章の扉（通常モード）→ 自動で本文へ
  for (let i = 0; i < 5 && (await page.locator('#gateView').isHidden()); i++) {
    await page.mouse.click(tocBox.x + tocBox.width * 0.15, tocBox.y + tocBox.height * 0.1);
    await page.waitForTimeout(250);
  }
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#readerChapterLabel')).toHaveText(/第一章/);
});

test('速度の選択肢で再生速度が切り替わる', async ({ page }) => {
  await openReader(page);
  await openMenuInReader(page);
  // 候補は文字の並び（0.8／1.0／1.25／1.5／2.0。0.75 は無い）。初期は 1.0× が選択中
  const choices = page.locator('#speedChoices .speed-choice');
  await expect(choices).toHaveText(['0.8×', '1.0×', '1.25×', '1.5×', '2.0×']);
  await expect(page.locator('#speedChoices .speed-choice[aria-pressed="true"]')).toHaveText('1.0×');
  await page.locator('#speedChoices .speed-choice[data-speed="1.25"]').click();
  await expect(page.locator('#speedChoices .speed-choice[aria-pressed="true"]')).toHaveText('1.25×');
  // 選択中は文字サイズと同じ藍（--indigo2）で示す
  const color = await page.evaluate(
    () => getComputedStyle(document.querySelector('#speedChoices .speed-choice[aria-pressed="true"]')!).color,
  );
  expect(color).toBe('rgb(30, 45, 82)');
  // 選択肢の並びが行からはみ出していない
  const overflow = await page.evaluate(() => {
    const row = document.getElementById('rowSpeed')!;
    return row.scrollWidth - row.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator('#menuCloseBtn').click();
  const rate = await page.evaluate(() => (document.getElementById('audioEl') as HTMLAudioElement).playbackRate);
  expect(rate).toBe(1.25);
});

test('フリガナのオン/オフが切り替わる', async ({ page }) => {
  await openReader(page);
  await expect(page.locator('body')).not.toHaveClass(/ruby-off/);
  await openMenuInReader(page);
  await page.locator('#rubyToggle').click();
  await expect(page.locator('body')).toHaveClass(/ruby-off/);
});

test('本文タップは進む／戻るだけ：中央寄りのタップでもめくれ、メニューは開かない', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  const cy = box.y + box.height * 0.5;
  // 操作ボタンは常時見えている（召喚する操作は要らない）
  await expect(page.locator('#playPauseBtn')).toBeVisible();
  await expect(page.locator('#menuBtn')).toBeVisible();
  // 中央寄り（左半分）のタップでも「次へ」としてめくれる（無反応帯はない）
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  await page.mouse.click(box.x + box.width * 0.46, cy);
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await expect(page.locator('#menuModal')).toBeHidden();
  // 中央寄り（右半分）のタップは「前へ」
  await page.mouse.click(box.x + box.width * 0.54, cy);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  await expect(page.locator('#menuModal')).toBeHidden();
  // 画面の端ぎわ（左右12px）は誤爆防止の無反応帯：めくれない
  await page.mouse.click(box.x + 4, cy);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
});

test('スワイプでめくれる：大きく払うと進み、小さい払いでは戻る', async ({ page }) => {
  await openReader(page);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  const cy = box.y + box.height * 0.5;
  const swipe = async (fromRatio: number, toRatio: number, slow = false, steps = 6): Promise<void> => {
    await page.mouse.move(box.x + box.width * fromRatio, cy);
    await page.mouse.down();
    if (slow) {
      // ゆっくり払う（フリックにならないよう、ステップ間に待ちを入れる）
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(box.x + box.width * (fromRatio + ((toRatio - fromRatio) * i) / steps), cy);
        await page.waitForTimeout(70);
      }
    } else {
      // 速い払いは1回の move にまとめて送る。呼び出しを分けると往復の遅延が
      // 入り、合成イベントの速度が実ジェスチャより遅く測れて不安定になる
      await page.mouse.move(box.x + box.width * toRatio, cy, { steps });
    }
    await page.mouse.up();
  };
  // ページめくり音の発音フック（app:sound イベント）を数える
  await page.evaluate(() => {
    const w = window as unknown as { __pageSounds: number };
    w.__pageSounds = 0;
    document.addEventListener('app:sound', (e) => {
      if ((e as CustomEvent).detail?.kind === 'page-turn') w.__pageSounds++;
    });
  });
  const pageSounds = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __pageSounds: number }).__pageSounds);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  await swipe(0.3, 0.75); // 右へ大きく払う → 次ページ（スワイプはタップと逆向き）
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await expect(page.locator('#menuModal')).toBeHidden();
  expect(await pageSounds()).toBeGreaterThanOrEqual(1); // 確定で1回鳴る
  await swipe(0.7, 0.25); // 左へ大きく払う → 前ページ
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  // 速いフリックは、確定量に届かない短い移動でもめくれる（粗いステップで速く払う）
  await swipe(0.46, 0.54, false, 3);
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  await swipe(0.54, 0.46, false, 3);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  // ゆっくり小さい払いは確定量未満 → めくれず、音も鳴らない
  const before = await pageSounds();
  await swipe(0.54, 0.48, true);
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  expect(await pageSounds()).toBe(before);
});

test('扉でもスワイプで遷移できる：左で後方へ（後方扉→目次）、右で本文へ', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  const box = await page.locator('#gateView').boundingBox();
  if (!box) throw new Error('gateView not found');
  const cy = box.y + box.height * 0.5;
  const gateSwipe = async (fromRatio: number, toRatio: number): Promise<void> => {
    await page.mouse.move(box.x + box.width * fromRatio, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * ((fromRatio + toRatio) / 2), cy, { steps: 4 });
    await page.mouse.move(box.x + box.width * toRatio, cy, { steps: 4 });
    await page.mouse.up();
  };
  // 左へ払う → 後方モードの扉へ
  await gateSwipe(0.7, 0.25);
  await expect(page.locator('#gateView')).toBeVisible();
  // 扉の下部の案内文言は出さない（v1.12.3 で削除）
  await expect(page.locator('#gateHint')).toHaveCount(0);
  await expect(page.locator('#gateView')).not.toContainText('タップで本文へ');
  // もう一度左へ払う → 目次ページへ（最終ページに着地する）
  await gateSwipe(0.7, 0.25);
  await expect(page.locator('#tocView')).toBeVisible();
  await expect(page.locator('#tocPager')).toHaveText('― 2 / 2 ―');
  // 目次から次方向（右へ払う）で第一章の扉へ戻る（「戻る」ピルは廃止され、
  // 扉へは次方向の操作で戻る）
  const tocBox = await page.locator('#tocView').boundingBox();
  if (!tocBox) throw new Error('tocView not found');
  const tocCy = tocBox.y + tocBox.height * 0.5;
  await page.mouse.move(tocBox.x + tocBox.width * 0.3, tocCy);
  await page.mouse.down();
  await page.mouse.move(tocBox.x + tocBox.width * 0.525, tocCy, { steps: 4 });
  await page.mouse.move(tocBox.x + tocBox.width * 0.75, tocCy, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#gateView')).toBeVisible();
  // 右へ払う → 第一章の本文へ入る
  await gateSwipe(0.3, 0.75);
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
});

test('章の扉でスワイプ：左で前の章の扉へ、右でその章へ入る', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await clickTocChapter(page, 1); // 第二章の扉
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第二章');
  const box = await page.locator('#gateView').boundingBox();
  if (!box) throw new Error('gateView not found');
  const cy = box.y + box.height * 0.5;
  const gateSwipe = async (fromRatio: number, toRatio: number): Promise<void> => {
    await page.mouse.move(box.x + box.width * fromRatio, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * ((fromRatio + toRatio) / 2), cy, { steps: 4 });
    await page.mouse.move(box.x + box.width * toRatio, cy, { steps: 4 });
    await page.mouse.up();
  };
  // 左へ払う → 第一章の扉（最終ページ指定）へ戻り、やがて本文（最終ページ）へ入る
  await gateSwipe(0.7, 0.25);
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  // 戻って、第二章の扉で右へ払う → 第二章へ入る
  await backToCover(page);
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await clickTocChapter(page, 1);
  await expect(page.locator('#gateNum')).toHaveText('第二章');
  await gateSwipe(0.3, 0.75);
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#readerChapterLabel')).toHaveText('第二章 忘れ物の傘');
});

test('回帰：扉で後方スワイプすると前章に着地し、次章へスキップしない（コール読み込み中でも）', async ({ page }) => {
  // 実機報告の再現：章題コールの読み込みが終わらないうちに扉で戻るスワイプをすると、
  // 旧い扉の play() 中断フォールバックが割り込んで、戻った先から元の章（次の章）へ
  // 進んでしまった。コールの応答を遅らせて「読み込み中」を作り、その状態で払う。
  // （修正前のコードでは、このテストは「第一章」ではなく「第二章」に入って失敗する）
  await page.route('**/audio/ch2-title.mp3', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await route.fulfill({
        contentType: 'audio/mpeg',
        body: readFileSync(new URL('../public/book/audio/ch2-title.mp3', import.meta.url)),
      });
    } catch {
      // 読み込みが中断されていたら何もしない
    }
  });
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await clickTocChapter(page, 1); // 第二章の扉（コールは読み込み中）
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateNum')).toHaveText('第二章');
  const box = await page.locator('#gateView').boundingBox();
  if (!box) throw new Error('gateView not found');
  const cy = box.y + box.height * 0.5;
  // 左へ払う → 第一章の扉へ戻る
  await page.mouse.move(box.x + box.width * 0.7, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, cy, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.25, cy, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  // 扉の自動入章（1.8秒）を過ぎたら第一章の本文に着地し、その後も第二章へは進まない
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
  await page.waitForTimeout(2500);
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
});

test('回帰：扉の後方スワイプに遅れて届く相方クリックが、新しい扉で「次へ」と誤認されない', async ({ page }) => {
  // 実機報告の再現（第2経路）：iOS では、スワイプに伴う click が指を離してから
  // 350ms（swipedRecently の窓）を超えて遅れて届くことがある。その click は
  // スワイプ確定で切り替わった新しい扉の上で処理され、指を離した位置
  // （左半分＝次側）が「入章タップ」と誤認されて、戻る操作なのに前方へ飛ぶ。
  // 相方クリックは新しい pointerdown を伴わないので、click だけを直接
  // dispatch して再現する（修正前はこのテストが「扉に留まる」で失敗する）
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await clickTocChapter(page, 1); // 第二章の扉
  await expect(page.locator('#gateNum')).toHaveText('第二章');
  const box = await page.locator('#gateView').boundingBox();
  if (!box) throw new Error('gateView not found');
  const cy = box.y + box.height * 0.5;
  // 左へ払う → 第一章の扉へ戻る（既存の回帰テストと同じ払い方）
  await page.mouse.move(box.x + box.width * 0.7, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, cy, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.25, cy, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  // 抑止窓（350ms）を十分に過ぎてから、左半分（次側）へ相方クリックを届ける
  await page.waitForTimeout(700);
  await page.evaluate(
    ({ x, y }) => {
      document
        .getElementById('gateView')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    },
    { x: box.x + box.width * 0.25, y: cy },
  );
  // 第一章の扉は自動入章タイマー（1.8秒）が来るまで扉に留まるはず
  // （誤認されると、その場で第一章の本文へ入ってしまう）
  await page.waitForTimeout(500);
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#readerView')).toBeHidden();
  // 本物のタップ（pointerdown を伴う）は従来どおり効く：次側タップで第一章へ入る
  await page.mouse.click(box.x + box.width * 0.25, cy);
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
});

test('画面は上下に引っ張れない：ドキュメントがスクロールしない', async ({ page }) => {
  // 表紙で確認：body が固定され、ドキュメントがビューポートより大きくならない
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  const cover = await page.evaluate(() => ({
    position: getComputedStyle(document.body).position,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(cover.position).toBe('fixed');
  expect(cover.scrollHeight).toBeLessThanOrEqual(cover.innerHeight);

  // 読書画面でも同じこと。縦方向にドラッグ（引っ張り）しても画面は動かない
  await openReader(page);
  const reader = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(reader.scrollHeight).toBeLessThanOrEqual(reader.innerHeight);
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  const cx = box.x + box.width * 0.5;
  await page.mouse.move(cx, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(cx, box.y + box.height * 0.75, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, 800);
  await page.evaluate(() => window.scrollTo(0, 120));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // 引っ張りでページがめくれたり、メニューが開いたりもしない（縦の動きはめくりの対象外）
  await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
  await expect(page.locator('#menuModal')).toBeHidden();
});

test('本を開いた直後は、メニューが勝手に出ない', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await expect(page.locator('#menuModal')).toBeHidden(); // 起動直後
  await enterViaToc(page, '#earModeBtn');
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } }); // 扉を即タップして本文へ（実機の速い操作を再現）
  await expect(page.locator('#readerView')).toBeVisible();
  await expect(page.locator('#pageFolio')).not.toHaveText('');
  // 少し待っても、メニューが勝手に出てくることはない
  await expect(page.locator('#menuModal')).toBeHidden();
  await page.waitForTimeout(1200);
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
  await page.locator('#earModeBtn').click(); // 最初のタップで流れ始める
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on');
  await expect(page.locator('#tocView')).toBeVisible(); // 初回は目次から始まる
  await clickTocChapter(page, 0);
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

test('章の扉に下部の案内文言は出ない（タイトルブロックは残る）', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page.locator('#eyeModeBtn').click();
  await expect(page.locator('#tocView')).toBeVisible(); // 初回は目次から始まる
  await clickTocChapter(page, 0); // 目で読むは扉で止まるので、そのまま確認できる
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gateHint')).toHaveCount(0);
  await expect(page.locator('#gateView')).not.toContainText('タップで本文へ');
  await expect(page.locator('#gateNum')).toHaveText('第一章');
  await expect(page.locator('#gateTitle')).toHaveText('雨の日の客');
});

test('版数ファイルが新しい版を示すと更新バナーが出る', async ({ page }) => {
  // 配信側の版数ファイルだけが新しい、という状況を差し替えで再現する。
  // アプリは起動時に version.json をキャッシュなしで取りに行き、自分の版数と比べる
  await page.route('**/version.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '999.0.0' }) }),
  );
  await page.goto('/');
  await expect(page.locator('#update-banner')).toBeVisible();
});

test('版数ファイルの検知で「更新」を押すと、再読み込みしてアプリが開き直す', async ({ page }) => {
  await page.route('**/version.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '999.0.0' }) }),
  );
  await page.goto('/');
  await expect(page.locator('#update-banner')).toBeVisible();
  // 待機中 SW が無い場合は、キャッシュを消して再読み込みする最終手段に進む（少し時間がかかる）
  await page.locator('#update-button').click();
  await expect(page.locator('#coverView')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.cover-vtitle')).toContainText('空の郵便が');
});

test('更新バナーは「あとで」で閉じられる', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.getElementById('update-banner')!.hidden = false;
  });
  await page.getByRole('button', { name: 'あとで' }).click();
  await expect(page.locator('#update-banner')).toBeHidden();
});

test('更新バナーのボタンは最前面にあり、タッチでも押せる', async ({ page }) => {
  // 実機報告（v1.13.1 で対応）: バナーは出るのにボタンが押せない。
  // まず幾何の側を固定する: 両ボタンの中心で elementFromPoint がボタン自身を
  // 返す（透明な要素が被っていない）ことと、タッチタップで実際に効くこと
  await page.route('**/version.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '999.0.0' }) }),
  );
  await page.goto('/');
  await expect(page.locator('#update-banner')).toBeVisible();
  for (const id of ['update-button', 'update-later']) {
    const top = await page.evaluate((btnId) => {
      const btn = document.getElementById(btnId)!;
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el === btn || btn.contains(el);
    }, id);
    expect(top, `#${id} の中心はボタン自身が最前面`).toBe(true);
  }
  const laterBox = await page.locator('#update-later').boundingBox();
  if (!laterBox) throw new Error('later box not found');
  await page.touchscreen.tap(laterBox.x + laterBox.width / 2, laterBox.y + laterBox.height / 2);
  await expect(page.locator('#update-banner')).toBeHidden();
});

test('SWの更新確認が返らなくても、「更新」は時間内に再読み込みまで進む', async ({ page }) => {
  // v1.13.0 までの実機症状の再現: registration.update() は新しい SW の
  // インストール完了まで返らないことがあり（iOS で滞留すると実質無期限）、
  // 旧実装はその await の後ろに全ての保険が並んでいたため、ボタンが無反応に
  // なった。update() が永遠に返らない状況を作っても、最後の砦のタイマーが
  // 再読み込みまで運ぶことを固定する
  await page.addInitScript(() => {
    ServiceWorkerRegistration.prototype.update = () => new Promise(() => undefined);
  });
  await page.route('**/version.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '999.0.0' }) }),
  );
  await page.goto('/');
  await expect(page.locator('#update-banner')).toBeVisible();
  const t0 = await page.evaluate(() => performance.timeOrigin);
  await page.locator('#update-button').click();
  // 押せたことがその場で分かる（文言が変わり、無効化される）
  await expect(page.locator('#update-button')).toHaveText('更新しています…');
  await expect(page.locator('#update-button')).toBeDisabled();
  // 再読み込みが起きる（timeOrigin が新しくなる）ことをもって到達とする
  await expect
    .poll(() => page.evaluate(() => performance.timeOrigin), { timeout: 30000 })
    .toBeGreaterThan(t0);
  await expect(page.locator('#coverView')).toBeVisible();
});

test.describe('初回案内（音声の総容量とWi-Fi推奨）と一括取り込み', () => {
  /* この一連だけは初回として開く：beforeEach の「見た」プリセットを打ち消す
     （init script は登録順に走るので、後から登録した方が勝つ） */
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.removeItem(`${id}-dl-notice-seen`);
    }, APP_ID);
  });

  test('初回は案内が出て、閉じるまで一括ダウンロード（SW登録）は始まらない。閉じたら二度と出ない', async ({ page }) => {
    await page.goto('/');
    const notice = page.locator('#dlNotice');
    await expect(notice).toBeVisible();
    // 容量は本のデータ（totalAudioBytes）から動的に出る：この本は約18.2MB
    await expect(page.locator('#dlNoticeBody')).toContainText('約18.2MB');
    await expect(page.locator('#dlNoticeBody')).toContainText('Wi-Fi');
    // 案内が開いている間は、Service Worker はまだ登録されていない
    const regsBefore = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    expect(regsBefore).toBe(0);
    await page.locator('#dlNoticeClose').click();
    await expect(notice).toBeHidden();
    // 閉じて初めて登録が始まり、有効になる
    const active = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return !!reg.active;
    });
    expect(active).toBe(true);
    // 再読み込みしても案内は出ない（見たことが保存されている）
    await page.reload();
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await expect(notice).toBeHidden();
  });

  test('全章の音声（本文＋章題コール）がキャッシュに取り込まれ、オフライン再生の前提がそろう', async ({ page }) => {
    test.setTimeout(90_000); // 約18MBの一括取り込みを待つので、既定の制限より長く取る
    await page.goto('/');
    await page.locator('#dlNoticeClose').click(); // 案内を閉じて登録を始める
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // precache が終わるまで待ち、全14ファイルがキャッシュに実在することを数で確かめる
    // （precache のキーはリビジョンのクエリ付きなので、検索部を無視して照合する）
    const countCachedAudio = (): Promise<number> =>
      page.evaluate(async () => {
        let n = 0;
        for (const key of await caches.keys()) {
          const cache = await caches.open(key);
          for (let i = 1; i <= 7; i++) {
            if (await cache.match(`book/audio/ch${i}.mp3`, { ignoreSearch: true })) n++;
            if (await cache.match(`book/audio/ch${i}-title.mp3`, { ignoreSearch: true })) n++;
          }
        }
        return n;
      });
    await expect.poll(countCachedAudio, { timeout: 60_000 }).toBe(14);
  });
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
  await expect(page.locator('#coverResume')).toContainText('つづきから'); // しおりが残っている（ボタン上の小行が再開を示す）
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
    // 雨は全てアニメーション（v1.13.2）：両端を全高で落ちる雨7＋上部の短い雨8。
    // 背景 SVG 側に静止した雨線は置かない（「止まって見える」実機指摘への対応）
    await expect(anim.locator('.anim-rain')).toHaveCount(15);
    await expect(anim.locator('.anim-rain.top')).toHaveCount(8);
    await openMenuInReader(page);
    await page.locator('#tocFromMenuBtn').click();
    await page.locator('#tocList .toc-item').nth(1).click();
    await expect(page.locator('#gateNum')).toHaveText('第二章');
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerChapterLabel')).toHaveText(/第二章/);
    await expect(anim).toHaveAttribute('data-chapter', '2');
    // 第二章の雨も量感を第一章に統一（密度・薄さとも）。水たまりのきらめきは残る
    await expect(anim.locator('.anim-rain')).toHaveCount(15);
    await expect(anim.locator('.anim-rain.top')).toHaveCount(8);
    await expect(anim.locator('.anim-glint')).toHaveCount(2);
    // 背景 SVG に静止した雨の線が残っていないこと（傘や日差しの線画は対象外：
    // 雨グループの目印コメントで判定する）
    const svgTexts = await page.evaluate(async () => {
      const get = async (n: number): Promise<string> => (await fetch('book/bg/ch' + n + '.svg')).text();
      return { ch1: await get(1), ch2: await get(2) };
    });
    expect(svgTexts.ch1).not.toContain('雨（上部にまばらに）');
    expect(svgTexts.ch2).not.toContain('まばらな雨');
    expect(svgTexts.ch2).toContain('開いた傘'); // 傘のモチーフは残っている
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

  test('ノンブルと章題は、ページの備品として常時表示される', async ({ page }) => {
    await openReader(page);
    await expect(page.locator('#pageFolio')).toBeVisible();
    await expect(page.locator('#pageFolio')).toHaveText(/― \d+ ―/);
    await expect(page.locator('#pageFolio')).toHaveCSS('opacity', '1');
    // 柱（上の帯）には章題だけを常時出す（章内位置 〇/〇 は置かない）
    await expect(page.locator('#pageChapterPos')).toHaveCount(0);
    await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
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

  test('バックグラウンド再生は朗読中だけ効く: 表紙と目で読むでは背面化で BGM が止まる', async ({ page }) => {
    const setHidden = (hidden: boolean): Promise<void> =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    const bgmOn = (): Promise<boolean> => page.evaluate(() => document.body.dataset.bgm === 'on');

    // 表紙：BGM が鳴っていても（バックグラウンド再生は既定オン）、背面化で止まる
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await page.locator('#coverMenuBtn').click(); // 最初のタップで BGM が流れ始める
    await expect.poll(bgmOn).toBe(true);
    await page.locator('#menuCloseBtn').click();
    await setHidden(true);
    await expect.poll(bgmOn).toBe(false); // 表紙ではバックグラウンド再生は効かない
    await setHidden(false);
    await expect.poll(bgmOn).toBe(true); // 前面に戻れば設定どおり再開する

    // 目で読む：BGM は鳴るが、背面化で止まる
    await page.locator('#eyeModeBtn').click();
    await expect(page.locator('#tocView')).toBeVisible(); // 初回は目次から始まる
    await clickTocChapter(page, 0);
    await expect(page.locator('#gateView')).toBeVisible();
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible();
    await expect.poll(bgmOn).toBe(true);
    await setHidden(true);
    await expect.poll(bgmOn).toBe(false); // 目で読むではバックグラウンド再生は効かない
    await setHidden(false);
    await expect.poll(bgmOn).toBe(true);
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
    await enterViaToc(page, '#earModeBtn');
    await expect(page.locator('#gateView')).toBeVisible();
    const gate = await page.locator('.gate-sheet').boundingBox();
    if (!gate) throw new Error('gate box not found');
    expect(gate.y).toBeGreaterThanOrEqual(59);
    expect(gate.y + gate.height).toBeLessThanOrEqual(912 - 34);
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
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

  await enterViaToc(page, '#earModeBtn');
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
  await page.locator('#earModeBtn').click();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(600);
  expect(await wlHeld()).toBe(false);
  expect(await wlState()).toBe('off');
});

/* ===== v1.8.0：目次の再配置（窮屈さの改善＋複数ページ化）と章題コール ===== */

test.describe('目次ページの体裁（390px）', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function openTocFromCover(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await openMenuOnCover(page);
    await page.locator('#tocFromMenuBtn').click();
    await expect(page.locator('#tocView')).toBeVisible();
  }

  test('目次に語り手名はなく、現在章の帯は文字の範囲だけ、列の塊はページ中央にある', async ({ page }) => {
    await openTocFromCover(page);
    await expect(page.locator('.toc-narr')).toHaveCount(0); // 語り手名は目次に載せない（扉で分かる）
    const m = await page.evaluate(() => {
      const sheet = document.querySelector('.toc-sheet')!.getBoundingClientRect();
      const inner = document.querySelector('.toc-inner')!.getBoundingClientRect();
      const cur = document.querySelector('#tocList .toc-item.current')!.getBoundingClientRect();
      return {
        sheet: { left: sheet.left, right: sheet.right, height: sheet.height },
        inner: { left: inner.left, right: inner.right },
        bandHeight: cur.height,
      };
    });
    // 現在章の帯はページ下端まで伸びない（文字のある範囲だけ）
    expect(m.bandHeight).toBeLessThan(m.sheet.height * 0.4);
    // 列の塊（見出し含む）は左右中央：両側の余白差はわずか
    const leftMargin = m.inner.left - m.sheet.left;
    const rightMargin = m.sheet.right - m.inner.right;
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(6);
    expect(leftMargin).toBeGreaterThan(20); // 左端ギリギリまで使わない
  });

  test('目次ページを送ると全章に辿り着け、列がシートからはみ出さない', async ({ page }) => {
    await openTocFromCover(page);
    const seen = new Set<string>();
    let prevPager = '';
    for (let i = 0; i < 6; i++) {
      const state = await page.evaluate(() => {
        const sheet = document.querySelector('.toc-sheet')!.getBoundingClientRect();
        const lis = [...document.querySelectorAll('#tocList li')];
        return {
          pager: document.querySelector('#tocPager')!.textContent || '',
          idxs: [...document.querySelectorAll('#tocList .toc-item')].map((el) => (el as HTMLElement).dataset.idx!),
          minLeft: Math.min(...lis.map((li) => li.getBoundingClientRect().left)),
          maxRight: Math.max(...lis.map((li) => li.getBoundingClientRect().right)),
          sheetLeft: sheet.left,
          sheetRight: sheet.right,
        };
      });
      state.idxs.forEach((x) => seen.add(x));
      expect(state.minLeft).toBeGreaterThanOrEqual(state.sheetLeft - 1);
      expect(state.maxRight).toBeLessThanOrEqual(state.sheetRight + 1);
      if (state.pager === prevPager) break;
      prevPager = state.pager;
      const tocBox = await page.locator('#tocView').boundingBox();
      if (!tocBox) throw new Error('tocView not found');
      await page.mouse.click(tocBox.x + tocBox.width * 0.15, tocBox.y + tocBox.height * 0.08);
      await page.waitForTimeout(250);
    }
    expect(seen.size).toBe(7);
  });

  test('章を増やす（12章）と目次は複数ページに分かれ、崩れない', async ({ page }) => {
    await page.route('**/book/data.json', async (route) => {
      const res = await route.fetch();
      const data = (await res.json()) as { chapters: Record<string, unknown>[] };
      const nums = ['第一章', '第二章', '第三章', '第四章', '第五章', '第六章', '第七章', '第八章', '第九章', '第十章', '第十一章', '第十二章'];
      const extra: Record<string, unknown>[] = [];
      for (let i = 7; i < 12; i++) {
        const c = JSON.parse(JSON.stringify(data.chapters[i % 7])) as Record<string, unknown>;
        c.num = nums[i];
        c.title = 'ダミーの章その' + (i - 6);
        extra.push(c);
      }
      data.chapters = data.chapters.concat(extra);
      await route.fulfill({ response: res, json: data });
    });
    await openTocFromCover(page);
    await expect(page.locator('#tocPager')).toBeVisible();
    await expect(page.locator('#tocPager')).toHaveText(/1 \/ [2-9]/);
    const seen = new Set<string>();
    let prevPager = '';
    for (let i = 0; i < 8; i++) {
      const state = await page.evaluate(() => {
        const sheet = document.querySelector('.toc-sheet')!.getBoundingClientRect();
        const lis = [...document.querySelectorAll('#tocList li')];
        return {
          pager: document.querySelector('#tocPager')!.textContent || '',
          idxs: [...document.querySelectorAll('#tocList .toc-item')].map((el) => (el as HTMLElement).dataset.idx!),
          minLeft: Math.min(...lis.map((li) => li.getBoundingClientRect().left)),
          maxRight: Math.max(...lis.map((li) => li.getBoundingClientRect().right)),
          sheetLeft: sheet.left,
          sheetRight: sheet.right,
        };
      });
      state.idxs.forEach((x) => seen.add(x));
      expect(state.minLeft).toBeGreaterThanOrEqual(state.sheetLeft - 1);
      expect(state.maxRight).toBeLessThanOrEqual(state.sheetRight + 1);
      if (state.pager === prevPager) break;
      prevPager = state.pager;
      const tocBox = await page.locator('#tocView').boundingBox();
      if (!tocBox) throw new Error('tocView not found');
      await page.mouse.click(tocBox.x + tocBox.width * 0.15, tocBox.y + tocBox.height * 0.08);
      await page.waitForTimeout(250);
    }
    expect(seen.size).toBe(12);
  });
});

test.describe('章題コール（扉の朗読）', () => {
  test('扉では章題コールが鳴り、読み終わってから本文が始まる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await enterViaToc(page, '#earModeBtn');
    await expect(page.locator('#gateView')).toBeVisible();
    await expect(page.locator('#gateAudio')).toHaveAttribute('src', /ch1-title\.mp3$/);
    // コール（約5秒）の途中では、まだ本文へ進んでいない
    await page.waitForTimeout(1500);
    await expect(page.locator('#readerView')).toBeHidden();
    // 読み終わると本文へ
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 12000 });
  });

  test('扉をタップするとコールを止めてすぐ本文へ進む', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await enterViaToc(page, '#earModeBtn');
    await expect(page.locator('#gateView')).toBeVisible();
    await page.waitForTimeout(400);
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 3000 });
  });

  test('コール音声が読み込めなくても、従来の待ち時間で本文へ進む', async ({ page }) => {
    await page.route('**/book/audio/*-title.mp3', (route) => route.abort());
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await enterViaToc(page, '#earModeBtn');
    await expect(page.locator('#gateView')).toBeVisible();
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 8000 });
  });

  test('再生中にページ送りで章をまたいでも、本文とコールが重ならない（2重再生の regression）', async ({ page }) => {
    await openReader(page);
    // 朗読が再生中であること
    await expect
      .poll(() => page.evaluate(() => !(document.getElementById('audioEl') as HTMLAudioElement).paused), { timeout: 8000 })
      .toBe(true);
    // 状態サンプリングを先に仕掛ける：コールが鳴り終わるまで100msごとに状態を取り、
    // 「本文とコールが同時に鳴っている瞬間が一度もない」ことと「コール自体は
    // 鳴った」ことを確かめる（一時点の状態だけ見ると、重なりの途中を取りこぼすため）
    await page.evaluate(() => {
      const w = window as unknown as { __overlap: number; __callHeard: boolean; __iv: ReturnType<typeof setInterval> };
      w.__overlap = 0;
      w.__callHeard = false;
      const a = document.getElementById('audioEl') as HTMLAudioElement;
      const g = document.getElementById('gateAudio') as HTMLAudioElement;
      w.__iv = setInterval(() => {
        const body = !a.paused && !a.ended;
        const call = !g.paused && !g.ended;
        if (body && call) w.__overlap++;
        if (call) w.__callHeard = true;
      }, 100);
    });
    // 章の最終ページまで送り、もう1回送って扉へ（再生中のまま章をまたぐ）
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    for (let i = 0; i < 60; i++) {
      if (await page.locator('#gateView').isVisible()) break;
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
      await page.waitForTimeout(120);
    }
    await expect(page.locator('#gateView')).toBeVisible();
    await expect(page.locator('#gateNum')).toHaveText('第二章');
    // コールが終われば本文（第2章）が始まる
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#readerChapterLabel')).toHaveText('第二章 忘れ物の傘');
    const seen = await page.evaluate(() => {
      const w = window as unknown as { __overlap: number; __callHeard: boolean; __iv: ReturnType<typeof setInterval> };
      clearInterval(w.__iv);
      return { overlap: w.__overlap, callHeard: w.__callHeard };
    });
    expect(seen.callHeard).toBe(true);
    expect(seen.overlap).toBe(0);
  });

  test('コールの読み込みが保留中でも、扉を進めばコールは後から鳴り出さない', async ({ page }) => {
    // 第2章のコール音声の応答を保留し、play() が完了しない状態を作る
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/book/audio/ch2-title.mp3', async (route) => {
      await held;
      await route.continue();
    });
    await openReader(page);
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    for (let i = 0; i < 60; i++) {
      if (await page.locator('#gateView').isVisible()) break;
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
      await page.waitForTimeout(120);
    }
    await expect(page.locator('#gateView')).toBeVisible();
    // コールが鳴り出す前に扉をタップして本文へ進む
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 5000 });
    // ここで保留していたコール音声を流す。止めたはずのコールが後から鳴り出してはいけない
    release();
    await page.waitForTimeout(1500);
    const gatePaused = await page.evaluate(() => (document.getElementById('gateAudio') as HTMLAudioElement).paused);
    expect(gatePaused).toBe(true);
  });
});

test.describe('ページ操作の統一（本文・扉・目次）', () => {
  /** 指定要素の上で横スワイプする（速い払い＝フリック寄り） */
  const swipeOn = async (
    page: import('@playwright/test').Page,
    selector: string,
    fromRatio: number,
    toRatio: number,
    steps = 3,
  ): Promise<void> => {
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(selector + ' not found');
    const cy = box.y + box.height * 0.5;
    await page.mouse.move(box.x + box.width * fromRatio, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * toRatio, cy, { steps });
    await page.mouse.up();
  };

  test('扉でも短いフリックで遷移できる（本文と同じ判定）', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await enterViaToc(page, '#earModeBtn');
    await expect(page.locator('#gateView')).toBeVisible();
    // 確定量に届かない短い速い払いでも、フリックとして入章できる
    await swipeOn(page, '#gateView', 0.46, 0.54);
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#readerChapterLabel')).toHaveText('第一章 雨の日の客');
  });

  test('目次でもスワイプとフリックが効き、前方向の端で表紙まで戻れる', async ({ page }) => {
    await openReader(page);
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    // 後方チェーンで目次まで来る：本文（前タップ）→ 後方扉（前スワイプ）→ 目次
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await expect(page.locator('#gateView')).toBeVisible();
    await swipeOn(page, '#gateView', 0.7, 0.25, 6);
    await expect(page.locator('#tocView')).toBeVisible();
    await expect(page.locator('#tocPager')).toHaveText('― 2 / 2 ―'); // 扉の直前＝最終ページに着地
    // 目次で大きく左へ払う → 1枚目へ。もう一度払うと先頭ページの前側なので表紙へ（チェーンの終端）
    await swipeOn(page, '#tocView', 0.7, 0.25, 6);
    await expect(page.locator('#tocPager')).toHaveText('― 1 / 2 ―');
    await swipeOn(page, '#tocView', 0.7, 0.25, 6);
    await expect(page.locator('#coverView')).toBeVisible();
    // もう一度チェーンで目次まで来て、今度は短いフリックでも表紙へ戻れる
    await page.locator('#earModeBtn').click();
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
    const box2 = await page.locator('#pageWrap').boundingBox();
    if (!box2) throw new Error('pageWrap not found');
    await page.mouse.click(box2.x + box2.width * 0.8, box2.y + box2.height * 0.5);
    await expect(page.locator('#gateView')).toBeVisible();
    await swipeOn(page, '#gateView', 0.7, 0.25, 6);
    await expect(page.locator('#tocView')).toBeVisible();
    await swipeOn(page, '#tocView', 0.53, 0.45); // 短いフリック（前へ）→ 1枚目へ
    await expect(page.locator('#tocPager')).toHaveText('― 1 / 2 ―');
    await swipeOn(page, '#tocView', 0.53, 0.45); // 短いフリック（前へ）→ 表紙へ
    await expect(page.locator('#coverView')).toBeVisible();
  });

  test('メニューから開いた目次では、前タップで開いた元の本文へ戻る', async ({ page }) => {
    await openReader(page);
    await openMenuInReader(page);
    await page.locator('#tocFromMenuBtn').click();
    await expect(page.locator('#tocView')).toBeVisible();
    const tocBox = await page.locator('#tocView').boundingBox();
    if (!tocBox) throw new Error('tocView not found');
    // 先頭ページでの前へ＝開いた元（本文）へ帰る（旧「戻る」の役目を後方操作へ統合。
    // 後方連鎖で開いた目次だけが、並び順どおり表紙へ進む）
    for (let i = 0; i < 4 && (await page.locator('#readerView').isHidden()); i++) {
      await page.mouse.click(tocBox.x + tocBox.width * 0.85, tocBox.y + tocBox.height * 0.1);
      await page.waitForTimeout(250);
    }
    await expect(page.locator('#readerView')).toBeVisible();
    await expect(page.locator('#tocView')).toBeHidden();
  });

  test('本文の途中から後方タップだけで表紙まで戻れる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await openMenuOnCover(page);
    await page.locator('#tocFromMenuBtn').click();
    await clickTocChapter(page, 2); // 第三章の扉
    await expect(page.locator('#gateNum')).toHaveText('第三章');
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerChapterLabel')).toHaveText('第三章 取り置きの本');
    const tapPrevOn = async (selector: string): Promise<void> => {
      const b = await page.locator(selector).boundingBox();
      if (!b) throw new Error(selector + ' not found');
      await page.mouse.click(b.x + b.width * 0.8, b.y + b.height * 0.5);
    };
    // 本文の先頭ページで前へ → 第三章の扉（最終ページ指定）
    await tapPrevOn('#pageWrap');
    await expect(page.locator('#gateNum')).toHaveText('第三章');
    // 扉で前へ → 第二章の扉 → 第一章の扉 → 後方扉 → 目次 → 表紙
    await tapPrevOn('#gateView');
    await expect(page.locator('#gateNum')).toHaveText('第二章');
    await tapPrevOn('#gateView');
    await expect(page.locator('#gateNum')).toHaveText('第一章');
    await tapPrevOn('#gateView'); // 後方扉へ
    // 扉の下部の案内文言は出さない（v1.12.3 で削除）
    await expect(page.locator('#gateHint')).toHaveCount(0);
    await tapPrevOn('#gateView'); // 目次へ（最終ページに着地）
    await expect(page.locator('#tocView')).toBeVisible();
    // 目次を前へ送り切り、先頭ページの前で表紙へ（タップ位置は項目のない上部。
    // 最終ページの中央は章項目のボタンに当たるため）
    const tocBox = await page.locator('#tocView').boundingBox();
    if (!tocBox) throw new Error('tocView not found');
    for (let i = 0; i < 4 && (await page.locator('#coverView').isHidden()); i++) {
      await page.mouse.click(tocBox.x + tocBox.width * 0.85, tocBox.y + tocBox.height * 0.1);
      await page.waitForTimeout(200);
    }
    await expect(page.locator('#coverView')).toBeVisible();
  });

  test('第一章の扉から後方スワイプで目次の最終ページに着地し、前方向で扉へ戻れる', async ({ page }) => {
    // 実機報告：第一章の扉で戻ると目次の1枚目に着地してしまい、扉の直前
    // （目次の最終ページ）に戻れなかった。本の並び順では扉の直前は最終ページ
    await openReader(page);
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    // 本文の先頭ページで前へ → 後方扉
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await expect(page.locator('#gateView')).toBeVisible();
    // 後方扉で左へ払う（後方スワイプ）→ 目次の最終ページに着地する
    await swipeOn(page, '#gateView', 0.7, 0.25, 6);
    await expect(page.locator('#tocView')).toBeVisible();
    await expect(page.locator('#tocPager')).toHaveText('― 2 / 2 ―');
    // 後方スワイプを続けると1枚目へ送られる
    await swipeOn(page, '#tocView', 0.7, 0.25, 6);
    await expect(page.locator('#tocPager')).toHaveText('― 1 / 2 ―');
    // 前方向（右へ払う）で最終ページへ戻り、もう一度で第一章の扉へ（対の確認）
    await swipeOn(page, '#tocView', 0.3, 0.75, 6);
    await expect(page.locator('#tocPager')).toHaveText('― 2 / 2 ―');
    await swipeOn(page, '#tocView', 0.3, 0.75, 6);
    await expect(page.locator('#gateView')).toBeVisible();
    await expect(page.locator('#gateNum')).toHaveText('第一章');
  });

  test('奥付でもページ操作が効く：後方スワイプで最終ページへ戻り、前方向で表紙へ戻る', async ({ page }) => {
    // 実機報告：奥付まで行くとスワイプで戻れなかった
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await openMenuOnCover(page);
    await page.locator('#tocFromMenuBtn').click();
    await clickTocChapter(page, 6); // 第七章
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    for (let i = 0; i < 80; i++) {
      if ((await page.locator('#pageContent .story-end').count()) > 0) break;
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
      await page.waitForTimeout(50);
    }
    await expect(page.locator('#pageContent .story-end')).toHaveCount(1); // 「おわり」のある最終ページ
    // 次タップで奥付へ
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await expect(page.locator('#endPage')).toBeVisible();
    // 奥付の帯：再生は出さず（朗読対象が無い）、家マークだけが右下にある
    await expect(page.locator('#endPlayBtn')).toBeHidden();
    await expect(page.locator('#endMenuBtn')).toBeVisible();
    const endMenuBox = await page.locator('#endMenuBtn').boundingBox();
    if (!endMenuBox) throw new Error('endMenuBtn not found');
    expect(endMenuBox.x + endMenuBox.width / 2).toBeGreaterThan(box.x + box.width * 0.8); // 右下
    expect(endMenuBox.y + endMenuBox.height).toBeGreaterThan(box.y + box.height - 70); // 帯の高さ内
    // 後方スワイプ（左へ払う）で本文の最終ページへ戻る
    await swipeOn(page, '#endPage', 0.7, 0.25, 6);
    await expect(page.locator('#endPage')).toBeHidden();
    await expect(page.locator('#pageContent .story-end')).toHaveCount(1);
    // 再び次タップで奥付へ行き、前方向スワイプ（右へ払う）で表紙へ戻る
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await expect(page.locator('#endPage')).toBeVisible();
    await swipeOn(page, '#endPage', 0.3, 0.75, 6);
    await expect(page.locator('#coverView')).toBeVisible();
    await expect(page.locator('#endPage')).toBeHidden();
  });
});

test('扉と目次にも本文と同じアイコン（再生・家マーク）があり、目で読むでは再生だけ消える', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  const playing = (): Promise<boolean> =>
    page.evaluate(() => !(document.getElementById('audioEl') as HTMLAudioElement).paused);
  // 耳で読む：扉に両アイコンがあり、再生アイコンで入章して朗読が始まる
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gatePlayBtn')).toBeVisible();
  await expect(page.locator('#gateMenuBtn')).toBeVisible();
  await page.locator('#gatePlayBtn').click();
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  await expect.poll(playing, { timeout: 8000 }).toBe(true);
  // 朗読を止めてから目次を開く。目次にも両アイコンがあり、家マークでメニューが開く
  await page.locator('#playPauseBtn').click();
  await expect.poll(playing).toBe(false);
  await openMenuInReader(page);
  await page.locator('#tocFromMenuBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await expect(page.locator('#tocPlayBtn')).toBeVisible();
  await expect(page.locator('#tocMenuBtn')).toBeVisible();
  await page.locator('#tocMenuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
  await page.locator('#menuCloseBtn').click();
  // 目次の再生アイコンで、現在位置の章の朗読が再開する
  await page.locator('#tocPlayBtn').click();
  await expect(page.locator('#readerView')).toBeVisible();
  await expect.poll(playing, { timeout: 8000 }).toBe(true);
  // 目で読む：扉では再生アイコンだけが消え、家マークは残る
  await backToCover(page);
  await page.locator('#eyeModeBtn').click();
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gatePlayBtn')).toBeHidden();
  await expect(page.locator('#gateMenuBtn')).toBeVisible();
});

test('アイコンの位置は全画面・全モードで統一（左下＝再生、右下＝家マーク）', async ({ page }) => {
  // ボタンの中心が、画面の左右どちら寄りにあるか（0.5 が中央）
  const ratio = async (viewSel: string, btnSel: string): Promise<number> => {
    const v = await page.locator(viewSel).boundingBox();
    const b = await page.locator(btnSel).boundingBox();
    if (!v || !b) throw new Error(`box not found: ${viewSel} ${btnSel}`);
    return (b.x + b.width / 2 - v.x) / v.width;
  };
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  // 耳で読む・扉：再生は左、家マークは右
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#gateView')).toBeVisible();
  expect(await ratio('#gateView', '#gatePlayBtn')).toBeLessThan(0.5);
  expect(await ratio('#gateView', '#gateMenuBtn')).toBeGreaterThan(0.5);
  // 目で読む・扉：再生が消えても、家マークは右のまま（左へ寄らない）
  await page.locator('#gateMenuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
  await page.locator('#toCoverFromMenuBtn').click();
  await expect(page.locator('#coverView')).toBeVisible();
  await page.locator('#eyeModeBtn').click();
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('#gatePlayBtn')).toBeHidden();
  expect(await ratio('#gateView', '#gateMenuBtn')).toBeGreaterThan(0.5);
  // 目で読む・目次：家マークは右のまま
  await page.locator('#gateMenuBtn').click();
  await expect(page.locator('#menuModal')).toBeVisible();
  await page.locator('#tocFromMenuBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await expect(page.locator('#tocPlayBtn')).toBeHidden();
  expect(await ratio('#tocView', '#tocMenuBtn')).toBeGreaterThan(0.5);
  // 耳で読む・本文：再生は左、家マークは右
  // メニューから開いた目次（ここでは表紙が開いた元）は、後方操作で表紙へ戻る
  const tocBox = await page.locator('#tocView').boundingBox();
  if (!tocBox) throw new Error('tocView not found');
  for (let i = 0; i < 4 && (await page.locator('#coverView').isHidden()); i++) {
    await page.mouse.click(tocBox.x + tocBox.width * 0.85, tocBox.y + tocBox.height * 0.1);
    await page.waitForTimeout(250);
  }
  await expect(page.locator('#coverView')).toBeVisible();
  await page.locator('#earModeBtn').click();
  // 扉が出たらタップで本文へ（しおりから直接本文が開いた場合はそのまま）
  if (await page.locator('#gateView').isVisible()) {
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
  }
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  expect(await ratio('#readerView', '#playPauseBtn')).toBeLessThan(0.5);
  expect(await ratio('#readerView', '#menuBtn')).toBeGreaterThan(0.5);
});

test('初めて読むときは、どちらのモードでも目次から始まる（しおりなし）', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  // 耳で読む：扉へ直行せず、まず目次ページが開く
  await page.locator('#earModeBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  await expect(page.locator('#gateView')).toBeHidden();
  // 章を選べば扉へ進む
  await clickTocChapter(page, 0);
  await expect(page.locator('#gateView')).toBeVisible();
  // 目で読むでも同じ（新しいページ＝しおりなしの状態で確認する）
  const page2 = await page.context().newPage();
  await page2.goto('/');
  await page2.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page2.locator('#eyeModeBtn').click();
  await expect(page2.locator('#tocView')).toBeVisible();
  await expect(page2.locator('#gateView')).toBeHidden();
  await clickTocChapter(page2, 0);
  await expect(page2.locator('#gateView')).toBeVisible();
  await page2.close();
});

test('しおりがあるときは目次を経由せず、つづきから再開する', async ({ page }) => {
  await openReader(page); // 読み始める（しおりが付く）
  await backToCover(page);
  await page.locator('#eyeModeBtn').click();
  // 目次は開かず、再開の扉が直接出る
  await expect(page.locator('#tocView')).toBeHidden();
  await expect(page.locator('#gateView')).toBeVisible();
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
  await expect(page.locator('#readerView')).toBeVisible();
});

test('目次の体裁は本文・扉と揃っている：戻るピルなし、ノンブルは帯の中央、項目は上端揃えで同じ高さ（A案）', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  await page.locator('#earModeBtn').click(); // 初回は目次から始まる
  await expect(page.locator('#tocView')).toBeVisible();
  // 「戻る」ピルは無い。ノンブルは帯（.sheet-footer）の中にあり、本文と同じ .folio の体裁
  await expect(page.locator('#tocBackBtn')).toHaveCount(0);
  const m = await page.evaluate(() => {
    const sheet = document.querySelector('.toc-sheet')!.getBoundingClientRect();
    const pager = document.querySelector('#tocPager')!;
    const pagerR = pager.getBoundingClientRect();
    const items = [...document.querySelectorAll('#tocList .toc-item')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    const menuBtn = document.querySelector('#tocMenuBtn')!;
    const cs = getComputedStyle(menuBtn);
    return {
      pagerInFooter: !!pager.closest('.sheet-footer'),
      pagerText: pager.textContent || '',
      pagerCx: pagerR.left + pagerR.width / 2,
      sheetCx: sheet.left + sheet.width / 2,
      items,
      sheetTop: sheet.top,
      sheetHeight: sheet.height,
      menuBg: cs.backgroundColor,
      menuColor: cs.color,
    };
  });
  expect(m.pagerInFooter).toBe(true);
  expect(m.pagerText).toBe('― 1 / 2 ―');
  expect(Math.abs(m.pagerCx - m.sheetCx)).toBeLessThanOrEqual(2); // 帯の中央
  // A案：全項目の上端が一致し、高さも同じ（現在地の印の領域が題の長さで変わらない）
  const tops = m.items.map((i) => i.top);
  const heights = m.items.map((i) => i.height);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  // 柱の頭は版面の上から約1/3（中央寄せではなく上気味）
  const headRatio = (tops[0] - m.sheetTop) / m.sheetHeight;
  expect(headRatio).toBeGreaterThan(0.25);
  expect(headRatio).toBeLessThan(0.4);
  // 家マークは本文と同じ薄いアイコン（背景を持たない）
  expect(m.menuBg).toBe('rgba(0, 0, 0, 0)');
});

test('デザインの約束事：帯の家具は全画面で同じ部品・寸法・色・浮き（DESIGN.md の自動検証）', async ({ page }) => {
  await page.goto('/');
  await page.locator('#tocList li').first().waitFor({ state: 'attached' });
  type Band = { w: number; h: number; color: string; gap: number };
  const measure = (btnSel: string, sheetSel: string): Promise<Band> =>
    page.evaluate(
      ([b, s]) => {
        const btn = document.querySelector(b)!;
        const sheet = document.querySelector(s)!.getBoundingClientRect();
        const r = btn.getBoundingClientRect();
        return { w: r.width, h: r.height, color: getComputedStyle(btn).color, gap: sheet.bottom - r.bottom };
      },
      [btnSel, sheetSel] as const,
    );
  const expectBand = (m: Band, refColor: string) => {
    expect(Math.abs(m.w - 44)).toBeLessThanOrEqual(1); // タップ領域 44px
    expect(Math.abs(m.h - 44)).toBeLessThanOrEqual(1);
    expect(m.color).toBe(refColor); // 全画面で同じトーン
    expect(Math.abs(m.gap - 10)).toBeLessThanOrEqual(1); // 帯の浮き --band-lift: 10px
  };
  // 目次（耳で読むの入口＝初回は目次から）
  await page.locator('#earModeBtn').click();
  await expect(page.locator('#tocView')).toBeVisible();
  const tocMenu = await measure('#tocMenuBtn', '.toc-sheet');
  const tocPlay = await measure('#tocPlayBtn', '.toc-sheet');
  expectBand(tocMenu, tocMenu.color);
  expectBand(tocPlay, tocMenu.color); // 再生と家は同じ色味
  // 扉
  await clickTocChapter(page, 0);
  await expect(page.locator('#gateView')).toBeVisible();
  expectBand(await measure('#gateMenuBtn', '.gate-sheet'), tocMenu.color);
  expectBand(await measure('#gatePlayBtn', '.gate-sheet'), tocMenu.color);
  // 本文
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
  await expect(page.locator('#readerView')).toBeVisible();
  expectBand(await measure('#menuBtn', '.page'), tocMenu.color);
  expectBand(await measure('#playPauseBtn', '.page'), tocMenu.color);
  // 奥付（第七章の最後まで送る）
  await backToCover(page);
  await openMenuOnCover(page);
  await page.locator('#tocFromMenuBtn').click();
  await clickTocChapter(page, 6);
  await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
  await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
  const box = await page.locator('#pageWrap').boundingBox();
  if (!box) throw new Error('pageWrap not found');
  for (let i = 0; i < 80; i++) {
    if ((await page.locator('#pageContent .story-end').count()) > 0) break;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.waitForTimeout(50);
  }
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await expect(page.locator('#endPage')).toBeVisible();
  expectBand(await measure('#endMenuBtn', '#endPage'), tocMenu.color);
  await expect(page.locator('#endPlayBtn')).toBeHidden(); // 奥付に再生は出さない
});

test.describe('読書モード（耳で読む／目で読む）', () => {
  test('表紙に2つの入口があり、目で読むでは人の声だけが鳴らず再生ボタンも出ない（BGMとめくり音はある）', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await expect(page.locator('#earModeBtn')).toBeVisible();
    await expect(page.locator('#eyeModeBtn')).toBeVisible();
    // 音の発音フックと音声要素の再生を監視する
    await page.evaluate(() => {
      const w = window as unknown as { __sounds: number };
      w.__sounds = 0;
      document.addEventListener('app:sound', () => w.__sounds++);
    });
    await enterViaToc(page, '#eyeModeBtn');
    await expect(page.locator('#gateView')).toBeVisible();
    // 扉はコールなしで自動でも進まない（少し待っても扉のまま）
    await page.waitForTimeout(2500);
    await expect(page.locator('#gateView')).toBeVisible();
    await expect(page.locator('#readerView')).toBeHidden();
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible();
    // 再生ボタンは出ない。本文の見た目は通常どおり（ページが組まれている）
    await expect(page.locator('#playPauseBtn')).toBeHidden();
    await expect(page.locator('#pageFolio')).toHaveText('― 1 ―');
    const silent = await page.evaluate(() => {
      const a = document.getElementById('audioEl') as HTMLAudioElement;
      const g = document.getElementById('gateAudio') as HTMLAudioElement;
      return {
        bodyPaused: a.paused,
        gatePaused: g.paused,
        sounds: (window as unknown as { __sounds: number }).__sounds,
        nowCount: document.querySelectorAll('.unit.now').length,
        bgm: document.body.dataset.bgm || 'off',
      };
    });
    // 人の声（朗読・章題コール）は鳴らない。BGM は設定どおり鳴っている
    expect(silent.bodyPaused).toBe(true);
    expect(silent.gatePaused).toBe(true);
    expect(silent.nowCount).toBe(0);
    expect(silent.bgm).toBe('on');
    // 手動でページを送ると、めくり音は鳴る（朗読は始まらず、ハイライトも付かない）
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
    const after = await page.evaluate(() => ({
      sounds: (window as unknown as { __sounds: number }).__sounds,
      nowCount: document.querySelectorAll('.unit.now').length,
      bodyPaused: (document.getElementById('audioEl') as HTMLAudioElement).paused,
    }));
    expect(after.sounds).toBeGreaterThan(silent.sounds);
    expect(after.nowCount).toBe(0);
    expect(after.bodyPaused).toBe(true);
    // メニューはモード別：BGM とめくり音は出し、朗読に紐づく項目は出さない
    await openMenuInReader(page);
    await expect(page.locator('#bgmToggle')).toBeVisible();
    await expect(page.locator('#pageSoundToggle')).toBeVisible();
    await expect(page.locator('#bgPlayToggle')).toBeHidden();
    await expect(page.locator('#rowSpeed')).toBeHidden();
    // 朗読に紐づく行が無くなるので「再生」の見出しも出ない
    await expect(page.locator('#menuHeadPlay')).toBeHidden();
    await expect(page.locator('#hlToggle')).toBeHidden();
    await expect(page.locator('#fontStdBtn')).toBeVisible();
    await expect(page.locator('#rubyToggle')).toBeVisible();
    await expect(page.locator('#wakeLockToggle')).toBeVisible();
    await expect(page.locator('#tocFromMenuBtn')).toBeVisible();
  });

  test('耳で読むは従来どおり：再生ボタンが出て朗読が始まり、メニューに音の項目がある', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await enterViaToc(page, '#earModeBtn');
    await expect(page.locator('#gateView')).toBeVisible();
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible();
    await expect(page.locator('#playPauseBtn')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => !(document.getElementById('audioEl') as HTMLAudioElement).paused), { timeout: 8000 })
      .toBe(true);
    await openMenuInReader(page);
    await expect(page.locator('#bgmToggle')).toBeVisible();
    await expect(page.locator('#pageSoundToggle')).toBeVisible();
    await expect(page.locator('#rowSpeed')).toBeVisible();
    await expect(page.locator('#menuHeadAudio')).toHaveText('音');
    await expect(page.locator('#menuHeadDisplay')).toHaveText('表示');
    await expect(page.locator('#menuHeadPlay')).toHaveText('再生');
  });

  test('モードをまたいでも、しおりの位置（同じページ）から再開できる', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    // 耳で読むで入り、2ページ目まで進める
    await enterViaToc(page, '#earModeBtn');
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible({ timeout: 10000 });
    const box = await page.locator('#pageWrap').boundingBox();
    if (!box) throw new Error('pageWrap not found');
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
    // 表紙へ戻り、目で読むで入り直す → 同じページから
    await backToCover(page);
    await page.locator('#eyeModeBtn').click();
    await expect(page.locator('#gateView')).toBeVisible();
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible();
    await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
    await expect(page.locator('#playPauseBtn')).toBeHidden();
    // さらに目で読むで3ページ目へ進め、耳で読むで入り直しても同じページ
    const box2 = await page.locator('#pageWrap').boundingBox();
    if (!box2) throw new Error('pageWrap not found');
    await page.mouse.click(box2.x + box2.width * 0.2, box2.y + box2.height * 0.5);
    await expect(page.locator('#pageFolio')).toHaveText('― 3 ―');
    await backToCover(page);
    await page.locator('#earModeBtn').click();
    await page.locator('#gateView').click({ position: { x: 60, y: 300 } });
    await expect(page.locator('#readerView')).toBeVisible();
    await expect(page.locator('#pageFolio')).toHaveText('― 3 ―');
  });

  test('表紙のメニューは全項目を見出しで分けて出す', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tocList li').first().waitFor({ state: 'attached' });
    await openMenuOnCover(page);
    // 分類は全画面で 音／表示／再生 の3つ（v1.13.3 再編：モード別見出しは廃止し、
    // ナビ行には見出しを付けない）
    await expect(page.locator('#menuHeadNav')).toBeHidden();
    await expect(page.locator('#menuHeadAudio')).toHaveText('音');
    await expect(page.locator('#menuHeadDisplay')).toHaveText('表示');
    await expect(page.locator('#menuHeadPlay')).toHaveText('再生');
    // 表紙では音の項目も表示項目も再生の項目もすべて見える
    await expect(page.locator('#bgmToggle')).toBeVisible();
    await expect(page.locator('#pageSoundToggle')).toBeVisible();
    await expect(page.locator('#rowSpeed')).toBeVisible();
    await expect(page.locator('#fontStdBtn')).toBeVisible();
    await expect(page.locator('#wakeLockToggle')).toBeVisible();
    await expect(page.locator('#hlToggle')).toBeVisible();
    // 分類の中身：音＝めくり音・BGM／表示＝強調・画面を暗くしない ほか／
    // 再生＝速度・バックグラウンド再生
    const grouping = await page.evaluate(() => ({
      soundInAud: !!document.querySelector('#menuGroupAudio #rowPageSound'),
      bgmInAud: !!document.querySelector('#menuGroupAudio #rowBgm'),
      speedInPlay: !!document.querySelector('#menuGroupPlay #rowSpeed'),
      bgPlayInPlay: !!document.querySelector('#menuGroupPlay #rowBgPlay'),
      hlInDis: !!document.querySelector('#menuGroupDisplay #rowHl'),
      wakeInDis: !!document.querySelector('#menuGroupDisplay #rowWake'),
    }));
    expect(grouping).toEqual({
      soundInAud: true,
      bgmInAud: true,
      speedInPlay: true,
      bgPlayInPlay: true,
      hlInDis: true,
      wakeInDis: true,
    });
    // 棚卸し（v1.13.2）：末尾の「設定」グループは廃止され、インストール案内は
    // ナビゲーションのグループに統合されている。見える見出しは3分類だけ
    const audit = await page.evaluate(() => ({
      installInNav: !!document.querySelector('#menuGroupNav #install-open'),
      heads: [...document.querySelectorAll<HTMLElement>('#menuModal .setting-group')]
        .filter((h) => !h.hidden)
        .map((h) => h.textContent),
    }));
    expect(audit.installInNav).toBe(true);
    expect(audit.heads).toEqual(['音', '表示', '再生']);
    // 閉じるは楕円ピルではなく×アイコン（文字なし・44px・右上）
    const closeBtn = page.locator('#menuCloseBtn');
    await expect(closeBtn).toHaveText('');
    const closeBox = await closeBtn.boundingBox();
    expect(closeBox?.width).toBe(44);
    expect(closeBox?.height).toBe(44);
    await page.locator('#menuCloseBtn').click();
    // 本文メニューの項目順は本の並び順：表紙に戻る が上で、目次を開く が下
    await openReader(page);
    await openMenuInReader(page);
    const toCoverBox = await page.locator('#toCoverFromMenuBtn').boundingBox();
    const tocBox = await page.locator('#tocFromMenuBtn').boundingBox();
    const installBox = await page.locator('#install-open').boundingBox();
    expect(toCoverBox!.y).toBeLessThan(tocBox!.y);
    expect(tocBox!.y).toBeLessThan(installBox!.y);
    await page.locator('#menuCloseBtn').click();
  });
});

test('復帰を繰り返してもBGMのマスターゲインは1つだけが生きている（二重化しない）', async ({ page }) => {
  /* 実機報告「復帰時に音が大きくなる／出なくなる」への回帰テスト（自動化できる範囲）。
     AudioContext を差し替えて、BGM のマスターゲイン（設定値 0.84 へランプする
     ゲイン）の生成と切断を記録する。背面→前面の往復（BGM が止まる→立つ経路）を
     繰り返したあと、生きているマスターがちょうど1つで、その値が設定値を
     超えていないことを数値で確認する。世代やゲインが積み重なる実装になると
     ここで落ちる。割り込み時の予約滞留（iOS 実機でしか再現できない分）は
     sound.ts の世代作り直しで対処し、本テストの対象外 */
  await page.addInitScript(() => {
    interface MasterRec { node: GainNode; disconnected: boolean }
    const probe = { masters: [] as MasterRec[] };
    (window as unknown as { __bgmProbe: typeof probe }).__bgmProbe = probe;
    const OrigAC = window.AudioContext;
    const origCreateGain = OrigAC.prototype.createGain;
    OrigAC.prototype.createGain = function () {
      const g = origCreateGain.call(this);
      const p = g.gain;
      const origLin = p.linearRampToValueAtTime.bind(p);
      p.linearRampToValueAtTime = (v: number, t: number) => {
        if (Math.abs(v - 0.84) < 0.01) probe.masters.push({ node: g, disconnected: false });
        return origLin(v, t);
      };
      const origDisc = g.disconnect.bind(g);
      g.disconnect = (...args: []) => {
        const rec = probe.masters.find((m) => m.node === g);
        if (rec) rec.disconnected = true;
        return (origDisc as (...a: unknown[]) => void)(...args);
      };
      return g;
    };
  });
  await page.goto('/');
  await expect(page.locator('#tocList li')).toHaveCount(7);
  await enterViaToc(page, '#earModeBtn');
  await expect(page.locator('#gateView')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on');
  const gateBox = await page.locator('#gateView').boundingBox();
  if (!gateBox) throw new Error('gateView の矩形が取れない');
  await page.mouse.click(gateBox.x + gateBox.width * 0.15, gateBox.y + gateBox.height * 0.5);
  await expect(page.locator('#readerView')).toBeVisible();
  await page.locator('#playPauseBtn').click(); // 朗読を止める（BGM が stop→start する復帰経路）
  const setHidden = async (hidden: boolean): Promise<void> => {
    await page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  };
  for (let i = 0; i < 3; i++) {
    await setHidden(true);
    await page.waitForTimeout(300);
    await setHidden(false);
    await page.waitForTimeout(300);
  }
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on');
  await page.waitForTimeout(3000); // 最後のフェードイン（2.5秒）が終わるまで待つ
  const result = await page.evaluate(() => {
    const probe = (window as unknown as { __bgmProbe: { masters: Array<{ node: GainNode; disconnected: boolean }> } }).__bgmProbe;
    const live = probe.masters.filter((m) => !m.disconnected);
    return { created: probe.masters.length, liveCount: live.length, liveValues: live.map((m) => m.node.gain.value) };
  });
  expect(result.created).toBeGreaterThanOrEqual(4); // 初回＋復帰3回ぶんの世代が作られた
  expect(result.liveCount).toBe(1); // 生きているマスターは1つだけ（積み重なっていない）
  expect(result.liveValues[0]).toBeGreaterThan(0.8);
  expect(result.liveValues[0]).toBeLessThanOrEqual(0.84); // 設定値を超えない
  // 効果音も復帰後に鳴る（同じ AudioContext の回復を確認）：めくりで app:sound が出る
  await page.evaluate(() => {
    const w = window as unknown as { __pageSounds: number };
    w.__pageSounds = 0;
    document.addEventListener('app:sound', (e) => {
      if ((e as CustomEvent).detail?.kind === 'page-turn') w.__pageSounds++;
    });
  });
  const box = await page.locator('#readerView').boundingBox();
  if (!box) throw new Error('readerView の矩形が取れない');
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, cy, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#pageFolio')).toHaveText('― 2 ―');
  expect(await page.evaluate(() => (window as unknown as { __pageSounds: number }).__pageSounds)).toBeGreaterThanOrEqual(1);
});

test('バックグラウンドへ移るときは、BGMを速くフェードしてから自分で suspend する（移行時ノイズ対策）', async ({ page }) => {
  /* 実機報告「アプリがバックグラウンドへ移行するときにノイズが鳴る」への対策の
     順序保証を、Chromium で観測できる範囲で固定する：
     (1) 背面化で BGM マスターが速やかに（約0.15秒の指数フェード）ほぼ 0 になる
     (2) その後、AudioContext が自分から suspended になる（OS に「鳴ったまま
         切られる」状態を作らない）
     (3) 前面に戻れば従来どおり BGM が立て直り、コンテキストも running に戻る
     iOS の割り込みそのものは Chromium では再現できないため、ここで固定するのは
     「フェード → suspend」の処理順序と、復帰経路が壊れていないことまで */
  await page.addInitScript(() => {
    const OrigAC = window.AudioContext;
    class ProbeAC extends OrigAC {
      constructor() {
        super();
        (window as unknown as { __ac: AudioContext }).__ac = this;
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = ProbeAC;
    // マスター（0.84 へランプするゲイン）を捕まえる（既存の二重化テストと同じ手口）
    const probe = { masters: [] as GainNode[] };
    (window as unknown as { __masters: typeof probe }).__masters = probe;
    const origCreateGain = OrigAC.prototype.createGain;
    OrigAC.prototype.createGain = function () {
      const g = origCreateGain.call(this);
      const origLin = g.gain.linearRampToValueAtTime.bind(g.gain);
      g.gain.linearRampToValueAtTime = (v: number, t: number) => {
        if (Math.abs(v - 0.84) < 0.01) probe.masters.push(g);
        return origLin(v, t);
      };
      return g;
    };
  });
  await openReader(page);
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on');
  await page.locator('#playPauseBtn').click(); // 朗読を止める（bgPlay の継続経路ではなく、停止の経路を通す）
  const setHidden = async (hidden: boolean): Promise<void> => {
    await page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  };
  const acState = (): Promise<string> => page.evaluate(() => (window as unknown as { __ac: AudioContext }).__ac.state);
  const masterValue = (): Promise<number> =>
    page.evaluate(() => {
      const ms = (window as unknown as { __masters: { masters: GainNode[] } }).__masters.masters;
      return ms.length ? ms[ms.length - 1].gain.value : -1;
    });
  await expect.poll(acState).toBe('running');
  await setHidden(true);
  // (1) マスターが速やかにほぼ 0 へ落ちる
  await expect.poll(masterValue, { timeout: 3000 }).toBeLessThan(0.01);
  // (2) その後、自分から suspended になる
  await expect.poll(acState, { timeout: 3000 }).toBe('suspended');
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'off');
  // (3) 前面に戻れば BGM が立て直り、コンテキストも running に戻る
  await setHidden(false);
  await expect(page.locator('body')).toHaveAttribute('data-bgm', 'on');
  await expect.poll(acState, { timeout: 5000 }).toBe('running');
});
