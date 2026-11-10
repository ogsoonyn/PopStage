import { defineConfig } from '@playwright/test';

// 手元にインストール済みの Google Chrome を使う(Playwright のブラウザは別途ダウンロードしない)
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  use: {
    channel: 'chrome',
    baseURL: 'http://localhost:5174',
    viewport: { width: 1400, height: 900 },
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
