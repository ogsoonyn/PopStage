/** E2E: 塗る・ぼかす・膨らませる・重ね方 */
import { test, expect } from '@playwright/test';
import { watchGlErrors, boot, weightSum, dragOnStage } from './helpers';

watchGlErrors();

test('起動するとサンプルが描画される', async ({ page }) => {
  await boot(page);
  const info = await page.evaluate(() => {
    const a = (window as any).popstage;
    const px: Uint8ClampedArray = a.stage.renderFrame(64, 48, a.project.camera, null);
    let opaque = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) opaque++;
    return { opaque, verts: a.stage.vertexCount, layers: a.doc.layers.length };
  });
  expect(info.layers).toBe(1);
  expect(info.verts).toBeGreaterThan(10000);
  expect(info.opaque).toBeGreaterThan(64 * 48 * 0.3);
});

test('単色背景は指定どおりの色で描かれる', async ({ page }) => {
  await boot(page);
  const corner = await page.evaluate(() => {
    const a = (window as any).popstage;
    a.project.camera.zoom = 4; // 画像を小さくして四隅を背景にする
    const px: Uint8ClampedArray = a.stage.renderFrame(64, 48, a.project.camera, '#336699');
    return [px[0], px[1], px[2], px[3]];
  });
  expect(corner).toEqual([0x33, 0x66, 0x99, 255]);
});

test('塗ると持ち上がり、塗った矩形だけ転送され、元に戻せる', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).popstage.weightOp('全消去', (wm: any) => wm.clear()));
  expect(await weightSum(page)).toBe(0);
  const partialBefore = await page.evaluate(() => (window as any).popstage.stage.partialUploads);
  await page.waitForTimeout(100);
  const shotBefore = await page.locator('#stage').screenshot();
  await dragOnStage(page, [0.3, 0.4], [0.6, 0.5]);
  await page.waitForTimeout(100);
  // CPU 側の値だけでなく、画面(GPU に送られたウェイト)が変わったことも確かめる
  expect((await page.locator('#stage').screenshot()).equals(shotBefore)).toBe(false);
  const painted = await weightSum(page);
  expect(painted).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).popstage.stage.partialUploads)).toBeGreaterThan(partialBefore);
  expect(await page.evaluate(() => (window as any).popstage.history.undoLabel)).toBe('ブラシ');

  await page.keyboard.press('Control+z');
  expect(await weightSum(page)).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await weightSum(page)).toBe(painted);

  // 消しゴム(E)で減る
  await page.keyboard.press('e');
  const shotPainted = await page.locator('#stage').screenshot();
  await dragOnStage(page, [0.3, 0.4], [0.6, 0.5]);
  await page.waitForTimeout(100);
  expect(await weightSum(page)).toBeLessThan(painted);
  expect((await page.locator('#stage').screenshot()).equals(shotPainted)).toBe(false);
});

test('全体をぼかす: プレビュー、キャンセル、適用、元に戻す', async ({ page }) => {
  await boot(page);
  const snapshot = () => page.evaluate(() => Array.from((window as any).popstage.activeLayer.weights.data as Uint8Array).join(','));
  const original = await snapshot();
  await page.locator('nav button[data-cmd=smoothAll]').click();
  await expect(page.locator('#blurDialog')).toHaveJSProperty('open', true);
  await page.locator('#blurRadiusN').fill('60');
  await page.waitForTimeout(150);
  expect(await snapshot()).not.toBe(original); // プレビュー中は表示用にぼかされる
  await page.locator('#blurCancel').click();
  expect(await snapshot()).toBe(original);     // キャンセルで元どおり
  expect(await page.evaluate(() => (window as any).popstage.history.canUndo)).toBe(false);

  await page.locator('nav button[data-cmd=smoothAll]').click();
  await page.locator('#blurRadius').fill('40');
  await page.locator('#blurApply').click();
  const blurred = await snapshot();
  expect(blurred).not.toBe(original);
  expect(await page.evaluate(() => (window as any).popstage.history.undoLabel)).toBe('全体をぼかす(半径 40px)');
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  expect(await snapshot()).toBe(original);
  await page.keyboard.press('Control+Shift+z');
  expect(await snapshot()).toBe(blurred);
});

