import { test, expect, type Page } from '@playwright/test';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

// ?e2e: 自動保存の復元を聞かず、揺れを止めた状態で起動する
async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // WebGL のエラー(GL_INVALID_* など)が出たらテストを失敗にする
  page.on('console', m => { if (/GL_INVALID|WebGL: INVALID/.test(m.text())) glErrors.push(m.text()); });
  await page.goto('/?e2e');
  await page.waitForFunction(() => {
    const a = (window as any).popstage;
    return a?.doc && a.stage.hasDocument && a.paused;
  });
  expect(errors).toEqual([]);
}

const glErrors: string[] = [];
test.beforeEach(() => { glErrors.length = 0; });
test.afterEach(() => { expect(glErrors, 'WebGL のエラー').toEqual([]); });

const weightSum = (page: Page) => page.evaluate(() => (window as any).popstage.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0));

async function dragOnStage(page: Page, from: [number, number], to: [number, number], button: 'left' | 'right' = 'left'): Promise<void> {
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down({ button });
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + box.width * (from[0] + (to[0] - from[0]) * i / 12), box.y + box.height * (from[1] + (to[1] - from[1]) * i / 12));
  }
  await page.mouse.up({ button });
  // ブラシの円カーソルが写り込まないよう、ポインタを画面の外へ逃がす
  await page.mouse.move(1, 1);
  await page.waitForTimeout(100);
}

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
  await page.locator('aside button[data-cmd=smoothAll]').click();
  await expect(page.locator('#blurDialog')).toHaveJSProperty('open', true);
  await page.locator('#blurRadiusN').fill('60');
  await page.waitForTimeout(150);
  expect(await snapshot()).not.toBe(original); // プレビュー中は表示用にぼかされる
  await page.locator('#blurCancel').click();
  expect(await snapshot()).toBe(original);     // キャンセルで元どおり
  expect(await page.evaluate(() => (window as any).popstage.history.canUndo)).toBe(false);

  await page.locator('aside button[data-cmd=smoothAll]').click();
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

test('画像を薄く・ポップを一時OFF: 画面だけが変わり、書き出しには影響しない', async ({ page }) => {
  await boot(page);
  await dragOnStage(page, [0.5, 0.5], [0.65, 0.45], 'right'); // 斜めから見て持ち上がりを分かるようにする
  const frame = () => page.evaluate(() => {
    const a = (window as any).popstage;
    return Array.from(a.stage.renderFrame(64, 48, a.project.camera, null) as Uint8ClampedArray).join(',');
  });
  const stage = page.locator('#stage');
  const shot0 = await stage.screenshot(), frame0 = await frame();
  await page.locator('#view').focus();

  await page.keyboard.press('f');
  await page.waitForTimeout(100);
  expect(await page.locator('#vFlat').isChecked()).toBe(true);
  await expect(page.locator('#sRec')).toContainText('ポップOFF');
  const shotFlat = await stage.screenshot();
  expect(shotFlat.equals(shot0)).toBe(false);
  expect(await frame()).toBe(frame0);

  await page.keyboard.press('Shift+W');
  await page.waitForTimeout(100);
  expect(await page.locator('#vFade').isChecked()).toBe(true);
  expect(await page.locator('#vOverlay').isChecked()).toBe(true);
  expect((await stage.screenshot()).equals(shotFlat)).toBe(false);
  expect(await frame()).toBe(frame0);

  await page.locator('#vFade').uncheck();
  await page.locator('#vFlat').uncheck();
  await page.mouse.move(1, 1);
  await page.waitForTimeout(100);
  expect((await stage.screenshot()).equals(shot0)).toBe(true);
});

test('3面図: 横に4つの図が出て、自由角度はドラッグで回り、主ビューの当たり判定はずれない', async ({ page }) => {
  await boot(page);
  // 注視点(原点)は主ビューの中央に映るので、そこを指すと画像の中心が返る
  const pickCenter = () => page.evaluate(() => {
    const a = (window as any).popstage, r = a.stage.canvas.getBoundingClientRect();
    const p = document.getElementById('multiView')!.getBoundingClientRect();
    const right = p.width > 0 ? p.left : r.right;
    const q = a.stage.pick((r.left + right) / 2, r.top + r.height / 2);
    return [q.x, q.y];
  });
  const [x0, y0] = await pickCenter();
  expect(Math.abs(x0)).toBeLessThan(1); expect(Math.abs(y0)).toBeLessThan(1);

  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  await expect(page.locator('#vMulti')).toBeChecked();
  await expect(page.locator('#multiView .mv-cell')).toHaveCount(4);
  const [x1, y1] = await pickCenter();
  expect(Math.abs(x1)).toBeLessThan(1); expect(Math.abs(y1)).toBeLessThan(1);

  // 正面の図に画像が描かれている(背景のチェッカーだけではない)
  const front = await page.locator('#multiView [data-kind=front]').screenshot();
  await page.evaluate(() => (window as any).popstage.setViewOption('flat', true));
  await page.waitForTimeout(100);
  const right = page.locator('#multiView [data-kind=right]');
  const rightFlat = await right.screenshot();
  await page.evaluate(() => (window as any).popstage.setViewOption('flat', false));
  await page.waitForTimeout(100);
  expect((await right.screenshot()).equals(rightFlat)).toBe(false); // 横から見ると膨らみが分かる
  expect(front.length).toBeGreaterThan(0);

  const free = (await page.locator('#multiView [data-kind=free]').boundingBox())!;
  const yaw0 = await page.evaluate(() => (window as any).popstage.multiCam.yaw);
  const mainYaw = await page.evaluate(() => (window as any).popstage.project.camera.yaw);
  await page.mouse.move(free.x + free.width * 0.3, free.y + free.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(free.x + free.width * 0.7, free.y + free.height * 0.5, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).popstage.multiCam.yaw)).not.toBeCloseTo(yaw0);
  expect(await page.evaluate(() => (window as any).popstage.project.camera.yaw)).toBeCloseTo(mainYaw);

  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeHidden();
  const [x2, y2] = await pickCenter();
  expect(Math.abs(x2)).toBeLessThan(1); expect(Math.abs(y2)).toBeLessThan(1);
});

