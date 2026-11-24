# 引き継ぎメモ(新しいチャットで、最初に読むこと)

## 目的
AIで作ったホームページを、STUDIO(studio.design)に移植する「AIの作業チーム」を作る。
- 指示はDiscordから出す。作業はCodex(OpenAI)がMacの上で行う。
- 用途は、STUDIOへの移植だけ。ほかの用途には使わない。
- 方針は「Discord＋自作」で決定済み(OpenClawは比較検討の結果、採用しない。理由: 用途が1つで、仕組みが小さいほうが安全・十分)。

## 利用者について
- Macで作業。ターミナル操作は慣れていない。日本語で、短く、1手順ずつ案内すること。
- 同じ提案のくり返し(例: 「1〜2日試して」)は嫌がる。言わないこと。
- 決定は利用者がする。勝手に「〜で行きます」と決めないこと。

## 仕組み(このフォルダ discord-agent/)
- `run.js` 起動口。`node run.js all` で全員起動。`.lock-<役割>` で二重起動を防止。
- `orchestrator.js` ディレクター(#command で依頼を受けて計画→#tasks で割り振り→結果を集約→#approve で公開の承認)。
- `bot.js` デザイナー(#tasks のJSONを処理/ designer-chat で会話モード)。`codex exec` を呼ぶ。
- `browser-guard.js` 作業前に専用Chromeを整える(古いタブを閉じる、キャッシュ消去、STUDIOの一覧を開いて待つ、固まっていたら再起動)。
- `core.js` / `messages.js` 計画の検証、承認トークン(HMAC)、Discordの文面。
- `docs/studio-playbook.md` STUDIOの操作手順書(作業指示に自動で添付)。
- `projects.json` プロジェクト名の一覧(あああ(サンプル)= rROn8jnXaA, 株式会社フィリーズ HP = BmqM3E1AWX)。
- `scripts/browser.sh`(`npm run browser`) 専用Chromeを起動(プロファイル ~/studio-chrome-profile、CDPポート9222)。
- `scripts/setup-browser.sh`(`npm run setup-browser`) CodexにPlaywright MCPを登録(--cdp-endpoint http://localhost:9222)。
- テスト: `npm test`(19件。browser-guard は実Chromiumで確認)。

## Discord
- チャンネル: #command(依頼) #tasks(Bot間のJSON) #log(進捗) #approve(公開の承認) #designer-chat(会話モード)
- Bot: ディレクター、デザイナー(1体)。
- 使い方: `!quick 依頼` で計画を省略。`!status` `!halt` `!resume`。designer-chat では `!new` `!session` `!stop`。
- 公開は、必ず人が #approve の「公開する」を押す。デザイナーは署名付き承認がないと公開しない。
- 設定ファイル: `.env.director` / `.env.designer`(トークン入り。コミット禁止、画面にも出さない)。

## 現在の状態
- 動作確認済み: Discord→計画→作業→保存確認→承認の流れ。STUDIOの見出しの編集は、保存まで成功した回がある。
- 課題: STUDIOの編集画面が開かない/白い/404/タブの固まり、など不安定。対策として browser-guard を入れたが、**本物のSTUDIOではまだ未確認**。
- 原因と分かったこと: 直接の編集URLは白くなりやすい → 一覧から「デザインエディタ」を押して開く方式に統一。古いBotが残って二重起動していたことがある(pkill / kill で停止)。

## 次にやること(順番)
1. `git pull && node run.js all` で起動 → `#command` に `!quick STUDIOの「あああ(サンプル)」のホーム最上部の見出しを「公開テスト4」に変えて` → 結果を見て、安定するまで直す。
2. 公開の流れ(承認→デザイナーが公開)を実際に通す。公開先: https://azure458834.studio.site
3. Discordの2段階認証(利用者の作業)。
4. 元のサイト(HTML/CSS)から、移植用の仕様書を自動で作る仕組み。
5. セクションごとに作る→元と見比べる→直す流れ。スマホ表示も。
6. 依頼ごとのスレッド(フォーラム)、スラッシュコマンド。
7. Mac起動時の自動立ち上げ。

## 作業ブランチ
`claude/kind-johnson-3tz5sj`(PR: tratssai71-create/-TeeenS-#2)。
