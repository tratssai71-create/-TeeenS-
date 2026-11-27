// 元サイト(HTML/CSS)から、STUDIO移植用の「仕様書」を自動で作る。
//   node scripts/make-spec.js <HTMLファイル or URL> [出力フォルダ=spec-out]
// 出力: spec.md(人とCodexが読む仕様書) / spec.json / shots/(セクションごとのスクリーンショット: PC・スマホ)
// 実際のChromeで開いて、画面に表示された結果(計算後のスタイル)を読むので、CSSの継承や上書きも反映される。
// ふだん使いのChromeや専用Chromeには触らず、使い捨てのChromeを、別のポートで起動する。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cdpSession } from "../browser-guard.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [, , input, outArg] = process.argv;
if (!input) { console.error("使い方: node scripts/make-spec.js <HTMLファイル or URL> [出力フォルダ]"); process.exit(1); }
const url = /^https?:|^file:/.test(input) ? input : pathToFileURL(resolve(input)).href;
const out = resolve(outArg ?? "spec-out");
const CHROME = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/opt/pw-browsers/chromium"].find(existsSync);
if (!CHROME) { console.error("Chromeが見つかりません(CHROME_PATH で指定できます)"); process.exit(1); }

const PORT = 9400 + Math.floor(Math.random() * 90);
const prof = mkdtempSync(join(tmpdir(), "spec-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

// ページ内で実行する抽出処理: トップレベルのセクションごとに、文字・画像・リンク・スタイルを集める
const EXTRACT = `(() => {
  const px = (v) => v && v !== "normal" ? v : "";
  const sty = (el) => { const c = getComputedStyle(el); return {
    font: c.fontFamily.split(",")[0].replace(/["']/g, "").trim(), size: c.fontSize, weight: c.fontWeight, lh: px(c.lineHeight),
    ls: px(c.letterSpacing), color: c.color, align: c.textAlign, transform: c.textTransform === "none" ? "" : c.textTransform,
    stroke: parseFloat(c.webkitTextStrokeWidth) > 0 ? c.webkitTextStrokeWidth + " " + c.webkitTextStrokeColor : undefined }; }; // 文字の縁取り(中が透明で、輪郭だけの文字など)
  // 確実に隠れているもの(表示なし・見えない・読み上げ除外・透明で触れない)。これの子は、たどらない
  const hard = (el) => { const c = getComputedStyle(el); return c.display === "none" || c.visibility === "hidden" || el.getAttribute("aria-hidden") === "true" || (c.opacity === "0" && c.pointerEvents === "none"); };
  const vis = (el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && c.visibility !== "hidden" && c.display !== "none" && !(c.opacity === "0" && c.pointerEvents === "none"); }; // opacity:0 は、スクロールで現れる前の状態のことがあるので、見えない扱いにしない(ホバー用の複製は、aria-hidden で除く)
  const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").replace(/\\s+/g, " ").trim();
  const layout = (el) => { const c = getComputedStyle(el); const o = { display: c.display };
    if (c.display.includes("flex")) { o.dir = c.flexDirection; o.gap = c.gap; o.justify = c.justifyContent; o.align = c.alignItems; o.wrap = c.flexWrap; }
    if (c.display.includes("grid")) { o.cols = c.gridTemplateColumns; o.gap = c.gap; }
    o.pad = c.padding; o.maxW = c.maxWidth; return o; };
  const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e); if (c.backgroundImage !== "none") return c.backgroundImage.slice(0, 160); if (c.backgroundColor !== "rgba(0, 0, 0, 0)") return c.backgroundColor; e = e.parentElement; } return "transparent"; };
  // 文字を包んでいる「箱」(ボタンの背景・角丸・枠線・余白)。自分か、近い親(セクションの手前まで)に、背景か枠線があるとき
  const boxOf = (el, root) => { let e = el; while (e && e !== root) { const c = getComputedStyle(e);
      const hasBg = c.backgroundImage !== "none" || c.backgroundColor !== "rgba(0, 0, 0, 0)"; const hasBd = parseFloat(c.borderTopWidth) > 0 && c.borderTopStyle !== "none";
      if (hasBg || hasBd) return { bg: c.backgroundImage !== "none" ? c.backgroundImage.slice(0, 120) : c.backgroundColor, radius: c.borderRadius, pad: c.padding, border: hasBd ? (c.borderTopWidth + " " + c.borderTopStyle + " " + c.borderTopColor) : "", w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) };
      e = e.parentElement; } return null; };
  const items = (root) => { const res = []; const walk = (el) => {
    if (hard(el)) return; // 隠れているもの・ホバー用の複製文字(aria-hidden)は除く。高さ0の折りたたみ(FAQの答えなど)は、中身を拾うため、たどる
    const t = el.tagName.toLowerCase();
    if (t === "img" || t === "video" || t === "svg" || t === "picture") { if (!vis(el)) return; const r = el.getBoundingClientRect();
      res.push({ kind: t === "img" ? "image" : t, src: (el.currentSrc || el.src || el.poster || "").replace(location.href.replace(/[^/]*$/, ""), ""), alt: el.alt || "", w: Math.round(r.width), h: Math.round(r.height) }); return; }
    if (/^h[1-6]$/.test(t) || t === "p" || t === "a" || t === "button" || t === "li" || t === "span" || t === "dt" || t === "dd" || t === "label" || t === "summary" || t === "div" || t === "td" || t === "th" || t === "figcaption" || t === "b" || t === "strong" || t === "em" || t === "small" || t === "mark" || t === "sup" || t === "sub") {
      const txt = vis(el) ? own(el) : "";
      if (txt) { const r = el.getBoundingClientRect();
        res.push({ kind: /^h[1-6]$/.test(t) ? "heading" : t === "a" || t === "button" ? "link" : "text", tag: t, text: txt.slice(0, 400), href: t === "a" ? el.getAttribute("href") : undefined,
          style: sty(el), box: boxOf(el, root), x: Math.round(r.x), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), bg: t === "a" || t === "button" ? getComputedStyle(el).backgroundColor : undefined }); } }
    for (const ch of el.children) walk(ch); }; walk(root); return res; };
  const roots = [...document.querySelectorAll("body > header, body > nav, body > main > *, body > section, body > footer, body > div, body > a")].filter((e) => vis(e) && e.getBoundingClientRect().height >= 40); // body直下の「a」(全面のリンクになった帯など)も、セクションとして拾う
  // 大きな包み(wrapper)の中に、セクションが並んでいたら、中身のセクションごとに分ける
  const expand = (el, depth) => { const kids = [...el.children].filter((c) => vis(c) && c.getBoundingClientRect().height >= 60 && /^(section|div|header|footer|nav|article|main|aside|a)$/i.test(c.tagName));
    return depth < 3 && el.getBoundingClientRect().height > 1500 && kids.length >= 2 ? kids.flatMap((c) => expand(c, depth + 1)) : [el]; };
  const list = (roots.length ? roots : [document.body]).flatMap((r) => expand(r, 0));
  return JSON.stringify({ title: document.title, lang: document.documentElement.lang, totalH: document.documentElement.scrollHeight,
    body: { bg: getComputedStyle(document.body).backgroundColor, font: sty(document.body) },
    sections: list.map((el, i) => { const r = el.getBoundingClientRect(); return {
      i, tag: el.tagName.toLowerCase(), id: el.id || "", cls: (el.className && el.className.toString ? el.className.toString() : "").slice(0, 80),
      y: Math.round(r.top + scrollY), h: Math.round(r.height), bg: bgOf(el), layout: layout(el), items: items(el) }; }) });
})()`;

async function capture(s, width, height, label, noShots = false) {
  await s.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await s.send("Page.navigate", { url });
  await sleep(2500);
  // 遅延読み込みの画像を出すために、ページを最後まで1回スクロールする
  const H = JSON.parse((await s.send("Runtime.evaluate", { expression: "JSON.stringify(document.documentElement.scrollHeight)", returnByValue: true })).result.value);
  for (let y = 0; y < H; y += height) { await s.send("Runtime.evaluate", { expression: `scrollTo(0,${y})` }); await sleep(250); }
  await s.send("Runtime.evaluate", { expression: "scrollTo(0,0)" }); await sleep(600);
  const data = JSON.parse((await s.send("Runtime.evaluate", { expression: EXTRACT, returnByValue: true })).result.value);
  mkdirSync(join(out, "shots"), { recursive: true });
  for (const sec of data.sections) {
    if (sec.h < 20 || noShots) continue;
    const name = `${label}-${String(sec.i + 1).padStart(2, "0")}-${sec.id || sec.tag}.png`;
    try {
      const shot = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: sec.y, width, height: Math.min(sec.h, 6000), scale: 1 } });
      writeFileSync(join(out, "shots", name), Buffer.from(shot.data, "base64")); sec.shot = `shots/${name}`;
    } catch {}
  }
  return data;
}

