#!/usr/bin/env python3
"""
scan_sites.py の出力(scored.csv)から、スコアが閾値以上の企業向けに
問い合わせフォーム用の文面ドラフトを1社ずつ生成する。

使い方:
    python3 draft_messages.py scored.csv drafts/ --min-score 30

出力先ディレクトリに 会社名.txt で1社1ファイル生成される。
生成された文面は必ず人が目を通し、必要に応じて手直ししてから
自分の手で送信すること(自動送信はしない)。

AI生成(自然な文面)を使いたい場合:
    pip3 install anthropic
    export ANTHROPIC_API_KEY="..."
    python3 draft_messages.py scored.csv drafts/ --ai

ANTHROPIC_API_KEY未設定、または anthropic 未インストールの場合は
自動的に固定テンプレートにフォールバックする。
"""
import argparse
import csv
import os
import re
import sys

FINDING_JP = {
    "SSL(https)未対応": "サイトがSSL(https)未対応で、ブラウザに「保護されていません」と表示されてしまっている状態でした",
    "スマホ対応(viewportタグ)なし": "スマートフォンで見た際にレイアウトが崩れてしまう作りになっていました",
    "meta descriptionが未設定(SEO弱い)": "検索結果に表示される説明文(meta description)が設定されておらず、検索での見え方に改善余地がありそうでした",
    "フレーム/marqueeなど古い技術を使用": "かなり古い作り方のページで、今の標準的な作り方とは差が出てしまっている印象でした",
    "h1タグなし(SEO構造が弱い)": "ページの見出し構造がSEO的に弱く、検索エンジンに内容が伝わりにくい作りでした",
    "自社サイトなし(Googleビジネスプロフィールのみ)": "Googleマップ上では拝見できたのですが、自社のホームページが見当たらず、検索から来店・問い合わせにつながる機会を逃してしまっている可能性があります",
}


def build_reasons(findings_str):
    reasons = []
    for key, jp in FINDING_JP.items():
        if key in findings_str:
            reasons.append(jp)
    m = re.search(r"コピーライト表記が(\d{4})年で止まっている", findings_str)
    if m:
        reasons.append(f"サイトの更新が{m.group(1)}年頃で止まっているようで、情報が古くなっている可能性があります")
    return reasons


TEMPLATE = """{name} ご担当者様

突然のご連絡失礼いたします。
岡山市を拠点にホームページ制作をしております、株式会社TeeenS（ティーンズ）の新田と申します。17歳で創業し、岡山の中小企業様のWeb活用をお手伝いしています。

貴社について拝見し、僭越ながら以下の点でWeb集客の改善余地があるのではと感じ、ご連絡させていただきました。

{reasons_bullet}

すぐにどうこうというお話ではなく、「今のサイトで機会損失が出ていないか」を無料で診断させていただくところからでもお力になれればと思っております。ご興味があれば、まずはお気軽にご返信いただけますと幸いです。

お忙しいところ恐れ入りますが、何卒よろしくお願いいたします。

株式会社TeeenS
代表取締役 新田 拓夢
https://teeen-s.com
"""


AI_SYSTEM_PROMPT = """あなたは岡山市の小さなWeb制作会社「株式会社TeeenS」の営業文面ライターです。
代表は17歳で創業した新田拓夢。丁寧語で、押し付けがましくない、テンプレ感のない自然な
問い合わせフォーム用メッセージを1通だけ書いてください。

制約:
- 冒頭で名乗り、突然の連絡であることへの一言を入れる
- 相手企業のサイトの具体的な所見(渡された findings)に触れ、押し付けがましくなく指摘する
- 売り込みすぎず、「無料診断」を軽く提案する程度に留める
- 署名は「株式会社TeeenS 代表取締役 新田 拓夢 / https://teeen-s.com」
- 本文のみ出力し、前置きや説明文は付けない
"""


