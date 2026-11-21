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
