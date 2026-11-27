// 元のページの、飾りの文字(輪郭だけの文字など、STUDIOの標準部品で作れないもの)を、透明な背景のPNGに書き出す。
// 使い方: node scripts/export-text-image.js <元のHTML> "<CSSセレクタ>" <出力ファイル.png> [倍率=2]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { cdpSession } from "../browser-guard.js";

const [htmlArg, selector, outArg, scaleArg = "2"] = process.argv.slice(2);
if (!htmlArg || !selector || !outArg) { console.error('使い方: node scripts/export-text-image.js <元のHTML> "<CSSセレクタ>" <出力.png> [倍率]'); process.exit(1); }
const CHROME = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
if (!CHROME) { console.error("Chromeが見つかりません"); process.exit(1); }
const PORT = 9333, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = mkdtempSync(join(tmpdir(), "textimg-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(prof, { recursive: true, force: true }); } catch {} };
try {
  let ws; for (let i = 0; i < 30 && !ws; i++) { await sleep(500); try { ws = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {} }
  if (!ws) throw new Error("Chromeにつなげませんでした");
  const s = await cdpSession(ws, 30000);
  await s.send("Page.enable"); await s.send("Runtime.enable");
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: Number(scaleArg), mobile: false });
  await s.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }); // 背景を透明に
  await s.send("Page.navigate", { url: pathToFileURL(resolve(htmlArg)).href });
  await sleep(3000);
  // 対象の文字だけを残し、ほかは消す(背景も透明にする)。アニメーションの、途中の状態を避けるため、動きを止める
  const rect = JSON.parse((await s.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null);
    const st = document.createElement("style"); st.textContent = "*{animation:none!important;transition:none!important} html,body{background:transparent!important} body *{visibility:hidden!important} .__keep, .__keep *{visibility:visible!important}";
    document.head.appendChild(st); el.classList.add("__keep"); el.querySelectorAll("i,b,span").forEach(x => x.classList.add("__keep"));
    el.querySelectorAll(".dot").forEach(d => { d.style.transform = "translateY(-.1em) scale(1)"; });
    el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y+scrollY,w:r.width,h:r.height}); })()` })).result.value);
  if (!rect) throw new Error(`セレクタ「${selector}」が見つかりません`);
  await sleep(500);
  const pad = 8;
  const shot = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.w + pad * 2, height: rect.h + pad * 2, scale: 1 } });
  mkdirSync(dirname(resolve(outArg)), { recursive: true });
  writeFileSync(resolve(outArg), Buffer.from(shot.data, "base64"));
  console.log(`書き出しました: ${resolve(outArg)}(${Math.round(rect.w)}×${Math.round(rect.h)}px の ${scaleArg}倍)`);
  s.close();
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { cleanup(); }
