import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const setCam = (page: Page, c: { yaw?: number; zoom?: number; x?: number; y?: number }) => page.evaluate(c => {
  const cam = (window as any).popstage.project.camera;
  cam.yaw = c.yaw ?? 0; cam.pitch = 0; cam.zoom = c.zoom ?? 1.5; cam.target = { x: c.x ?? 0, y: c.y ?? 0, z: 0 };
}, c);

test('キーフレームの経路: 各フレームの絵のゴースト・輪郭・番号・矢印・秒数を重ね、番号でその視点へ移る。再生中・別のタブ・オフでは消える', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  const overlay = page.locator('#keyPath');
  await expect(overlay).toBeHidden();
  await setCam(page, { zoom: 2.5 });
  await page.locator('#keyAdd').click();
  await setCam(page, { zoom: 2.5, x: 400, y: 250 });
  await page.locator('#keyAdd').click();
  await setCam(page, { zoom: 2.5, x: -350, y: -200 });
  await page.locator('#keyAdd').click();
  await page.locator('#keyList > li').nth(1).locator('[data-act=sec]').fill('2.5');
  await page.locator('#keyList > li').nth(1).locator('[data-act=sec]').dispatchEvent('change');
  // 全体が見える視点から確かめる
  await setCam(page, { zoom: 4 });
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.kp-mark')).toHaveCount(3);
  await expect(overlay.locator('.kp-mark text')).toHaveText(['1', '2', '3']);
  await expect(overlay.locator('.kp-outline:not(.kp-halo)')).toHaveCount(3);
  await expect(overlay.locator('canvas.kp-ghost')).toHaveCount(3);
  await expect(overlay.locator('.kp-arrow:not(.kp-halo)')).toHaveCount(3);
  await expect(overlay.locator('.kp-path.back:not(.kp-halo)')).toHaveCount(1);
  await expect(overlay.locator('.kp-sec text')).toHaveText(['1.0秒', '2.5秒', '1.0秒']);
  // 番号は、そのフレームで画面に映る絵の中心(2番は注視点を右上へ動かしたので、絵は左下に映る)
  const marks = () => overlay.locator('.kp-mark').evaluateAll(gs => gs.map(g => { const r = g.getBoundingClientRect(); return [r.x, r.y]; }));
  await expect.poll(async () => { const p = await marks(); return p[1][0] < p[0][0] && p[1][1] > p[0][1]; }).toBe(true);
  // 今の視点を動かしても、重ねた絵と番号は動かない
  const before = await marks();
  await setCam(page, { zoom: 1.2, yaw: 0.5 });
  await page.waitForTimeout(200);
  expect(await marks()).toEqual(before);
  await page.screenshot({ path: test.info().outputPath('keypath.png') });

  // 番号を押すとその視点へ。今の視点のフレームは強める
  await overlay.locator('.kp-mark').nth(1).click();
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBe(400);
  await expect(overlay.locator('.kp-mark').nth(1)).toHaveClass(/strong/);

  // 一覧の行に乗せたフレームを強める
  await page.locator('#keyList > li').nth(2).hover();
  await expect(overlay.locator('.kp-mark').nth(2)).toHaveClass(/strong/);

  // 再生中は消える
  await page.locator('#keyMake').click();
  await expect(overlay).toBeHidden();
  await page.evaluate(() => (window as any).popstage.stopTake());
  await expect(overlay).toBeVisible();

  // 書き出し中は消える
  await page.evaluate(() => { const a = (window as any).popstage; a.exporting = true; a.emit('status', undefined); });
  await expect(overlay).toBeHidden();
  await page.evaluate(() => { const a = (window as any).popstage; a.exporting = false; a.emit('status', undefined); });
  await expect(overlay).toBeVisible();

  // 番号の上のホイールでもズームする
  const z0 = await page.evaluate(() => (window as any).popstage.project.camera.zoom);
  await overlay.locator('.kp-mark').nth(0).hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => (window as any).popstage.project.camera.zoom)).not.toBe(z0);

  // 別のタブでは消える
  await openTab(page, 'view');
  await expect(overlay).toBeHidden();
  await openTab(page, 'anim');
  await expect(overlay).toBeVisible();

  // オフにすると消え、ブラウザに覚える
  await page.locator('#keyPathShow').uncheck();
  await expect(overlay).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => (window as any).popstage?.doc);
  await expect(page.locator('#keyPathShow')).not.toBeChecked();
});

test('キーフレームの経路: 回転・ズームだけのフレームは番号を横に並べ、秒数を番号の下に出す', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  await setCam(page, { yaw: 0 });
  await page.locator('#keyAdd').click();
  await setCam(page, { yaw: 0.4, zoom: 2 });
  await page.locator('#keyAdd').click();
  const overlay = page.locator('#keyPath');
  await expect(overlay.locator('.kp-mark')).toHaveCount(2);
  await expect(overlay.locator('.kp-arrow:not(.kp-halo)')).toHaveCount(0);
  await expect(overlay.locator('.kp-sec')).toHaveCount(2);
  const marks = () => overlay.locator('.kp-mark').evaluateAll(gs => gs.map(g => { const r = g.getBoundingClientRect(); return [r.x, r.y]; }));
  await expect.poll(async () => { const p = await marks(); return p[1][0] - p[0][0] > 15 && Math.abs(p[1][1] - p[0][1]) < 1; }).toBe(true);
});
