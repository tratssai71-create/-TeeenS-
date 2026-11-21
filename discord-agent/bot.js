import { Client, GatewayIntentBits } from "discord.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const {
  AGENT_NAME = "agent", DISCORD_TOKEN, WORKDIR = process.cwd(),
  CODEX_ARGS = "--sandbox workspace-write --skip-git-repo-check",
  TIMEOUT_MIN = "30",
} = process.env;
const CHANNELS = new Set(list(process.env.CHANNEL_IDS));
const ALLOWED = new Set(list(process.env.ALLOWED_USER_IDS));

if (!DISCORD_TOKEN || !CHANNELS.size || !ALLOWED.size) {
  console.error("DISCORD_TOKEN / CHANNEL_IDS / ALLOWED_USER_IDS を .env に設定してください");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Developer Portal で有効化が必要
  ],
});

let current = null;      // 実行中の子プロセス
let chain = Promise.resolve(); // タスクは1件ずつ直列実行

function runCodex(prompt) {
  return new Promise(async (resolve) => {
    const dir = await mkdtemp(join(tmpdir(), "codex-"));
    const outFile = join(dir, "last.txt");
    const args = ["exec", ...CODEX_ARGS.split(/\s+/).filter(Boolean),
      "-C", WORKDIR, "--output-last-message", outFile, prompt];
    const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });
    current = child;
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), Number(TIMEOUT_MIN) * 60_000);
    child.on("close", async (code, sig) => {
      clearTimeout(timer);
      current = null;
      let last = "";
      try { last = (await readFile(outFile, "utf8")).trim(); } catch {}
      await rm(dir, { recursive: true, force: true });
      resolve({ code, sig, text: last || log.trim().slice(-1500) || "(出力なし)" });
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

client.on("messageCreate", async (msg) => {
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

  await msg.reply(`[${AGENT_NAME}] 受付: キューに追加しました`);
  chain = chain.then(async () => {
    await msg.channel.send(`[${AGENT_NAME}] 作業開始`);
    const r = await runCodex(text);
    const status = r.code === 0 ? "完了" : `終了(code=${r.code}${r.sig ? ", " + r.sig : ""})`;
    const parts = chunks(`[${AGENT_NAME}] ${status}\n${r.text}`);
    for (const p of parts) await msg.channel.send(p);
  }).catch((e) => console.error(e));
});

client.once("ready", () => console.log(`[${AGENT_NAME}] logged in as ${client.user.tag}`));
client.login(DISCORD_TOKEN);
