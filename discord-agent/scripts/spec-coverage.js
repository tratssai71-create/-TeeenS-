// 仕様書が、元のページの文字を、どれだけ拾えているかを調べる(取りこぼしの検出)。
// 使い方: node scripts/spec-coverage.js <HTMLファイル or URL> [仕様書のフォルダ=spec-out]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cdpSession } from "../browser-guard.js";

const [, , input, dirArg] = process.argv;
if (!input) { console.error("使い方: node scripts/spec-coverage.js <HTMLファイル or URL> [仕様書のフォルダ]"); process.exit(1); }
const url = /^https?:|^file:/.test(input) ? input : pathToFileURL(resolve(input)).href;
const spec = JSON.parse(readFileSync(join(resolve(dirArg ?? "spec-out"), "spec.json"), "utf8"));
const norm = (t) => String(t ?? "").replace(/[\s　「」『』"'“”‘’・、。,.!?！？:：;；\-—–]/g, "").toLowerCase();
const specText = spec.pc.sections.flatMap((s) => s.items.filter((i) => i.text).map((i) => norm(i.text))).join("|");
const CHROME = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
const PORT = 9336, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = mkdtempSync(join(tmpdir(), "cov-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  let ws; for (let i = 0; i < 30 && !ws; i++) { await sleep(500); try { ws = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {} }
  const s = await cdpSession(ws, 30000);
  await s.send("Page.enable"); await s.send("Runtime.enable");
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await s.send("Page.navigate", { url }); await sleep(2500);
  const H = JSON.parse((await s.send("Runtime.evaluate", { expression: "JSON.stringify(document.documentElement.scrollHeight)", returnByValue: true })).result.value);
  for (let y = 0; y < H; y += 900) { await s.send("Runtime.evaluate", { expression: `scrollTo(0,${y})` }); await sleep(200); }
  // 見えている文字の塊(文字ノードを持つ要素ごと)を集める。1px四方の見えない文字・非表示は除く
  const lines = JSON.parse((await s.send("Runtime.evaluate", { returnByValue: true, expression: `(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const t = n.textContent.replace(/\\s+/g, " ").trim(); if (t.length < 2) continue; const e = n.parentElement; if (!e || ["SCRIPT","STYLE","NOSCRIPT"].includes(e.tagName)) continue;
      const r = e.getBoundingClientRect(); const c = getComputedStyle(e); if (r.width <= 2 || r.height <= 2 || c.display === "none" || c.visibility === "hidden") continue;
      let hid = false; for (let a = e; a && a !== document.body; a = a.parentElement) { const q = getComputedStyle(a); if (q.display === "none" || q.visibility === "hidden" || a.getAttribute("aria-hidden") === "true" || (q.opacity === "0" && q.pointerEvents === "none")) { hid = true; break; } } if (hid) continue; out.push(t); }
    return JSON.stringify(out); })()` })).result.value);
  const missing = lines.filter((l) => { const k = norm(l); return k.length >= 2 && !specText.includes(k); });
  const pct = lines.length ? Math.round(100 * (1 - missing.length / lines.length)) : 100;
  console.log(`文字の拾えた割合: ${pct}%(見えている文字の塊 ${lines.length}件のうち、仕様書に無いもの ${missing.length}件)`);
  if (missing.length) console.log("仕様書に無い文字(先頭から最大15件):\n" + missing.slice(0, 15).map((m) => `  ・${m.slice(0, 50)}`).join("\n"));
  s.close();
} finally { try { chrome.kill(); rmSync(prof, { recursive: true, force: true }); } catch {} }
