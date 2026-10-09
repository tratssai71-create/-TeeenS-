#!/usr/bin/env python3
"""
sent_log.csv から送信履歴ページ(sent_dashboard.html)を作る。
send_forms.py の実行後に自動で呼ばれる。手動なら:
    python3 build_dashboard.py
"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, "sent_log.csv")
OUT_PATH = os.path.join(HERE, "sent_dashboard.html")


def build():
    rows = []
    if os.path.exists(LOG_PATH):
        with open(LOG_PATH, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    for r in rows:
        shot = f"shots/{r.get('domain', '')}.png"
        r["shot"] = shot if os.path.exists(os.path.join(HERE, shot)) else ""
    rows.sort(key=lambda r: r.get("time", ""), reverse=True)
    data = json.dumps(rows, ensure_ascii=False).replace("</", "<\\/")
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(TEMPLATE.replace("/*DATA*/[]", data))
    print(f"送信履歴ページを更新: {OUT_PATH}")


TEMPLATE = r"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>営業送信履歴</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#1a1a1a;--ink2:#5c5c5c;--line:#e4e4e0;--accent:#1a1a1a;
  --ok:#1f7a4d;--okbg:#e5f4ec;--warn:#9a6700;--warnbg:#fdf3dc;--ng:#b3261e;--ngbg:#fbe9e7;--skip:#666;--skipbg:#efefec;--reply:#2456c7;--replybg:#e7eefc}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141414;--card:#1e1e1e;--ink:#f0f0f0;--ink2:#a8a8a8;--line:#333;--accent:#f0f0f0;
  --okbg:#15321f;--ok:#6fd39c;--warnbg:#3a2e10;--warn:#f0c060;--ngbg:#3d1714;--ng:#ff8a80;--skipbg:#2a2a2a;--skip:#aaa;--replybg:#16254a;--reply:#8fb0ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Noto Sans JP",sans-serif;font-size:15px;line-height:1.7}
.wrap{max-width:960px;margin:0 auto;padding:32px 16px 80px}
header h1{font-size:24px;margin:0 0 4px}
header p{margin:0;color:var(--ink2);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:24px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat b{display:block;font-size:26px;line-height:1.2}
.stat span{font-size:12px;color:var(--ink2)}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.bar input{flex:1;min-width:180px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
.bar button{padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font:inherit;font-size:13px;cursor:pointer}
.bar button.on{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.item{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
.head{display:flex;align-items:center;gap:12px;padding:14px 16px;cursor:pointer}
.head .main{flex:1;min-width:0}
.head .co{font-weight:700;font-size:16px}
.head .meta{font-size:12px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap}
.b-sent{background:var(--okbg);color:var(--ok)}.b-unconfirmed{background:var(--warnbg);color:var(--warn)}
.b-error,.b-blocked{background:var(--ngbg);color:var(--ng)}.b-skip{background:var(--skipbg);color:var(--skip)}
.b-reply{background:var(--replybg);color:var(--reply)}
.body{display:none;border-top:1px solid var(--line);padding:16px}
.item.open .body{display:block}
.msg{white-space:pre-wrap;background:var(--bg);border-radius:8px;padding:14px;font-size:14px;margin:0 0 12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px}
.row a{color:var(--reply)}
.row button{padding:6px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;font-size:13px;cursor:pointer}
.memo{width:100%;margin-top:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;font-size:13px;min-height:60px}
.shot{max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:10px}
.empty{text-align:center;color:var(--ink2);padding:40px 0}
@media (max-width:600px){.stats{grid-template-columns:repeat(2,1fr)}.head{flex-wrap:wrap}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>営業送信履歴</h1>
  <p id="updated"></p>
</header>
<div class="stats" id="stats"></div>
<div class="bar">
  <input id="q" placeholder="会社名・本文で検索">
  <button data-f="all" class="on">すべて</button>
  <button data-f="sent">送信済み</button>
  <button data-f="reply">返信あり</button>
  <button data-f="problem">要確認</button>
  <button data-f="skip">スキップ</button>
</div>
<div id="list"></div>
</div>
<script>
const DATA = /*DATA*/[];
const LABEL = {sent:"送信済み",unconfirmed:"未確認",error:"エラー",blocked:"拒否",dry_run:"テスト入力",
  skip_ng:"営業お断り",skip_captcha:"画像認証",skip_noform:"フォームなし",skip_ai:"対象外"};
const store = {get(k){try{return JSON.parse(localStorage.getItem("sd:"+k))}catch(e){return null}},
  set(k,v){try{localStorage.setItem("sd:"+k,JSON.stringify(v))}catch(e){}}};
let filter = "all";
const esc = s => String(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const kind = r => r.status==="sent"?"sent":r.status.startsWith("skip")?"skip":"problem";
const replied = r => !!(store.get("reply:"+r.domain));
const fmt = t => t ? t.replace("T"," ").slice(0,16) : "";

function render(){
  const q = document.getElementById("q").value.trim();
  const today = new Date().toISOString().slice(0,10);
  const sent = DATA.filter(r=>r.status==="sent");
  document.getElementById("stats").innerHTML = [
    [sent.length,"送信済み"],[sent.filter(r=>r.time.startsWith(today)).length,"今日の送信"],
    [DATA.filter(replied).length,"返信あり"],[DATA.filter(r=>kind(r)==="problem").length,"要確認"]
  ].map(([n,l])=>`<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  const rows = DATA.filter(r=>{
    if(filter==="reply" && !replied(r)) return false;
    if(!["all","reply"].includes(filter) && kind(r)!==filter) return false;
    return !q || (r.company+r.name+r.message+r.domain).includes(q);
  });
  document.getElementById("list").innerHTML = rows.length ? rows.map((r,i)=>{
    const k = kind(r);
    const memo = store.get("memo:"+r.domain)||"";
    return `<div class="item" data-d="${esc(r.domain)}">
      <div class="head">
        <div class="main"><div class="co">${esc(r.company||r.name)}</div>
          <div class="meta">${fmt(r.time)} ・ ${esc(r.domain)}${r.detail?" ・ "+esc(r.detail):""}</div></div>
        ${replied(r)?'<span class="badge b-reply">返信あり</span>':""}
        <span class="badge b-${k==="skip"?"skip":r.status}">${LABEL[r.status]||esc(r.status)}</span>
      </div>
      <div class="body">
        ${r.message?`<pre class="msg">${esc(r.message)}</pre>`:""}
        <div class="row">
          ${r.form_url?`<a href="${esc(r.form_url)}" target="_blank" rel="noopener">送信したフォームを開く ↗</a>`:""}
          ${r.message?'<button data-act="copy">本文をコピー</button>':""}
          <button data-act="reply">${replied(r)?"返信ありを解除":"返信ありにする"}</button>
        </div>
        <textarea class="memo" placeholder="メモ（返信内容・次のアクションなど）">${esc(memo)}</textarea>
        ${r.shot?`<img class="shot" loading="lazy" src="${esc(r.shot)}" alt="送信時の入力画面">`:""}
      </div></div>`;
  }).join("") : '<div class="empty">該当する履歴はありません</div>';
}

document.getElementById("list").addEventListener("click", e=>{
  const item = e.target.closest(".item"); if(!item) return;
  const r = DATA.find(x=>x.domain===item.dataset.d);
  const act = e.target.dataset.act;
  if(act==="copy"){navigator.clipboard.writeText(r.message); e.target.textContent="コピーしました"; return;}
  if(act==="reply"){store.set("reply:"+r.domain,!replied(r)); render(); document.querySelector(`.item[data-d="${CSS.escape(r.domain)}"]`).classList.add("open"); return;}
  if(e.target.closest(".head")) item.classList.toggle("open");
});
document.getElementById("list").addEventListener("input", e=>{
  if(!e.target.classList.contains("memo")) return;
  store.set("memo:"+e.target.closest(".item").dataset.d, e.target.value);
});
document.querySelectorAll(".bar button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".bar button").forEach(x=>x.classList.remove("on"));
  b.classList.add("on"); filter=b.dataset.f; render();
});
document.getElementById("q").oninput = render;
document.getElementById("updated").textContent = DATA.length ? `最終送信 ${fmt(DATA[0].time)} ・ 全${DATA.length}件` : "まだ履歴がありません";
render();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    build()
