import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';

// スマホ(Android の Chrome 相当)の画面と指の操作。指は CDP でタッチを送って再現する
const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
test.use({ ...pixel, deviceScaleFactor: 1 });

async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?e2e');
  await page.waitForFunction(() => {
    const a = (window as any).popstage;
    return a?.doc && a.stage.hasDocument && a.paused;
  });
  expect(errors).toEqual([]);
}

type Pt = [number, number];
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
}
/** 指を置いて、from から to へ steps 回に分けて動かして離す。from と to は指ごとの位置 */
async function swipe(cdp: CDPSession, from: Pt[], to: Pt[], steps = 8): Promise<void> {
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', from.map((p, j) => [p[0] + (to[j][0] - p[0]) * i / steps, p[1] + (to[j][1] - p[1]) * i / steps]));
  await touch(cdp, 'touchEnd', []);
}
async function viewCenter(page: Page): Promise<Pt> {
  const b = (await page.locator('#view').boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2];
}
const weightSum = (page: Page) => page.evaluate(() => (window as any).popstage.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0));

test('スマホ幅では3Dビューが全面に出て、PC のパネルは隠れる', async ({ page }) => {
  await boot(page);
  await expect(page.locator('html')).toHaveClass(/mobile/);
  await expect(page.locator('#toolNav')).toBeHidden();
  await expect(page.locator('#menubar')).toBeHidden();
  await expect(page.locator('#mTools')).toBeVisible();
  const view = (await page.locator('#view').boundingBox())!;
  expect(view.width).toBeGreaterThan(400);
  // 塗りのツールは「塗って直す」の奥にあるので、最初はつかむ
  await expect(page.locator('#mTools [data-mtool="grab"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mTools [data-mtool="brush"]')).toBeHidden();
  await expect(page.locator('#mTools [data-mtool="inflate"]')).toBeHidden();
  await expect(page.locator('#mTools [data-mtool="pan"]')).toBeVisible();
});

test('「移動」では1本指で画像を動かし、画像の上でも外でも回転しない', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('#mTools [data-mtool="pan"]').click();
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { x: c.target.x, y: c.target.y, z: c.target.z, yaw: c.yaw, pitch: c.pitch }; });
  const before = await weightSum(page), c0 = await cam();
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx, cy]], [[cx + 80, cy + 40]]);
  const c1 = await cam();
  expect(Math.hypot(c1.x - c0.x, c1.y - c0.y, c1.z - c0.z)).toBeGreaterThan(0);
  expect([c1.yaw, c1.pitch]).toEqual([c0.yaw, c0.pitch]);
  // 画像の外(上の端)から始めても回転せず、動かす
  const b = (await page.locator('#view').boundingBox())!;
  await swipe(cdp, [[cx, b.y + 12]], [[cx - 60, b.y + 40]]);
  const c2 = await cam();
  expect(Math.hypot(c2.x - c1.x, c2.y - c1.y, c2.z - c1.z)).toBeGreaterThan(0);
  expect([c2.yaw, c2.pitch]).toEqual([c0.yaw, c0.pitch]);
  expect(await weightSum(page)).toBe(before);
});

test('シートを開くと3Dビューはシートの上に縮み、シートの中身は下のバーに隠れない', async ({ page }) => {
  await boot(page);
  const closed = (await page.locator('#view').boundingBox())!.height;
  await page.locator('[data-mtab="motion"]').click();
  await page.waitForTimeout(400);
  await expect(page.locator('#mSheet #pPop')).toBeVisible();
  expect((await page.locator('#view').boundingBox())!.height).toBeLessThan(closed - 100);
  const sheet = (await page.locator('#mSheet').boundingBox())!, bar = (await page.locator('#mTools').boundingBox())!;
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(bar.y + 1);
  // いちばん下まで送ると、最後の項目がシートの中に見える
  await page.locator('#mPanes').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const last = (await page.locator('#pAutoStr').boundingBox())!;
  expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
  // つまみを押すたびに 半分 → 全部 → 閉じる
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'full');
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'closed');
});

test('プリセットはシートのボタンで選べる', async ({ page }) => {
  await boot(page);
  const chip = page.locator('#mPresets button').nth(1);
  const value = await chip.getAttribute('data-value');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.physics.preset)).toBe(value);
});

