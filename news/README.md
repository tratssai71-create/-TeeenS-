# 📰 お知らせの追加手順

## 1. ファイルを作る
`_template.html` を**コピー**して、好きな名前で保存。
推奨ファイル名形式: **`YYYY-MM-DD.html`** (例: `2026-05-30.html`)

```
news/
├── _template.html      ← テンプレート（編集しない）
├── README.md           ← このファイル
├── 2026-05-30.html     ← 個別の記事
├── 2026-05-12.html
└── ...
```

## 2. 記事を編集する
コピーした HTML ファイルを開き、`✏️` マークの付いた箇所を書き換えます:

- **`<title>`** — ブラウザタブに表示されるタイトル
- **カテゴリ** (`<span class="art-cat">`) — お知らせ / メディア / イベント など
- **日付** — `2026.05.30` のフォーマット
- **タイトル** (`<h1 class="art-h1">`) — 記事の見出し
- **サムネイル画像** — 写真があれば `<img src="..."/>`、なければプレースホルダ
- **本文** (`<div class="art-body">`) — `<p>`, `<h2>`, `<h3>`, `<ul>`, `<blockquote>` などが使えます

## 3. トップページのリンクを更新する
`index.html` の `#news` セクション内のお知らせカード `<a href="news/...html">` を編集します。

```html
<!-- 1 -->
<a href="news/2026-05-30.html" class="news-c sa">          <!-- ← ファイル名 -->
  <div class="news-c-img"><span class="news-c-ph">TeeenS</span></div>
  <h3 class="news-c-title">ここにタイトル</h3>            <!-- ← タイトル -->
  <div class="news-c-meta">
    <span class="news-c-cat">お知らせ</span>              <!-- ← カテゴリ -->
    <span class="news-c-date">2026.05.30</span>           <!-- ← 日付 -->
  </div>
</a>
```

カテゴリの色分け:
| クラス | 色 |
|---|---|
| `news-c-cat` (デフォルト) | 黒背景 / 白文字 |
| `news-c-cat news-c-cat-press` | 白背景 / 黒枠 |
| `news-c-cat news-c-cat-event` | 薄グレー |
| `news-c-cat news-c-cat-info` | 透明 / 点線 |

## 4. 画像について
- **写真がある場合**: `<div class="news-c-img news-c-img-photo"><img src="..."/></div>`
- **写真がない場合**: `<div class="news-c-img"><span class="news-c-ph">TeeenS</span></div>` (黒地にロゴテキスト)

画像ファイルはこのフォルダ (`news/`) に入れて、相対パスで参照すると整理しやすいです。