test('膨らませる: 範囲をドラッグし、高さを数値で決めて適用し、1手で戻せる', async ({ page }) => {
  await boot(page);
  // 関数は直接渡せないので、文字列にして window.popstage を引数に呼ぶ
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  await app(a => a.weightOp('全消去', (wm: any) => wm.clear()));
  const maxWeight = () => app(a => a.activeLayer.weights.max() as number);
  expect(await app(a => a.activeLayer.pop)).toBe(140);

  await page.keyboard.press('i');
  expect(await app(a => a.tool)).toBe('inflate');
  await dragOnStage(page, [0.4, 0.35], [0.6, 0.65]);
  const dlg = page.locator('#inflateDialog');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(page.locator('#inflTitle')).toHaveText('範囲を膨らませる');
  // 高さの初期値はポップ量と同じなので、頂上はウェイト 100%
  expect(await maxWeight()).toBe(255);
  // プレビュー中は元に戻すなどを受け付けない
  await expect(page.locator('#toolOptions button[data-cmd=undo]')).toBeDisabled();

  // 高さを 70px(ポップ量 140px の半分)にする
  await page.locator('#inflHeightN').fill('70');
  // プレビューは次のフレームで計算するので、反映されるまで待つ
  await expect.poll(async () => Math.abs(await maxWeight() - 128)).toBeLessThanOrEqual(1);
  await expect(page.locator('#inflNote')).toContainText('70px');

  // 数値で大きさを変えると範囲も変わる
  const w0 = await app(a => a.inflateState.area.w);
  await page.locator('#inflW').fill(String(w0 + 100));
  await expect.poll(() => app(a => a.inflateState.area.w)).toBe(w0 + 100);

  // ドラッグし直すと範囲を描き直す(同じプレビューのまま)
  await dragOnStage(page, [0.3, 0.3], [0.45, 0.5]);
  expect(await app(a => a.inflateState.area.w)).not.toBe(w0 + 100);

  await page.locator('#inflApply').click();
  await expect(dlg).toHaveJSProperty('open', false);
  expect(await app(a => a.history.undoLabel)).toMatch(/^膨らませる\(楕円 \d+×\d+px・高さ 70px\)$/);
  const applied = await weightSum(page);
  expect(applied).toBeGreaterThan(0);

  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  expect(await weightSum(page)).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await weightSum(page)).toBe(applied);

  // キャンセルすると元どおりで、何も記録しない
  await dragOnStage(page, [0.55, 0.55], [0.7, 0.7]);
  expect(await weightSum(page)).toBeGreaterThan(applied);
  await page.locator('#inflCancel').click();
  expect(await weightSum(page)).toBe(applied);
  expect(await app(a => a.history.undoLabel)).toMatch(/^膨らませる/);
});

test('膨らませる: 高さがポップ量を超えると新しいレイヤーに作り、元のレイヤーには触れない。1手で戻せる', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const layerCount = () => app(a => a.doc.layers.length as number);
  // 元のレイヤー(プリン)のウェイトとポップ量を、1バイトずつ比べられるよう控えておく
  await app(a => { (window as any).__orig = { id: a.activeLayerId, data: a.activeLayer.weights.data.slice(), pop: a.activeLayer.pop }; });
  const sourceIntact = () => app(a => {
    const o = (window as any).__orig, l = a.store.findLayer(o.id)?.layer;
    if (!l || l.pop !== o.pop) return false;
    const d: Uint8Array = l.weights.data;
    return d.length === o.data.length && d.every((v: number, i: number) => v === o.data[i]);
  });
  expect(await app(a => a.activeLayer.pop)).toBe(140);
  expect(await layerCount()).toBe(1);

  await page.keyboard.press('i');
  await dragOnStage(page, [0.3, 0.25], [0.4, 0.35]);
  await expect(page.locator('#inflateDialog')).toHaveJSProperty('open', true);
  expect(await layerCount()).toBe(1); // ポップ量以下の高さなら、同じレイヤーに作る

  // ポップ量(140px)より高い 420px にすると、プレビューの間から新しいレイヤーが見える
  await page.locator('#inflHeightN').fill('420');
  await expect.poll(layerCount).toBe(2);
  await expect(page.locator('#inflNote')).toContainText('ポップ量(140px)を超えるので、新しいレイヤー「膨らみ1」(ポップ量 420px)に作ります');
  await expect(page.locator('#layerList li')).toHaveCount(2);
  expect(await sourceIntact()).toBe(true);
  expect(await app(a => a.history.canUndo)).toBe(false); // プレビュー中は記録しない
  expect(await app(a => a.dirty)).toBe(false);
  // 高さを戻すと、同じレイヤーに作る方へ切り替わる(仮のレイヤーは消える)。また上げると戻る
  await page.locator('#inflHeightN').fill('100');
  await expect.poll(layerCount).toBe(1);
  expect(await app(a => a.activeLayer.weights.data.some((v: number, i: number) => v !== (window as any).__orig.data[i]))).toBe(true);
  await page.locator('#inflHeightN').fill('420');
  await expect.poll(layerCount).toBe(2);
  expect(await sourceIntact()).toBe(true);

  await page.locator('#inflApply').click();
  expect(await layerCount()).toBe(2);
  expect(await app(a => a.history.undoLabel)).toMatch(/^膨らませる\(楕円 \d+×\d+px・高さ 420px・新しいレイヤー「膨らみ1」\)$/);
  const added = await app(a => ({ name: a.activeLayer.name, pop: a.activeLayer.pop, max: a.activeLayer.weights.max(), index: a.activeIndex, preset: a.activeLayer.physics.preset }));
  // 新しいレイヤーが選ばれ、ポップ量 = 高さ、頂上はウェイト 100%、揺れ方は元のレイヤーと同じ
  expect(added).toEqual({ name: '膨らみ1', pop: 420, max: 255, index: 1, preset: 'puru' });
  expect(await sourceIntact()).toBe(true);
  expect(await app(a => a.dirty)).toBe(true);

  // 1手で戻すと新しいレイヤーごと消え、元のレイヤーはそのまま
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  expect(await layerCount()).toBe(1);
  expect(await sourceIntact()).toBe(true);
  expect(await app(a => a.history.canUndo)).toBe(false);
  await page.keyboard.press('Control+Shift+z');
  expect(await layerCount()).toBe(2);
  await page.keyboard.press('Control+z');

  // キャンセルすると、仮のレイヤーも消えて何も残らない
  await dragOnStage(page, [0.6, 0.25], [0.7, 0.35]);
  await page.locator('#inflHeightN').fill('900');
  await expect.poll(layerCount).toBe(2);
  await page.locator('#inflCancel').click();
  expect(await layerCount()).toBe(1);
  expect(await sourceIntact()).toBe(true);
  expect(await app(a => a.history.canUndo)).toBe(false);
  await expect(page.locator('#pPopN')).toBeEnabled();
  await expect(page.locator('#pPopN')).toHaveValue('140');
});