test('2本指で平行移動とピンチズームができ、画像の外をなぞると回転する', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { zoom: c.zoom, x: c.target.x, yaw: c.yaw }; });
  const [cx, cy] = await viewCenter(page);
  const before = await cam();
  // 画像の外(上の端)を1本指でなぞると回転
  const top = (await page.locator('#view').boundingBox())!.y + 20;
  await swipe(cdp, [[cx - 60, top]], [[cx + 60, top]]);
  expect((await cam()).yaw).not.toBeCloseTo(before.yaw, 3);
  // 指を広げると近づく
  await swipe(cdp, [[cx - 40, cy], [cx + 40, cy]], [[cx - 120, cy], [cx + 120, cy]]);
  const pinched = await cam();
  expect(pinched.zoom).toBeLessThan(before.zoom * 0.6);
  // 2本指をそろえて動かすと平行移動
  await swipe(cdp, [[cx - 40, cy], [cx + 40, cy]], [[cx + 20, cy], [cx + 100, cy]]);
  expect((await cam()).x).not.toBeCloseTo(pinched.x, 5);
});

test('2本指タップで戻し、3本指タップでやり直す', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => (window as any).popstage.addLayer());
  const layers = () => page.evaluate(() => (window as any).popstage.doc.layers.length);
  expect(await layers()).toBe(2);
  const [cx, cy] = await viewCenter(page);
  // タップは 300ms 以内に離したものだけなので、起動直後の重い描画が落ち着いてから送る
  await page.waitForTimeout(1000);
  // 指が少し震えても(それぞれの指が置いた所からわずかに動いても)タップとみなす
  await touch(cdp, 'touchStart', [[cx - 60, cy], [cx + 60, cy]]);
  await touch(cdp, 'touchMove', [[cx - 58, cy + 2], [cx + 62, cy - 2]]);
  await touch(cdp, 'touchEnd', []);
  expect(await layers()).toBe(1);
  await touch(cdp, 'touchStart', [[cx - 40, cy], [cx, cy], [cx + 40, cy]]); await touch(cdp, 'touchEnd', []);
  expect(await layers()).toBe(2);
});

test('「塗って直す」の膨らみで範囲を描くと「ツール」タブで決めて適用できる', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await page.locator('#mTools [data-mtool="inflate"]').click();
  const before = await weightSum(page);
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx - 60, cy - 40]], [[cx + 60, cy + 40]]);
  expect(await page.evaluate(() => (window as any).popstage.previewingInflate)).toBe(true);
  await expect(page.locator('[data-mtab="tool"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inflApply')).toBeVisible();
  await page.locator('#inflApply').click();
  expect(await page.evaluate(() => (window as any).popstage.previewingInflate)).toBe(false);
  expect(await weightSum(page)).toBeGreaterThan(before);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'closed');
});

test('「塗って直す」で塗れ、2本目の指を置くと塗りは取り消される', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await expect(page.locator('#mTools [data-mtool="brush"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mModeBar')).toBeVisible();
  const [cx, cy] = await viewCenter(page);
  const before = await weightSum(page), dirty0 = await page.evaluate(() => (window as any).popstage.dirty);
  // 1本指で塗りかけてから2本目を置く → 塗った分は消え、アンドゥにも残らない
  await touch(cdp, 'touchStart', [[cx - 80, cy + 60]]);
  for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [[cx - 80 + i * 15, cy + 60]]);
  expect(await weightSum(page)).not.toBe(before);
  await touch(cdp, 'touchStart', [[cx - 80 + 90, cy + 60], [cx + 60, cy - 60]]);
  await touch(cdp, 'touchEnd', []);
  expect(await weightSum(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).popstage.history.canUndo)).toBe(false);
  // 取り消した塗りでは「未保存」にならない
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(dirty0);
  // 1本指で塗ると残る
  await swipe(cdp, [[cx - 80, cy + 60]], [[cx + 20, cy + 60]]);
  expect(await weightSum(page)).not.toBe(before);
  await page.locator('#mPaintDone').click();
  await expect(page.locator('#mTools [data-mtool="grab"]')).toHaveAttribute('aria-pressed', 'true');
});

test('幅を広げると PC の配置に戻る', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('html')).not.toHaveClass(/mobile/);
  await expect(page.locator('#toolNav')).toBeVisible();
  await expect(page.locator('#mTools')).toBeHidden();
  // 移していた部品は右のパネルへ戻る
  expect(await page.locator('#pPop').evaluate(el => !!el.closest('aside'))).toBe(true);
  expect(await page.locator('#layerList').evaluate(el => !!el.closest('aside'))).toBe(true);
  expect(await page.locator('#inflateDialog').evaluate(el => el.parentElement === document.body)).toBe(true);
});
