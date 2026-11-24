// 作業の前に、専用Chromeを「毎回、同じ状態」に整える(タブ整理・キャッシュ消去・STUDIO一覧を開いて待つ)。
// Chrome DevTools Protocol(CDP)を直接使うので、Playwrightが固まっていても動く。Node 22+ のグローバル WebSocket を使用。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(cdp, path, opts = {}, ms = 3000) {
  const r = await fetch(`${cdp}${path}`, { ...opts, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}
const ping = async (cdp) => { try { await http(cdp, "/json/version", {}, 2500); return true; } catch { return false; } };

export function cdpSession(wsUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("ws open timeout")); }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve({
        send: (method, params = {}) => new Promise((res, rej) => {
          const i = ++id;
          const to = setTimeout(() => { pending.delete(i); rej(new Error(`${method} timeout`)); }, timeoutMs);
          pending.set(i, { res, rej, to });
          ws.send(JSON.stringify({ id: i, method, params }));
        }),
        close: () => { try { ws.close(); } catch {} },
      });
    });
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const p = pending.get(m.id); if (!p) return;
      clearTimeout(p.to); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws error")); });
  });
}

/**
 * @returns {{ok:true}|{ok:false, code:"browser_down"|"login_required"|"not_ready"|"cdp_error", detail?:string}}
 */
export async function prepareBrowser({
  cdp = "http://localhost:9222", startUrl = "https://app.studio.design/projects",
  readyText = "プロジェクト", autoRestart = true, restart, log = () => {}, readyTimeoutMs = 40000,
} = {}) {
  let alive = await ping(cdp);
  if (!alive && autoRestart && restart) {
    log("専用Chromeが応答しないので、起動し直します…");
    try { await restart(); } catch (e) { log(`起動し直しに失敗: ${e.message}`); }
    for (let i = 0; i < 25 && !alive; i++) { await sleep(1000); alive = await ping(cdp); }
  }
  if (!alive) return { ok: false, code: "browser_down" };

  try {
    const old = (await http(cdp, "/json/list")).filter((t) => t.type === "page");
    const fresh = await http(cdp, "/json/new?about:blank", { method: "PUT" });   // まっさらなタブを1つ作る
    for (const p of old) { try { await http(cdp, `/json/close/${p.id}`); } catch {} } // 古い・壊れたタブは全部閉じる
    const s = await cdpSession(fresh.webSocketDebuggerUrl);
    try {
      await s.send("Network.enable");
      await s.send("Network.clearBrowserCache");     // 古いスクリプト(404)の原因を消す。ログイン(Cookie)は消えない
      await s.send("Page.enable");
      await s.send("Page.navigate", { url: startUrl });
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(1500);
        const r = await s.send("Runtime.evaluate", {
          expression: `JSON.stringify({u:location.href,s:document.readyState,t:document.body?document.body.innerText.slice(0,4000):""})`,
          returnByValue: true,
        });
        const st = JSON.parse(r.result.value);
        if (/\/login/.test(st.u)) return { ok: false, code: "login_required" };
        if (st.s === "complete" && st.t.includes(readyText)) return { ok: true };
      }
      return { ok: false, code: "not_ready" };
    } finally { s.close(); }
  } catch (e) {
    return { ok: false, code: "cdp_error", detail: e.message };
  }
}
