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

// 画面に readyText が出た時点で、すぐ終わる(0.3秒ごとに確認。以前は、1.5秒ごと)
async function waitReady(s, readyText, timeoutMs, startUrl) {
  const want = new URL(startUrl).pathname.replace(/\/$/, ""); // 前のページの文字を読み違えないよう、URLが一覧に変わったことも確かめる
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await s.send("Runtime.evaluate", {
        expression: `JSON.stringify({u:location.href,s:document.readyState,t:document.body?document.body.innerText.slice(0,4000):""})`,
        returnByValue: true,
      });
      const st = JSON.parse(r.result.value);
      if (/\/login/.test(st.u)) return { ok: false, code: "login_required" };
      if (st.s === "complete" && st.t.includes(readyText) && new URL(st.u).pathname.replace(/\/$/, "") === want) return { ok: true };
    } catch {}
    await sleep(300);
  }
  return { ok: false, code: "not_ready" };
}

/**
 * @returns {{ok:true}|{ok:false, code:"browser_down"|"login_required"|"not_ready"|"cdp_error", detail?:string}}
 */
export async function prepareBrowser({
  cdp = "http://localhost:9222", startUrl = "https://app.studio.design/projects",
  readyText = "プロジェクト", autoRestart = true, restart, log = () => {}, readyTimeoutMs = 40000,
  deep = false, keepEditor = false, studioPattern = /studio\.design/, // true: 毎回の整備(タブを作り直す+キャッシュ消去)。false(既定): 正常なら、既存のタブを一覧に戻すだけ
} = {}) {
  let alive = await ping(cdp);
  if (!alive && autoRestart && restart) {
    log("専用Chromeが応答しないので、起動し直します…");
    try { await restart(); } catch (e) { log(`起動し直しに失敗: ${e.message}`); }
    for (let i = 0; i < 25 && !alive; i++) { await sleep(1000); alive = await ping(cdp); }
  }
  if (!alive) return { ok: false, code: "browser_down" };

  // 会話モード: すでに編集画面が開いているなら、一覧へ戻さず、そのまま続ける(直しの途中の状態を消さない)
  if (keepEditor && !deep) {
    try {
      const pages = (await http(cdp, "/json/list")).filter((t) => t.type === "page");
      if (pages.some((t) => /app\.studio\.design\/projects\/[^/]+\/editor/.test(t.url))) return { ok: true, kept: true };
    } catch {}
  }

  // 速い道(既定): タブが1つだけで、STUDIOを開いているなら、キャッシュ消去も、タブの作り直しもせず、一覧へ戻して、画面が出た時点で終わる
  if (!deep) {
    try {
      const pages = (await http(cdp, "/json/list")).filter((t) => t.type === "page");
      if (pages.length === 1 && studioPattern.test(pages[0].url)) {
        const s = await cdpSession(pages[0].webSocketDebuggerUrl);
        try {
          await s.send("Page.enable");
          await s.send("Page.navigate", { url: startUrl });
          const r = await waitReady(s, readyText, Math.min(readyTimeoutMs, 15000), startUrl);
          if (r.ok) return { ok: true, fast: true };
          if (r.code === "login_required") return { ok: false, code: "login_required" };
          log("速い整備で画面が出なかったので、タブを作り直します…");
        } finally { s.close(); }
      }
    } catch (e) { log(`速い整備に失敗(${e.message})。タブを作り直します…`); }
  }

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
      return await waitReady(s, readyText, readyTimeoutMs, startUrl);
    } finally { s.close(); }
  } catch (e) {
    return { ok: false, code: "cdp_error", detail: e.message };
  }
}

/**
 * 作業の完了後、Bot自身が、専用Chromeの編集タブを再読み込みして、期待する文字が画面に出ているかを確かめる(Codexの自己申告を信じない)。
 * メイン画面と、入れ子の画面(iframe)の両方の文字を調べる。
 * @returns {{status:"verified"|"not_found"|"unverifiable", detail?:string}}
 *   verified=見つかった / not_found=画面は読めたが文字がない / unverifiable=タブやChromeにつなげなかった
 */