test('3面図: 正面・右・下はホイールでズーム・ドラッグで平行移動、自由角度は中ドラッグで平行移動し、主ビューと揺れには影響しない', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除して、揺れの計算が動いている状態で確かめる
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  await page.waitForTimeout(1500); // 重さで垂れた所で落ち着かせる
  const state = () => page.evaluate(() => {
    const a = (window as any).popstage;
    return {
      main: JSON.stringify(a.project.camera), viewTarget: JSON.stringify(a.world.viewTarget),
      dirty: a.dirty as boolean, undo: a.history.size as number,
      ortho: JSON.parse(JSON.stringify(a.multiOrtho)) as { zoom: number; pan: { x: number; y: number; z: number } },
      free: JSON.parse(JSON.stringify(a.multiCam)) as { yaw: number; pitch: number; zoom: number; target: { x: number; y: number; z: number } },
    };
  });
  const s0 = await state();
  expect(s0.ortho).toEqual({ zoom: 1, pan: { x: 0, y: 0, z: 0 } });
  const before = await page.evaluate(() => { const a = (window as any).popstage; return a.world.displacement(a.doc.layers[0].id).x; });
  const watching = watchSwingX(page, 2500);

  // 正面: ホイールで拡大する。中心から外れた所で回すと、その点へ寄るので中心がずれる
  const front = page.locator('#multiView [data-kind=front]'), fb = (await front.boundingBox())!;
  const shot0 = await front.screenshot();
  await page.mouse.move(fb.x + fb.width * 0.75, fb.y + fb.height * 0.5);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await state()).ortho.zoom).toBeGreaterThan(1.3);
  const s1 = await state();
  expect(s1.ortho.pan.x).toBeGreaterThan(0); // 右寄りの点へ寄る
  expect(s1.ortho.pan.y).toBeCloseTo(0);
  await page.waitForTimeout(100);
  expect((await front.screenshot()).equals(shot0)).toBe(false);
  // 右からの図でも同じ状態を変える(3つで共有)。縮小は下限で止まる
  const right = page.locator('#multiView [data-kind=right]'), rb = (await right.boundingBox())!;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 800);
  await expect.poll(async () => (await state()).ortho.zoom).toBeCloseTo(0.5);
  await page.mouse.wheel(0, -600);
  await expect.poll(async () => (await state()).ortho.zoom).toBeGreaterThan(1);

  // 正面: 左ドラッグで平行移動(画像がポインタに付いてくるので、中心は逆へずれる)
  const pan0 = (await state()).ortho.pan;
  await page.mouse.move(fb.x + fb.width * 0.5, fb.y + fb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width * 0.7, fb.y + fb.height * 0.7, { steps: 5 });
  await page.mouse.up();
  const pan1 = (await state()).ortho.pan;
  expect(pan1.x).toBeLessThan(pan0.x);
  expect(pan1.y).toBeGreaterThan(pan0.y);
  expect(pan1.z).toBeCloseTo(pan0.z);

  // 右から(画面の右 = 画像の -z): 右へドラッグすると中心は +z へずれる。上下は y
  const drag = async (b: { x: number; y: number; width: number; height: number }, dx: number, dy: number) => {
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * (0.5 + dx), b.y + b.height * (0.5 + dy), { steps: 5 });
    await page.mouse.up();
  };
  await drag(rb, 0.2, 0);
  const pan2 = (await state()).ortho.pan;
  expect(pan2.z).toBeGreaterThan(pan1.z);
  expect(pan2.x).toBeCloseTo(pan1.x);
  expect(pan2.y).toBeCloseTo(pan1.y);
  // 下から(画面の上 = 画像の +z): 下へドラッグすると中心は +z へずれる。左右は x
  const bottom = page.locator('#multiView [data-kind=bottom]'), bb = (await bottom.boundingBox())!;
  await drag(bb, 0, 0.2);
  const pan3 = (await state()).ortho.pan;
  expect(pan3.z).toBeGreaterThan(pan2.z);
  expect(pan3.x).toBeCloseTo(pan2.x);
  expect(pan3.y).toBeCloseTo(pan2.y);

  // ダブルクリックで拡大率と平行移動が戻る
  await front.dblclick();
  expect((await state()).ortho).toEqual({ zoom: 1, pan: { x: 0, y: 0, z: 0 } });

  // 自由角度: 中ドラッグで平行移動する。回転とズームは変わらない
  const free = page.locator('#multiView [data-kind=free]'), vb = (await free.boundingBox())!;
  await page.mouse.move(vb.x + vb.width * 0.3, vb.y + vb.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(vb.x + vb.width * 0.7, vb.y + vb.height * 0.5, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const s2 = await state();
  const moved = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  expect(moved(s2.free.target, s0.free.target)).toBeGreaterThan(5);
  expect(s2.free.yaw).toBeCloseTo(s0.free.yaw);
  expect(s2.free.pitch).toBeCloseTo(s0.free.pitch);
  expect(s2.free.zoom).toBeCloseTo(s0.free.zoom);
  // Shift+左ドラッグでも平行移動になり、回転しない
  await page.keyboard.down('Shift');
  await page.mouse.move(vb.x + vb.width * 0.5, vb.y + vb.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width * 0.5, vb.y + vb.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const s3 = await state();
  expect(moved(s3.free.target, s2.free.target)).toBeGreaterThan(5);
  expect(s3.free.yaw).toBeCloseTo(s0.free.yaw);
  expect(s3.free.pitch).toBeCloseTo(s0.free.pitch);
  // 左ドラッグは今まで通り回転
  await page.mouse.move(vb.x + vb.width * 0.3, vb.y + vb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width * 0.7, vb.y + vb.height * 0.5, { steps: 5 });
  await page.mouse.up();
  expect((await state()).free.yaw).not.toBeCloseTo(s0.free.yaw);

  // 主ビューの視点・揺れの計算・未保存の印・アンドゥには何も起きない
  const [lo, hi] = await watching;
  expect(Math.max(Math.abs(lo - before), Math.abs(hi - before))).toBeLessThan(0.005);
  const s4 = await state();
  expect(s4.main).toBe(s0.main);
  expect(s4.viewTarget).toBe(s0.viewTarget);
  expect(s4.dirty).toBe(s0.dirty);
  expect(s4.undo).toBe(s0.undo);

  // ダブルクリックで回転・ズーム・平行移動がすべて初期の視点に戻る
  await free.dblclick();
  expect((await state()).free).toEqual(s0.free);

  // 別の画像を開くと、3面図の視点は初めの表示に戻る(前の画像の大きさで動かしたずれを残さない)
  await page.mouse.move(fb.x + fb.width * 0.8, fb.y + fb.height * 0.3);
  await page.mouse.wheel(0, -400);
  await drag(vb, 0, 0);
  await page.evaluate(() => { const a = (window as any).popstage; a.multiCam.target = { x: 300, y: 0, z: 0 }; });
  await expect.poll(async () => (await state()).ortho.zoom).toBeGreaterThan(1);
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 80; c.height = 60; c.getContext('2d')!.fillRect(0, 0, 40, 30);
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    const a = (window as any).popstage;
    a.dirty = false; // 自動揺らしを切った分の「未保存」で確認が出ないように
    await a.openFile(new File([b], 'small.png', { type: 'image/png' }));
  });
  const s5 = await state();
  expect(s5.ortho).toEqual({ zoom: 1, pan: { x: 0, y: 0, z: 0 } });
  expect(s5.free).toEqual(s0.free);
});

for (const target of ['[data-tool=brush]', '#pPreset']) test(`${target} にフォーカスが残っていても、Space+ドラッグは平行移動になり塗らない`, async ({ page }) => {
  await boot(page);
  await page.locator(target).focus();
  await expect(page.locator(target)).toBeFocused();
  const before = await page.evaluate(() => ({ t: { ...(window as any).popstage.project.camera.target }, undo: (window as any).popstage.history.canUndo }));
  const sum0 = await weightSum(page);
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.keyboard.down('Space');
  await dragOnStage(page, [0.4, 0.5], [0.6, 0.6]);
  await page.keyboard.up('Space');
  const after = await page.evaluate(() => ({ t: { ...(window as any).popstage.project.camera.target }, undo: (window as any).popstage.history.canUndo }));
  expect(await weightSum(page)).toBe(sum0);
  expect(after.undo).toBe(before.undo);
  expect(Math.hypot(after.t.x - before.t.x, after.t.y - before.t.y, after.t.z - before.t.z)).toBeGreaterThan(1);
});

test('視点を変えると「未保存」になる。変化の無い一括処理では「未保存」にならない', async ({ page }) => {
  await boot(page);
  const dirty = () => page.evaluate(() => (window as any).popstage.dirty as boolean);
  expect(await dirty()).toBe(false);

  // 空のレイヤーを足して保存済みにし、全消去しても(変化が無いので)未保存にならない
  await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.addLayer();
    a.fileHandle = { name: 'x.popstage', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    await a.save();
    a.weightOp('全消去', (wm: any) => wm.clear());
  });
  await page.waitForTimeout(400);
  expect(await dirty()).toBe(false);

  await dragOnStage(page, [0.5, 0.5], [0.7, 0.5], 'right');
  await expect.poll(dirty).toBe(true);

  // 回した直後に保存しても、保存が済んだ後で「未保存」に戻らない
  await page.evaluate(async () => { const a = (window as any).popstage; await a.save(); });
  await dragOnStage(page, [0.5, 0.5], [0.3, 0.5], 'right');
  await page.evaluate(async () => { await (window as any).popstage.save(); });
  expect(await dirty()).toBe(false);
  await page.waitForTimeout(500);
  expect(await dirty()).toBe(false);
});

