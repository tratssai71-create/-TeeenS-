# 初回セットアップ(1台のPCで動かす)

まずは **ディレクター + デザイナー** の2体で、「依頼 → 計画 → 承認 → 実行」を確認する。

## Bot の名前(Discord上の表示名)
| 役割(内部名) | Bot名のおすすめ | 担当 |
|---|---|---|
| director | **ディレクター** | 依頼を分解して指示する司令塔 |
| designer | **デザイナー** | STUDIOで見た目を編集 |
| writer | **ライター** | 文言・記事 |
| qa | **チェッカー** | 見た目・リンクの確認 |
| publisher | **パブリッシャー** | 承認後の公開 |

表示名はDiscord側で自由に付けてよい。内部の役割名(`designer` 等)は変えない。

## 1. Discordサーバーとチャンネル
1. Discordで「サーバーを作成」(自分専用)
2. テキストチャンネルを作る: `#command` `#tasks` `#log` `#approve`
3. `#tasks` は **自分とBotだけが書ける**ようにしておく(誤爆防止)
4. 設定 → 詳細設定 → **開発者モード** をON。チャンネル・自分のアイコンを右クリック →「IDをコピー」で各IDを控える

## 2. Botを作る(最初は2体)
[Discord Developer Portal](https://discord.com/developers/applications) で「New Application」を2回行う。
名前は「ディレクター」「デザイナー」。それぞれ:
1. Bot タブ → **Reset Token** でトークンをコピー(**他人に見せない・コミットしない**)
2. Bot タブ → **Message Content Intent** をON
3. OAuth2 → URL Generator → scope `bot`、権限は「メッセージを送信・履歴を読む・チャンネルを見る」 → 出たURLでサーバーに招待
4. 各BotのユーザーIDも控える(Botを右クリック →「IDをコピー」)

## 3. このPCに用意するもの
- Node.js 20.12 以上、Codex CLI(ログイン済み)
- `discord-agent/` で `npm install`
- 作業用フォルダ(Codexが触る場所)を決めておく

## 4. 設定ファイル
```bash
cp .env.director.example .env.director
cp .env.worker.example   .env.designer
```
- `.env.director`: トークン(ディレクター)、`COMMAND/TASKS/LOG/APPROVE_CHANNEL_ID`、`ALLOWED_USER_IDS`(自分のID)、`WORKER_BOT_IDS`(デザイナーBotのID)、`ROLES=designer`、`APPROVAL_SECRET`(長いランダム文字列)
- `.env.designer`: トークン(デザイナー)、`CHANNEL_IDS`(個別指示用に `#command` 以外のチャンネルを作るなら)、`ALLOWED_USER_IDS`、`WORKDIR`、`TASKS_CHANNEL_ID`、`LOG_CHANNEL_ID`、`ORCHESTRATOR_BOT_ID`(ディレクターBotのID)

`.env.*` は `.gitignore` 済み(コミットされない)。

## 5. 起動
```bash
node run.js all        # 両方まとめて(別々のターミナルで node run.js director / designer でもよい)
```
Discordでそれぞれのオンライン表示と、`#log` の「logged in」を確認。

## 6. 動作確認(安全な順)
1. **疎通**: 個別チャンネルで `!ping` → `online`(CHANNEL_IDSを設定した場合)
2. **ごく小さい依頼**: `#command` に「作業フォルダに hello.txt を作って『こんにちは』と書いて」(STUDIOには触らない)
3. 計画案が出る → 「実行」 → `#log` に進捗 → `#command` に完了報告
4. この時点では publisher がいないので、公開承認の画面(`#approve`)が出るところまでで止めてよい
5. 問題なければ、次に Playwright MCP を登録して STUDIO の小さな編集を試す

## つまずきやすい点
- 返事がない → Message Content Intent、チャンネルID、`ALLOWED_USER_IDS` を確認
- `codex` が見つからない → ターミナルで `codex --version` が通るか確認
- Codexのオプション名はバージョンで違うことがある → `codex exec --help` で `--output-last-message` `-C` `--sandbox` を確認
