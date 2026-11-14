// Node の型は入れていないので、設定ファイル(vite.config.ts)で使う所だけ宣言する(@types/node を入れたら消す)
declare module 'node:child_process' {
  export function execSync(command: string, options: { encoding: 'utf8'; stdio?: unknown; cwd?: string }): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