test('画角のアンドゥは画角だけを戻し、その後に回した視点は戻さない', async ({ page }) => {
  await boot(page);
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { fov: c.fov, yaw: c.yaw }; });
  const c0 = await cam();
  await page.locator('#pFov').fill(String(c0.fov + 20));
  await page.locator('#pFov').dispatchEvent('change');
  await dragOnStage(page, [0.5, 0.5], [0.7, 0.5], 'right');
  const c1 = await cam();
  expect(c1.fov).toBe(c0.fov + 20);
  expect(c1.yaw).not.toBeCloseTo(c0.yaw);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  const c2 = await cam();
  expect(c2.fov).toBe(c0.fov);
  expect(c2.yaw).toBeCloseTo(c1.yaw);
  await page.keyboard.press('Control+y');
  expect((await cam()).fov).toBe(c0.fov + 20);
});

test('レイヤー一覧はキーボードで選択・名前の変更ができる', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { const a = (window as any).popstage; a.addLayer(); a.addLayer(); });
  const active = () => page.evaluate(() => (window as any).popstage.activeLayer.name as string);
  const selected = page.locator('#layerList li[aria-selected=true]');
  // Tab で止まるのは選択中の1項目だけ
  await expect(page.locator('#layerList li[tabindex="0"]')).toHaveCount(1);
  await selected.focus();
  const top = await active();
  await page.keyboard.press('ArrowDown');
  expect(await active()).not.toBe(top);
  await expect(selected).toBeFocused();
  await page.keyboard.press('End');
  expect(await active()).toBe('プリン');
  await page.keyboard.press('Home');
  expect(await active()).toBe(top);
  // F2 で名前を変え、Enter で確定するとフォーカスが項目に戻る
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('かお');
  await page.keyboard.press('Enter');
  expect(await active()).toBe('かお');
  await expect(selected).toBeFocused();
  // 視点リセット(Home)などのショートカットに取られない
  await page.evaluate(() => { (window as any).popstage.project.camera.yaw = 1.23; });
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => (window as any).popstage.project.camera.yaw)).toBe(1.23);
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

test('右ドラッグで視点が回り、Home で正面に戻る', async ({ page }) => {
  await boot(page);
  const cam = () => page.evaluate(() => (window as any).popstage.project.camera);
  const yaw0 = (await cam()).yaw;
  // 開いた直後は、膨らみが分かるよう斜めから見ている
  expect(Math.abs(yaw0)).toBeGreaterThan(0.1);
  expect(Math.abs((await cam()).pitch)).toBeGreaterThan(0.1);
  await dragOnStage(page, [0.5, 0.5], [0.7, 0.6], 'right');
  await page.evaluate(() => { const c = (window as any).popstage.project.camera; c.zoom = 2.5; c.target = { x: 40, y: -20, z: 5 }; c.fov = 50; });
  expect((await cam()).yaw).not.toBeCloseTo(yaw0);
  await page.locator('#view').focus();
  await page.keyboard.press('Home');
  // 画角はそのまま、回転・平行移動・ズームは正面の等倍へ
  expect(await cam()).toEqual({ fov: 50, yaw: 0, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } });
});

test('つかんでドラッグすると揺れる', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.keyboard.press('g');
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.45, { steps: 8 });
  await page.waitForTimeout(400);
  const during = await page.evaluate(() => { const a = (window as any).popstage; return a.world.displacement(a.doc.layers[0].id).x; });
  await page.mouse.up();
  expect(during).toBeGreaterThan(0.01);
});

/** ms ミリ秒の間、先頭レイヤーの揺れ(x)の最小・最大と、最初に ±0.01 を超えた向きを測る */
const watchSwingX = (page: Page, ms: number) => page.evaluate(ms => new Promise<[number, number, number]>(resolve => {
  const a = (window as any).popstage, t0 = performance.now();
  let lo = 0, hi = 0, first = 0;
  const tick = () => {
    const x = a.world.displacement(a.doc.layers[0].id).x;
    lo = Math.min(lo, x); hi = Math.max(hi, x);
    if (!first && Math.abs(x) > 0.01) first = Math.sign(x);
    if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve([lo, hi, first]);
  };
  tick();
}), ms);

test('中ドラッグで平行移動すると揺れ、視点のリセットでは揺れない', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.waitForTimeout(1500); // 重さで垂れた所で落ち着かせる
  const box = (await page.locator('#view').boundingBox())!;
  const watching = watchSwingX(page, 1200);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const [lo, hi, first] = await watching;
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBeLessThan(0);
  // 画像は右へ動くので、塗った部分は左へ遅れ、止めた所で右へ振れ返す
  expect(first).toBe(-1);
  expect(lo).toBeLessThan(-0.01);
  expect(hi).toBeGreaterThan(0.01);

  await page.waitForTimeout(3000); // 収まるのを待つ
  const still = watchSwingX(page, 800);
  const before = await page.evaluate(() => { const a = (window as any).popstage; return a.world.displacement(a.doc.layers[0].id).x; });
  await page.keyboard.press('Home');
  const [lo2, hi2] = await still;
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBe(0);
  expect(Math.max(Math.abs(lo2 - before), Math.abs(hi2 - before))).toBeLessThan(0.005);
});

test('「揺らす」ツール: 左ドラッグで画像は動かずに揺れ、視点も「未保存」も変わらない', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.waitForTimeout(1500);
  await page.keyboard.press('y');
  expect(await page.evaluate(() => (window as any).popstage.tool)).toBe('shake');
  // 自動揺らしを切った分の「未保存」を消してから試す
  const cam0 = await page.evaluate(() => { const a = (window as any).popstage; a.dirty = false; return JSON.stringify(a.project.camera); });
  const box = (await page.locator('#view').boundingBox())!;
  const watching = watchSwingX(page, 1200);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  const [lo, hi, first] = await watching;
  // 中ドラッグで右へ動かしたときと同じく、塗った部分は左へ遅れてから振れ返す
  expect(first).toBe(-1);
  expect(lo).toBeLessThan(-0.01);
  expect(hi).toBeGreaterThan(0.01);
  const after = await page.evaluate(() => { const a = (window as any).popstage; return { cam: JSON.stringify(a.project.camera), shakeX: a.shake.x, dirty: a.dirty }; });
  expect(after.cam).toBe(cam0); // カメラは画像に付いたまま(画面上の位置は変わらない)
  expect(after.shakeX).toBeLessThan(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(false);
  // 「揺らす」でも Space+左ドラッグは平行移動
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  // 中ドラッグは従来どおり画像を動かす
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBeLessThan(0);
});

test('レイヤーの追加・複製・削除・名前の変更', async ({ page }) => {
  await boot(page);
  await page.locator('aside button[data-cmd=addLayer]').click();
  await page.locator('aside button[data-cmd=duplicateLayer]').click();
  await expect(page.locator('#layerList li')).toHaveCount(3);
  await expect(page.locator('#layerCount')).toHaveText('3 / 8');
  await page.locator('#layerList li[aria-selected=true] span.truncate').dblclick();
  await page.locator('#layerList input.input').fill('顔');
  await page.keyboard.press('Enter');
  await expect(page.locator('#layerList li[aria-selected=true]')).toContainText('顔');
  await page.locator('aside button[data-cmd=deleteLayer]').click();
  await expect(page.locator('#layerList li')).toHaveCount(2);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
  await expect(page.locator('#layerList li')).toHaveCount(1);
});