const fmtStyle = (s) => s ? `${s.font} ${s.size}/${s.lh || "-"} w${s.weight} ${s.color}${s.ls ? ` ls${s.ls}` : ""}${s.align && s.align !== "start" ? ` ${s.align}` : ""}${s.transform ? ` ${s.transform}` : ""}` : "";
function mdSection(sec, mobile) {
  const L = [];
  const lay = sec.layout;
  L.push(`### ${sec.i + 1}. <${sec.tag}${sec.id ? ` id="${sec.id}"` : ""}> 高さ${sec.h}px 背景: ${sec.bg}`);
  L.push(`- レイアウト: ${lay.display}${lay.dir ? ` ${lay.dir}` : ""}${lay.cols && lay.cols !== "none" ? ` 列=${lay.cols}` : ""}${lay.gap && lay.gap !== "normal" ? ` 間隔=${lay.gap}` : ""} / 余白=${lay.pad}${lay.maxW !== "none" ? ` / 最大幅=${lay.maxW}` : ""}`);
  if (sec.shot) L.push(`- 見本画像: ${sec.shot}`);
  for (const it of sec.items) {
    if (it.kind === "image" || it.kind === "video" || it.kind === "svg") L.push(`- [${it.kind}] ${it.w}×${it.h} ${it.src ? `src=${it.src.slice(0, 120)}` : ""}${it.alt ? ` alt="${it.alt}"` : ""}`);
    else L.push(`- [${it.kind === "heading" ? it.tag : it.kind}] 「${it.text.slice(0, 120)}」 ${fmtStyle(it.style)}${it.href ? ` → ${it.href}` : ""}${it.bg && it.bg !== "rgba(0, 0, 0, 0)" ? ` ボタン背景=${it.bg}` : ""}${it.box ? ` 箱[背景=${it.box.bg} 角丸=${it.box.radius} 余白=${it.box.pad}${it.box.border ? " 枠=" + it.box.border : ""} ${it.box.w}×${it.box.h}]` : ""}`);
  }
  return L.join("\n");
}