test('膨らませる: レイヤーが上限の8枚なら新しいレイヤーは作らず、ポップ量の高さで止める', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  // 8枚にして、いちばん上(最後に足した、何も塗っていないレイヤー)に作る。ポップ量は既定の 80px
  await app(a => { for (let i = 0; i < 7; i++) a.addLayer(); });
  expect(await app(a => a.doc.layers.length)).toBe(8);
  expect(await app(a => a.activeLayer.pop)).toBe(80);
  const undoBefore = await app(a => a.history.size as number);

  await page.keyboard.press('i');
  await dragOnStage(page, [0.3, 0.25], [0.4, 0.35]);
  await page.locator('#inflHeightN').fill('300');
  await expect(page.locator('#inflNote')).toContainText('レイヤーが上限の 8 枚なので新しいレイヤーを作れません。80px で止まります');
  expect(await app(a => a.doc.layers.length)).toBe(8);
  await page.locator('#inflApply').click();
  expect(await app(a => a.doc.layers.length)).toBe(8);
  expect(await app(a => a.activeLayer.pop)).toBe(80);
  expect(await app(a => a.activeLayer.weights.max())).toBe(255); // ポップ量の高さ(80px)で止まる
  expect(await app(a => a.history.undoLabel)).toMatch(/^膨らませる\(楕円 \d+×\d+px・高さ 80px\)$/);
  expect(await app(a => a.history.size)).toBe(undoBefore + 1);
});

test('1フレームの間の塗りは、まとめて1回だけ GPU へ送る', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage, st = a.stage;
    const nextFrame = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    await nextFrame();
    const before = st.partialUploads + st.fullUploads;
    // 高レートのペンのように、1フレームの間に何十回も塗り進める
    a.beginStroke('brush', -100, 0, 1);
    for (let i = 1; i <= 40; i++) a.strokeTo(-100 + i * 5, Math.sin(i) * 20, 1);
    const sync = st.partialUploads + st.fullUploads - before;
    await nextFrame();
    const after = st.partialUploads + st.fullUploads - before;
    a.endStroke();
    return { sync, after };
  });
  expect(r.sync).toBe(0);
  expect(r.after).toBeGreaterThanOrEqual(1);
  expect(r.after).toBeLessThanOrEqual(2);
});

