// 元のページと、いまのSTUDIOの編集画面を、同じ幅で、全体を撮って、並べた画像(spec-out/compare/compare-01.png …)を作る。
// 使い方: node scripts/compare-images.js <元のHTML> [出力フォルダ=spec-out/compare]
//   ※ STUDIO の画面は、専用Chrome(9222)の編集画面を、スクロールしながら撮って、つなげる。画面の操作はしない(スクロールだけ)。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cdpSession } from "../browser-guard.js";

const html = process.argv[2];
const out = resolve(process.argv[3] ?? "spec-out/compare");
if (!html) { console.error("使い方: node scripts/compare-images.js <元のHTML> [出力フォルダ]"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(out, "slices"), { recursive: true });
const ev = async (s, expression) => JSON.parse((await s.send("Runtime.evaluate", { expression, returnByValue: true })).result.value ?? "null");

// ---- 1) STUDIO の編集画面を、上から下へ、スクロールしながら撮る ----
const page = (await (await fetch("http://localhost:9222/json/list")).json()).filter((t) => t.type === "page" && /studio\.design\/projects\/[^/]+\/editor/.test(t.url))[0];
if (!page) { console.error("STUDIOの編集画面が開かれていません"); process.exit(1); }
const s = await cdpSession(page.webSocketDebuggerUrl, 20000);
const FIRST = process.env.FIRST_TEXT ?? "About", LAST = process.env.LAST_TEXT ?? "TeeenS Inc";
const ROOT = `(() => { const find = (t) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.includes(t)) return n.parentElement; return null; };
  const a = find(${JSON.stringify(FIRST)}), b = find(${JSON.stringify(LAST)}); if (!a || !b) return null; let e = a; while (e && !e.contains(b)) e = e.parentElement; return e; })()`;
const rectJs = `(() => { const e = ${ROOT}; if (!e) return JSON.stringify(null); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, ih: innerHeight, iw: innerWidth, dpr: devicePixelRatio }); })()`;
const wheel = async (dy, x, y) => { await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }); await sleep(450); };
// 左側の「追加パネル」などが開いていると、キャンバスの左を隠してしまう。開いているパネルを、閉じる(閉じるだけ。ほかの操作はしない)
await s.send("Runtime.evaluate", { expression: `document.querySelectorAll('button[aria-label$="パネルを閉じる"]').forEach((b) => b.click())` });
await sleep(700);
let R = await ev(s, rectJs);
if (!R) { console.error("サイト本体が見つかりませんでした"); process.exit(1); }
const cx = Math.round(R.x + R.w / 2), cy = Math.round(R.ih / 2);
const CANVAS_W = Number(process.env.CANVAS_WIDTH ?? 1280); // STUDIOの編集画面の、デフォルトの幅(画面の下に「デフォルト : 1280px」と出る)
const TOP = 60, BOT = R.ih - 110, STEP = BOT - TOP - 20; // キャンバスとして見えている範囲(上のバー・下の浮かぶバーを除く)
// 画面の表示位置を、目標(キャンバスの上端が y=target になる位置)に合わせる。ホイール1あたり、半分の距離だけ動く
const goto = async (target) => { for (let i = 0; i < 80; i++) { const y = (await ev(s, rectJs)).y; const d = y - target; if (Math.abs(d) < 3) return; await wheel(Math.max(-3000, Math.min(3000, Math.round(d * 2))), cx, cy); } };
await goto(TOP); await sleep(600);
const x0 = Math.max(0, Math.round(R.x)), w0 = Math.round(R.w), slices = [];
const totalCss = (await ev(s, rectJs)).h;
for (let k = 0; k * STEP < totalCss + STEP && k < 120; k++) {
  await goto(TOP - k * STEP); await sleep(350);
  const r = await ev(s, rectJs);
  const hh = Math.min(BOT - TOP, r.y + r.h - TOP); if (hh <= 5) break;
  const shot = await s.send("Page.captureScreenshot", { format: "png", clip: { x: x0, y: TOP, width: w0, height: hh, scale: 1 } });
  const f = join(out, "slices", `s${String(k).padStart(3, "0")}.png`);
  writeFileSync(f, Buffer.from(shot.data, "base64"));
  slices.push({ file: f, offsetCss: TOP - r.y }); // ページの上端から、この画像の上端までの距離(CSS px)
}
const total = totalCss, dpr = R.dpr;
s.close();
writeFileSync(join(out, "slices.json"), JSON.stringify({ slices, total, dpr, width: w0 }));

// ---- 2) 元のページを、同じ幅で、全体を撮る ----
const CHROME = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find(existsSync);
const PORT = 9335, prof = mkdtempSync(join(tmpdir(), "cmp-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
try {
  let ws; for (let i = 0; i < 30 && !ws; i++) { await sleep(500); try { ws = (await (await fetch(`http://localhost:${PORT}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {} }
  const o = await cdpSession(ws, 30000);
  await o.send("Page.enable"); await o.send("Runtime.enable");
  await o.send("Emulation.setDeviceMetricsOverride", { width: CANVAS_W, height: 900, deviceScaleFactor: (w0 * dpr) / CANVAS_W, mobile: false }); // 画像の画素の幅を、STUDIOの画像と、そろえる
  await o.send("Page.navigate", { url: pathToFileURL(resolve(html)).href }); await sleep(2500);
  const H = await ev(o, "JSON.stringify(document.documentElement.scrollHeight)");
  for (let y = 0; y < H; y += 900) { await o.send("Runtime.evaluate", { expression: `scrollTo(0,${y})` }); await sleep(200); } // 遅延読み込みの画像を出す
  await o.send("Runtime.evaluate", { expression: "scrollTo(0,0)" }); await sleep(500);
  const shot = await o.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: CANVAS_W, height: Math.min(H, 16000), scale: 1 } });
  writeFileSync(join(out, "original-full.png"), Buffer.from(shot.data, "base64"));
  o.close();
} finally { try { chrome.kill(); rmSync(prof, { recursive: true, force: true }); } catch {} }

// ---- 3) つなげて、並べる(Python / Pillow) ----
const py = spawnSync("python3", [join(dirname(fileURLToPath(import.meta.url)), "compose-compare.py"), out], { stdio: "inherit" });
process.exit(py.status ?? 0);
