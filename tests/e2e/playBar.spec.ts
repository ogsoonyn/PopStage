import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);

const setCam = (page: Page, c: { zoom?: number; x?: number }) => page.evaluate(c => {
  const cam = (window as any).popstage.project.camera;
  cam.yaw = 0; cam.pitch = 0; cam.zoom = c.zoom ?? 1.5; cam.target = { x: c.x ?? 0, y: 0, z: 0 };
}, c);

/** キーフレーム3つ(2番は弾む)で動きを作って再生する */
async function playKeys(page: Page): Promise<void> {
  await openTab(page, 'anim');
  await setCam(page, {});
  await page.locator('#keyAdd').click();
  await setCam(page, { x: 300 });
  await page.locator('#keyAdd').click();
  await setCam(page, { x: -300 });
  await page.locator('#keyAdd').click();
  await page.locator('#keyList .key-row[data-key="1"] [data-act=mode]').selectOption('bounce');
  await page.locator('#keyMake').click();
  expect(await app(page, a => a.takeState)).toBe('playing');
}

test('再生の進み具合: 再生中だけ主ビューの下に出て、キーの番号・時間・一時停止・シーク・停止ができる', async ({ page }) => {
  await boot(page);
  const bar = page.locator('#playBar');
  await expect(bar).toBeHidden();
  await playKeys(page);
  await expect(bar).toBeVisible();
  // 主ビューの下端に置く(上半分には出さない)
  const [b, v] = await Promise.all([bar.boundingBox(), page.locator('#stageWrap').boundingBox()]);
  expect(b!.y + b!.height).toBeGreaterThan(v!.y + v!.height - 40);
  expect(b!.y + b!.height).toBeLessThanOrEqual(v!.y + v!.height);
  // キーの番号は形で通り方を見分ける
  const keys = page.locator('#playKeys .play-key');
  await expect(keys).toHaveText(['1', '2', '3']);
  await expect(keys.nth(1)).toHaveAttribute('data-mode', 'bounce');
  await expect(page.locator('#playTime')).toContainText('/ 3.0秒');
  await expect(page.locator('#playCam')).toBeEnabled();

  // 一時停止すると位置が進まない。続けると進む
  await page.locator('#playPause').click();
  await expect(page.locator('#playPause')).toHaveAttribute('aria-pressed', 'true');
  const held = await app(page, a => a.takePosition);
  await page.waitForTimeout(300);
  expect(await app(page, a => a.takePosition)).toBe(held);
  await expect(page.locator('#takeInfo')).toHaveText('一時停止中');

  // 番号を押すと、そのフレームの時刻へ移る(一時停止のまま)
  await keys.nth(1).click();
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['playing', true]);
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  await expect.poll(() => app(page, a => a.playView.target.x)).toBeCloseTo(300, 0);

  // トラックをドラッグすると位置が動き、離すと元の状態(一時停止)に戻る
  const t = (await page.locator('#playTrack').boundingBox())!;
  await page.mouse.move(t.x + t.width * 0.1, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width * 0.75, t.y + t.height / 2, { steps: 5 });
  expect(await app(page, a => a.takePosition)).toBeCloseTo(2.25, 1);
  await page.mouse.up();
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['playing', true]);

  // キーで動かす(Home は視点のリセットに渡さない)
  await page.locator('#playTrack').focus();
  await page.keyboard.press('Home');
  expect(await app(page, a => a.takePosition)).toBe(0);
  await page.keyboard.press('ArrowRight');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(0.5, 2);
  // PageDown・PageUp は次・前の番号の時刻へ
  await page.keyboard.press('PageDown');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  await page.keyboard.press('PageDown');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(2, 1);
  await page.keyboard.press('PageUp');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  // 修飾キー付きはショートカットに渡す(Shift+Home はカメラを戻す。位置は変えない)
  await app(page, a => { a.project.camera.yaw = 0.7; });
  await page.keyboard.press('Shift+Home');
  expect(await app(page, a => a.project.camera.yaw)).toBe(0);
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);

  // Shift+L でも一時停止を切り替えられる
  await page.keyboard.press('Shift+L');
  await expect(page.locator('#playPause')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Shift+L');
  await expect(page.locator('#playPause')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#playPause').click();
  await expect.poll(() => app(page, a => a.takePosition)).not.toBeCloseTo(1, 1);
  await expect(page.locator('#takeInfo')).toHaveText('再生中');

  await page.locator('#playStop').click();
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['idle', false]);
  await expect(bar).toBeHidden();
});

test('再生の進み具合: 記録中は赤いバーで最長までの進みを出し、■ で止める。3面図が出ているときはその左まで', async ({ page }) => {
  await boot(page);
  await app(page, a => a.setPaused(false));
  await app(page, a => a.startRecording());
  const bar = page.locator('#playBar');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/recording/);
  await expect(page.locator('#playTime')).toContainText('/ 60.0秒');
  await expect(page.locator('#playPause')).toBeHidden();
  await expect(page.locator('#playCam')).toBeHidden();
  await expect(page.locator('#playKeys .play-key')).toHaveCount(0);
  // 何もしていない所は詰められるので、つかんで引っぱってから止める
  await app(page, a => {
    a.world.grab = { x: 0.2, y: 0, z: 0 }; a.world.grabGains.set(a.doc.layers[0].id, 1);
    for (let i = 0; i < 40; i++) a.frame(1 / 60);
    a.world.grab = null; a.world.grabGains.clear();
    for (let i = 0; i < 60; i++) { a.project.camera.yaw += 0.01; a.frame(1 / 60); }
  });
  await page.locator('#playStop').click();
  expect(await app(page, a => [a.takeState, !!a.project.take])).toEqual(['idle', true]);
  await expect(bar).toBeHidden();

  // 3面図を出すと、バーはその左までになる
  await app(page, a => { a.view.multi = true; a.syncView(); a.playTake(); });
  await expect(bar).toBeVisible();
  const [b, m] = await Promise.all([bar.boundingBox(), page.locator('#multiView').boundingBox()]);
  expect(b!.x + b!.width).toBeLessThanOrEqual(m!.x);
  // 記録した操作(キーフレームでない)には番号を出さない
  await expect(page.locator('#playKeys .play-key')).toHaveCount(0);
});
