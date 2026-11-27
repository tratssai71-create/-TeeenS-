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

## 追記(2026-11-25)
- 自動立ち上げ: `~/Library/LaunchAgents/jp.teeens.discord-agent.plist` を作成済み(**まだ読み込んでいない**。次のログイン/再起動で、`node run.js all` が自動で上がる)。
  - 今すぐ有効にする: `launchctl load ~/Library/LaunchAgents/jp.teeens.discord-agent.plist`(ターミナルで動いているBotは、先に止める。二重起動は、ロックで防がれる)
  - 無効にする: `launchctl unload ~/Library/LaunchAgents/jp.teeens.discord-agent.plist`
  - ログ: `~/Library/Logs/discord-agent.log`
- コマンド: `!report`(今日の件数・成功率・段階ごとの平均秒数) `!limit` / `!limit clear`(Codex利用上限の記録)
- 記録: `timings.csv`(段階ごとの秒数。コミット対象外)
- Codex が上限になると、再開時刻を覚えて、受付の時点で案内し、時刻になったら #log でお知らせする。
- 環境変数: `VERIFY_MODE=warn|strict|off`(Botの確認) `EDITOR_PREOPEN=0`(編集画面の先開きを止める) `BROWSER_DEEP=1`(毎回、念入りに整える)

## 追記(2026-11-26): 役割の見直し
- 方針: STUDIOの構造(セクションの枠)は人が作る。エージェントは「文字の流し込み・変更」と「検査」を担当する(Codexに、ゼロからセクションを作らせると、1セクションで約9分半・71操作かかり、画面も確認しづらかったため)。
- 検査役: #designer-chat で `!check`(全部)/ `!check 2`(セクション2だけ)。`spec-out/spec.json`(`npm run spec -- 移植元HTML` で作成)と、いまの編集画面の文字・大きさ・太さ・色・行間・字間を比べる。コードは `checker.js`。
- `!shot`: Codexを使わず、いまの画面を貼る(一番下までスクロールした画面も)。ただし、スクロールは、まだ効いていない(2枚が同じ)。
- 環境変数: `SCREENSHOT=0`(画面の自動投稿を止める) `DIRECT_TOOLS=1`(道具の直接呼び。実測で効果なし)
- 制作の流れ(#designer-chat): `!new`(会話リセット)→ `!build N`(仕様書から依頼文を作って制作)→ `!check N`(検査)→ `!fix N`(検査の違いから、直す依頼文を作って修正)→ `!progress`(全体の進み具合)。`!lessons`(Codexの「📝 学び」の記録 docs/lessons.md)、`!shot`(画面)。制作先は `BUILD_PROJECT`(既定: discord テスト)。
- 仕様書(`npm run spec -- 移植元HTML`)は、文字を包む「箱」(背景・角丸・余白・枠)も記録する。
- ディレクター(自動): #designer-chat で `!auto N`(1セクション)/ `!auto N-M`(連続)。作る → 検査 → 違いがあれば直す を、最大 `AUTO_MAX_ROUNDS`(既定3)回まで自動で繰り返す。失敗したら、理由を聞いて、別のやり方で1回だけ再試行。同じ違いが残る・2回続けて失敗・利用上限のときは、止めて、人に判断を求める。公開は、しない。`!stop` で中断。
- ディレクターの育成: 詰まったとき `!accept …` の候補を、自動で出す / 結果を `docs/director-log.csv` に記録(セクション・結果・検査の回数・所要秒)/ `!auto all`(全セクション。すでに合っているものは飛ばす)。

## 追記(2026-11-27): LP複製(全9→10セクション)の記録
- 方式: 仕様書(`npm run spec -- 元HTML`)→ ディレクター `!auto N` が「作る→検査→直す」を自動で回す。1セクション約2〜7分。詰まったら止まって人に聞く(`!accept` で「これでよい」を記録)。
- 見比べ: `!check N`(文字・スタイル)/ `!progress`(全体の表)/ `!compare`(元とSTUDIOを左右に並べた画像と、見た目の近さの目安)。Codexは使わない。
- 仕様書の取りこぼしを直した: 全面がリンクの帯、輪郭だけの文字(内容なので検査する)、見えない文字(1px四方)、body直下の `a`。
- 人の作業が要るところ: 画像(ロゴ・写真・図)のアップロード、背景の飾り(線の図形)、輪郭文字(STUDIOの標準に縁取りが見つからず、薄いグレーの塗り文字で代用)。輪郭の大きな見出しは `scripts/export-text-image.js` で透明PNGに書き出して、画像として置く。
- 注意: Botを再起動するときは、子のプロセス(`run.js designer` / `run.js director`)まで止めること(`pkill -INT -f run.js`)。止めたあと `ps` で残りがないことを確認する。
- 次の複製(別のサイト)へ: `docs/studio-playbook.md`(操作手順+覚えたコツ)、`docs/lessons.md`(学びの記録)、`docs/director-log.csv`(セクションごとの所要時間)を引き継ぐ。
- 配置の検査: `!check N` に「📐 配置のずれ(目安)」が出る(文字の左位置・幅・高さ(行数)・同じセクションの先頭の文字からの縦の距離を、幅1280pxの仕様書(`pc1280`)と、STUDIOの拡大率をそろえて比べる)。直すときは `!fix N 配置`。ディレクター(`!auto`)は、配置のずれを、完了の条件にしない(件数だけ知らせる)。許容は `!accept 文字の一部 位置(左)|幅|高さ(行数)|縦の位置(先頭の文字から)`。
- 別サイトでの通し試験(2026-11-27): Bright Air(14セクション)/ origin-medaka(10)/ サロン予約(6)/ TeeenS LP(10)で、仕様書づくり13〜25秒、`node scripts/spec-coverage.js <HTML> <仕様書フォルダ>` の「文字の拾えた割合」は 100 / 100 / 96 / 100%。取りこぼしの直し: 折りたたみ(高さ0)の中身(FAQの答え)、インライン要素(b, strong など)。使い方: `npm run spec -- <HTML> [出力フォルダ]` → `node scripts/spec-coverage.js <HTML> [フォルダ]` で漏れを確認 → STUDIOに制作。
- `!compare` の「見た目の近さ」: 輪郭(明るさの変わり目)の地図の相関(0〜100)を、セクションごとに出す。上下±12行のずれは許す。画像が空の枠だと下がる。目安として使う。
- スマホ検査: STUDIOの編集画面の下のボタンで「モバイルサイズ」に切り替えると(幅540px)、`!check N` / `!progress` が、自動で、スマホの仕様(`spec.sp`、幅 `SP_WIDTH` 既定540)で検査する。`!fix N` もモバイルサイズで直す指示になる。表示幅と仕様書の幅が違うときは、配置は比べず、取り直し方を案内する。確認が済んだら、デフォルトサイズに戻す。いまの TeeenS LP は、モバイル用の文字サイズなどが、まだ未設定(PCの値のまま)。
- コマンド表: `docs/commands.md`(#designer-chat で `!help` を送ると、貼られる。Discord の「ピン留め」で固定すると、見やすい)。
