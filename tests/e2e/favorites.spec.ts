import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
const rows = (page: Page) => page.locator('#favList > li');

test('お気に入り: K で残し、設定を変えても「適用」で戻せる。適用はアンドゥでき、名前の変更・上書き・削除もできる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  await expect(page.locator('#favEmpty')).toBeVisible();
  await expect(page.locator('#favCount')).toHaveText('0/30');

  // 残す(K)
  await page.locator('#view').focus();
  await page.keyboard.press('k');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('#favEmpty')).toBeHidden();
  await expect(rows(page).first().locator('[data-act=name]')).toHaveValue('お気に入り 1');
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
  const saved = await app(page, a => ({ physics: structuredClone(a.doc.layers[0].physics), pop: a.doc.layers[0].pop, period: a.project.autoSwing.period, yaw: a.project.camera.yaw }));

  // 設定を変えると印が消える
  await openTab(page, 'layer');
  await page.locator('#pPreset').selectOption('tame');
  await app(page, a => { a.store.patchLayer(a.doc.layers[0].id, { pop: 500 }); a.project.camera.yaw += 1; });
  await openTab(page, 'anim');
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'false');

  // 適用すると戻る(視点も)
  await rows(page).first().locator('[data-act=apply]').click();
  expect(await app(page, a => ({ physics: a.doc.layers[0].physics, pop: a.doc.layers[0].pop, period: a.project.autoSwing.period, yaw: a.project.camera.yaw }))).toEqual(saved);
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');

  // 適用はアンドゥで戻せる(視点は戻さない)
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  expect(await app(page, a => [a.doc.layers[0].physics.preset, a.doc.layers[0].pop])).toEqual(['tame', 500]);
  expect(await app(page, a => a.project.camera.yaw)).toBeCloseTo(saved.yaw);

  // 今の状態で上書きすると、印が付く
  await rows(page).first().locator('[data-act=set]').click();
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
  expect(await app(page, a => a.project.favorites[0].layers[0].pop)).toBe(500);

  // 名前はその場で変える(Enter で確定。空にしたら元に戻る)
  const name = rows(page).first().locator('[data-act=name]');
  await name.fill('ぼよん最高');
  await name.press('Enter');
  expect(await app(page, a => a.project.favorites[0].name)).toBe('ぼよん最高');
  await name.fill('  ');
  await name.press('Enter');
  await expect(name).toHaveValue('ぼよん最高');
  // 名前の入力中は K でお気に入りが増えない
  await name.focus();
  await page.keyboard.press('k');
  await name.press('Escape');
  await expect(name).toHaveValue('ぼよん最高');
  await expect(rows(page)).toHaveCount(1);

  // 左のツールバーからも残せる。2件目は次の番号になる
  await page.locator('#toolNav [data-cmd=addFavorite]').click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1).locator('[data-act=name]')).toHaveValue('お気に入り 2');

  // 消す(アンドゥで戻る)
  await rows(page).first().locator('[data-act=del]').click();
  await expect(rows(page)).toHaveCount(1);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('#favCount')).toHaveText('2/30');
});

test('お気に入り: 記録を再生しているときに残すと、適用で記録と再生まで戻る', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  // キーフレームから動きを作って再生する
  await app(page, a => {
    a.project.camera.yaw = 0; a.addKey();
    a.project.camera.yaw = 0.8; a.addKey();
    a.makeKeyTake();
  });
  expect(await app(page, a => a.takeState)).toBe('playing');
  await page.locator('#favAdd').click();
  expect(await app(page, a => a.project.favorites[0].playing)).toBe(true);
  await expect(rows(page).first().locator('.fav-sub')).toContainText('キーフレーム');

  // 記録を消し、視点を変えてから適用する
  await app(page, a => { a.clearTake(); a.project.camera.zoom = 3; });
  expect(await app(page, a => [a.project.take, a.takeState])).toEqual([null, 'idle']);
  await rows(page).first().locator('[data-act=apply]').click();
  expect(await app(page, a => [a.project.take === a.project.favorites[0].take, a.takeState])).toEqual([true, 'playing']);
  expect(await app(page, a => a.project.camera.zoom)).toBeCloseTo(1);

  // 記録中は残せない
  await app(page, a => a.startRecording());
  await expect(page.locator('#favAdd')).toBeDisabled();
  await expect(rows(page).first().locator('[data-act=apply]')).toBeDisabled();
  await app(page, a => a.stopRecording());
  await expect(page.locator('#favAdd')).toBeEnabled();
});

test('お気に入り: 保存したファイルを開き直しても残っている', async ({ page }) => {
  await boot(page);
  await app(page, a => { a.addFavorite(); a.addFavorite(); a.renameFavorite(a.project.favorites[1].id, 'ふたつめ'); });
  await app(page, async a => {
    const { serializeProject } = await import('/src/storage/popstage.ts');
    await a.openProjectBytes(serializeProject(a.project), 'x.pukupop', null);
  });
  await openTab(page, 'anim');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1).locator('[data-act=name]')).toHaveValue('ふたつめ');
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
});
