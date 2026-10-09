# 岡山企業 リード発掘・診断ツール

「企業を探す → サイトを診断する → 営業文面を作る」を補助するツール群。

**フォームへの自動送信は一切行わない。** 送信は必ず人が内容を確認して手動で行うこと。

## 全体の流れ

```
find_companies.py  (Google Placesで企業を自動検索)
        ↓ leads.csv
scan_sites.py       (各社サイトの古さを自動診断・スコア化)
        ↓ scored.csv
draft_messages.py   (診断結果を元に営業文面をドラフト。--aiでClaudeが自然文に)
        ↓ drafts/*.txt
        ↓
    人が確認・手直し → 手動で送信
```

## 1. 企業を自動検索する — `find_companies.py`

事前準備:

```bash
export GOOGLE_PLACES_API_KEY="Google Cloud Consoleで取得したAPIキー"
```

Google Cloud Console で「Places API」を有効化し、課金設定をした上でAPIキーを発行してください。
Text Search / Place Details の呼び出しは従量課金なので、`--pages` を上げすぎないこと。

```bash
python3 find_companies.py "岡山市 工務店" leads.csv --pages 1
```

- 業種×エリアで検索キーワードを変えて何度か実行し、`leads.csv` を業種ごとに分けて作るのがおすすめ
- ウェブサイトが見つからない企業も候補に含める（自社サイトが無いこと自体が強い営業機会になるため）
- 取得したデータをGoogleマップ以外のデータベースとして無断で蓄積・転売しないこと（Google利用規約）。あくまで自社の一時的な営業リストとして使う

手動でリストを作る場合は `leads_template.csv` をコピーして使ってください（列は同じフォーマット）。

## 2. サイトを診断する — `scan_sites.py`

```bash
python3 scan_sites.py leads.csv scored.csv
```

`scored.csv` にはスコア(0-100、高いほど改善余地あり)と技術的な所見(findings)が
追加され、スコアの高い順に並び替えられる。

診断項目: SSL対応、スマホ対応(viewport)、meta description、古い技術(frame/marquee)の使用、
footerのコピーライト年、h1タグの有無、自社サイトの有無。

## 3. 営業文面をドラフトする — `draft_messages.py`

固定テンプレート版（追加設定不要）:

```bash
python3 draft_messages.py scored.csv drafts/ --min-score 30
```

Claudeによる自然文生成版（企業ごとに文面を書き分ける）:

```bash
pip3 install anthropic
export ANTHROPIC_API_KEY="..."
python3 draft_messages.py scored.csv drafts/ --min-score 30 --ai
```

`ANTHROPIC_API_KEY` 未設定 or `anthropic` 未インストールの場合は自動的に
固定テンプレートにフォールバックする。`drafts/` に1社1ファイル(`会社名.txt`)で出力される。

## 4. 送信前に必ず確認する

- `drafts/` の中身を1件ずつ目視で確認・手直しする
- 「フォーム営業お断り」を明記しているサイトは対象から除外する
- 一斉送信ではなく、様子を見ながら1日5〜10社程度から始める
- 大量の自動一斉送信はブランド毀損・スパム的行為とみなされるリスクがあるため行わない
