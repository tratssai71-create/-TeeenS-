import { Client, GatewayIntentBits } from "discord.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyApproval } from "./core.js";
import { roleLabel } from "./messages.js";
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
  "ブラウザ操作は、登録済みの Playwright の道具(playwright/browser_*)だけを使う。cua_repl など別の道具は使わない。",
  "このチャットでは、公開は行わない(右上の「公開」ボタンは押さない)。公開が必要なときは、#command で依頼して、承認ボタンを使うよう案内する。",
  "**必須(編集を伴う作業)**: 完了を報告する前に、必ず、ページを再読み込み(同じURLを開き直す)して、変更が保存されていることを確かめる。報告には「再読み込み後に、○○と表示されていた」と、確認した内容を書く。再読み込みで確認できなかったら、完了にせず、`RESULT: FAILED` と書く。",
  "作業のあとは、何をしたかを1〜3行で報告する。分からないことは、推測で進めず、質問する。",
].filter(Boolean).join("\n\n");

// チャンネルごとの会話セッションを覚えておく(再起動しても続けられる)
const SESSIONS_FILE = process.env.CHAT_SESSIONS_FILE ?? "chat-sessions.json";
let sessions = {};
try { sessions = JSON.parse(readIf(SESSIONS_FILE) || "{}"); } catch {}
const saveSessions = () => { try { writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch {} };

function buildPrompt(t) {
  const acc = (t.acceptance ?? []).map((a) => `- ${a}`).join("\n");
  return [
    `タスク: ${t.title ?? t.id}`,
    t.instructions ?? "",
    t.inputs ? `入力: ${JSON.stringify(t.inputs)}` : "",
    acc ? `受け入れ基準:\n${acc}` : "",
    PROJECTS ? `STUDIOのプロジェクト(編集画面は、直接URLではなく、必ず https://app.studio.design/projects の一覧から、該当プロジェクトの「デザインエディタ」を押して開く):\n${PROJECTS}` : "",
    PLAYBOOK ? `操作手順:\n${PLAYBOOK}` : "",
    "ブラウザ操作は、登録済みの Playwright の道具(playwright/browser_*)だけを使う。cua_repl など別の道具は使わない。",
    "**必須(編集を伴う作業)**: 完了を報告する前に、必ず、ページを再読み込み(同じURLを開き直す)して、変更が保存されていることを確かめる。報告には「再読み込み後に、○○と表示されていた」と、確認した内容を書く。再読み込みで確認できなかったら、完了にせず、`RESULT: FAILED` と書く。",
    "最後に、何をしたかと確認結果を簡潔に報告し、**最終行**に次のどれか1つだけを書く: 依頼どおり完了したなら `RESULT: OK` / 一部でも未実施・失敗なら `RESULT: FAILED` / 人の対応が必要なら `RESULT: BLOCKED`。",
  ].filter(Boolean).join("\n\n");
}

// 専用Chrome(ブラウザ操作の接続先)が起動しているか確認する。BROWSER_CHECK=0 で無効
const BROWSER_CDP = process.env.BROWSER_CDP ?? "http://localhost:9222";
async function browserUp() {
  if (process.env.BROWSER_CHECK === "0") return true;
  try { return (await fetch(`${BROWSER_CDP}/json/version`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}

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
  const logCh = LOG_CHANNEL_ID ? await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null) : null;
  if (!(await browserUp())) {
    await logCh?.send(`⛔ [${roleLabel(AGENT_NAME)}] 作業できません: 専用Chromeが閉じています\n👉 ターミナルで \`npm run browser\` を実行して、STUDIOにログインしたまま開いてください`);
    await msg.channel.send(JSON.stringify({
      v: 1, type: "result", id: t.id, from: AGENT_NAME, status: "blocked",
      summary: "専用Chrome(ブラウザ操作の接続先)が起動していません", error: "browser_down",
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
    const r = await runCodex(buildPrompt(t), makeProgress((x) => buf.push(x)));
    clearInterval(timer);
    await flush();
    // 完了の判定: 終了コードだけでなく、Codex自身の「RESULT: OK/FAILED/BLOCKED」を見る(未実施なのに完了扱いを防ぐ)
    const mk = [...r.text.matchAll(/RESULT:\s*(OK|FAILED|BLOCKED)/gi)].pop()?.[1]?.toUpperCase();
    const status = r.code !== 0 ? "failed" : mk === "OK" ? "done" : mk === "BLOCKED" ? "blocked" : "failed";
    const why = r.code !== 0 ? `code=${r.code}${r.sig ? " " + r.sig : ""}` : mk ? (mk === "OK" ? null : `reported_${mk.toLowerCase()}`) : "no_result_marker";
    const result = {
      v: 1, type: "result", id: t.id, from: AGENT_NAME, status,
      summary: r.text.replace(/RESULT:\s*(OK|FAILED|BLOCKED)/gi, "").trim().slice(0, 1500),
      error: why,
    };
    await msg.channel.send(JSON.stringify(result));
    await logCh?.send(`${status === "done" ? "✅" : "❌"} [${roleLabel(AGENT_NAME)}] 作業を終えました(${status === "done" ? "完了" : status === "blocked" ? "要対応" : "失敗"}): ${t.title ?? t.id}`);
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
    if (!(await browserUp())) {
      return void msg.channel.send(`専用Chromeが起動していません。ターミナルで \`npm run browser\` を実行して、STUDIOにログインしたまま開いておいてください`);
    }
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
