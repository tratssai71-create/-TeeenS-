#!/usr/bin/env python3
"""
draft_messages.py が作った文面を、各社の問い合わせフォームへ自動送信する。

使い方:
    .venv/bin/python send_forms.py scored.csv drafts/ --limit 20
    .venv/bin/python send_forms.py scored.csv drafts/ --dry-run   # 入力だけして送信しない(スクショで確認)

ルール(コード側で強制):
- ページ内に「営業お断り」等の記載があれば送らない
- 画像認証(reCAPTCHA v2 / hCaptcha / Turnstile)があれば送らない(突破はしない)
- sent_log.csv に記録済みのドメインには二度と送らない
- 1回の実行で --limit 件まで。1件ごとに30〜90秒あける
"""
import argparse
import csv
import json
import os
import random
import re
import subprocess
import sys
import time
from datetime import datetime
from urllib.parse import urljoin, urlparse

from playwright.sync_api import sync_playwright
from pydantic import BaseModel

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, "sent_log.csv")
SHOT_DIR = os.path.join(HERE, "shots")
LOG_FIELDS = ["time", "name", "company", "domain", "form_url", "status", "detail", "message"]

CONTACT_LINK_RE = re.compile(r"お問い?合わ?せ|問合せ|コンタクト|contact|inquiry|toiawase|otoiawase|form", re.I)
STRONG_LINK_RE = re.compile(r"お問い?合わ?せ|問合せ|contact|inquiry|toiawase", re.I)
# 問い合わせ以外の用途のフォーム(送ると迷惑・的外れになる)
OFF_TOPIC_RE = re.compile(r"資料|ダウンロード|download|document|採用|求人|recruit|entry|エントリー|予約|reserve|見積|estimate|会員|login|サンプル", re.I)
NG_RE = re.compile(
    r"(営業|セールス|勧誘|売り込み|広告|宣伝)[^。\n]{0,25}(お断り|ご遠慮|禁止|控え|受け付けて(い|お)りません|対応(いた)?しかね|返信(いた)?しません)"
)
DONE_RE = re.compile(r"ありがとうございま|送信(が)?完了|送信しました|受け付けました|受付(が)?完了|thank\s*you", re.I)
CAPTCHA_SELECTORS = [
    "iframe[src*='recaptcha/api2/anchor']",
    "iframe[src*='recaptcha/enterprise/anchor']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='challenges.cloudflare.com']",
    ".g-recaptcha:not([data-size='invisible'])",
    ".h-captcha",
    ".cf-turnstile",
]

EXTRACT_JS = r"""
() => {
  const forms = [...document.querySelectorAll('form')].filter(f => f.querySelector('textarea'));
  const root = forms[0] || (document.querySelector('textarea') ? document.body : null);
  if (!root) return null;
  const labelOf = el => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const pl = el.closest('label'); if (pl) return pl.innerText;
    const row = el.closest('tr, dl, .form-group, .wpcf7-form-control-wrap, p, li, div');
    const th = row && row.querySelector('th, dt, label, .label');
    return th ? th.innerText : '';
  };
  const out = [];
  root.querySelectorAll('input, textarea, select').forEach(el => {
    const type = (el.type || el.tagName).toLowerCase();
    if (['hidden','submit','button','image','reset','file'].includes(type)) return;
    const r = el.getBoundingClientRect();
    if ((r.width === 0 && r.height === 0) && !['radio','checkbox'].includes(type)) return;
    const idx = out.length;
    el.setAttribute('data-lg-idx', idx);
    const item = {idx, tag: el.tagName.toLowerCase(), type, name: el.name || '', placeholder: el.placeholder || '',
      label: (labelOf(el) || '').trim().slice(0, 80), required: el.required || /必須|\*/.test(labelOf(el) || '')};
    if (el.tagName === 'SELECT') item.options = [...el.options].map(o => o.text.trim()).slice(0, 30);
    if (['radio','checkbox'].includes(type)) item.option_label = (el.closest('label')?.innerText || el.value || '').trim().slice(0, 60);
    out.push(item);
  });
  return out;
}
"""


