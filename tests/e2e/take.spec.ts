import { test, expect, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';

// ?e2e: 自動保存の復元を聞かず、揺れを止めた状態で起動する
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

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);

/** 記録を作る: 記録を始め、つかんで引っぱり、視点を回してから止める(フレームは手で進める) */
async function recordTake(page: Page): Promise<number> {
  return app(page, a => {
    a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } });
    a.startRecording();
    for (let i = 0; i < 20; i++) a.frame(1 / 60); // 何もしていない所(詰められる)
    a.world.grab = { x: 0.2, y: 0, z: 0 }; a.world.grabGains.set(a.doc.layers[0].id, 1);
    for (let i = 0; i < 40; i++) a.frame(1 / 60);
    a.world.grab = null; a.world.grabGains.clear();
    for (let i = 0; i < 60; i++) { a.project.camera.yaw += 0.01; a.frame(1 / 60); }
    for (let i = 0; i < 30; i++) a.frame(1 / 60);
    a.stopRecording();
    return a.takeLength as number;
  });
}

test('操作の記録: R で記録し、L でループ再生。画面を触ると止まり、記録はアンドゥで消せる', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('r');
  expect(await app(page, a => [a.takeState, a.paused])).toEqual(['recording', false]);
  await expect(page.locator('#takeBadge')).toBeVisible();
  await expect(page.locator('#takeBadge')).toHaveClass(/recording/);
  // 記録中に右ドラッグで視点を回す
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 20 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(600);
  await page.locator('#view').focus();
  await page.keyboard.press('r');
  expect(await app(page, a => a.takeState)).toBe('idle');
  await expect(page.locator('#takeBadge')).toBeHidden();
  const len = await app(page, a => a.takeLength);
  expect(len).toBeGreaterThan(0.5);
  await expect(page.locator('#takePlay')).toBeEnabled();

  // ループ再生すると視点が記録どおりに動く
  const yaw0 = await app(page, a => a.project.take.samples[0].camera.yaw);
  await app(page, a => { a.project.camera.yaw = 2; });
  await page.keyboard.press('l');
  expect(await app(page, a => a.takeState)).toBe('playing');
  await expect(page.locator('#takeBadge')).toContainText('ループ再生中');
  await expect.poll(() => app(page, a => a.project.camera.yaw)).not.toBe(2);
  // 記録の範囲の中の向きになる
  const yaws = await app(page, a => a.project.take.samples.map((s: any) => s.camera.yaw));
  const lo = Math.min(...yaws) - 1e-6, hi = Math.max(...yaws) + 1e-6;
  const now = await app(page, a => a.project.camera.yaw);
  expect(now).toBeGreaterThanOrEqual(lo); expect(now).toBeLessThanOrEqual(hi);
  expect(yaw0).toBeGreaterThanOrEqual(lo);
  // 画面を触ると止まる
  await page.mouse.click(box.x + 5, box.y + 5);
  expect(await app(page, a => a.takeState)).toBe('idle');

  // 記録はアンドゥで消え、やり直しで戻る
  await page.keyboard.press('Control+z');
  expect(await app(page, a => a.project.take)).toBeNull();
  await expect(page.locator('#takePlay')).toBeDisabled();
  await page.keyboard.press('Control+Shift+z');
  expect(await app(page, a => a.takeLength)).toBeCloseTo(len, 5);
});

test('操作の記録: ボタンで記録・再生・消す。再生中のボタンの印で止められる', async ({ page }) => {
  await boot(page);
  await page.locator('#takeRec').click();
  expect(await app(page, a => a.takeState)).toBe('recording');
  await expect(page.locator('#takeRec')).toContainText('記録を止める');
  await app(page, a => { a.world.grab = { x: 0.2, y: 0, z: 0 }; for (let i = 0; i < 60; i++) a.frame(1 / 60); a.world.grab = null; for (let i = 0; i < 30; i++) a.frame(1 / 60); });
  await page.locator('#takeBadge').click();
  expect(await app(page, a => a.takeState)).toBe('idle');
  expect(await app(page, a => !!a.project.take)).toBe(true);
  await page.locator('#takePlay').click();
  expect(await app(page, a => a.takeState)).toBe('playing');
  await page.locator('#takeBadge').click();
  expect(await app(page, a => a.takeState)).toBe('idle');
  await page.locator('#takeClear').click();
  expect(await app(page, a => a.project.take)).toBeNull();
  // 短すぎる記録は残さない
  await page.locator('#takeRec').click();
  await page.locator('#takeRec').click();
  expect(await app(page, a => a.project.take)).toBeNull();
});

