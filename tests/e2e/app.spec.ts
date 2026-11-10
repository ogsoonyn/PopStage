import { test, expect, type Page } from '@playwright/test';

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

test('右ドラッグで視点が回り、Home で戻る', async ({ page }) => {
  await boot(page);
  const yaw0 = await page.evaluate(() => (window as any).popstage.project.camera.yaw);
  await dragOnStage(page, [0.5, 0.5], [0.7, 0.5], 'right');
  const yaw1 = await page.evaluate(() => (window as any).popstage.project.camera.yaw);
  expect(yaw1).not.toBeCloseTo(yaw0);
  await page.locator('#view').focus();
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => (window as any).popstage.project.camera.yaw)).toBeCloseTo(yaw0);
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

  await page.selectOption('#pPreset', 'bain');
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.physics.preset)).toBe('bain');
  await expect(page.locator('#pHardO')).toHaveText('15');
});

test('保存して開き直すと同じ状態に戻る', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.addLayer();
    a.store.patchLayer(a.activeLayerId, { pop: -42, name: '二枚目' });
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
