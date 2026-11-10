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

test('別のファイルを開くと、前の作業の自動保存は消える', async ({ page }) => {
  await boot(page);
  const bytes = await page.evaluate(() => Array.from((window as any).popstage.serialize() as Uint8Array));
  await autosaveOp(page, 'put', { name: 'old.popstage', bytes: [9, 9, 9] });
  expect(await autosaveOp(page, 'get')).toBe('old.popstage');
  expect(await page.evaluate(async (b) => (window as any).popstage.openProjectBytes(new Uint8Array(b), 'new.popstage', null), bytes)).toBe(true);
  await expect.poll(() => autosaveOp(page, 'get')).toBeNull();
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