def generate_with_ai(client, name, industry, findings_str):
    user_msg = f"企業名: {name}\n業種: {industry or '不明'}\nサイト診断結果: {findings_str}"
    resp = client.messages.create(
        model="claude-sonnet-5",
        max_tokens=800,
        system=AI_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    return "".join(block.text for block in resp.content if block.type == "text")


CLI_PROMPT = """あなたは岡山市のWeb制作会社「株式会社TeeenS」の営業文面ライター。
下のサイト本文を読んで、この会社の問い合わせフォームに送る営業メッセージを1通書く。
TeeenSの営業アプリにある既存テンプレートの型に沿うこと。

型(この順番):
1. 宛名: サイトから読み取った正式な社名 +「 ご担当者様」(読み取れなければ「ご担当者様」)
2. 「突然のご連絡失礼いたします。」
   「岡山市でホームページ制作をしております、株式会社TeeenS（ティーンズ）代表の新田と申します。岡山の中小企業様のWeb集客をお手伝いしています。」
3. 相手の事業内容に一文触れ、ちゃんとサイトを見たと伝わるようにする
4. 診断結果から1〜2点、その業種の経営者に伝わる平易な言葉で指摘する(お客様目線の困りごとに言い換え。SSL・meta description・viewport などの専門用語は使わない)
   例: SSL未対応→「ブラウザに『保護されていない通信』と表示され、初めての方が不安に感じやすい状態」
   例: スマホ非対応→「スマートフォンで見ると文字が小さく、電話番号や地図を探しにくい」
   例: 更新年が古い→「何年も更新が止まっているように見え、営業しているか不安に思われるかもしれない」
   確認していない事実(検索順位・アクセス数など)は断定しない
5. 提案: 「今すぐどうこうというお話ではなく、まずはZoomなどオンラインで、気づいた点を無料でお伝えするところからでもお力になれればと思います。」程度。
   サイトが長く放置されていそうなら「公開後も月額で一緒にサイトを育てるプラン(軽微な修正は都度課金なし・初期費用0円のプランあり)」に一言触れてよい
6. 次のリンク欄をそのまま入れる:
▼株式会社TeeenSについて
HP：https://teeen-s.com
制作実績：https://teeen-s.com/works
料金プラン：https://teeen-s.com/pricing
7. 「ご興味があれば、このままご返信いただくか、お電話でもお気軽にどうぞ。」「お忙しいところ恐れ入りますが、何卒よろしくお願いいたします。」
8. 署名は必ず次の4行:
株式会社TeeenS
teeens.info@gmail.com
代表取締役 新田 拓夢
https://teeen-s.com

全体で400〜600字(リンク欄・署名を除く)。前置きや説明なし、本文だけ出力。

診断結果: {findings}
サイトURL: {url}
サイト本文(抜粋):
{page_text}
"""


def fetch_text(url):
    import ssl
    import urllib.request
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 TeeenS-SiteAudit/1.0"})
    raw = urllib.request.urlopen(req, timeout=15, context=ctx).read()
    html = None
    for enc in ("utf-8", "cp932", "euc-jp"):
        try:
            html = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    html = html or raw.decode("utf-8", "ignore")
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    text = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", html, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return f"タイトル: {title.group(1).strip() if title else ''}\n{text[:3000]}"


def generate_with_cli(row):
    import subprocess
    top = urllib_root(row["url"])
    page_text = fetch_text(top)
    if top.rstrip("/") != row["url"].rstrip("/"):
        try:
            page_text += "\n" + fetch_text(row["url"])[:1500]
        except Exception:
            pass
    prompt = CLI_PROMPT.format(findings=row.get("findings", ""), url=row["url"], page_text=page_text)
    out = subprocess.run(["claude", "-p", "--tools", ""], input=prompt, capture_output=True, text=True, timeout=300)
    if out.returncode != 0 or not out.stdout.strip():
        raise RuntimeError(out.stderr[:200])
    return out.stdout.strip() + "\n"


def urllib_root(url):
    from urllib.parse import urlparse
    u = urlparse(url)
    return f"{u.scheme}://{u.netloc}/"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scored_csv")
    parser.add_argument("out_dir")
    parser.add_argument("--min-score", type=int, default=30)
    parser.add_argument("--ai", action="store_true", help="Claude APIで自然な文面を生成する(従量課金)")
    parser.add_argument("--cli", action="store_true", help="Claude Code(claude -p)で文面を生成する(追加料金なし)")
    parser.add_argument("--only", help="この name の行だけ処理する(カンマ区切り)")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    client = None
    if args.ai:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            print("警告: --ai指定ですがANTHROPIC_API_KEY未設定。テンプレートにフォールバックします。", file=sys.stderr)
        else:
            try:
                import anthropic
                client = anthropic.Anthropic(api_key=api_key)
            except ImportError:
                print("警告: anthropicパッケージ未インストール(pip3 install anthropic)。テンプレートにフォールバックします。", file=sys.stderr)

    with open(args.scored_csv, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    written = 0
    for row in rows:
        score = int(row.get("score", 0))
        if score < args.min_score:
            continue

        if args.only and row["name"] not in args.only.split(","):
            continue
        findings_str = row.get("findings", "")
        reasons = build_reasons(findings_str)
        if not reasons:
            continue

        if args.cli:
            try:
                text = generate_with_cli(row)
            except Exception as e:
                print(f"生成失敗({row['name']}): {e} -> スキップ", file=sys.stderr)
                continue
        elif client:
            try:
                text = generate_with_ai(client, row["name"], row.get("industry", ""), findings_str)
            except Exception as e:
                print(f"AI生成失敗({row['name']}): {e} -> テンプレートにフォールバック", file=sys.stderr)
                reasons_bullet = "\n".join(f"・{r}" for r in reasons)
                text = TEMPLATE.format(name=row["name"], reasons_bullet=reasons_bullet)
        else:
            reasons_bullet = "\n".join(f"・{r}" for r in reasons)
            text = TEMPLATE.format(name=row["name"], reasons_bullet=reasons_bullet)

        safe_name = re.sub(r"[\\/:*?\"<>|]", "_", row["name"])
        out_path = os.path.join(args.out_dir, f"{safe_name}.txt")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        written += 1

    print(f"完了: {written}件のドラフトを {args.out_dir}/ に出力しました。")
    print("送信前に必ず内容を確認・手直ししてください（自動送信はしません）。")


if __name__ == "__main__":
    main()