test('スライダーの変更は1手として元に戻せる', async ({ page }) => {
  await boot(page);
  const pop0 = await page.evaluate(() => (window as any).popstage.activeLayer.pop);
  const slider = page.locator('#pPop');
  await slider.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  const pop1 = await page.evaluate(() => (window as any).popstage.activeLayer.pop);
  expect(pop1).toBe(pop0 + 5);
  await page.locator('#view').focus();
  // キー操作は1回ごとに change が出るので5手。すべて戻すと元の値
  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.pop)).toBe(pop0);

});

test('プリセットで材質・揺らし方・周期が変わり、1手で元に戻せる', async ({ page }) => {
  await boot(page);
  const state = () => page.evaluate(() => {
    const a = (window as any).popstage;
    return { preset: a.activeLayer.physics.preset, motion: a.activeLayer.physics.motion, hardness: a.activeLayer.physics.hardness, period: a.project.autoSwing.period };
  });
  const before = await state();
  expect(before).toMatchObject({ preset: 'puru', motion: 'jiggle' });
  await expect(page.locator('#pPreset option')).toHaveCount(12); // 11 種類 + カスタム

  await page.selectOption('#pPreset', 'bain');
  expect(await state()).toEqual({ preset: 'bain', motion: 'jump', hardness: 0.25, period: 1.8 });
  await expect(page.locator('#pHardO')).toHaveText('25');
  await expect(page.locator('#pMotion')).toHaveValue('jump');
  await expect(page.locator('#pPresetDesc')).toContainText('ジャンプ');
  await expect(page.locator('#pPeriodO')).toHaveText('1.8秒');

  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  expect(await state()).toEqual(before);

  // 揺らし方は詳細設定の中にあり、変えるとカスタムになる
  await expect(page.locator('#pMotion')).toBeHidden();
  await page.locator('#physDetails summary').click();
  await page.selectOption('#pMotion', 'heartbeat');
  await expect(page.locator('#physSummary')).toContainText('鼓動');
  expect(await state()).toMatchObject({ preset: 'custom', motion: 'heartbeat', hardness: before.hardness });
});

test('揺らし方の固有設定: 選んだ揺らし方の項目が出て、変えると1手で戻せる', async ({ page }) => {
  await boot(page);
  const params = () => page.evaluate(() => { const p = (window as any).popstage.activeLayer.physics; return { preset: p.preset, mp: p.motionParams }; });
  await page.locator('#physDetails summary').click();
  // 既定(ぷるぷる = 上下に小刻み)の項目
  await expect(page.locator('#motionParams label')).toHaveText(['振れ幅', '2回目の強さ', 'つつく長さ']);
  await page.selectOption('#pPreset', 'tame');
  await expect(page.locator('#motionParams label')).toHaveText(['ためる深さ', 'ためる時間', '膨らみの強さ']);
  await expect(page.locator('#mp-depth + output')).toHaveText('70%');

  await page.locator('#mp-depth').fill('0.95');
  await page.locator('#mp-depth').dispatchEvent('change');
  await expect(page.locator('#mp-depth + output')).toHaveText('95%');
  expect(await params()).toEqual({ preset: 'custom', mp: { 'charge.depth': 0.95 } });
  expect(await page.evaluate(() => (window as any).popstage.history.undoLabel)).toBe('ためて膨らむ: ためる深さ');

  // 選択式の項目(伸びて戻るの向き)
  await page.selectOption('#pMotion', 'stretch');
  await page.selectOption('#mp-dir', '2');
  expect((await params()).mp).toEqual({ 'charge.depth': 0.95, 'stretch.dir': 2 });

  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await params()).toEqual({ preset: 'tame', mp: {} });
  await expect(page.locator('#mp-depth + output')).toHaveText('70%');
});

test('保存して開き直すと同じ状態に戻る', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.addLayer();
    a.store.patchLayer(a.activeLayerId, { pop: 1234, name: '二枚目' });
    a.activeLayer.weights.data.fill(33);
    a.store.patchProject({ background: '#336699' });
    const before = JSON.stringify(a.doc.layers.map((l: any) => [l.name, l.pop, l.physics, l.weights.data.reduce((s: number, v: number) => s + v, 0)]));
    const bytes = a.serialize(await a.thumbnail());
    await a.loadSample();
    await a.openProjectBytes(bytes, 'test.popstage', null);
    const after = JSON.stringify(a.doc.layers.map((l: any) => [l.name, l.pop, l.physics, l.weights.data.reduce((s: number, v: number) => s + v, 0)]));
    return { before, after, bg: a.project.background, size: bytes.length };
  });
  expect(result.after).toBe(result.before);
  expect(result.bg).toBe('#336699');
  expect(result.size).toBeGreaterThan(1000);
});

/** 自動保存(IndexedDB)を直接読み書きする */
const autosaveOp = (page: Page, op: 'get' | 'put' | 'clear', entry?: { name: string; bytes: number[] }) => page.evaluate(async ([op, entry]) => {
  const db: IDBDatabase = await new Promise((res, rej) => {
    const r = indexedDB.open('popstage', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('autosave');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const store = db.transaction('autosave', op === 'get' ? 'readonly' : 'readwrite').objectStore('autosave');
  const req = op === 'get' ? store.get('current') : op === 'clear' ? store.delete('current')
    : store.put({ savedAt: Date.now(), name: entry!.name, bytes: new Uint8Array(entry!.bytes) }, 'current');
  const v = await new Promise(res => { req.onsuccess = () => res(req.result); });
  db.close();
  return op === 'get' ? (v ? (v as any).name as string : null) : null;
}, [op, entry] as const);

test('自動保存の復元に失敗したらサンプルで始め、自動保存を残すか消すかを選べる', async ({ page }) => {
  await page.goto('/?e2e');
  await autosaveOp(page, 'put', { name: 'broken.popstage', bytes: [1, 2, 3] });
  const answer = async (yes: boolean) => {
    await expect(page.locator('#askDialog')).toBeVisible();
    await page.locator(yes ? '#askYes' : '#askNo').click();
  };
  const restoreAndFail = async () => {
    await page.goto('/?e2e&restore');
    await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元しますか?');
    await answer(true);
    await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元できませんでした');
  };

  // 残しておく → サンプルが開き、自動保存は残る
  await restoreAndFail();
  await answer(false);
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await autosaveOp(page, 'get')).toBe('broken.popstage');

  // 削除する → 自動保存が消える
  await restoreAndFail();
  await answer(true);
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await autosaveOp(page, 'get')).toBeNull();
});

test('自動保存から復元すると、塗った内容と設定が戻る', async ({ page }) => {
  await boot(page);
  await dragOnStage(page, [0.45, 0.45], [0.6, 0.55]);
  const before = await page.evaluate(() => {
    const a = (window as any).popstage;
    a.store.patchProject({ background: '#224466' });
    return a.doc.layers.map((l: any) => l.weights.data.reduce((s: number, v: number) => s + v, 0));
  });
  expect(before[0]).toBeGreaterThan(0);
  // 自動保存が書き込まれるまで待つ
  await expect.poll(() => autosaveOp(page, 'get'), { timeout: 10000 }).not.toBeNull();
  await page.waitForTimeout(1500);
  await page.goto('/?e2e&restore');
  await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元しますか?');
  await page.locator('#askYes').click();
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  const after = await page.evaluate(() => {
    const a = (window as any).popstage;
    return { sums: a.doc.layers.map((l: any) => l.weights.data.reduce((s: number, v: number) => s + v, 0)), bg: a.project.background, dirty: a.dirty };
  });
  expect(after.sums).toEqual(before);
  expect(after.bg).toBe('#224466');
  expect(after.dirty).toBe(true);
});

test('別のファイルを開くと、前の作業の自動保存は消える', async ({ page }) => {
  await boot(page);
  const bytes = await page.evaluate(() => Array.from((window as any).popstage.serialize() as Uint8Array));
  await autosaveOp(page, 'put', { name: 'old.popstage', bytes: [9, 9, 9] });
  expect(await autosaveOp(page, 'get')).toBe('old.popstage');
  expect(await page.evaluate(async (b) => (window as any).popstage.openProjectBytes(new Uint8Array(b), 'new.popstage', null), bytes)).toBe(true);
  await expect.poll(() => autosaveOp(page, 'get')).toBeNull();
});

test('自動保存は塗った内容を反映し、失敗したらステータスバーで知らせる', async ({ page }) => {
  await boot(page);
  const autosavedSum = () => page.evaluate(async () => {
    const db: IDBDatabase = await new Promise(res => {
      const r = indexedDB.open('popstage', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('autosave');
      r.onsuccess = () => res(r.result);
    });
    const req = db.transaction('autosave', 'readonly').objectStore('autosave').get('current');
    const v: any = await new Promise(res => { req.onsuccess = () => res(req.result); });
    db.close();
    if (!v) return -1;
    const mod = '/src/storage/popstage.ts';
    const { deserializeProject } = await import(/* @vite-ignore */ mod);
    // 自動保存は Blob で入る(古い版は Uint8Array)
    const bytes = v.bytes instanceof Blob ? new Uint8Array(await v.bytes.arrayBuffer()) : v.bytes;
    const { project } = await deserializeProject(bytes);
    return project.documents[0].layers[0].weights.data.reduce((s: number, x: number) => s + x, 0) as number;
  });
  // 1回目: 塗って自動保存させる
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  const s1 = await weightSum(page);
  await expect.poll(autosavedSum, { timeout: 10000 }).toBe(s1);
  // 2回目: さらに塗ると、使い回していた PNG ではなく新しい内容が保存される
  await dragOnStage(page, [0.3, 0.3], [0.4, 0.4]);
  const s2 = await weightSum(page);
  expect(s2).not.toBe(s1);
  await expect.poll(autosavedSum, { timeout: 10000 }).toBe(s2);

  // 保存先が壊れていると、ステータスバーに失敗が出る
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('容量が足りません', 'QuotaExceededError'); };
  });
  await page.evaluate(() => (window as any).popstage.store.patchLayer((window as any).popstage.activeLayerId, { pop: 33 }));
  await expect(page.locator('#sSave')).toContainText('自動保存に失敗しました', { timeout: 10000 });
  // ファイルへ保存できたら、失敗の案内は消える
  await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.fileHandle = { name: 'x.popstage', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    await a.save();
  });
  await expect(page.locator('#sSave')).not.toContainText('自動保存に失敗しました');
});

