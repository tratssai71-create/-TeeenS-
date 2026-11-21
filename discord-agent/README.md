# discord-agent

Discordのチャンネルに書いた指示を `codex exec` で実行し、結果を返信するBot。
**1端末 = 1Bot = 1エージェント** で、端末ごとに `.env` を変えて動かす。

## セットアップ(各端末)
1. Discord Developer Portal でBotを作成し、**Message Content Intent** を有効化、サーバーに招待
2. `npm install`
3. `cp .env.example .env` して編集(トークン、チャンネルID、あなたのユーザーID、WORKDIR)
4. Codex CLI にログイン済み & studio のMCP(またはブラウザ操作)を設定済みにする
5. `npm start`(常駐させるなら pm2 / systemd)

## 使い方
- 担当チャンネルにそのまま指示を書く
- `!ping` 生存確認 / `!stop` 実行中タスクの中断
- タスクは1件ずつ順番に実行される

## 安全面
- `ALLOWED_USER_IDS` 以外のメッセージは無視する
- `CODEX_ARGS` は最小権限(workspace-write)から始める。`--dangerously-bypass-approvals-and-sandbox` は使わない
- `.env`(トークン)はコミットしない

## 司令塔(orchestrator) — P2
設計は `docs/ORCHESTRATOR.md`。依頼を分解してワーカーに割り振り、結果を集約する。

1. サーバーに `#command` `#tasks` `#log` を作る(`#tasks` は人が書けない権限にする)
2. **司令塔用に別のBot**を作成・招待し、`.env.orchestrator.example` → `.env.orchestrator` を編集
3. 各ワーカーの `.env` に `TASKS_CHANNEL_ID` / `LOG_CHANNEL_ID` / `ORCHESTRATOR_BOT_ID`(司令塔BotのID)を追加
4. 司令塔の `WORKER_BOT_IDS` に各ワーカーBotのIDを入れる
5. `npm run orchestrator`(ワーカー側は `npm start`)
6. `#command` に依頼を書く → 計画案が出る → ボタンで「実行」

コマンド: `!status` / `!halt`(新規割り当て停止) / `!resume`
動作: 依存が解けたタスクから送信、ロールごとに直列、失敗は最大 `MAX_RETRY` 回再試行、無応答は検知して再送。
テスト: `npm test`(計画の検証・依存解決・メッセージ長の純粋ロジック)
未実装: qaの差し戻しループ(P3)、公開の承認ボタン(P4)
