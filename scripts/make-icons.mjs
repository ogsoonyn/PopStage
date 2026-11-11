// アプリアイコンの画像を public/icons に書き出す: node scripts/make-icons.mjs
// 絵は scripts/icon-art.mjs。PNG は Playwright の Chromium で SVG を描いて作る
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { iconSvg } from './icon-art.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });

// 他のアプリと並べて小さく見えないよう絵は大きめ。丸く切り抜かれるとお皿の端が少し欠けるのは許容する
const ART = iconSvg(1.25, 8);
writeFileSync(new URL('icon.svg', out), ART);

const sizes = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
];
// E2E と同じく手元の Google Chrome を使う。別の Chromium を使うときは CHROME_PATH にその場所を入れる
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
const page = await browser.newPage();
for (const [name, size] of sizes) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${ART}`);
  await page.screenshot({ path: new URL(name, out).pathname, omitBackground: false });
  console.log('wrote', name);
}
await browser.close();