class FieldValue(BaseModel):
    idx: int
    value: str  # text/select=入力値やオプション文字列, radio/checkbox="check"


class FillPlan(BaseModel):
    ok: bool  # 送ってよいフォームか(問い合わせフォームで、営業禁止の記載がない)
    reason: str
    fields: list[FieldValue]


PLAN_PROMPT = """日本企業の問い合わせフォームに営業メッセージを入力する。各入力欄に何を入れるか決めて。

送信者情報:
{sender}

件名: {subject}
本文(本文/お問い合わせ内容の欄にそのまま入れる):
<<<
{message}
>>>

ページURL: {page_url}
フォーム項目(JSON):
{fields}

ルール:
- 必須項目は必ず埋める。任意項目も送信者情報で埋まるものは埋める
- 氏名が姓/名で分かれていれば分けて、1欄なら「新田 拓夢」。フリガナ欄はカタカナ/ひらがなを欄の指示に合わせる
- 電話・郵便番号が分割欄なら分割して入れる
- メール確認欄にも同じメール
- 問い合わせ種別のselect/radioは「その他」か最も近いもの。options の文字列をそのまま value に
- 個人情報保護方針への同意チェックは value="check"
- 資料ダウンロード・資料請求・採用応募・予約・見積専用など、一般の問い合わせでないフォームなら ok=false
- ページに営業・セールスお断りの記載があれば ok=false
ページ抜粋:
{page_text}
"""


def load_log():
    if not os.path.exists(LOG_PATH):
        return set()
    with open(LOG_PATH, newline="", encoding="utf-8") as f:
        return {r["domain"] for r in csv.DictReader(f)}


def write_log(row):
    new = not os.path.exists(LOG_PATH)
    with open(LOG_PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)


def company_of(message, fallback):
    first = message.strip().splitlines()[0] if message.strip() else ""
    m = re.match(r"(.+?)\s*(ご担当者様|御中|様)$", first)
    return m.group(1).strip() if m and m.group(1).strip() else fallback


def domain_of(url):
    return urlparse(url).netloc.lower().removeprefix("www.")


def has_form(page, wait_ms=0):
    if wait_ms:
        try:
            page.wait_for_selector("textarea", timeout=wait_ms)
        except Exception:
            pass
    return page.locator("form textarea, textarea").count() > 0


