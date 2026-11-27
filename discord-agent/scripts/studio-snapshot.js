// いまの STUDIO の編集画面の中の、サイト本体(キャンバス)の HTML を取り出して、使い捨てのChromeで、PC幅(1440px)で描き直して、全体の画像にする。
// 使い方: node scripts/studio-snapshot.js <出力フォルダ> [幅=1440]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cdpSession } from "../browser-guard.js";

const out = resolve(process.argv[2] ?? "spec-out/compare");
const width = Number(process.argv[3] ?? 1440);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

// 1) 編集画面のタブから、キャンバスの HTML を取り出す
const pages = (await (await fetch("http://localhost:9222/json/list")).json()).filter((t) => t.type === "page" && /studio\.design\/projects\/[^/]+\/editor/.test(t.url));
if (!pages[0]) { console.error("STUDIOの編集画面が開かれていません"); process.exit(1); }
const s0 = await cdpSession(pages[0].webSocketDebuggerUrl, 20000);
let html = null, base = "";
try {
  // キャンバスは、編集画面のページの中に、直接、入っている。最初のセクションの文字と、最後のセクションの文字を、両方含む、いちばん小さい要素を、サイト本体とみなす
  const r = await s0.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
    const first = ${JSON.stringify(process.env.FIRST_TEXT ?? "Landing")}, last = ${JSON.stringify(process.env.LAST_TEXT ?? "TeeenS Inc")};
    const find = (t) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.includes(t)) return n.parentElement; return null; };
    const a = find(first), b = find(last); if (!a || !b) return JSON.stringify(null);
    let e = a; while (e && !e.contains(b)) e = e.parentElement; if (!e) return JSON.stringify(null);
    // 親をたどって、ページ全体の幅を持つ包み(サイト本体)まで広げる: 子が1つだけの間は、親へ
    while (e.parentElement && e.parentElement !== document.body && e.parentElement.children.length === 1) e = e.parentElement;
    const css = []; for (const sh of document.styleSheets) { try { css.push([...sh.cssRules].map((x) => x.cssText).join(" ")); } catch { if (sh.href) css.push('@import url("' + sh.href + '");'); } }
    return JSON.stringify({ u: location.href, css: css.join(" "), h: e.outerHTML });
  })()` });
  const d = JSON.parse(r.result.value ?? "null");
  if (d) html = { u: d.u, h: `<!doctype html><html><head><meta charset="utf-8"><style>${d.css}</style></head><body>${d.h}</body></html>` };
} finally { s0.close(); }
if (!html) { console.error("サイト本体の画面が見つかりませんでした"); process.exit(1); }
try { base = new URL(html.u).origin + "/"; } catch {}
const doc = html.h.replace(/<head([^>]*)>/i, `<head$1><base href="${base}"><style>html,body{margin:0}</style>`);
const file = join(out, "studio-canvas.html");
writeFileSync(file, doc);

// 2) 使い捨てのChromeで、PC幅で描き直して、全体を撮る
const CHROME = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
const PORT = 9334, prof = mkdtempSync(join(tmpdir(), "snap-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
try {
  let ws; for (let i = 0; i < 30 && !ws; i++) { await sleep(500); try { ws = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {} }
  const s = await cdpSession(ws, 30000);
  await s.send("Page.enable"); await s.send("Runtime.enable");
  await s.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await s.send("Page.navigate", { url: pathToFileURL(file).href });
  await sleep(4000);
  const H = JSON.parse((await s.send("Runtime.evaluate", { expression: "JSON.stringify(document.documentElement.scrollHeight)", returnByValue: true })).result.value);
  const shot = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(H, 16000), scale: 1 } });
  writeFileSync(join(out, "studio-full.png"), Buffer.from(shot.data, "base64"));
  console.log(`書き出しました: ${join(out, "studio-full.png")}(幅${width}px・高さ${H}px)`);
  s.close();
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { try { chrome.kill(); rmSync(prof, { recursive: true, force: true }); } catch {} }