export async function verifyText({ cdp = "http://localhost:9222", expected, timeoutMs = 40000, reload = true } = {}) {
  if (!expected) return { status: "unverifiable", detail: "期待する文字が不明" };
  let pages;
  try { pages = (await http(cdp, "/json/list")).filter((t) => t.type === "page"); } catch (e) { return { status: "unverifiable", detail: `Chromeに接続できません: ${e.message}` }; }
  // 編集画面らしいタブを優先(一覧ページ以外のSTUDIOのタブ)
  const page = pages.find((p) => /studio\.design/.test(p.url) && !/\/projects\/?(\?|$)/.test(p.url)) ?? pages[0];
  if (!page) return { status: "unverifiable", detail: "開いているタブがありません" };
  let s;
  try {
    s = await cdpSession(page.webSocketDebuggerUrl);
    await s.send("Page.enable");
    if (reload) await s.send("Page.reload", { ignoreCache: true });
    const deadline = Date.now() + timeoutMs;
    let seen = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const texts = [];
      try {
        const main = await s.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true });
        texts.push(main.result.value ?? "");
        const walk = (n) => [n.frame.id, ...(n.childFrames ?? []).flatMap(walk)];
        const tree = await s.send("Page.getFrameTree");
        for (const fid of walk(tree.frameTree).slice(1)) {
          try {
            const w = await s.send("Page.createIsolatedWorld", { frameId: fid });
            const r = await s.send("Runtime.evaluate", { contextId: w.executionContextId, expression: "document.body ? document.body.innerText : ''", returnByValue: true });
            texts.push(r.result.value ?? "");
          } catch {}
        }
      } catch { continue; } // 再読み込み中は、読めないことがある
      seen = seen || texts.some((t) => t.length > 0);
      if (texts.some((t) => t.includes(expected))) return { status: "verified" };
    }
    return seen ? { status: "not_found", detail: `再読み込み後の画面に「${expected}」が見つかりません` } : { status: "unverifiable", detail: "画面の文字を読み取れませんでした" };
  } catch (e) {
    return { status: "unverifiable", detail: e.message };
  } finally { s?.close(); }
}

/**
 * 一覧の画面で、対象プロジェクトの「デザインエディタ」を、Botが先に押しておく(読み込みの待ちを、Codexの起動と並行させるため)。
 * 押すだけで、読み込みの完了は待たない(Codex側が browser_wait_for で待つ)。
 * 一意に特定できなければ、何も押さない(clicked:false)。そのときは、Codexが、自分で開く。
 * @returns {{clicked:boolean, detail?:string}}
 */
export async function openEditor({ cdp = "http://localhost:9222", name, studioPattern = /studio\.design|localhost/, wsUrl, dryRun = false } = {}) {
  if (!name) return { clicked: false, detail: "プロジェクト名が不明" };
  const key = name.replace(/[（(][^）)]*[）)]/g, "").trim(); // 「あああ(サンプル)」→「あああ」
  if (!key) return { clicked: false, detail: "プロジェクト名が空" };
  let s;
  try {
    if (!wsUrl) {
      const pages = (await http(cdp, "/json/list")).filter((t) => t.type === "page");
      if (pages.length !== 1 || !studioPattern.test(pages[0].url)) return { clicked: false, detail: "タブが1つではありません" };
      wsUrl = pages[0].webSocketDebuggerUrl;
    }
    s = await cdpSession(wsUrl);
    const expr = `(() => {
      const key = ${JSON.stringify(key)};
      const label = (e) => (e.getAttribute("aria-label") || e.title || e.innerText || "").replace(/\\s+/g, " ").trim();
      let cands = [...document.querySelectorAll("a,button")].filter((e) => { const l = label(e); return l.includes("デザインエディタ") && l.includes(key); });
      const exact = cands.filter((e) => label(e).startsWith(key + ":") || label(e).startsWith(key + "："));  // 「あああ」と「あああ2」のように似た名前があるときは、完全一致を優先
      if (exact.length >= 1) cands = exact;
      // 一覧には、同じプロジェクトへのリンクが2つ(カードと行)ある。移動先(href)が同じなら、1つとして扱う
      const hrefs = new Set(cands.map((e) => e.getAttribute("href") || label(e)));
      if (hrefs.size !== 1) return JSON.stringify({ n: hrefs.size });
      if (!${dryRun}) cands[0].click();
      return JSON.stringify({ n: 1, label: label(cands[0]), href: cands[0].getAttribute("href") });
    })()`;
    const r = JSON.parse((await s.send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value);
    return r.n === 1 ? { clicked: !dryRun, detail: `${r.label} → ${r.href}` } : { clicked: false, detail: `候補が${r.n}件(1件のときだけ押します)` };
  } catch (e) {
    return { clicked: false, detail: e.message };
  } finally { s?.close(); }
}


/** 専用Chromeの、STUDIO編集タブ(なければ、STUDIOのタブ)のスクリーンショットを、PNGで返す。撮れなければ null */
export async function captureScreenshot({ cdp = "http://localhost:9222", studioPattern = /studio\.design/ } = {}) {
  let s;
  try {
    const pages = (await http(cdp, "/json/list")).filter((t) => t.type === "page" && studioPattern.test(t.url));
    const page = pages.find((t) => /\/editor/.test(t.url)) ?? pages[0];
    if (!page) return null;
    s = await cdpSession(page.webSocketDebuggerUrl, 15000);
    const r = await s.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(r.data, "base64");
  } catch { return null; } finally { s?.close(); }
}
