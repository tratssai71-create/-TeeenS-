import { Client, GatewayIntentBits } from "discord.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyApproval, extractExpectedText } from "./core.js";
import { roleLabel, detectUsageLimit } from "./messages.js";
import { prepareBrowser, verifyText } from "./browser-guard.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const {
  AGENT_NAME = "agent", DISCORD_TOKEN, WORKDIR = process.cwd(),
  CODEX_ARGS = "--sandbox workspace-write --skip-git-repo-check",
  TIMEOUT_MIN = "30",
} = process.env;
const CHANNELS = new Set(list(process.env.CHANNEL_IDS));
// ワーカーモード(司令塔からのタスク受信)。未設定なら無効
const { TASKS_CHANNEL_ID, LOG_CHANNEL_ID, ORCHESTRATOR_BOT_ID } = process.env;
const seenTasks = new Set(); // 二重実行防止
// publisherなど「承認必須」のワーカー: 司令塔が署名した公開承認がなければ実行しない
const REQUIRE_APPROVAL = env_flag(process.env.REQUIRE_APPROVAL);
const { APPROVAL_SECRET } = process.env;
function env_flag(v) { return v === "1" || v === "true"; }
const ALLOWED = new Set(list(process.env.ALLOWED_USER_IDS));

if (!DISCORD_TOKEN || (!CHANNELS.size && !TASKS_CHANNEL_ID) || !ALLOWED.size) {
  console.error("DISCORD_TOKEN / ALLOWED_USER_IDS と、CHANNEL_IDS か TASKS_CHANNEL_ID を .env に設定してください");
  process.exit(1);
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message ?? e));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Developer Portal で有効化が必要
  ],
});

let current = null;      // 実行中の子プロセス
let chain = Promise.resolve(); // タスクは1件ずつ直列実行

// 連続する同じ行を「×N」にまとめる(進捗の表示を短くする)
function compress(lines) {
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.text === l) last.n++; else out.push({ text: l, n: 1 });
  }
  return out.map((o) => (o.n > 1 ? `${o.text} ×${o.n}` : o.text));
}

// 受け取った文字列を、1行ずつコールバックに渡す
function lineSplitter(cb) {
  let buf = "";
  return (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const p of parts) cb(p.replace(/\r$/, ""));
  };
}

// codex exec の出力から、人が見て分かる進捗(使っている道具、Codexの発言、セッションID)だけを取り出す
function makeProgress(push, { session = true } = {}) {
  let mode = null;
  return (line) => {
    const s = line.trim();
    const sid = s.match(/^session id:\s*(\S+)/);
    if (sid) return session && push(`🧾 セッション: \`${sid[1]}\`(あとで \`codex resume ${sid[1]}\` で、やり取りを見られます)`);
    if (s === "codex") { mode = "codex"; return; }
    const tool = s.match(/^mcp:\s*(\S+)\s+started/);
    if (tool) { mode = null; return push(`🔧 ${tool[1]}`); }
    if (/^(user|exec|tokens used)$/.test(s) || s.startsWith("mcp:")) { mode = null; return; }
    if (mode === "codex" && s && !/^-+$/.test(s)) push(`💬 ${s.slice(0, 300)}`);
  };
}

function runCodex(prompt, onLine, resumeId) {
  return new Promise(async (resolve) => {
    const dir = await mkdtemp(join(tmpdir(), "codex-"));
    const outFile = join(dir, "last.txt");
    // ブラウザ操作などのMCPを、確認なし(無人)で使えるようにする。MCP_AUTO_APPROVE=名前,名前 で変更(空で無効)
    const approve = list(process.env.MCP_AUTO_APPROVE ?? "playwright")
      .flatMap((s) => ["-c", `mcp_servers.${s}.default_tools_approval_mode="approve"`]);
    const win = process.platform === "win32";
    const base = ["exec", ...CODEX_ARGS.split(/\s+/).filter(Boolean), ...approve,
      "-C", WORKDIR, "--output-last-message", outFile];
    // 通常: 指示文は stdin("-")。会話の続き(resume): 前のセッションに続けて実行する
    const args = resumeId ? [...base, "resume", resumeId, win ? "-" : (prompt.startsWith("-") ? " " + prompt : prompt)] : [...base, "-"];
    // Windowsでは codex が .cmd のため shell 経由。その場合は、指示文を引数に載せずstdinで渡す(コマンド注入を避ける)
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], shell: win });
    if (!resumeId || win) child.stdin.end(prompt); else child.stdin.end();
    current = child;
    let log = "";
    const feedOut = onLine ? lineSplitter(onLine) : null;
    const feedErr = onLine ? lineSplitter(onLine) : null;
    child.stdout.on("data", (d) => { log += d; feedOut?.(d); });
    child.stderr.on("data", (d) => { log += d; feedErr?.(d); });
    const timer = setTimeout(() => child.kill("SIGTERM"), Number(TIMEOUT_MIN) * 60_000);
    child.on("close", async (code, sig) => {
      clearTimeout(timer);
      current = null;
      let last = "";
      try { last = (await readFile(outFile, "utf8")).trim(); } catch {}
      await rm(dir, { recursive: true, force: true });
      resolve({ code, sig, text: last || log.trim().slice(-1500) || "(出力なし)", sessionId: log.match(/session id:\s*(\S+)/)?.[1] });
    });
    child.on("error", async (e) => {
      clearTimeout(timer); current = null;
      resolve({ code: -1, text: `起動失敗: ${e.message}` });
    });
  });
}

