# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ここには、README やソースを読んでも分からない「開発の途中で決めたルール」だけを書く。機能は README の「主な機能」、コマンド・構成・画面まわりの表の置き場所は README の「開発」を見る。

## やりとり

- 報告・説明・質問、コミットメッセージ、PR、Issue、コードのコメントは日本語で書く。
- ライブラリ・実行環境・ブラウザなどを入れる前に、名前と用途を示して確認を取る。指示がない限り自動で入れない。依存はなるべく増やさない。

## ブランチと PR

- 既定のブランチは `develop`。作業は `develop` から切ったブランチ(`claude/<内容>`)で行う。
- 実装が済んだら別のエージェントにレビューさせる。PR 前のレビューの指摘は、その PR の中で直す。直したら `develop` 向けの PR を作り、`gh pr merge --merge` でマージする。
- 頼まれたレビューで見つけた課題と、作業の範囲の外で見つけた課題は Issue に立てる。`develop` にマージして直った Issue は、PR の番号をコメントに書いて閉じてよい。
- `main` へは `develop` からのリリース PR(タイトルは「リリース: …」)だけを、頼まれたときに作る。`main` への push はそのまま GitHub Pages への公開になる。
- PR の本文には、変えたこと、動きが変わるところ、確認したこと(テストの件数と、落ちたテストとその理由)を書く。

## 手元の動作確認を乱さない

メインの作業ツリーからはポート 5173 の dev サーバーで動作確認をしている。エージェントの作業がそれを止めたり重くしたりしないようにする(E2E の Chrome は SwiftShader で描くので CPU を大きく使い、5173 が固まったことがある)。

- 実装は `.claude/worktrees/<名前>` の git worktree で行う(node_modules は親から解決される)。
- 自分で立てる Vite はポート 5175〜5179 にし、`cacheDir` を分ける。設定ファイルは `vite.<名前>.config.ts` / `playwright.<名前>.config.ts`、キャッシュは `.vite-<名前>/` という名前にする(`.gitignore` で追跡外になる)。
- E2E に既定の `playwright.config.ts` は使わない(ポート 5174 のサーバーを使い回す設定のため)。自分の Playwright の設定では `webServer: undefined`、`workers: 1` にし、`use.baseURL` を自分で立てたポートにする。
- 作業中は、変えた機能の spec だけを流す。全件の E2E は最後に1回だけ流す。
- Playwright のブラウザはダウンロードしない(`npx playwright install` をしない)。インストール済みの Chrome を使う。
- Windows では、バックグラウンドのコマンドを TaskStop で止めても vite の node 子プロセスが残る。残すとワークツリーを削除できない。PowerShell で `Get-NetTCPConnection -LocalPort <port> -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }` のようにポートから止める。

## 公開リポジトリとして書く

- README には、手元の環境に依存した記述(パス、自分の PC の事情など)を書かない。
- 設計書(`*詳細設計書.md`)は追跡外の手元の資料。コードのコメントから「設計書◯章」のように参照しない。

## 話題ごとのルールと経緯

関係するファイルを読むと、Claude Code が `.claude/rules/` から読み込む。

- `.claude/rules/storage.md`: 保存形式と、ブラウザに残すデータの互換
- `.claude/rules/ui.md`: 画面の作り(説明の出し方、置き場所、スマホ、状態の変え方)
- `.claude/rules/testing.md`: E2E の書き方と、既知の不安定なテスト

なぜそう決めたかの経緯は `.claude/docs/decisions.md` にある(自動では読み込まない)。過去の判断を覆しそうなときや、背景を知りたいときに読む。新しく決めたことがあれば、ルールはこれらのファイルに、経緯は decisions.md に足す。
