import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // 静的ファイルとしてどこに置いても動くよう相対パスで出力する
  base: './',
  plugins: [tailwindcss()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