test('画像を開くときのデコードは1回だけ。巨大な寸法の画像はデコードする前に断る', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    let calls = 0;
    const orig = window.createImageBitmap;
    (window as any).createImageBitmap = (...args: any[]) => { calls++; return (orig as any)(...args); };
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    c.getContext('2d')!.fillRect(10, 10, 50, 30);
    const blob = (type: string): Promise<Blob> => new Promise(r => c.toBlob(b => r(b!), type, 0.9));
    const mod = '/src/ui/imageio.ts';
    const { imageHeaderSize } = await import(/* @vite-ignore */ mod);
    const sizes: Record<string, unknown> = {};
    for (const t of ['image/png', 'image/jpeg', 'image/webp']) sizes[t] = imageHeaderSize(new Uint8Array(await (await blob(t)).arrayBuffer()));

    calls = 0;
    await a.openFile(new File([await blob('image/png')], 'once.png', { type: 'image/png' }));
    const openCalls = calls, name = a.doc.name;

    // IHDR だけの PNG で 20000×20000 を名乗る
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 20000); new DataView(png.buffer).setUint32(20, 20000);
    calls = 0;
    await a.openFile(new File([png], 'huge.png', { type: 'image/png' }));
    // 拡張子は .png でも中身が GIF のもの(ヘッダから大きさを確かめられない)
    await a.openFile(new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b])], 'fake.png', { type: 'image/png' }));
    window.createImageBitmap = orig;
    return { sizes, openCalls, name, hugeCalls: calls, after: a.doc.name };
  });
  for (const t of ['image/png', 'image/jpeg', 'image/webp']) expect(r.sizes[t], t).toEqual({ width: 120, height: 80 });
  expect(r.openCalls).toBe(1);
  expect(r.name).toBe('once.png');
  expect(r.hugeCalls).toBe(0);
  expect(r.after).toBe('once.png');
  await expect(page.locator('#toasts')).toContainText('画像が大きすぎます');
  await expect(page.locator('#toasts')).toContainText('PNG / JPEG / WebP ではありません');
});

test('ドロップで画像を開ける。ダイアログ表示中・書き出し中は開かない', async ({ page }) => {
  await boot(page);
  const drop = () => page.evaluate(async () => {
    const a = (window as any).popstage;
    const c = document.createElement('canvas'); c.width = 40; c.height = 30;
    c.getContext('2d')!.fillRect(0, 0, 40, 30);
    const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 300));
    return a.doc.name as string;
  });
  const name0 = await page.evaluate(() => (window as any).popstage.doc.name);

  // ダイアログの表示中
  await page.evaluate(() => (document.getElementById('helpDialog') as HTMLDialogElement).showModal());
  expect(await drop()).toBe(name0);
  await expect(page.locator('#toasts')).toContainText('ダイアログを閉じてから');
  await page.evaluate(() => (document.getElementById('helpDialog') as HTMLDialogElement).close());

  // 書き出しの最中
  await page.evaluate(() => { (window as any).popstage.exporting = true; });
  expect(await drop()).toBe(name0);
  await expect(page.locator('#toasts')).toContainText('いまはファイルを開けません');
  await page.evaluate(() => { (window as any).popstage.exporting = false; });

  // ふだんは開ける
  expect(await drop()).toBe('dropped.png');
});

test('上書き保存の最中に変更すると、保存後も「未保存」のまま残る', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    let written = false;
    // 書き込みに時間がかかる保存先(上書き保存のハンドル)の代わり
    a.fileHandle = { name: 'slow.popstage', createWritable: async () => ({ write: async () => { written = true; await gate; }, close: async () => {} }) };
    const clean = async () => { const p = a.save(); await new Promise(r => setTimeout(r, 0)); release(); return p; };

    // 変更しないで保存すると「保存済み」になる
    a.store.patchLayer(a.activeLayerId, { pop: 10 });
    const ok1 = await clean();
    const dirty1 = a.dirty;

    // 書き込みを待っている間に変更すると「未保存」のまま
    let release2!: () => void, writing!: () => void;
    const gate2 = new Promise<void>(res => { release2 = res; });
    const started = new Promise<void>(res => { writing = res; });
    a.fileHandle = { name: 'slow.popstage', createWritable: async () => ({ write: async () => { writing(); await gate2; }, close: async () => {} }) };
    a.store.patchLayer(a.activeLayerId, { pop: 20 });
    const p = a.save();
    await started; // 直列化が済み、書き込みを待っているところ
    a.store.patchLayer(a.activeLayerId, { pop: 30 });
    release2();
    const ok2 = await p;
    return { ok1, dirty1, written, ok2, dirty2: a.dirty };
  });
  expect(r).toEqual({ ok1: true, dirty1: false, written: true, ok2: true, dirty2: true });
});

