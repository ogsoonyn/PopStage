import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const setCam = (page: Page, c: { yaw?: number; zoom?: number; x?: number; y?: number }) => page.evaluate(c => {
  const cam = (window as any).popstage.project.camera;
  cam.yaw = c.yaw ?? 0; cam.pitch = 0; cam.zoom = c.zoom ?? 1.5; cam.target = { x: c.x ?? 0, y: c.y ?? 0, z: 0 };
}, c);

test('キーフレームの経路: 枠・番号・矢印・秒数を重ね、番号でその視点へ移る。再生中・別のタブ・オフでは消える', async ({ page }) => {
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
  await expect(overlay.locator('.kp-frame')).toHaveCount(3);
  await expect(overlay.locator('.kp-arrow')).toHaveCount(3);
  await expect(overlay.locator('.kp-path.back')).toHaveCount(1);
  await expect(overlay.locator('.kp-sec text')).toHaveText(['1.0秒', '2.5秒', '1.0秒']);
  // 番号の位置は、そのフレームで画面の中心に来る所(2番は右上へ動かした所なので、1番より右・上)
  const pos = await overlay.locator('.kp-mark').evaluateAll(gs => gs.map(g => { const r = g.getBoundingClientRect(); return [r.x, r.y]; }));
  expect(pos[1][0]).toBeGreaterThan(pos[0][0]); expect(pos[1][1]).toBeLessThan(pos[0][1]);
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
  await expect(overlay.locator('.kp-arrow')).toHaveCount(0);
  await expect(overlay.locator('.kp-sec')).toHaveCount(2);
  const pos = await overlay.locator('.kp-mark').evaluateAll(gs => gs.map(g => { const r = g.getBoundingClientRect(); return [r.x, r.y]; }));
  expect(pos[1][0] - pos[0][0]).toBeGreaterThan(15); expect(Math.abs(pos[1][1] - pos[0][1])).toBeLessThan(1);
});