try {
  let ws; for (let i = 0; i < 30 && !ws; i++) { await sleep(500); try { ws = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {} }
  if (!ws) throw new Error("Chromeにつなげませんでした");
  const s = await cdpSession(ws, 30000);
  await s.send("Page.enable"); await s.send("Runtime.enable");
  const pc = await capture(s, 1440, 900, "pc");
  const SP_WIDTH = Number(process.env.SP_WIDTH ?? 540); // STUDIOの「モバイル」のベース幅(編集画面の下に出る。既定は540px)。この幅で取る
  const sp = await capture(s, SP_WIDTH, 844, "sp");
  const pc1280 = await capture(s, 1280, 900, "pc1280", true); // STUDIOの編集画面の、デフォルトの幅。配置の検査に使う(画像は撮らない)
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "spec.json"), JSON.stringify({ url, pc, sp, pc1280, spWidth: SP_WIDTH }, null, 2));
  const md = [
    `# 移植仕様書: ${pc.title || url}`,
    `元: ${url}`,
    "",
    "この仕様書は、元サイトを実際のChromeで開いて、画面に表示された結果から自動で作った。STUDIOで、セクションの上から順に、1つずつ作ること。",
    "各セクションを作ったら、見本画像(shots/)と並べて見比べ、文字の大きさ・色・余白・配置の違いを直してから、次に進む。",
    "",
    `- 言語: ${pc.lang || "-"} / 全体の高さ: PC ${pc.totalH}px, スマホ ${sp.totalH}px`,
    `- ページの背景: ${pc.body.bg} / 基本の文字: ${fmtStyle(pc.body.font)}`,
    "",
    "## PC(幅1440px)",
    ...pc.sections.filter((x) => x.h >= 20).map((x) => mdSection(x)),
    "",
    "## スマホ(幅390px): PCとの違いだけ確認する",
    ...sp.sections.filter((x) => x.h >= 20).map((x) => `- ${x.i + 1}. <${x.tag}${x.id ? ` id="${x.id}"` : ""}> 高さ${x.h}px レイアウト=${x.layout.display}${x.layout.dir ? " " + x.layout.dir : ""}${x.layout.cols && x.layout.cols !== "none" ? " 列=" + x.layout.cols : ""} 見本=${x.shot ?? "-"}`),
    "",
  ].join("\n");
  writeFileSync(join(out, "spec.md"), md);
  console.log(`作成しました: ${join(out, "spec.md")}(PC ${pc.sections.length}セクション / スマホ ${sp.sections.length}セクション)`);
  s.close();
} catch (e) { console.error("失敗:", e.message); process.exitCode = 1; } finally { cleanup(); }
