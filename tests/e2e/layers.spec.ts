/** 複数のレイヤーを選んでまとめて変える操作と、ウェイトの重ね表示(OFF / 選択中 / 全レイヤー) */
import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);

/** サンプルにレイヤーを足して3枚にし、それぞれに値を入れる(一覧の下から順に A / B / C) */
async function threeLayers(page: Page): Promise<void> {
  await boot(page);
  await app(page, a => {
    a.addLayer(); a.addLayer();
    const [l0, l1, l2] = a.doc.layers;
    a.store.patchLayer(l0.id, { name: 'A', pop: 100, blend: 'add' });
    a.store.patchLayer(l1.id, { name: 'B', pop: 200, blend: 'max', physics: { ...l1.physics, motion: 'piston', hardness: 0.2 } });
    a.store.patchLayer(l2.id, { name: 'C', pop: 0, blend: 'add' });
    a.history.clear();
  });
}

/** 一覧の行(上ほど手前なので、名前で探す) */
const row = (page: Page, name: string) => page.locator('#layerList li', { hasText: name });
const selected = (page: Page) => app(page, a => a.selectedLayers.map((l: any) => l.name));

test('一覧で Ctrl / Shift を押しながら選び、Ctrl+A で全部、Esc で1枚に戻す。並べ替えは1枚のときだけ', async ({ page }) => {
  await threeLayers(page);
  await row(page, 'A').click();
  await row(page, 'C').click({ modifiers: ['Control'] });
  expect(await selected(page)).toEqual(['A', 'C']);
  expect(await app(page, a => a.activeLayer.name)).toBe('C');
  await expect(page.locator('#layerSelBar')).toBeVisible();
  await expect(page.locator('#layerSelText')).toHaveText('2枚を選択中');
  await expect(row(page, 'C')).toHaveClass(/is-primary/);
  await expect(page.locator('#activeLayerName')).toHaveText('C ほか1枚');
  await expect(page.locator('button.btn-square[data-cmd=layerUp]')).toBeDisabled();
  await expect(page.locator('button.btn-square[data-cmd=layerDown]')).toBeDisabled();
  // もう一度 Ctrl+クリックで外す
  await row(page, 'A').click({ modifiers: ['Control'] });
  expect(await selected(page)).toEqual(['C']);
  await expect(page.locator('#layerSelBar')).toBeHidden();
  // Shift で範囲(起点は最後に押したレイヤー)
  await row(page, 'C').click();
  await row(page, 'A').click({ modifiers: ['Shift'] });
  expect(await selected(page)).toEqual(['A', 'B', 'C']);
  // クリックだけならその1枚
  await row(page, 'B').click();
  expect(await selected(page)).toEqual(['B']);
  // Ctrl+A と Esc
  await page.keyboard.press('Control+a');
  expect(await selected(page)).toEqual(['A', 'B', 'C']);
  expect(await app(page, a => a.activeLayer.name)).toBe('B');
  await row(page, 'B').focus();
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual(['B']);
  // 選び方はアンドゥに積まない
  expect(await app(page, a => a.history.size)).toBe(0);
});

test('値が揃っていない項目は「混在」と出し、変えると選んだ全部に書く。まとめて1手で戻る', async ({ page }) => {
  await threeLayers(page);
  await openTab(page, 'layer');
  await row(page, 'A').click();
  await row(page, 'B').click({ modifiers: ['Control'] });
  await expect(page.locator('#pBlend option:checked')).toHaveText('混在');
  await expect(page.locator('#pMotion option:checked')).toHaveText('混在');
  await page.locator('#physDetails summary').click();
  await expect(page.locator('#pHardO')).toHaveText('混在');
  // 揺らし方が違うので、揺らし方ごとの設定は出さない
  await expect(page.locator('#motionParams')).toContainText('揺らし方が揃っていない');

  await page.locator('#pBlend').selectOption('max');
  expect(await app(page, a => a.doc.layers.map((l: any) => l.blend))).toEqual(['max', 'max', 'add']);
  expect(await app(page, a => a.history.undoLabel)).toBe('重ね方(2枚)');
  // 硬さは、ほかの揺れの設定(揺らし方)を残して、その項目だけを揃える
  await page.locator('#pHard').fill('70');
  expect(await app(page, a => a.doc.layers.slice(0, 2).map((l: any) => [l.physics.hardness, l.physics.motion]))).toEqual([[0.7, 'jiggle'], [0.7, 'piston']]);
  await expect(page.locator('#pHardO')).toHaveText('70');
  await app(page, a => a.history.undo());
  await app(page, a => a.history.undo());
  expect(await app(page, a => a.doc.layers.map((l: any) => [l.blend, l.physics.hardness]))).toEqual([['add', 0.6], ['max', 0.2], ['add', 0.6]]);
});