test('膨らませる: ヘルプを Esc で閉じてもプレビューは残る。範囲を描いている途中の Esc で描き直しは始まらない', async ({ page }) => {
  await boot(page);
  const previewing = () => page.evaluate(() => (window as any).popstage.previewingInflate as boolean);
  await page.locator('#view').focus();
  await page.keyboard.press('i');
  await dragOnStage(page, [0.4, 0.35], [0.6, 0.65]);
  expect(await previewing()).toBe(true);
  await page.evaluate(() => (document.getElementById('helpDialog') as HTMLDialogElement).showModal());
  await page.keyboard.press('Escape');
  await expect(page.locator('#helpDialog')).not.toHaveAttribute('open', '');
  expect(await previewing()).toBe(true);
  await page.locator('#inflCancel').click();
  expect(await previewing()).toBe(false);
  // 描いている途中で Esc
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
  expect(await previewing()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await previewing()).toBe(false);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 4 });
  expect(await previewing()).toBe(false);
  await page.mouse.up();
});

test('重ね方「最大」: 重なった膨らみは高い方だけになり、加算のように倍にならない', async ({ page }) => {
  await boot(page);
  // 2枚のレイヤーに、少し重なる円をそれぞれ塗る(ポップ量は同じ)。横から見た膨らみの厚みを比べる
  const depth = () => page.evaluate(() => {
    const a = (window as any).popstage;
    const cam = { ...a.project.camera, yaw: Math.PI / 2, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } };
    const W = 200, H = 120, px: Uint8ClampedArray = a.stage.renderFrame(W, H, cam, null);
    let min = W, max = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 0) { min = Math.min(min, x); max = Math.max(max, x); }
    return max - min;
  });
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.addLayer();
    a.doc.layers.forEach((l: any, i: number) => {
      const wm = l.weights, cx = wm.width * (i ? 0.58 : 0.42), cy = wm.height / 2, r = wm.width * 0.14;
      wm.data.fill(0);
      for (let y = 0; y < wm.height; y++) for (let x = 0; x < wm.width; x++) if (Math.hypot(x - cx, y - cy) < r) wm.data[y * wm.width + x] = 255;
      a.store.weightsChanged(l.id, wm.fullRect);
      a.store.patchLayer(l.id, { pop: 300 });
    });
  });
  await page.waitForTimeout(100);
  const add = await depth();
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchLayer(a.doc.layers[1].id, { blend: 'max' }); });
  const max = await depth();
  // 加算は重なりで 600px ぶん、最大は 300px ぶん出る(画像の厚みぶんを除いても、はっきり差が出る)
  expect(add).toBeGreaterThan(max * 1.4);
  // パネルの重ね方の選択と、一覧の印も変わる
  await page.evaluate(() => { const a = (window as any).popstage; a.setActiveLayer(a.doc.layers[1].id); });
  await expect(page.locator('#pBlend')).toHaveValue('max');
  await expect(page.locator('#layerList li').first()).toContainText('最大');
  // パネルから加算へ戻すと、元の厚みに戻る
  await page.locator('#pBlend').selectOption('add');
  expect(await depth()).toBe(add);
});

test('全体をぼかす: プレビュー中も視点は回せる。塗る・ツールの切り替え・元に戻すはできず、Esc でキャンセルする', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const original = await weightSum(page);
  await page.locator('nav button[data-cmd=smoothAll]').click();
  await expect(page.locator('#blurDialog')).toHaveJSProperty('open', true);
  expect(await page.evaluate(() => document.querySelector('#blurDialog')!.matches(':modal'))).toBe(false);
  await page.locator('#blurRadiusN').fill('60');
  await page.waitForTimeout(150);
  const previewed = await weightSum(page);
  expect(previewed).not.toBe(original);
  // 右ドラッグで視点が回る
  const yaw0 = await app(a => a.project.camera.yaw);
  await dragOnStage(page, [0.4, 0.5], [0.6, 0.5], 'right');
  expect(await app(a => a.project.camera.yaw)).not.toBeCloseTo(yaw0, 3);
  // 塗れない・ツールは変わらない・元に戻すも効かない(プレビュー中のウェイトを守る)
  await page.locator('#view').focus();
  await page.keyboard.press('g');
  expect(await app(a => a.tool)).toBe('brush');
  await dragOnStage(page, [0.45, 0.45], [0.55, 0.55]);
  expect(await weightSum(page)).toBe(previewed);
  await page.keyboard.press('Control+z');
  expect(await app(a => a.previewingBlur)).toBe(true);
  // 表示の切り替えは効く
  const overlay = await app(a => a.view.overlay);
  await page.keyboard.press('w');
  expect(await app(a => a.view.overlay)).toBe(!overlay);
  // Esc でキャンセルし、元に戻る
  await page.keyboard.press('Escape');
  await expect(page.locator('#blurDialog')).toHaveJSProperty('open', false);
  expect(await weightSum(page)).toBe(original);
  expect(await app(a => a.previewingBlur)).toBe(false);
});
