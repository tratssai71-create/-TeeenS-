#!/usr/bin/env python3
"""
Claude Code(claude -p)のWeb検索で、岡山の中小企業の公式サイトを集める。追加料金なし。
find_companies.py(Google Places API版)の無料代替。

使い方:
    python3 find_companies_cli.py "岡山市 工務店" leads_koumuten.csv --count 15

出力は leads.csv と同じ列(name,url,industry,contact_form_url,notes)。
既存の *_scored.csv / sent_log.csv にあるドメインは除外する。
"""
import argparse
import csv
import glob
import json
import os
import re
import subprocess
import sys
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))

PROMPT = """Web検索で「{query}」に当てはまる岡山県の中小企業を探し、その会社の公式ホームページのURLを集めて。

条件:
- 公式サイトのトップURLだけ(ポータル・求人サイト・SNS・Googleマップ・ホットペッパー等のまとめサイトは不可)
- 大企業・上場企業・全国チェーン・自治体・学校・病院は除く
- 【最重要】作りが古いサイトだけを集める。候補ごとに WebFetch でトップページを実際に開き、次のどれかに当てはまるものだけ採用:
  httpのまま(https非対応) / スマホ非対応(viewportなし・テーブルレイアウト・フレーム) / コピーライトや新着情報が5年以上前で止まっている / 見た目が明らかに2010年前後のデザイン
  今どきのきれいなサイト(WordPressの新しいテーマ、STUDIO、Wix等で整っているもの)は除外
- 探し方のヒント: 地域名+業種で検索し、検索結果の2ページ目以降や小さな事業者も見る。「有限会社」「〇〇商店」「〇〇工業所」など小規模な会社ほど古いサイトが多い
- 次のドメインは既に接触済みなので除外: {exclude}
- {count}社を目標に。見つからなければ少なくてよい。存在を確認できたURLだけ

JSONだけを出力: {{"companies":[{{"name":"正式な社名","url":"https://...","industry":"業種","why":"古いと判断した理由"}}]}}
"""

SCHEMA = {
    "type": "object",
    "properties": {"companies": {"type": "array", "items": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "url": {"type": "string"}, "industry": {"type": "string"}},
        "required": ["name", "url", "industry"]}}},
    "required": ["companies"],
}


def domain_of(url):
    return urlparse(url).netloc.lower().removeprefix("www.")


def known_domains():
    seen = set()
    for path in glob.glob(os.path.join(HERE, "*.csv")):
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r.get("url"):
                    seen.add(domain_of(r["url"]))
                if r.get("domain"):
                    seen.add(r["domain"])
    return seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("out_csv")
    ap.add_argument("--count", type=int, default=15)
    args = ap.parse_args()

    seen = known_domains()
    prompt = PROMPT.format(query=args.query, count=args.count, exclude=", ".join(sorted(seen))[:3000] or "なし")
    out = subprocess.run(
        ["claude", "-p", "--output-format", "json", "--allowedTools", "WebSearch,WebFetch",
         "--tools", "WebSearch,WebFetch", "--json-schema", json.dumps(SCHEMA)],
        input=prompt, capture_output=True, text=True, timeout=900,
    )
    if out.returncode != 0:
        sys.exit(f"claude -p 失敗: {out.stderr[:300]}")
    data = json.loads(out.stdout)
    payload = data.get("structured_output")
    if payload is None:
        m = re.search(r"\{.*\}", data.get("result", ""), re.S)
        payload = json.loads(m.group(0)) if m else {"companies": []}

    rows = []
    for c in payload.get("companies", []):
        url = c.get("url", "").strip()
        if not url.startswith("http") or domain_of(url) in seen:
            continue
        seen.add(domain_of(url))
        rows.append({"name": domain_of(url).split(".")[0], "url": url, "industry": c.get("industry", ""),
                     "contact_form_url": "", "notes": c.get("name", "")})

    with open(args.out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["name", "url", "industry", "contact_form_url", "notes"])
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)}社を {args.out_csv} に出力")


if __name__ == "__main__":
    main()