test('中の画像が壊れた .popstage を開いても、今の状態は何も変わらない', async ({ page }) => {
  await boot(page);
  const good = await page.evaluate(async () => Array.from((window as any).popstage.serialize() as Uint8Array));
  // 画像だけでたらめなバイト列に差し替え、名前とレイヤーの寸法も変えておく
  const files = unzipSync(new Uint8Array(good));
  const json = JSON.parse(strFromU8(files['project.json']));
  json.documents[0].name = 'BROKEN';
  json.documents[0].image.width = 300; json.documents[0].image.height = 200;
  const imagePath: string = json.documents[0].image.path;
  files['project.json'] = strToU8(JSON.stringify(json));
  files[imagePath] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const broken = Array.from(zipSync(files));

  const r = await page.evaluate(async (bytes) => {
    const a = (window as any).popstage;
    const snap = () => ({ name: a.doc.name, file: a.fileName, undo: a.history.canUndo, image: a.stage.imageSize.w, weightTex: a.stage.weightSize.w, layerW: a.doc.layers[0].weights.width });
    a.weightOp('反転', (wm: any) => wm.invert()); // 元に戻せる操作を1つ積んでおく
    const before = snap();
    await a.openProjectBytes(new Uint8Array(bytes), 'broken.popstage', null);
    return { before, after: snap() };
  }, broken);
  expect(r.before.undo).toBe(true);
  expect(r.after).toEqual(r.before);
  await expect(page.locator('#toasts')).toContainText('画像を読み込めませんでした');
});

for (const format of ['mp4', 'webm', 'webm-alpha', 'png', 'gif'] as const) {
  test(`書き出し: ${format}`, async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async (format) => {
      const a = (window as any).popstage;
      const path = '/src/export/encoders.ts';
      const { availableFormats } = await import(/* @vite-ignore */ path);
      const avail = await availableFormats(160, 120);
      if (!avail[format]) return { skipped: true };
      const res = await a.exportMedia({ format, width: 160, height: 120, fps: 30, duration: 1, background: format === 'mp4' || format === 'webm' ? '#ffffff' : null, motion: 'auto' }, () => {}, new AbortController().signal);
      const head = new Uint8Array(await res.blob.slice(0, 12).arrayBuffer());
      return { skipped: false, size: res.blob.size, frames: res.frames, head: [...head], name: res.filename };
    }, format);
    test.skip(r.skipped === true, `${format} はこのブラウザで使えない`);
    expect(r.frames).toBe(30);
    expect(r.size).toBeGreaterThan(500);
    const h = r.head!;
    if (format === 'mp4') expect(String.fromCharCode(...h.slice(4, 8))).toBe('ftyp');
    if (format.startsWith('webm')) expect(h.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    if (format === 'png') expect(h.slice(0, 2)).toEqual([0x50, 0x4b]);
    if (format === 'gif') expect(String.fromCharCode(...h.slice(0, 6))).toBe('GIF89a');
  });
}

test('書き出し: 連番PNG で大きく長いときは、メモリの目安を示して確認する', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exportDialog')).toBeVisible();
  await page.locator('#exFormat').selectOption('png');
  await page.locator('#exW').fill('3840');
  await page.locator('#exH').fill('3840');
  await page.locator('#exLoop').uncheck();
  await page.locator('#exDur').fill('60');
  await page.locator('#exDur').dispatchEvent('change');
  await page.locator('#exStart').click();
  await expect(page.locator('#askTitle')).toHaveText('書き出すデータが大きくなります');
  await expect(page.locator('#askBody')).toContainText('GB');
  await page.locator('#askNo').click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).popstage.exporting)).toBe(false);
  await expect(page.locator('#exportDialog')).toBeVisible();
});

test('書き出し: 直前の操作を再生', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.setPaused(false);
    // 1秒ぶん、記録しながら進める
    a.world.grab = { x: 0.2, y: 0, z: 0 };
    for (let i = 0; i < 60; i++) a.frame(1 / 60);
    a.world.grab = null;
    for (let i = 0; i < 60; i++) a.frame(1 / 60);
    const res = await a.exportMedia({ format: 'png', width: 64, height: 48, fps: 30, duration: 1.5, background: null, motion: 'replay' }, () => {}, new AbortController().signal);
    return res.frames;
  });
  expect(r).toBe(45);
});

test('見た目の基準画像(揺れ停止・正面寄りの視点)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { const a = (window as any).popstage; a.setViewOption('overlay', false); });
  await page.waitForTimeout(300);
  await expect(page.locator('#stage')).toHaveScreenshot('stage-sample.png');
});

/* ---------- 最近開いたファイル ---------- */

/** 最近開いたファイルの記録(IndexedDB)を読む。記録は開く処理を待たずに進むので、件数が揃うまで待つのに使う */
const recentStored = (page: Page) => page.evaluate(async () => {
  const mod = '/src/storage/recent.ts';
  const { recent } = await import(/* @vite-ignore */ mod);
  return (await recent.list()).map((e: any) => ({ name: e.name, handle: !!e.handle, blob: e.bytes instanceof Blob }));
});
const waitRecent = (page: Page, n: number) => expect.poll(async () => (await recentStored(page)).length).toBe(n);

async function openRecentDialog(page: Page): Promise<void> {
  await page.locator('#menubar [role=button]', { hasText: 'ファイル' }).click();
  await page.locator('#menubar button[data-cmd=recent]').click();
  await expect(page.locator('#recentDialog')).toHaveAttribute('open', '');
}

/** 塗りつぶした PNG を作る(ブラウザ内で) */
const makePng = (page: Page, name: string, color: string) => page.evaluate(async ([name, color]) => {
  const c = document.createElement('canvas'); c.width = 160; c.height = 120;
  const g = c.getContext('2d')!; g.fillStyle = color; g.fillRect(0, 0, 160, 120);
  const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
  (window as any).__png = new File([b], name, { type: 'image/png' });
}, [name, color]);

test('最近開いたファイル: 開いた画像が縮小画像付きで並び、そこから開き直せる(場所を覚えられないときはコピー)', async ({ page }) => {
  await boot(page);
  await openRecentDialog(page);
  await expect(page.locator('#recentEmpty')).toBeVisible();
  await expect(page.locator('#recentClear')).toBeDisabled();
  await page.keyboard.press('Escape');

  await makePng(page, 'red.png', '#e33');
  await page.evaluate(async () => { const a = (window as any).popstage; await a.openFile((window as any).__png); });
  await makePng(page, 'blue.png', '#33e');
  await page.evaluate(async () => { const a = (window as any).popstage; await a.openFile((window as any).__png); await a.loadSample(); });
  await waitRecent(page, 2);
  // コピーは Blob で持つ(一覧を読むだけでは中身がメモリに載らない)
  expect(await recentStored(page)).toEqual([{ name: 'blue.png', handle: false, blob: true }, { name: 'red.png', handle: false, blob: true }]);

  await openRecentDialog(page);
  const cards = page.locator('#recentList li');
  await expect(cards).toHaveCount(2);
  await expect(cards.locator('.recent-name')).toHaveText(['blue.png', 'red.png']); // 新しい順
  await expect(cards.first()).toContainText('コピー');
  const thumbOk = await cards.first().locator('img').evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth > 0));
  expect(thumbOk).toBe(true);
  // 最初の項目にフォーカスがある
  await expect(cards.first().locator('button.recent-open')).toBeFocused();
  await cards.nth(1).locator('button.recent-open').click();
  await expect(page.locator('#recentDialog')).not.toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => (window as any).popstage.doc.name)).toBe('red.png');
  // 開き直すと先頭へ移り、重複しない
  await expect.poll(async () => (await recentStored(page)).map((e: { name: string }) => e.name)).toEqual(['red.png', 'blue.png']);
  await openRecentDialog(page);
  await expect(cards.locator('.recent-name')).toHaveText(['red.png', 'blue.png']);
});