test('操作の記録: .pukupop に保存して開き直すと戻る。別のファイルを開くと再生は止まる', async ({ page }) => {
  await boot(page);
  const len = await recordTake(page);
  expect(len).toBeGreaterThan(1);
  const r = await app(page, async a => {
    const bytes = a.serialize(await a.thumbnail());
    a.playTake();
    await a.loadSample();
    const afterLoad = [a.takeState, a.project.take];
    await a.openProjectBytes(bytes, 'take.pukupop', null);
    return { afterLoad, len: a.takeLength, n: a.project.take?.samples.length };
  });
  expect(r.afterLoad).toEqual(['idle', null]);
  expect(r.len).toBeCloseTo(len, 5);
});

test('書き出し: 記録した操作をループ再生すると、1周ぶんのコマ数で継ぎ目がつながる', async ({ page }) => {
  await boot(page);
  const len = await recordTake(page);
  // 2周ぶん書き出して、1周目の初めと2周目の初めがほぼ同じ絵になるか確かめる
  const r = await app(page, async a => {
    const L = a.takeLength, res = await a.exportMedia({ format: 'png', width: 64, height: 48, fps: 30, duration: 2 * L, background: '#ffffff', motion: 'loop' }, () => {}, new AbortController().signal);
    return { frames: res.frames, bytes: [...new Uint8Array(await res.blob.arrayBuffer())] };
  });
  const per = Math.round(len * 30);
  expect(r.frames).toBe(per * 2);
  const files = unzipSync(new Uint8Array(r.bytes));
  const names = Object.keys(files).filter(n => n.endsWith('.png')).sort();
  expect(names.length).toBe(per * 2);
  // PNG のバイト列がほぼ同じ(同じ視点・同じ揺れ)
  const a = files[names[0]], b = files[names[per]];
  expect(Math.abs(a.length - b.length)).toBeLessThan(a.length * 0.05);

  // 書き出しダイアログ: 記録があれば選べて、長さは1周の整数倍に丸める
  await page.keyboard.press('Control+e');
  await expect(page.locator('input[name=exMotion][value=loop]')).toBeEnabled();
  await expect(page.locator('#exTakeLen')).toContainText(len.toFixed(1));
  await app(page, a => { a.clearTake(); });
});

test('スタートとエンド: 今の視点を登録し、往復の動きを作ってループ再生する。保存すると設定も戻る', async ({ page }) => {
  await boot(page);
  await page.locator('#pathDetails summary').click();
  await expect(page.locator('#pathMake')).toBeDisabled();
  await app(page, a => { const c = a.project.camera; c.yaw = 0; c.pitch = 0; c.zoom = 1.5; c.target = { x: 0, y: 0, z: 0 }; });
  await page.locator('#pathSetStart').click();
  await app(page, a => { const c = a.project.camera; c.yaw = 0.8; c.zoom = 2.5; c.target = { x: 120, y: 0, z: 0 }; });
  await page.locator('#pathSetEnd').click();
  // 見る: スタートの視点へ動かす
  await page.locator('#pathGoStart').click();
  expect(await app(page, a => [a.project.camera.yaw, a.project.camera.target.x])).toEqual([0, 0]);
  await page.locator('#pathSec').fill('10'); // 1.0 秒
  await page.locator('#pathSec').dispatchEvent('input');
  await page.locator('#pathRepeat').selectOption('pingpong');
  await expect(page.locator('#pathMake')).toBeEnabled();
  await page.locator('#pathMake').click();
  expect(await app(page, a => [a.takeState, a.takeLength, a.project.take.path.repeat])).toEqual(['playing', 2, 'pingpong']);
  // 再生中は視点がスタートとエンドの間を動く
  await expect.poll(() => app(page, a => a.project.camera.yaw), { timeout: 5000 }).toBeGreaterThan(0.2);
  const tx = await app(page, a => a.project.camera.target.x);
  expect(tx).toBeGreaterThanOrEqual(0); expect(tx).toBeLessThanOrEqual(120);
  // 画像の位置が動くので揺れる
  await expect.poll(() => app(page, a => Math.abs(a.world.displacement(a.doc.layers[0].id).x)), { timeout: 5000 }).toBeGreaterThan(0.001);
  // アンドゥで記録が消えて止まる
  await page.locator('#view').focus();
  await app(page, a => a.history.undo());
  expect(await app(page, a => [a.takeState, a.project.take])).toEqual(['idle', null]);
  await app(page, a => a.history.redo());
  // 保存して開き直すと、設定(片道の時間など)も下書きに戻る
  const r = await app(page, async a => {
    const bytes = a.serialize(await a.thumbnail());
    await a.loadSample();
    const cleared = a.pathDraft.start;
    await a.openProjectBytes(bytes, 'path.pukupop', null);
    return { cleared, seconds: a.pathDraft.seconds, end: a.pathDraft.end?.target.x, len: a.takeLength };
  });
  expect(r).toEqual({ cleared: null, seconds: 1, end: 120, len: 2 });
  await expect(page.locator('#pathSecO')).toHaveText('1.0秒');
});
