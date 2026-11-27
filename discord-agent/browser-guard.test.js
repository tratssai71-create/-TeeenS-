import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { prepareBrowser } from "./browser-guard.js";

// 実際のChromiumで確認する(playwright が使えない環境では、スキップ)
let chromium = null;
try { chromium = createRequire(import.meta.url)("playwright").chromium; } catch {
  try { chromium = createRequire("/usr/lib/node_modules/")("playwright").chromium; } catch {}
}
const skip = chromium ? false : "playwright/Chromium が無い環境";

const PORT = 9333;
const CDP = `http://localhost:${PORT}`;

function server() {
  const srv = http.createServer((req, res) => {
    if (req.url === "/projects") { res.setHeader("content-type", "text/html; charset=utf-8"); return void res.end("<body><h1>プロジェクト一覧</h1></body>"); }
    if (req.url === "/needlogin") { res.statusCode = 302; res.setHeader("location", "/login?redirect_url=/needlogin"); return void res.end(); }
    if (req.url.startsWith("/login")) { res.setHeader("content-type", "text/html"); return void res.end("<body>Sign in</body>"); }
    if (req.url === "/blank") { res.setHeader("content-type", "text/html"); return void res.end("<body></body>"); }
    res.statusCode = 404; res.end("nf");
  });
  return new Promise((r) => srv.listen(0, () => r(srv)));
}

test("実Chromium: 古いタブを閉じ、一覧が出た状態の1タブにそろえる", { skip, timeout: 90000 }, async () => {
  const srv = await server(); const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
  try {
    const ctx = await browser.newContext();
    for (let i = 0; i < 4; i++) await (await ctx.newPage()).goto(`${base}/blank`); // タブを溜める
    const r = await prepareBrowser({ cdp: CDP, startUrl: `${base}/projects`, readyText: "プロジェクト一覧" });
    assert.deepEqual(r, { ok: true });
    const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter((t) => t.type === "page");
    assert.equal(pages.length, 1, "タブが1つだけ残る");
    assert.match(pages[0].url, /\/projects$/);
  } finally { await browser.close(); srv.close(); }
});

test("実Chromium: ログイン画面に飛ばされたら login_required", { skip, timeout: 90000 }, async () => {
  const srv = await server(); const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
  try {
    const r = await prepareBrowser({ cdp: CDP, startUrl: `${base}/needlogin`, readyText: "プロジェクト一覧" });
    assert.equal(r.ok, false); assert.equal(r.code, "login_required");
  } finally { await browser.close(); srv.close(); }
});

test("実Chromium: 画面が出ないときは not_ready(待ち時間を短くして確認)", { skip, timeout: 90000 }, async () => {
  const srv = await server(); const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
  try {
    const r = await prepareBrowser({ cdp: CDP, startUrl: `${base}/blank`, readyText: "プロジェクト一覧", readyTimeoutMs: 4000 });
    assert.equal(r.ok, false); assert.equal(r.code, "not_ready");
  } finally { await browser.close(); srv.close(); }
});

test("Chromeが無いとき: browser_down(自動で起動し直しを呼ぶ)", { timeout: 60000 }, async () => {
  let called = 0;
  const r = await prepareBrowser({ cdp: "http://localhost:9444", autoRestart: true, restart: async () => { called++; } });
  assert.deepEqual(r, { ok: false, code: "browser_down" });
  assert.equal(called, 1);
});
