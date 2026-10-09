#!/usr/bin/env python3
"""
leads.csv (name,url,industry,contact_form_url,notes) を読み込み、
各社サイトを軽くスキャンして「古さ・改善余地スコア」を算出する。

使い方:
    python3 scan_sites.py leads.csv scored.csv

出力 scored.csv には score(0-100, 高いほど改善余地あり) と findings
（具体的にどこが古いか、営業文面に使える所見）が追加される。

注意:
- 取得するのはトップページ1回分のGETのみ。サイト全体をクロールしたり
  高頻度でアクセスしたりはしない。
- リクエスト間に待機時間を入れ、相手サーバーに負荷をかけない。
- あくまで「診断」までがこのスクリプトの役割。フォーム送信は行わない。
"""
import csv
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

REQUEST_INTERVAL_SEC = 2.0
TIMEOUT_SEC = 10
USER_AGENT = "TeeenS-SiteAudit/1.0 (+https://teeen-s.com)"

CURRENT_YEAR = datetime.now().year


_UNVERIFIED_CTX = ssl.create_default_context()
_UNVERIFIED_CTX.check_hostname = False
_UNVERIFIED_CTX.verify_mode = ssl.CERT_NONE


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            headers = dict(resp.headers)
            body = resp.read(500_000).decode("utf-8", errors="ignore")
            return resp.status, headers, body
    except urllib.error.URLError as e:
        if isinstance(e.reason, ssl.SSLCertVerificationError):
            # ローカル環境の証明書設定不備を診断結果に混ぜないためのフォールバック
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC, context=_UNVERIFIED_CTX) as resp:
                headers = dict(resp.headers)
                body = resp.read(500_000).decode("utf-8", errors="ignore")
                return resp.status, headers, body
        raise


def scan_one(name, url):
    findings = []
    score = 0

    if not url:
        return {"score": 100, "findings": "自社サイトなし(Googleビジネスプロフィールのみ)"}

    if not url.lower().startswith("https://"):
        findings.append("SSL(https)未対応")
        score += 25

    try:
        status, headers, html = fetch(url)
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        findings.append(f"サイトにアクセスできない可能性あり({e})")
        return {"score": 90, "findings": "; ".join(findings)}

    if status >= 400:
        findings.append(f"HTTPステータス{status}")
        score += 15

    if "viewport" not in html.lower():
        findings.append("スマホ対応(viewportタグ)なし")
        score += 25

    if not re.search(r"<meta[^>]+name=[\"']description[\"']", html, re.I):
        findings.append("meta descriptionが未設定(SEO弱い)")
        score += 10

    if re.search(r"<frameset|<marquee|<blink", html, re.I):
        findings.append("フレーム/marqueeなど古い技術を使用")
        score += 20

    years = re.findall(r"(?:copyright|©|\(c\))\D{0,10}(20\d{2})", html, re.I)
    if years:
        oldest_mentioned = min(int(y) for y in years)
        if CURRENT_YEAR - oldest_mentioned >= 3:
            findings.append(f"コピーライト表記が{oldest_mentioned}年で止まっている")
            score += 15

    last_mod = headers.get("Last-Modified")
    if last_mod:
        findings.append(f"最終更新(サーバー応答): {last_mod}")

    if not re.search(r"<h1", html, re.I):
        findings.append("h1タグなし(SEO構造が弱い)")
        score += 5

    if not findings:
        findings.append("目立った技術的な古さは検出されず(デザイン面は目視確認推奨)")

    return {"score": min(score, 100), "findings": "; ".join(findings)}


def main():
    if len(sys.argv) != 3:
        print("usage: python3 scan_sites.py <input.csv> <output.csv>")
        sys.exit(1)

    in_path, out_path = sys.argv[1], sys.argv[2]

    with open(in_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    results = []
    for i, row in enumerate(rows):
        name, url = row["name"].strip(), row["url"].strip()
        print(f"[{i+1}/{len(rows)}] scanning {name} ({url}) ...")
        result = scan_one(name, url)
        row["score"] = result["score"]
        row["findings"] = result["findings"]
        results.append(row)
        if i < len(rows) - 1:
            time.sleep(REQUEST_INTERVAL_SEC)

    results.sort(key=lambda r: int(r["score"]), reverse=True)

    fieldnames = list(rows[0].keys())
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)

    print(f"\n完了: {out_path} にスコア順で書き出しました。")


if __name__ == "__main__":
    main()
