import { test, expect, devices } from '@playwright/test';
import { boot, watchGlErrors } from './helpers';

watchGlErrors();

const PC_PARTS = ['#menubar', '#toolOptions', '#toolNav', 'body > main > aside', 'body > footer'];
const viewSize = (page: import('@playwright/test').Page) => page.locator('#view').evaluate(c => [c.clientWidth, c.clientHeight]);

test('Tab で UI を隠して3Dビューを画面いっぱいにし、もう一度 Tab・Esc・戻すボタンで戻す', async ({ page }) => {
  await boot(page);
  const before = await viewSize(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
  for (const s of PC_PARTS) await expect(page.locator(s)).toBeHidden();
  await expect.poll(() => viewSize(page)).toEqual([1400, 900]);
  expect(before[0]).toBeLessThan(1400);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  for (const s of PC_PARTS) await expect(page.locator(s)).toBeVisible();
  await expect.poll(() => viewSize(page)).toEqual(before);

  // Esc でも戻る
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);

  // ツールオプションの欄の右端のボタンで隠し、マウスを動かすと出る「UIを戻す」で戻す
  await page.locator('#toolOptions [data-cmd=toggleUi]').click();
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
  const restore = page.locator('#uiRestore');
  await page.mouse.move(700, 450);
  await page.mouse.move(710, 460);
  await expect(restore).toHaveCSS('opacity', '1');
  await restore.click();
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  await expect(restore).toBeHidden();
});

test('マウスを止めると戻すボタンは消え、隠している間も3面図は出さない', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('M');
  await expect(page.locator('#multiView')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#multiView')).toBeHidden();
  await page.mouse.move(600, 400);
  await page.mouse.move(610, 410);
  await expect(page.locator('#uiRestore')).toHaveCSS('opacity', '1');
  await expect(page.locator('#uiRestore')).toHaveCSS('opacity', '0', { timeout: 5000 });
  // ショートカットはそのまま効く
  await page.keyboard.press('Shift+G');
  expect(await page.evaluate(() => (window as any).popstage.view.grid)).toBe(true);
  await page.keyboard.press('Tab');
  // 戻すと3面図も戻る
  await expect(page.locator('#multiView')).toBeVisible();
});

test('入力欄やキーボードで移ってきたボタンでは、Tab はふつうにフォーカスを移す', async ({ page }) => {
  await boot(page);
  await page.locator('#pTabs [data-ptab=layer]').click();
  await page.locator('#pPopN').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  // キーボードで移った先(:focus-visible)でも、続けて Tab で移れる
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
});

test('キーを押してから3Dビューやスライダーをマウスで触っても、Tab で隠せる', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('V');
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + 20);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  await page.keyboard.press('B');
  await page.locator('#brushSize').click();
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
});

test.describe('スマホ', () => {
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
  test.use({ ...pixel, deviceScaleFactor: 1 });

  test('「…」メニューから隠すと上下のバーとシートが消え、右上の「UIを戻す」で戻る', async ({ page }) => {
    await boot(page);
    await page.locator('#mTop [aria-label=メニュー]').click();
    await page.locator('#mTop [data-cmd=toggleUi]').click();
    await expect(page.locator('html')).toHaveClass(/ui-hidden/);
    for (const s of ['#mTop', '#mTools', '#mSheet', '#mFine']) await expect(page.locator(s)).toBeHidden();
    const vp = page.viewportSize()!;
    await expect.poll(() => viewSize(page)).toEqual([vp.width, vp.height]);
    await expect(page.locator('#uiRestore')).toBeVisible();
    await page.locator('#uiRestore').click();
    await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
    await expect(page.locator('#mTools')).toBeVisible();
  });
});