// Discordの2000文字制限に合わせて分割
function chunks(s, n = 1900) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

// --- ワーカーモード: #tasks のJSONタスクを処理 ---
// 手順書(playbook)とプロジェクトURL一覧を、作業指示に添える(試行錯誤を減らして速くする)
const readIf = (p) => { try { return existsSync(p) ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const PLAYBOOK = readIf(process.env.PLAYBOOK_FILE ?? "docs/studio-playbook.md");
let PROJECTS = "";
try {
  const pj = JSON.parse(readIf(process.env.PROJECTS_FILE ?? "projects.json") || "{}");
  PROJECTS = Object.keys(pj).map((n) => `- ${n}`).join("\n");
} catch {}

// チャット用: 最初のメッセージにだけ添える前提(会話の続きでは、すでに伝わっている)
const CHAT_PREAMBLE = [
  "あなたは、Webサイト制作チームの『デザイナー』です。Discordのチャットで、ユーザーと会話しながら、STUDIOの編集作業を進めます。返答は、短く、分かりやすい日本語で。",
  PROJECTS ? `STUDIOのプロジェクト(編集画面は、直接URLではなく、必ず https://app.studio.design/projects の一覧から、該当プロジェクトの「デザインエディタ」を押して開く):\n${PROJECTS}` : "",
  PLAYBOOK ? `操作手順:\n${PLAYBOOK}` : "",
  "ブラウザ操作は、登録済みの Playwright の道具(playwright/browser_*)だけを使う。cua_repl など別の道具は使わない。ブラウザは、すでに、STUDIOのプロジェクト一覧が、1タブだけ開いた状態に整えてある。新しいタブは開かず、そのタブで、対象プロジェクトの「デザインエディタ」を押して開く。",
  "このチャットでは、公開は行わない(右上の「公開」ボタンは押さない)。公開が必要なときは、#command で依頼して、承認ボタンを使うよう案内する。",
  "**必須(編集を伴う作業)**: 完了を報告する前に、必ず、ページを再読み込み(browser_evaluate で `() => location.reload()` を実行する。F5キーは効かない。URLを開き直さない)して、変更が保存されていることを確かめる。報告には「再読み込み後に、○○と表示されていた」と、確認した内容を書く。再読み込みで確認できなかったら、完了にせず、`RESULT: FAILED` と書く。",
  "作業のあとは、何をしたかを1〜3行で報告する。分からないことは、推測で進めず、質問する。",
].filter(Boolean).join("\n\n");

// チャンネルごとの会話セッションを覚えておく(再起動しても続けられる)
const SESSIONS_FILE = process.env.CHAT_SESSIONS_FILE ?? "chat-sessions.json";
let sessions = {};
try { sessions = JSON.parse(readIf(SESSIONS_FILE) || "{}"); } catch {}
const saveSessions = () => { try { writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch {} };

// Botが完了後に再読み込みして確認できる依頼では、Codexに再読み込みをさせない(以前は、F5が効かず、約25秒を無駄にした)
const BOT_VERIFY_LINE = "**再読み込みは、しない。スクリーンショットも撮らない。**変更したら、変更後の文字が、画面(または右パネル)に出たことだけを確認して、すぐに報告する(完了後に、Bot自身が、再読み込みして、保存を確認する)。";
const RELOAD_LINE = "**必須(編集を伴う作業)**: 完了を報告する前に、ページを再読み込みして、保存を確認する。再読み込みは、browser_evaluate で `() => location.reload()` を実行する(F5キーは効かない)。そのあと、browser_wait_for で、確認したい文字が出るまで待つ(固定秒数では待たない)。報告には「再読み込み後に、○○と表示されていた」と書く。確認できなかったら `RESULT: FAILED`。";
const SPEED_LINE = "**速く進めるための決まり**: Playwrightの道具は、すでに登録済みで、exec の中で `tools.mcp__playwright__browser_snapshot` / `_click` / `_find` / `_evaluate` / `_type` / `_press_key` / `_wait_for` / `_tabs` として、すぐ呼べる。道具の一覧の調べ直しは、しない。1回の exec で、複数の操作(例: クリック→待つ→find)を、まとめて実行する。";
function buildPrompt(t, botVerifies = false) {
  const acc = (t.acceptance ?? []).map((a) => `- ${a}`).join("\n");
  return [
    `タスク: ${t.title ?? t.id}`,
    t.instructions ?? "",
    t.inputs ? `入力: ${JSON.stringify(t.inputs)}` : "",
    acc ? `受け入れ基準:\n${acc}` : "",
    PROJECTS ? `STUDIOのプロジェクト(編集画面は、直接URLではなく、必ず https://app.studio.design/projects の一覧から、該当プロジェクトの「デザインエディタ」を押して開く):\n${PROJECTS}` : "",
    PLAYBOOK ? `操作手順:\n${PLAYBOOK}` : "",
    "ブラウザ操作は、登録済みの Playwright の道具(playwright/browser_*)だけを使う。cua_repl など別の道具は使わない。ブラウザは、すでに、STUDIOのプロジェクト一覧が、1タブだけ開いた状態に整えてある。新しいタブは開かず、そのタブで、対象プロジェクトの「デザインエディタ」を押して開く。",
    SPEED_LINE,
    botVerifies ? BOT_VERIFY_LINE : RELOAD_LINE,
    "最後に、何をしたかと確認結果を簡潔に報告し、**最終行**に次のどれか1つだけを書く: 依頼どおり完了したなら `RESULT: OK` / 一部でも未実施・失敗なら `RESULT: FAILED` / 人の対応が必要なら `RESULT: BLOCKED`。",
  ].filter(Boolean).join("\n\n");
}

// 作業の前に、専用Chromeを毎回同じ状態に整える(古いタブを閉じる→キャッシュ消去→STUDIOの一覧を開いて待つ)。BROWSER_CHECK=0 で無効
const BROWSER_CDP = process.env.BROWSER_CDP ?? "http://localhost:9222";
const restartChrome = () => new Promise((resolve) => {
  // 固まった専用Chromeだけを終了して(ふだん使いのChromeは対象外)、起動スクリプトでもう一度開く
  spawn("pkill", ["-f", "studio-chrome-profile"]).on("close", () => {
    setTimeout(() => { spawn("bash", ["scripts/browser.sh"], { stdio: "ignore", detached: true }).unref(); resolve(); }, 2000);
  });
});
async function ensureBrowser(log = () => {}) {
  if (process.env.BROWSER_CHECK === "0") return { ok: true };
  return prepareBrowser({
    cdp: BROWSER_CDP,
    startUrl: process.env.BROWSER_START_URL ?? "https://app.studio.design/projects",
    readyText: process.env.BROWSER_READY_TEXT ?? "プロジェクト",
    autoRestart: process.env.BROWSER_AUTORESTART !== "0",
    restart: restartChrome, log,
  });
}
const BROWSER_ERR = {
  browser_down: "専用Chromeが起動していません。ターミナルで `npm run browser` を実行して、STUDIOにログインしたまま開いてください。",
  login_required: "STUDIOのログインが切れています。専用Chromeで、STUDIOにログインし直してください(ログイン後、そのまま開いておきます)。",
  not_ready: "STUDIOの画面が、40秒待っても表示されませんでした。ネットワークやSTUDIO側の状態を確認して、もう一度送ってください。",
  cdp_error: "専用Chromeとの接続に失敗しました。もう一度送ってください。続く場合は、専用Chromeを終了して `npm run browser` で開き直してください。",
};

async function handleTask(msg, t) {
  if (seenTasks.has(t.id)) return;
  seenTasks.add(t.id);
  // 公開タスク(requiresApproval か、IDに -publish- を含む)は、署名付きの公開承認がなければ実行しない
  const isPublish = t.requiresApproval === true || String(t.id).includes("-publish-");
  if ((REQUIRE_APPROVAL || isPublish) && !verifyApproval(APPROVAL_SECRET, t.inputs?.approval, t.job)) {
    await msg.channel.send(JSON.stringify({
      v: 1, type: "result", id: t.id, from: AGENT_NAME, status: "blocked",
      summary: "有効な公開承認がないため実行しません", error: "approval_invalid",
    }));
    return;
  }
  const timing = { recvAt: Date.now() }; // 段階ごとの所要時間(ms)。結果JSONに載せて、ディレクターが #log に出す
  const logCh = LOG_CHANNEL_ID ? await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null) : null;
  await logCh?.send(`🧹 [${roleLabel(AGENT_NAME)}] ブラウザを整えています(古いタブを閉じて、STUDIOの一覧を開きます)…`);
  const br = await ensureBrowser((m) => logCh?.send(`🔧 ${m}`).catch(() => {}));
  timing.guardMs = Date.now() - timing.recvAt;
  if (!br.ok) {
    await logCh?.send(`⛔ [${roleLabel(AGENT_NAME)}] 作業できません\n👉 ${BROWSER_ERR[br.code] ?? br.code}`);
    await msg.channel.send(JSON.stringify({
      v: 1, type: "result", id: t.id, from: AGENT_NAME,
      status: br.code === "browser_down" || br.code === "login_required" ? "blocked" : "failed",
      summary: BROWSER_ERR[br.code] ?? br.code, error: br.code,
    }));
    return;
  }
  await logCh?.send(`🛠️ [${roleLabel(AGENT_NAME)}] 作業を始めました: ${t.title ?? t.id}`);
  chain = chain.then(async () => {
    // 作業の様子を、数秒ごとに #log へ流す(裏で動いていても、何をしているか分かるように)
    const buf = []; let sentN = 0;
    const flush = async () => {
      if (!buf.length || !logCh) return;
      const text = compress(buf.splice(0)).join("\n").slice(0, 1900);
      if (sentN++ < 40) await logCh.send(text).catch(() => {});
    };
    const timer = setInterval(flush, 4000);
    timing.codexStartAt = Date.now();
    const botVerifies = !isPublish && (process.env.VERIFY_MODE ?? "warn") !== "off" && process.env.BROWSER_CHECK !== "0" && !!extractExpectedText(t.instructions ?? t.title ?? "");
    const r = await runCodex(buildPrompt(t, botVerifies), makeProgress((x) => buf.push(x)));
    timing.codexMs = Date.now() - timing.codexStartAt;
    clearInterval(timer);
    await flush();
    // 完了の判定: 終了コードだけでなく、Codex自身の「RESULT: OK/FAILED/BLOCKED」を見る(未実施なのに完了扱いを防ぐ)
    const lim = r.code !== 0 ? detectUsageLimit(r.text) : null;
    const mk = [...r.text.matchAll(/RESULT:\s*(OK|FAILED|BLOCKED)/gi)].pop()?.[1]?.toUpperCase();
    const status = lim ? "blocked" : r.code !== 0 ? "failed" : mk === "OK" ? "done" : mk === "BLOCKED" ? "blocked" : "failed";
    const why = lim ? "usage_limit" : r.code !== 0 ? `code=${r.code}${r.sig ? " " + r.sig : ""}` : mk ? (mk === "OK" ? null : `reported_${mk.toLowerCase()}`) : "no_result_marker";
    // Bot自身の確認: Codexが「完了」と言っても、再読み込みして、変更後の文字が本当にあるかを見る。VERIFY_MODE=off で無効 / strict で、見つからなければ失敗にする(既定: warn=警告だけ)
    let finalStatus = status, verifyNote = null;
    const VERIFY_MODE = process.env.VERIFY_MODE ?? "warn";
    const expected = isPublish ? null : extractExpectedText(t.instructions ?? t.title ?? "");
    if (status === "done" && expected && VERIFY_MODE !== "off" && process.env.BROWSER_CHECK !== "0") {
      await logCh?.send(`🔍 [${roleLabel(AGENT_NAME)}] Bot自身で、再読み込みして「${expected}」を確認しています…`).catch(() => {});
      const t0 = Date.now();
      const v = await verifyText({ cdp: BROWSER_CDP, expected });
      timing.verifyMs = Date.now() - t0;
      if (v.status === "verified") verifyNote = `Botが再読み込み後に「${expected}」を確認しました`;
      else if (v.status === "not_found") {
        verifyNote = `⚠️ ${v.detail}`;
        if (VERIFY_MODE === "strict") finalStatus = "failed";
      } else verifyNote = `(Botでの確認はできませんでした: ${v.detail})`;
      await logCh?.send(`${v.status === "verified" ? "✅" : v.status === "not_found" ? "⚠️" : "ℹ️"} ${verifyNote}`).catch(() => {});
    }
    timing.endAt = Date.now();
    const result = {
      v: 1, type: "result", id: t.id, from: AGENT_NAME, status: finalStatus,
      summary: lim ? `Codexの利用上限に達しました。再開できる時刻: ${lim.at ?? "不明"}` : r.text.replace(/RESULT:\s*(OK|FAILED|BLOCKED)/gi, "").trim().slice(0, 1500),
      error: finalStatus !== status ? "verify_failed" : why, timing,
    };
    if (verifyNote) result.summary = `${result.summary}\n${verifyNote}`.slice(0, 1500);
    await msg.channel.send(JSON.stringify(result));
    await logCh?.send(`${finalStatus === "done" ? "✅" : "❌"} [${roleLabel(AGENT_NAME)}] 作業を終えました(${finalStatus === "done" ? "完了" : finalStatus === "blocked" ? "要対応" : "失敗"}): ${t.title ?? t.id}`);
  }).catch((e) => console.error(e));
}

client.on("messageCreate", async (msg) => {
  if (TASKS_CHANNEL_ID && msg.channelId === TASKS_CHANNEL_ID) {
    // 司令塔Botの発言のみ受け付ける
    if (!msg.author.bot || msg.author.id !== ORCHESTRATOR_BOT_ID) return;
    let t;
    try { t = JSON.parse(msg.content); } catch { return; }
    if (t?.type === "task" && t.to === AGENT_NAME && t.id) await handleTask(msg, t);
    return;
  }
  if (msg.author.bot) return;
  if (!CHANNELS.has(msg.channelId)) return;
  if (!ALLOWED.has(msg.author.id)) return; // 許可ユーザー以外は無視

  const text = msg.content.trim();
  if (!text) return;

  if (text === "!stop") {
    if (current) { current.kill("SIGTERM"); return void msg.reply(`[${AGENT_NAME}] 中断しました`); }
    return void msg.reply(`[${AGENT_NAME}] 実行中のタスクはありません`);
  }
  if (text === "!ping") return void msg.reply(`[${AGENT_NAME}] online`);

  if (text === "!new") { delete sessions[msg.channelId]; saveSessions(); return void msg.reply(`[${AGENT_NAME}] 会話をリセットしました。次のメッセージから、新しい会話を始めます`); }
  if (text === "!session") return void msg.reply(sessions[msg.channelId] ? `セッション: \`${sessions[msg.channelId]}\`(\`codex resume ${sessions[msg.channelId]}\` で、Codexで続きを見られます)` : "まだ会話が始まっていません");

  // ---- チャットモード: 同じチャンネルの会話は、同じCodexセッションで続ける ----
  msg.react("👀").catch(() => {});
  chain = chain.then(async () => {
    await msg.channel.send("🧹 ブラウザを整えています…").catch(() => {});
    const br = await ensureBrowser();
    if (!br.ok) return void msg.channel.send(`⛔ ${BROWSER_ERR[br.code] ?? br.code}`);
    const buf = []; let sentN = 0;
    const flush = async () => {
      if (!buf.length) return;
      const t = compress(buf.splice(0)).join("\n").slice(0, 1900);
      if (sentN++ < 40) await msg.channel.send(t).catch(() => {});
    };
    const timer = setInterval(flush, 4000);
    const typing = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);
    msg.channel.sendTyping().catch(() => {});
    const fresh = (t) => `${CHAT_PREAMBLE}\n\nユーザー: ${t}`;
    const sid = sessions[msg.channelId];
    let said = ""; // 途中で💬として流した発言(最後の返事と重複して2回出るのを防ぐ)
    const mkProg = () => makeProgress((x) => { buf.push(x); if (x.startsWith("💬 ")) said += x.slice(3); }, { session: false });
    let r = await runCodex(sid ? text : fresh(text), mkProg(), sid);
    if (sid && r.code !== 0) { // 前の会話を引き継げなかったときは、新しく始める
      buf.push("(前の会話を引き継げなかったので、新しい会話で続けます)");
      delete sessions[msg.channelId];
      r = await runCodex(fresh(text), mkProg());
    }
    clearInterval(timer); clearInterval(typing);
    if (r.sessionId) { sessions[msg.channelId] = r.sessionId; saveSessions(); }
    await flush();
    const body = r.code === 0 ? r.text : `うまくいきませんでした(code=${r.code}${r.sig ? ", " + r.sig : ""})\n${r.text}`;
    const norm = (s) => s.replace(/\s+/g, "");
    const dup = r.code === 0 && said && norm(said).includes(norm(r.text).slice(0, 40));
    if (!dup) for (const p of chunks(body)) await msg.channel.send(p);
  }).catch((e) => console.error(e));
});

client.once("ready", () => console.log(`[${AGENT_NAME}] logged in as ${client.user.tag}`));
client.login(DISCORD_TOKEN);