test('ポップ量は一番高いレイヤーの値を出し、比率で伸び縮みする。0 のレイヤーは 0 のまま', async ({ page }) => {
  await threeLayers(page);
  await openTab(page, 'layer');
  await row(page, 'A').click();
  await page.keyboard.press('Control+a');
  await expect(page.locator('#pPopN')).toHaveValue('200');
  await page.locator('#pPopN').fill('300');
  await page.locator('#pPopN').press('Enter');
  expect(await app(page, a => a.doc.layers.map((l: any) => l.pop))).toEqual([150, 300, 0]);
  expect(await app(page, a => a.history.undoLabel)).toBe('ポップ量(3枚)');
  // 一覧には重ね方のアイコンとポップ量を出す
  await expect(row(page, 'B').locator('.layer-info')).toHaveAttribute('data-blend', 'max');
  await expect(row(page, 'B').locator('.layer-info')).toHaveText('300');
  await app(page, a => a.history.undo());
  expect(await app(page, a => a.doc.layers.map((l: any) => l.pop))).toEqual([100, 200, 0]);
});

test('一覧の重ね方のアイコンを押すと、その行だけ重ね方が切り替わる。選択は変えない', async ({ page }) => {
  await threeLayers(page);
  await row(page, 'A').click();
  const before = await app(page, a => a.doc.layers.map((l: any) => l.blend));
  const btn = row(page, 'C').locator('.blend-btn');
  const idx = await app(page, a => a.doc.layers.findIndex((l: any) => l.name === 'C'));
  const cur = before[idx], other = cur === 'add' ? 'max' : 'add';
  await btn.click();
  await expect(row(page, 'C').locator('.layer-info')).toHaveAttribute('data-blend', other);
  const after = await app(page, a => a.doc.layers.map((l: any) => l.blend));
  expect(after).toEqual(before.map((b: string, i: number) => (i === idx ? other : b)));
  expect(await app(page, a => a.activeLayer.name)).toBe('A');
  await row(page, 'C').locator('.blend-btn').click();
  expect(await app(page, a => a.doc.layers.map((l: any) => l.blend))).toEqual(before);
  await app(page, a => a.history.undo());
  expect(await app(page, a => a.doc.layers.map((l: any) => l.blend))).toEqual(after);
});

test('揺れ・プリセット・ウェイトの一括処理・複製・削除は選んだ全部に効く。表示のチェックは押した1行だけ', async ({ page }) => {
  await threeLayers(page);
  await openTab(page, 'layer');
  await row(page, 'A').click();
  await row(page, 'B').click({ modifiers: ['Control'] });
  await app(page, a => a.setLayerSwing(false));
  expect(await app(page, a => a.doc.layers.map((l: any) => l.physics.enabled))).toEqual([false, false, true]);
  await app(page, a => a.setLayerSwing(true));
  await app(page, a => a.setPreset('fuwa'));
  const presets = await app(page, a => a.doc.layers.map((l: any) => l.physics.preset));
  expect(presets.slice(0, 2)).toEqual(['fuwa', 'fuwa']);
  expect(presets[2]).not.toBe('fuwa');
  // 反転は選んだ2枚それぞれにかけ、1手で戻る
  const sums = () => app(page, a => a.doc.layers.map((l: any) => l.weights.data.reduce((s: number, v: number) => s + v, 0)));
  const before = await sums();
  await app(page, a => a.weightOp('反転', (wm: any) => wm.invert()));
  const after = await sums();
  expect(after[0]).not.toBe(before[0]); expect(after[1]).not.toBe(before[1]); expect(after[2]).toBe(before[2]);
  expect(await app(page, a => a.history.undoLabel)).toBe('反転(2枚)');
  await app(page, a => a.history.undo());
  expect(await sums()).toEqual(before);
  // 表示のチェックは1行だけ
  await row(page, 'A').locator('input[type=checkbox]').uncheck();
  expect(await app(page, a => a.doc.layers.map((l: any) => l.visible))).toEqual([false, true, true]);
  // 複製: 選んだ2枚をそれぞれのすぐ上に足し、複製したものを選ぶ
  await page.locator('button.btn-square[data-cmd=duplicateLayer]').click();
  expect(await app(page, a => a.doc.layers.map((l: any) => l.name))).toEqual(['A', 'A のコピー', 'B', 'B のコピー', 'C']);
  expect(await selected(page)).toEqual(['A のコピー', 'B のコピー']);
  // 削除: 選んだ2枚を消し、1手で戻る
  await page.locator('button.btn-square[data-cmd=deleteLayer]').click();
  expect(await app(page, a => a.doc.layers.map((l: any) => l.name))).toEqual(['A', 'B', 'C']);
  await app(page, a => a.history.undo());
  expect(await app(page, a => a.doc.layers.length)).toBe(5);
  // 全部は消せない
  await page.keyboard.press('Control+a');
  await page.locator('button.btn-square[data-cmd=deleteLayer]').click();
  expect(await app(page, a => a.doc.layers.length)).toBe(5);
});

