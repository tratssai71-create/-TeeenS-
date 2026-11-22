# discord-agent

Discordのチャンネルに書いた指示を `codex exec` で実行し、結果を返信するBot。
**1端末 = 1Bot = 1エージェント** で、端末ごとに `.env` を変えて動かす。

> 初回は `docs/SETUP.md`(1台のPCで動かす手順)を参照。

## セットアップ(各端末)
1. Discord Developer Portal でBotを作成し、**Message Content Intent** を有効化、サーバーに招待
2. `npm install`
3. `cp .env.worker.example .env.designer` して編集(トークン、チャンネルID、あなたのユーザーID、WORKDIR)
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
2. **司令塔用に別のBot**を作成・招待し、`.env.director.example` → `.env.director` を編集
3. 各ワーカーの `.env` に `TASKS_CHANNEL_ID` / `LOG_CHANNEL_ID` / `ORCHESTRATOR_BOT_ID`(司令塔BotのID)を追加
4. 司令塔の `WORKER_BOT_IDS` に各ワーカーBotのIDを入れる
5. `npm run orchestrator`(ワーカー側は `npm start`)
6. `#command` に依頼を書く → 計画案が出る → ボタンで「実行」

コマンド: `!status` / `!halt`(新規割り当て停止) / `!resume`
動作: 依存が解けたタスクから送信、ロールごとに直列、失敗は最大 `MAX_RETRY` 回再試行、無応答は検知して再送。
テスト: `npm test`(計画の検証・依存解決・メッセージ長の純粋ロジック)
未実装: qaの差し戻しループ(P3)

## 公開の承認ゲート — P4
作業が全部成功すると、司令塔は **公開せずに `#approve` へ承認ボタンを出す**。

1. `#approve` を作り、司令塔の `.env.director` に `APPROVE_CHANNEL_ID` と `APPROVAL_SECRET`(長いランダム文字列)を設定
2. (既定では不要)公開を専用Botに分けたいとき、**publisher端末**のワーカーを追加: `AGENT_NAME=publisher`、`REQUIRE_APPROVAL=1`、`APPROVAL_SECRET=司令塔と同じ値`
   - 司令塔の `WORKER_BOT_IDS` にそのBotのIDも追加
3. 「公開する」を押す → 司令塔が**署名付き承認トークン**(ジョブID・承認者・時刻、有効1時間)を発行し、publisherに公開タスクを送る
4. publisherはトークンの署名・ジョブ一致・期限を検証し、**不正なら実行せず blocked で返す**(承認なしの公開を端末側でも拒否)
5. 「公開しない」→ ジョブは `rejected`。修正は `#command` に新しい依頼として書く

publisherのCodex権限は「公開操作だけ」になるよう指示を絞る(`PUBLISH_INSTRUCTIONS` で上書き可)。

## 速く動かすコツ
- `#command` に **`!quick 依頼`** と書くと、計画づくりを省いて、すぐデザイナーが作業する(小さな依頼向け)。公開は、これまでどおり承認が必要。
- `docs/studio-playbook.md`(STUDIOの操作手順)と `projects.json`(プロジェクトの編集画面URL)は、デザイナーへの指示に自動で添えられる。プロジェクトを増やすときは、`projects.json` に追記する。

## 公開の流れ(既定: デザイナーが公開まで担当)
作業完了 → `#approve` に承認待ち → 「公開する」を押す → 司令塔が署名付き承認を発行 → **デザイナーが「公開」ボタンを押す**。
- デザイナーは、公開タスク(IDに `-publish-` を含む)を、署名付き承認がなければ実行しない。通常の編集タスクは、承認なしで動く。
- 専用Botに分けたいときは、`.env.director` に `PUBLISHER_ROLE=publisher` と、publisherワーカーを追加する。

## チャットモード(デザイナーと会話しながら作る)
`.env.designer` の `CHAT`用チャンネル(`CHANNEL_IDS`)に、`#designer-chat` のID を入れると、そのチャンネルでは**会話が同じCodexセッションで続く**。
- 普通に書くだけで、指示になる。「もう少し大きくして」のような続きも通る。
- 作業の様子(🔧💬)が、同じチャンネルに流れる。入力中の表示も出る。
- `!new` で会話をリセット / `!session` でセッションID(`codex resume <ID>` でCodexでも続きを見られる) / `!stop` で中断。
- 公開は、このチャットでは行わない。公開は `#command` の承認ボタンで行う。
