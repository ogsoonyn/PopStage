import { defineConfig } from '@playwright/test';

// Node の型は入れていないので、使う所だけ宣言する(@types/node を入れたら消す)
declare const process: { env: Record<string, string | undefined> };

/**
 * Claude Code のクラウド環境(GPU が無く 4 コア)で流しているか。そこでは 1 つずつ流し、@local の付いたテストを外す
 * (描画の速さに頼るテストと、そこの Chrome で落ちるテスト)。E2E_ALL=1 を付けると、@local も流す
 */
const cloud = !!process.env.CLAUDE_CODE_REMOTE;

// 手元にインストール済みの Google Chrome を使う(Playwright のブラウザは別途ダウンロードしない)
export default defineConfig({
  testDir: 'tests/e2e',
  grepInvert: cloud && !process.env.E2E_ALL ? /@local/ : undefined,
  // クラウドでは 2 並列でも CPU が足りず、タップの時間・止まった所の記録など実時間に頼るテストが毎回どれか落ちるので、1 つずつ流す
  workers: cloud ? 1 : undefined,
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