test('最近開いたファイル: 一覧から外す・消去する(ファイル自体はそのまま)', async ({ page }) => {
  await boot(page);
  for (const [n, c] of [['a.png', '#e33'], ['b.png', '#3e3'], ['c.png', '#33e']]) {
    await makePng(page, n, c);
    await page.evaluate(async () => { await (window as any).popstage.openFile((window as any).__png); });
  }
  await waitRecent(page, 3);
  await openRecentDialog(page);
  const names = page.locator('#recentList .recent-name');
  await expect(names).toHaveText(['c.png', 'b.png', 'a.png']);
  await page.locator('#recentList li').first().locator('.recent-remove').click();
  await expect(names).toHaveText(['b.png', 'a.png']);
  // Delete キーでも外せて、フォーカスは次の項目へ
  await page.locator('#recentList button.recent-open').first().focus();
  await page.keyboard.press('Delete');
  await expect(names).toHaveText(['a.png']);
  await expect(page.locator('#recentList button.recent-open').first()).toBeFocused();
  // 消去は確認してから
  await page.locator('#recentClear').click();
  await page.locator('#askNo').click();
  await expect(names).toHaveText(['a.png']);
  await page.locator('#recentClear').click();
  await page.locator('#askYes').click();
  await expect(page.locator('#recentEmpty')).toBeVisible();
  await expect(page.locator('#recentDialog')).toHaveAttribute('open', '');
  expect(await recentStored(page)).toEqual([]);
});

test('最近開いたファイル: 未保存の確認でやめたら一覧に戻る。記録に失敗しても開ける', async ({ page }) => {
  await boot(page);
  await makePng(page, 'keep.png', '#e33');
  await page.evaluate(async () => { const a = (window as any).popstage; await a.openFile((window as any).__png); await a.loadSample(); a.addLayer(); });
  await waitRecent(page, 1);
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(true);
  await openRecentDialog(page);
  // ダブルクリックしても確認は1回だけ
  await page.locator('#recentList button.recent-open').first().dblclick();
  await expect(page.locator('#askTitle')).toHaveText('保存されていない変更があります');
  await page.locator('#askNo').click();
  await expect(page.locator('#recentDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#askDialog')).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => (window as any).popstage.doc.name)).not.toBe('keep.png');
  await page.locator('#recentList button.recent-open').first().click();
  await page.locator('#askYes').click();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.doc.name)).toBe('keep.png');
  await expect(page.locator('#toasts')).not.toContainText('いまはファイルを開けません');

  // IndexedDB が開けなくても、画像は開ける(一覧に入らないだけ)
  await makePng(page, 'nodb.png', '#3e3');
  await page.evaluate(() => { indexedDB.open = () => { throw new Error('IndexedDB は使えません'); }; });
  await page.evaluate(async () => { await (window as any).popstage.openFile((window as any).__png); });
  expect(await page.evaluate(() => (window as any).popstage.doc.name)).toBe('nodb.png');
  await makePng(page, 'next.png', '#33e');
  await page.evaluate(async () => { await (window as any).popstage.openFile((window as any).__png); });
  expect(await page.evaluate(() => (window as any).popstage.doc.name)).toBe('next.png');
});

test('最近開いたファイル: ファイルの場所を覚えて開き直し、保存も元のファイルへ。消えたファイルは一覧から外せる', async ({ page }) => {
  await boot(page);
  // ブラウザ内のファイルシステム(OPFS)で、本物のファイルハンドルを作る
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const c = document.createElement('canvas'); c.width = 100; c.height = 100; c.getContext('2d')!.fillRect(0, 0, 50, 50);
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    const h = await root.getFileHandle('photo.png', { create: true });
    const w = await h.createWritable(); await w.write(b); await w.close();
    const a = (window as any).popstage;
    await a.openFile(await h.getFile(), h);
    // プロジェクトとして保存する(保存先も場所として覚える)
    a.fileHandle = await root.getFileHandle('work.popstage', { create: true });
    await a.save();
    await a.loadSample();
  });
  await waitRecent(page, 2);
  await openRecentDialog(page);
  const cards = page.locator('#recentList li');
  await expect(cards.locator('.recent-name')).toHaveText(['work.popstage', 'photo.png']);
  await expect(cards.first()).toContainText('プロジェクト');
  await expect(page.locator('#recentList')).not.toContainText('コピー');
  expect(await recentStored(page)).toEqual([{ name: 'work.popstage', handle: true, blob: false }, { name: 'photo.png', handle: true, blob: false }]);

  // プロジェクトを開き直すと、上書き保存の先も元のファイルになる
  await cards.first().locator('button.recent-open').click();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.fileName)).toBe('work.popstage');
  expect(await page.evaluate(async () => {
    const a = (window as any).popstage, root = await navigator.storage.getDirectory();
    return a.fileHandle.isSameEntry(await root.getFileHandle('work.popstage'));
  })).toBe(true);

  // ファイルが消えていたら、一覧から外すか聞く
  await page.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry('photo.png'); });
  await openRecentDialog(page);
  await cards.nth(1).locator('button.recent-open').click();
  await expect(page.locator('#askTitle')).toHaveText('「photo.png」が見つかりません');
  await page.locator('#askYes').click();
  await expect(cards.locator('.recent-name')).toHaveText(['work.popstage']);
  expect(await page.evaluate(() => (window as any).popstage.fileName)).toBe('work.popstage');
});

test('パフォーマンスのデバッグ表示は ?debug かショートカットで出し、止まった所を記録して書き出せる', async ({ page }) => {
  await boot(page);
  // ふだんは計測しない
  expect(await page.evaluate(() => (window as any).popstage.perf)).toBeNull();
  await expect(page.locator('#perfOverlay')).toHaveCount(0);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toBeVisible();
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).popstage.perf)).toBeNull();

  await page.goto('/?e2e&debug');
  await page.waitForFunction(() => { const a = (window as any).popstage; return a?.doc && a.stage.hasDocument && a.perf; });
  await expect(page.locator('#perfOverlay')).toContainText('fps');
  expect(await page.evaluate(() => (window as any).popstage.loops)).toBe(1);
  // メインスレッドを 400ms 止めると、「このページの処理」で止まったと記録される
  await page.evaluate(() => new Promise<void>(res => requestAnimationFrame(() => { const t = performance.now(); while (performance.now() - t < 400) { /* 止める */ } res(); })));
  await expect(page.locator('#perfOverlay')).toContainText('止まる → このページの処理', { timeout: 5000 });
  // 「記録を保存」で書き出す JSON を横取りして確かめる
  await page.evaluate(() => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b: Blob | MediaSource) => { (window as any).__saved = (b as Blob).text(); return orig(b); };
  });
  await page.locator('#perfOverlay [data-act=save]').click();
  const data = JSON.parse(await page.evaluate(() => (window as any).__saved));
  expect(data.freezes.length).toBeGreaterThan(0);
  // 起動直後の読み込みでも止まることがあるので、いちばん長い記録を見る
  const worst = data.freezes.reduce((m: any, f: any) => (f.gap > m.gap ? f : m));
  expect(worst.gap).toBeGreaterThan(350);
  expect(worst.verdict).toBe('page');
  expect(data.frames.length).toBeGreaterThan(10);
  expect(data.document.layers).toBe(1);
});

/* ---------- ショートカットと細かな表示 ---------- */