test('ウェイトの重ね表示: 選択中は選んだレイヤー、全レイヤーは表示中の全部を出し、選んでいないものは薄く', async ({ page }) => {
  await threeLayers(page);
  const show = () => app(page, a => (a.stage as any).uniforms.uShow.value.slice(0, 3));
  await row(page, 'A').click();
  await row(page, 'C').click({ modifiers: ['Control'] });
  await app(page, a => a.setOverlayMode('selected'));
  expect(await show()).toEqual([1, 0, 1]);
  await app(page, a => a.setOverlayMode('all'));
  const dim = await show();
  expect(dim[0]).toBe(1); expect(dim[2]).toBe(1); expect(dim[1]).toBeGreaterThan(0); expect(dim[1]).toBeLessThan(1);
  // 隠したレイヤーは全レイヤー表示に出さない
  await row(page, 'B').locator('input[type=checkbox]').uncheck();
  expect((await show())[1]).toBe(0);
  await app(page, a => a.setOverlayMode('off'));
  expect(await app(page, a => a.view.overlay)).toBe(false);
  // 「画像と表示」タブの3つの切り替え
  await openTab(page, 'view');
  await page.locator('#vOverlayAll').check();
  expect(await app(page, a => a.overlayMode)).toBe('all');
  // 塗るツールに切り替えたときの自動ONは、全レイヤーのときはそのまま
  await page.locator('#view').focus();
  await page.keyboard.press('g'); await page.keyboard.press('b');
  expect(await app(page, a => a.overlayMode)).toBe('all');
  // 一覧の色の印は、重ね表示の色と同じ
  await expect(row(page, 'A').locator('.layer-color')).toHaveCSS('background-color', 'rgb(255, 51, 128)');
});

test('スマホ: 長押しで選択モードに入り、タップで足す・外す。「完了」で抜ける', async ({ page }) => {
  await threeLayers(page);
  await row(page, 'A').click();
  const longPress = (name: string) => row(page, name).evaluate(async li => {
    const o = { bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10 } as PointerEventInit;
    li.dispatchEvent(new PointerEvent('pointerdown', o));
    await new Promise(r => setTimeout(r, 600));
    li.dispatchEvent(new PointerEvent('pointerup', o));
    (li as HTMLElement).click();
  });
  await longPress('B');
  expect(await selected(page)).toEqual(['A', 'B']);
  await expect(page.locator('#layerSelText')).toHaveText('選択モード: 2枚');
  await row(page, 'C').click();
  expect(await selected(page)).toEqual(['A', 'B', 'C']);
  await row(page, 'A').click();
  expect(await selected(page)).toEqual(['B', 'C']);
  // 1枚に減っても選択モードのまま(次のタップで置き換えない)
  await row(page, 'C').click();
  await expect(page.locator('#layerSelText')).toHaveText('選択モード: 1枚');
  await row(page, 'C').click();
  expect(await selected(page)).toEqual(['B', 'C']);
  await page.locator('#layerSelDone').click();
  await expect(page.locator('#layerSelDone')).toBeHidden();
  await row(page, 'B').click();
  expect(await selected(page)).toEqual(['B']);
  await expect(page.locator('#layerSelBar')).toBeHidden();
});
