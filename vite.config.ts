import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';
import pkg from './package.json' with { type: 'json' };

/** 最後のコミットの日時(「PukuPop について」に出す)。git が無い所では空にする */
function commitDate(): string {
  try { return execSync('git log -1 --format=%cI', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

export default defineConfig({
  // 静的ファイルとしてどこに置いても動くよう相対パスで出力する
  base: './',
  plugins: [tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __COMMIT_DATE__: JSON.stringify(commitDate()) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