test('ショートカット: 一覧のキーがすべて期待どおりに効く', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  await page.locator('#view').focus();

  // ツール(ボタンにもキーを出す)
  for (const [key, tool] of [['b', 'brush'], ['e', 'erase'], ['s', 'smooth'], ['i', 'inflate'], ['g', 'grab'], ['y', 'shake'], ['v', 'view'], ['b', 'brush']]) {
    await page.keyboard.press(key);
    expect(await app(a => a.tool), key).toBe(tool);
    await expect(page.locator(`.tool[data-tool=${tool}]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`.tool[data-tool=${tool}] .tool-key`)).toHaveText(key.toUpperCase());
  }
  // 表示の切り替え(押すたびに入れ替わる)
  const view = () => app(a => ({ ...a.view, paused: a.paused }));
  for (const [key, prop] of [['w', 'overlay'], ['Shift+W', 'fade'], ['Shift+G', 'grid'], ['f', 'flat'], ['p', 'paused'], ['m', 'multi']] as const) {
    const before = (await view())[prop];
    await page.keyboard.press(key);
    await expect.poll(async () => (await view())[prop], key).toBe(!before);
    await page.keyboard.press(key);
    await expect.poll(async () => (await view())[prop], key).toBe(before);
  }
  // Home で正面へ
  await app(a => { a.project.camera.yaw = 1; a.project.camera.pitch = 0.5; });
  await page.keyboard.press('Home');
  expect(await app(a => [a.project.camera.yaw, a.project.camera.pitch])).toEqual([0, 0]);
  // [ と ] でブラシの大きさ
  const size0 = await app(a => a.brush.size);
  await page.keyboard.press(']');
  expect(await app(a => a.brush.size)).toBeGreaterThan(size0);
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  expect(await app(a => a.brush.size)).toBeLessThan(size0);
  // 元に戻す / やり直す
  await app(a => a.weightOp('全消去', (wm: any) => wm.clear()));
  const sum = () => app(a => a.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0) as number);
  expect(await sum()).toBe(0);
  await page.keyboard.press('Control+z');
  expect(await sum()).toBeGreaterThan(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await sum()).toBe(0);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  expect(await sum()).toBe(0);
  // 保存(Ctrl+S は今のファイルへ、Ctrl+Shift+S は保存先を選ぶ)・開く(Ctrl+O / Ctrl+Shift+O)は、ファイルの選択画面を横取りして確かめる
  await app(a => {
    const w = window as any;
    w.__calls = [];
    w.showSaveFilePicker = async () => { w.__calls.push('saveAs'); throw new DOMException('x', 'AbortError'); };
    w.showOpenFilePicker = async (o: any) => { w.__calls.push('open:' + Object.keys(o.types[0].accept).join(',')); throw new DOMException('x', 'AbortError'); };
    a.fileHandle = { name: 'k.popstage', createWritable: async () => { w.__calls.push('save'); return { write: async () => {}, close: async () => {} }; } };
  });
  const calls = () => page.evaluate(() => (window as any).__calls as string[]);
  await page.keyboard.press('Control+s');
  await expect.poll(calls).toEqual(['save']);
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(calls).toEqual(['save', 'saveAs']);
  await page.keyboard.press('Control+o');
  await expect.poll(calls).toEqual(['save', 'saveAs', 'open:application/zip,image/*']);
  await page.keyboard.press('Control+Shift+o');
  await expect.poll(calls).toEqual(['save', 'saveAs', 'open:application/zip,image/*', 'open:image/*']);
  // 書き出し
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exportDialog')).toHaveAttribute('open', '');
  // 画面を覆うダイアログの表示中は、ほかのショートカットは効かない
  await page.keyboard.press('g');
  expect(await app(a => a.tool)).toBe('brush');
  await page.keyboard.press('Escape');
  await expect(page.locator('#exportDialog')).not.toHaveAttribute('open', '');
  // パフォーマンスのデバッグ表示
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toBeVisible();
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toHaveCount(0);
  // 日本語入力がオンのとき(key が Process)も、キーの位置で効く
  await page.evaluate(() => document.getElementById('view')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyG', bubbles: true })));
  expect(await app(a => a.tool)).toBe('grab');
  // 選択欄にフォーカスがあるときは、文字キーを選択欄に任せる
  await page.locator('#brushPressure').focus();
  await page.keyboard.press('b');
  expect(await app(a => a.tool)).toBe('grab');
  await page.locator('#view').focus();

  // 膨らませるのパネル(画面を覆わない)を開いている間も、表示の切り替えは効く。ツールの切り替えや元に戻すは効かない
  await page.keyboard.press('i');
  await dragOnStage(page, [0.4, 0.35], [0.6, 0.65]);
  await expect(page.locator('#inflateDialog')).toHaveJSProperty('open', true);
  await page.locator('#view').focus();
  const overlay = (await view()).overlay;
  await page.keyboard.press('w');
  await expect.poll(async () => (await view()).overlay).toBe(!overlay);
  await page.keyboard.press('b');
  expect(await app(a => a.tool)).toBe('inflate');
  const undo0 = await app(a => a.history.size);
  await page.keyboard.press('Control+z');
  expect(await app(a => [a.previewingInflate, a.history.size])).toEqual([true, undo0]);
});

test('3面図にはウェイトの重ね表示と「画像を薄く」を効かせない。画像の外ではカーソルが十字になる', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  const front = page.locator('#multiView [data-kind=front]');
  const set = (overlay: boolean, fade: boolean) => page.evaluate(([o, f]) => { const a = (window as any).popstage; a.view.overlay = o; a.view.fade = f; a.syncView(); }, [overlay, fade]);
  const shots = async () => {
    await page.waitForTimeout(150);
    return { front: await front.screenshot(), main: await page.screenshot({ clip: { x: (await page.locator('#view').boundingBox())!.x, y: (await page.locator('#view').boundingBox())!.y, width: 300, height: 300 } }) };
  };
  await set(false, false);
  const plain = await shots();
  await set(true, true);
  const both = await shots();
  expect(both.front.equals(plain.front)).toBe(true);
  expect(both.main.equals(plain.main)).toBe(false); // 主ビューには効く

  // カーソル: 画像の上はブラシの円だけ、画像の外では十字
  await page.keyboard.press('m');
  await page.keyboard.press('b');
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.locator('#view')).toHaveCSS('cursor', 'none');
  await page.mouse.move(box.x + 4, box.y + 4);
  await expect(page.locator('#view')).toHaveCSS('cursor', 'crosshair');
});

test('設定はブラウザに覚え、読み込み直しても戻る(ファイルには書かない)', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  // ブラシ・表示・ツール・背景を変える
  await page.locator('#brushSize').fill('150');
  await page.locator('#brushPressure').selectOption('size');
  await page.locator('#vGrid').check();
  await page.locator('#vMulti').check();
  await page.locator('#view').focus();
  await page.keyboard.press('g');
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ background: '#123456', autoSwing: { ...a.project.autoSwing, period: 2.5 } }); });
  // 書き出しの設定
  await page.keyboard.press('Control+e');
  await page.locator('#exW').fill('640');
  await page.locator('#exW').dispatchEvent('change');
  await page.locator('input[name=exFps][value="30"]').check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  const s = await page.evaluate(() => { const a = (window as any).popstage; return { brush: a.brush, view: a.view, tool: a.tool, bg: a.project.background }; });
  expect(s.brush.size).toBe(150);
  expect(s.brush.pressure).toBe('size');
  expect(s.view.grid).toBe(true);
  expect(s.view.multi).toBe(true);
  expect(s.tool).toBe('grab');
  await expect(page.locator('#brushSizeO')).toHaveText('150px');
  await expect(page.locator('#vGrid')).toBeChecked();
  // サンプルの背景は変えない。新しい画像を開くと、覚えた背景・周期になる
  expect(s.bg).not.toBe('#123456');
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    await (window as any).popstage.openFile(new File([b], 'n.png', { type: 'image/png' }));
  });
  expect(await page.evaluate(() => { const a = (window as any).popstage; return [a.project.background, a.project.autoSwing.period]; })).toEqual(['#123456', 2.5]);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exW')).toHaveValue('640');
  await expect(page.locator('input[name=exFps][value="30"]')).toBeChecked();
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