def find_contact_page(page, url, contact_url):
    page.goto(contact_url or url, timeout=30000, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    if NG_RE.search(page.inner_text("body")):
        return "ng"
    if has_form(page) and not OFF_TOPIC_RE.search(page.url):
        if contact_url or STRONG_LINK_RE.search(page.url):
            return page.url
    candidates = []
    for a in page.locator("a[href]").all()[:300]:
        try:
            text, href = (a.inner_text() or "").strip(), a.get_attribute("href") or ""
        except Exception:
            continue
        if href.startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        if OFF_TOPIC_RE.search(text) or OFF_TOPIC_RE.search(href):
            continue
        if CONTACT_LINK_RE.search(text) or CONTACT_LINK_RE.search(href):
            full = urljoin(page.url, href)
            if domain_of(full) == domain_of(url) and full not in [c for _, c in candidates]:
                strong = bool(STRONG_LINK_RE.search(text) or STRONG_LINK_RE.search(href))
                candidates.append((0 if strong else 1, full))
    candidates = [c for _, c in sorted(candidates, key=lambda x: x[0])]
    for c in candidates[:3]:
        try:
            page.goto(c, timeout=30000, wait_until="domcontentloaded")
        except Exception:
            continue
        if has_form(page, wait_ms=8000):
            return page.url
    return None


def has_captcha(page):
    return any(page.locator(s).count() > 0 for s in CAPTCHA_SELECTORS)


def fill(page, plan, fields):
    types = {f["idx"]: f for f in fields}
    for fv in plan.fields:
        f = types.get(fv.idx)
        if not f:
            continue
        loc = page.locator(f'[data-lg-idx="{fv.idx}"]')
        try:
            if f["type"] in ("radio", "checkbox"):
                if fv.value.strip().lower() in ("check", "true", "1", "yes"):
                    loc.check(force=True, timeout=5000)
            elif f["tag"] == "select":
                loc.select_option(label=fv.value, timeout=5000)
            else:
                loc.fill(fv.value, timeout=5000)
        except Exception as e:
            print(f"    入力失敗 idx={fv.idx} {f['label'][:20]}: {e.__class__.__name__}", file=sys.stderr)


SUBMIT_SELECTOR = (
    "form:has(textarea) [type=submit], form:has(textarea) button:not([type=button]):not([type=reset]), "
    "button:has-text('送信'), button:has-text('確認'), input[value*='送信'], input[value*='確認']"
)
FINAL_SELECTOR = "[type=submit], button:has-text('送信'), input[value*='送信']"


def wait_settle(page, max_sec=25):
    """非同期送信(「送信中...」表示)に備えて、完了表示かページ遷移が出るまで待つ"""
    start_url = page.url
    for _ in range(max_sec):
        page.wait_for_timeout(1000)
        body = page.inner_text("body")
        if DONE_RE.search(body) or "thank" in page.url.lower():
            return body + " 送信完了"
        if page.url != start_url and "送信中" not in body:
            return body
        if "送信中" not in body and _ >= 3:
            return body
    return page.inner_text("body")


def submit(page):
    page.locator(SUBMIT_SELECTOR).first.click(timeout=10000)
    for _ in range(2):
        body = wait_settle(page)
        if DONE_RE.search(body):
            return "sent", ""
        # 確認画面(入力欄が消えて「送信する」ボタンだけある)なら、もう一段押す
        if not has_form(page) and page.locator(FINAL_SELECTOR).count() > 0:
            page.locator(FINAL_SELECTOR).first.click(timeout=10000)
            continue
        break
    body = page.inner_text("body")
    if DONE_RE.search(body):
        return "sent", ""
    # 送信後に入力欄が空に戻っていれば送信成功(STUDIOなど)
    try:
        if has_form(page) and page.locator("textarea").first.input_value() == "":
            return "sent", "入力欄のリセットで完了を判定"
    except Exception:
        pass
    if "送信中" in body:
        return "blocked", "送信先サービスが自動操作を拒否(送信中のまま)"
    if re.search(r"入力(して|されて)(ください|いません)|必須|エラー|正しく", body) and has_form(page):
        return "error", "入力エラーで送信できず"
    return "unconfirmed", "送信後に完了表示を確認できず"


def make_plan(client, prompt):
    """client=None なら Claude Code(claude -p)を使う＝月額プラン内で追加料金なし"""
    if client is not None:
        resp = client.messages.parse(
            model="claude-opus-5",
            max_tokens=16000,
            thinking={"type": "adaptive"},
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": prompt}],
            output_format=FillPlan,
        )
        return resp.parsed_output
    out = subprocess.run(
        ["claude", "-p", "--output-format", "json", "--tools", "",
         "--json-schema", json.dumps(FillPlan.model_json_schema())],
        input=prompt, capture_output=True, text=True, timeout=300,
    )
    if out.returncode != 0:
        print(f"    claude -p 失敗: {out.stderr[:200]}", file=sys.stderr)
        return None
    data = json.loads(out.stdout)
    payload = data.get("structured_output")
    if payload is None:
        m = re.search(r"\{.*\}", data.get("result", ""), re.S)
        payload = json.loads(m.group(0)) if m else None
    return FillPlan.model_validate(payload) if payload else None


def process(client, page, row, message, sender, dry_run):
    url = row["url"]
    form_url = find_contact_page(page, url, row.get("contact_form_url"))
    if form_url == "ng":
        return "skip_ng", url, "営業お断りの記載あり"
    if not form_url:
        return "skip_noform", url, "問い合わせフォームが見つからない"
    body = page.inner_text("body")
    if NG_RE.search(body):
        return "skip_ng", form_url, "営業お断りの記載あり"
    if has_captcha(page):
        return "skip_captcha", form_url, "画像認証あり"
    fields = page.evaluate(EXTRACT_JS)
    if not fields:
        return "skip_noform", form_url, "入力欄を取得できず"

    prompt = PLAN_PROMPT.format(
        sender=json.dumps(sender, ensure_ascii=False),
        subject=sender.get("subject", ""),
        message=message,
        fields=json.dumps(fields, ensure_ascii=False),
        page_url=page.url,
        page_text=body[:3000],
    )
    plan = make_plan(client, prompt)
    if plan is None:
        return "error", form_url, "入力計画の生成失敗"
    if not plan.ok:
        return "skip_ai", form_url, plan.reason

    fill(page, plan, fields)
    shot = os.path.join(SHOT_DIR, f"{domain_of(url)}.png")
    page.screenshot(path=shot, full_page=True)
    if dry_run:
        return "dry_run", form_url, f"入力のみ: {shot}"
    status, detail = submit(page)
    page.screenshot(path=os.path.join(SHOT_DIR, f"{domain_of(url)}_after.png"), full_page=True)
    return status, form_url, detail


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scored_csv")
    ap.add_argument("drafts_dir")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--min-score", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--api", action="store_true", help="Claude Codeでなく従量課金のAPIを使う")
    ap.add_argument("--headed", action="store_true", help="ブラウザを表示して動かす")
    args = ap.parse_args()

    with open(os.path.join(HERE, "sender.json"), encoding="utf-8") as f:
        sender = json.load(f)
    if any("TODO" in str(v) for v in sender.values()):
        sys.exit("sender.json の TODO(メール・電話・住所)を埋めてください")

    os.makedirs(SHOT_DIR, exist_ok=True)
    done = load_log()
    client = None
    if args.api:
        import anthropic
        client = anthropic.Anthropic()

    with open(args.scored_csv, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if int(r.get("score") or 0) >= args.min_score]

    count = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        for row in rows:
            if count >= args.limit:
                break
            if not row.get("url") or domain_of(row["url"]) in done:
                continue
            safe = re.sub(r"[\\/:*?\"<>|]", "_", row["name"])
            draft_path = os.path.join(args.drafts_dir, f"{safe}.txt")
            if not os.path.exists(draft_path):
                continue
            with open(draft_path, encoding="utf-8") as f:
                message = f.read().strip()

            print(f"[{count + 1}/{args.limit}] {row['name']} {row['url']}")
            ctx = browser.new_context(locale="ja-JP", viewport={"width": 1280, "height": 900})
            page = ctx.new_page()
            try:
                status, form_url, detail = process(client, page, row, message, sender, args.dry_run)
            except Exception as e:
                status, form_url, detail = "error", row["url"], f"{e.__class__.__name__}: {str(e)[:120]}"
            finally:
                ctx.close()
            print(f"    -> {status} {detail}")

            if not args.dry_run:
                write_log({"time": datetime.now().isoformat(timespec="seconds"), "name": row["name"],
                           "company": company_of(message, row["name"]), "domain": domain_of(row["url"]),
                           "form_url": form_url, "status": status, "detail": detail, "message": message})
                done.add(domain_of(row["url"]))
            if status in ("sent", "unconfirmed", "error", "dry_run"):
                count += 1
                if not args.dry_run and count < args.limit:
                    time.sleep(random.uniform(30, 90))
        browser.close()
    print(f"完了: {count}件処理。ログ: {LOG_PATH}")
    if not args.dry_run:
        import build_dashboard
        build_dashboard.build()


if __name__ == "__main__":
    main()
