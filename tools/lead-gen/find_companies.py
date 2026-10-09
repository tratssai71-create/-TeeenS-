#!/usr/bin/env python3
"""
Google Places API (Text Search + Place Details) を使って、
指定したキーワード(例: "岡山市 工務店")に該当する企業を検索し、
leads.csv と同じフォーマットで出力する。

事前準備:
    export GOOGLE_PLACES_API_KEY="取得したAPIキー"
    (Google Cloud Console で Places API を有効化し、課金設定をしたキー)

使い方:
    python3 find_companies.py "岡山市 工務店" leads_koumuten.csv
    python3 find_companies.py "岡山市 美容室" leads_biyou.csv --pages 2

注意:
- Text Search / Place Details 呼び出しは Google の従量課金対象。
  --pages を上げすぎると課金額が増える点に注意(1ページ=20件、詳細取得も件数分課金)。
- Googleの利用規約上、取得した情報を大量スクレイピング目的の再配布や
  Googleマップ以外のデータベースとして無断で蓄積・転売することは禁止されている。
  ここでは自社の営業リスト作成という一時利用にとどめること。
- ウェブサイトが存在しない企業も候補として出力する(notesに明記)。
  そういう企業はサイト自体が無いという、むしろ強い営業機会になる。
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request

TEXT_SEARCH_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json"
DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"
REQUEST_INTERVAL_SEC = 1.0


def call_api(url, params):
    qs = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{url}?{qs}", timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def text_search(query, api_key, max_pages):
    results = []
    params = {"query": query, "key": api_key, "language": "ja", "region": "jp"}
    for page in range(max_pages):
        data = call_api(TEXT_SEARCH_URL, params)
        status = data.get("status")
        if status not in ("OK", "ZERO_RESULTS"):
            print(f"警告: Text Search status={status} {data.get('error_message', '')}", file=sys.stderr)
            break
        results.extend(data.get("results", []))
        next_token = data.get("next_page_token")
        if not next_token or page == max_pages - 1:
            break
        # next_page_token は発行直後は無効なことがあるため待機が必要
        time.sleep(2.0)
        params = {"pagetoken": next_token, "key": api_key}
    return results


def get_details(place_id, api_key):
    params = {
        "place_id": place_id,
        "fields": "name,website,formatted_address,formatted_phone_number",
        "key": api_key,
        "language": "ja",
    }
    data = call_api(DETAILS_URL, params)
    return data.get("result", {})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("query", help='例: "岡山市 工務店"')
    parser.add_argument("out_csv")
    parser.add_argument("--pages", type=int, default=1, help="Text Searchのページ数(1ページ=最大20件)")
    args = parser.parse_args()

    api_key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if not api_key:
        print("エラー: 環境変数 GOOGLE_PLACES_API_KEY が設定されていません。", file=sys.stderr)
        sys.exit(1)

    print(f"検索中: {args.query} ...")
    places = text_search(args.query, api_key, args.pages)
    print(f"{len(places)}件ヒット。詳細情報を取得します。")

    rows = []
    for i, place in enumerate(places):
        place_id = place.get("place_id")
        print(f"[{i+1}/{len(places)}] {place.get('name')}")
        details = get_details(place_id, api_key) if place_id else {}
        website = details.get("website", "")
        address = details.get("formatted_address", place.get("formatted_address", ""))
        phone = details.get("formatted_phone_number", "")
        notes_parts = [p for p in [address, phone] if p]
        if not website:
            notes_parts.append("要確認:自社サイトが見つからない(Googleビジネスプロフィールのみの可能性)")
        rows.append({
            "name": details.get("name", place.get("name", "")),
            "url": website,
            "industry": args.query,
            "contact_form_url": "",
            "notes": " / ".join(notes_parts),
        })
        time.sleep(REQUEST_INTERVAL_SEC)

    with open(args.out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "url", "industry", "contact_form_url", "notes"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"\n完了: {args.out_csv} に{len(rows)}件書き出しました。")
    print("この後 scan_sites.py に渡してサイト診断してください。")


if __name__ == "__main__":
    main()
