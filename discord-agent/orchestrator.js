import {
  Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson, validatePlan, readyTasks, buildTaskMessage, jobFinished, signApproval } from "./core.js";

const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const env = process.env;
const ROLES = list(env.ROLES ?? "designer,writer,qa");
const ALLOWED = new Set(list(env.ALLOWED_USER_IDS));
const WORKERS = new Set(list(env.WORKER_BOT_IDS)); // 結果を受け付けるワーカーBot
const MAX_TASKS = Number(env.MAX_TASKS ?? 8);
const MAX_RETRY = Number(env.MAX_RETRY ?? 2);
const TASK_TIMEOUT_MIN = Number(env.TASK_TIMEOUT_MIN ?? 30);
const MAX_JOBS_PER_DAY = Number(env.MAX_JOBS_PER_DAY ?? 20);
const STATE_FILE = env.STATE_FILE ?? "state.json";
const WORKDIR = env.WORKDIR ?? process.cwd();
const PLANNER_ARGS = (env.PLANNER_ARGS ?? "--sandbox read-only --skip-git-repo-check").split(/\s+/).filter(Boolean);
const { DISCORD_TOKEN, COMMAND_CHANNEL_ID, TASKS_CHANNEL_ID, LOG_CHANNEL_ID, APPROVE_CHANNEL_ID, APPROVAL_SECRET } = env;
const PUBLISHER_ROLE = env.PUBLISHER_ROLE ?? "publisher";
const PUBLISH_INSTRUCTIONS = env.PUBLISH_INSTRUCTIONS ??
  "STUDIOエディタで、承認済みの変更を本番に公開する操作だけを行う。公開後に公開URLを開いて表示を確認し、URLを報告する。公開以外の編集は一切しない。想定外の画面や確認ダイアログが出たら公開せず blocked として報告する。";

for (const [k, v] of Object.entries({ DISCORD_TOKEN, COMMAND_CHANNEL_ID, TASKS_CHANNEL_ID, LOG_CHANNEL_ID, APPROVE_CHANNEL_ID, APPROVAL_SECRET })) {
  if (!v) { console.error(`${k} が未設定です`); process.exit(1); }
}
if (!ALLOWED.size || !WORKERS.size) { console.error("ALLOWED_USER_IDS / WORKER_BOT_IDS を設定してください"); process.exit(1); }

// ---------- 状態 ----------
let state = { seq: 0, halted: false, day: "", jobsToday: 0, jobs: {} };
if (existsSync(STATE_FILE)) state = JSON.parse(await readFile(STATE_FILE, "utf8"));
const save = () => writeFile(STATE_FILE, JSON.stringify(state, null, 2));

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message ?? e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message ?? e));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const ch = (id) => client.channels.fetch(id);
const log = async (text) => { try { const c = await ch(LOG_CHANNEL_ID); for (let i = 0; i < text.length; i += 1900) await c.send(text.slice(i, i + 1900)); } catch (e) { console.error(e); } };

// ---------- プランナー(codex exec) ----------
function runPlanner(prompt) {
  return new Promise(async (resolve, reject) => {
    const dir = await mkdtemp(join(tmpdir(), "plan-"));
    const out = join(dir, "last.txt");
    const child = spawn("codex", ["exec", ...PLANNER_ARGS, "-C", WORKDIR, "--output-last-message", out, "-"],
      { stdio: ["pipe", "ignore", "pipe"], shell: process.platform === "win32" });
    child.stdin.end(prompt);
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(timer);
      try { resolve(await readFile(out, "utf8")); } catch { reject(new Error(`planner失敗 code=${code} ${err.slice(-300)}`)); }
      finally { rm(dir, { recursive: true, force: true }); }
    });
  });
}

const ROLE_DESC = {
  designer: "STUDIOエディタ(ブラウザ操作)での編集。文言・素材の用意や、完成後の見た目の確認(スクリーンショット)も兼ねる。同時に1タスクのみ。",
  writer: "文言・記事・SEO文・素材の用意(STUDIOは触らない)。",
  qa: "完成したページのスクリーンショット確認、リンク切れ、レスポンシブ、文言チェック(読み取りのみ)。",
};
const plannerPrompt = (request) => `あなたはWebサイト制作チームの司令塔です。次の依頼を、担当ロールごとのタスクに分解してください。

使えるロール(これ以外の名前は絶対に使わない): ${ROLES.join(", ")}
${ROLES.map((r) => `- ${r}: ${ROLE_DESC[r] ?? "担当作業"}`).join("\n")}
制約: タスクは最大${MAX_TASKS}件。各 instructions は具体的に1000字以内。小さな依頼は1〜2タスクで足りる。${ROLES.includes("qa") ? "最後に必ずqaの検証タスクを置く。" : ""}
出力は次の形式のJSONのみ(説明文は不要):
{"tasks":[{"key":"短い英数字ID","to":"ロール","title":"件名","instructions":"具体的な作業指示","acceptance":["受け入れ基準"],"deps":["先行タスクのkey"]}]}

依頼:
${request}`;

// ---------- ジョブ進行 ----------
async function createJob(request, replyTo) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) { state.day = today; state.jobsToday = 0; }
  if (state.jobsToday >= MAX_JOBS_PER_DAY) return replyTo.reply("本日のジョブ上限に達しました");
  if (state.halted) return replyTo.reply("停止中です(`!resume` で再開)");
  state.jobsToday++;
  const id = `j${++state.seq}`;
  await replyTo.reply(`[${id}] 受付。計画を作成中…`);
  try {
    const plan = extractJson(await runPlanner(plannerPrompt(request)));
    const tasks = validatePlan(plan, { roles: ROLES, maxTasks: MAX_TASKS });
    state.jobs[id] = { id, request, status: "awaiting_plan_approval", tasks, createdAt: Date.now() };
    await save();
    const lines = tasks.map((t) => `• \`${t.key}\` [${t.to}] ${t.title}${t.deps.length ? ` (← ${t.deps.join(", ")})` : ""}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`plan:ok:${id}`).setLabel("実行").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`plan:ng:${id}`).setLabel("却下").setStyle(ButtonStyle.Danger),
    );
    await replyTo.channel.send({ content: `[${id}] 計画案:\n${lines.join("\n")}`.slice(0, 1900), components: [row] });
  } catch (e) {
    await save();
    await replyTo.channel.send(`[${id}] 計画の作成に失敗: ${e.message}`);
  }
}

async function dispatch(job) {
  if (state.halted || job.status !== "running") return;
  const tc = await ch(TASKS_CHANNEL_ID);
  for (const t of readyTasks(job)) {
    t.attempt++;
    t.sentId = `${job.id}-${t.key}-a${t.attempt}`;
    t.status = "sent"; t.sentAt = Date.now();
    try {
      await tc.send(buildTaskMessage(job, t, TASK_TIMEOUT_MIN));
    } catch (e) {
      t.attempt--; t.status = "pending"; t.sentId = null;
      await save();
      const hint = e.code === 50001 || e.code === 50013 ? "権限がありません。#tasks で、ディレクターに「チャンネルを見る」「メッセージを送信」を許可してください" : e.message;
      await log(`[${job.id}] ${t.to} への送信に失敗: ${hint}。直したら \`!resume\` で再開`);
      state.halted = true; await save();
      return;
    }
    await log(`[${job.id}] → ${t.to}: ${t.key} (${t.title})`);
  }
  await save();
  await maybeFinish(job);
}

async function maybeFinish(job) {
  if (job.status !== "running") return;
  // 失敗したタスクに依存する未実行タスクは skipped
  for (const t of job.tasks) if (t.status === "pending") {
    const bad = t.deps.some((d) => ["failed", "skipped"].includes(job.tasks.find((x) => x.key === d).status));
    if (bad) t.status = "skipped";
  }
  if (!jobFinished(job)) return;
  const failed = job.tasks.filter((t) => t.status !== "done");
  if (!failed.length && !job.approval) return awaitApproval(job); // 公開前に必ず人の承認
  job.status = failed.length ? "failed" : "completed";
  await save();
  const body = job.tasks.map((t) => `• \`${t.key}\` ${t.status}: ${(t.summary ?? "").slice(0, 150)}`).join("\n");
  const c = await ch(COMMAND_CHANNEL_ID);
  await c.send(`[${job.id}] ${failed.length ? "一部失敗で終了(公開は未実施または要確認)" : "完了・公開済み"}\n${body}`.slice(0, 1900));
}

async function awaitApproval(job) {
  job.status = "awaiting_approval";
  await save();
  const body = job.tasks.map((t) => `• \`${t.key}\` [${t.to}] ${(t.summary ?? "").slice(0, 200)}`).join("\n");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pub:ok:${job.id}`).setLabel("公開する").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pub:ng:${job.id}`).setLabel("公開しない").setStyle(ButtonStyle.Danger),
  );
  const c = await ch(APPROVE_CHANNEL_ID);
  await c.send({ content: `[${job.id}] 公開の承認待ち\n依頼: ${job.request.slice(0, 200)}\n${body}`.slice(0, 1900), components: [row] });
  await log(`[${job.id}] 作業完了。#approve で公開の承認待ち`);
}

async function onResult(r) {
  const job = state.jobs[r.job] ?? Object.values(state.jobs).find((j) => j.tasks.some((t) => t.sentId === r.id));
  const task = job?.tasks.find((t) => t.sentId === r.id && t.status === "sent");
  if (!task) return; // 古い/重複した結果は無視
  task.summary = r.summary ?? "";
  if (r.status === "done") task.status = "done";
  else if (r.status === "blocked") { task.status = "failed"; await log(`[${job.id}] ${task.key} が blocked: ${task.summary.slice(0, 300)} → 人の対応が必要`); }
  else if (task.attempt <= MAX_RETRY) { task.status = "pending"; await log(`[${job.id}] ${task.key} 失敗、再試行 (${task.attempt}/${MAX_RETRY})`); }
  else task.status = "failed";
  await save();
  await dispatch(job);
}

// 応答のないタスクを検知
setInterval(async () => {
  for (const job of Object.values(state.jobs)) {
    if (job.status !== "running") continue;
    let changed = false;
    for (const t of job.tasks) if (t.status === "sent" && Date.now() - t.sentAt > (TASK_TIMEOUT_MIN + 5) * 60_000) {
      t.summary = "タイムアウト(ワーカー無応答)";
      t.status = t.attempt <= MAX_RETRY ? "pending" : "failed"; changed = true;
      await log(`[${job.id}] ${t.key} 無応答 → ${t.status}`);
    }
    if (changed) { await save(); await dispatch(job); }
  }
}, 60_000);

// ---------- Discord入口 ----------
client.on("messageCreate", async (msg) => {
  if (msg.author.id === client.user.id) return;
  if (msg.channelId === TASKS_CHANNEL_ID) {
    if (!msg.author.bot || !WORKERS.has(msg.author.id)) return;
    try { const r = JSON.parse(msg.content); if (r?.type === "result") await onResult(r); } catch {}
    return;
  }
  if (msg.channelId !== COMMAND_CHANNEL_ID || msg.author.bot || !ALLOWED.has(msg.author.id)) return;
  const text = msg.content.trim();
  if (text === "!halt") { state.halted = true; await save(); return void msg.reply("停止しました。新規の割り当てを止めます(実行中タスクは各ワーカーで `!stop` )"); }
  if (text === "!resume") { state.halted = false; await save(); for (const j of Object.values(state.jobs)) await dispatch(j); return void msg.reply("再開しました"); }
  if (text === "!status") {
    const rows = Object.values(state.jobs).slice(-5).map((j) => `${j.id}: ${j.status} (${j.tasks.filter((t) => t.status === "done").length}/${j.tasks.length})`);
    return void msg.reply(rows.join("\n") || "ジョブなし");
  }
  if (text) await createJob(text, msg);
});

client.on("interactionCreate", async (i) => {
  if (i.isButton() && i.customId.startsWith("pub:")) return onPublishButton(i);
  if (!i.isButton() || !i.customId.startsWith("plan:")) return;
  if (!ALLOWED.has(i.user.id)) return void i.reply({ content: "権限がありません", ephemeral: true });
  const [, act, id] = i.customId.split(":");
  const job = state.jobs[id];
  if (!job || job.status !== "awaiting_plan_approval") return void i.reply({ content: "この計画は処理済みです", ephemeral: true });
  if (act === "ok") {
    job.status = "running"; await save();
    await i.update({ content: `${i.message.content}\n\n✅ 実行開始`, components: [] });
    await dispatch(job);
  } else {
    job.status = "rejected"; await save();
    await i.update({ content: `${i.message.content}\n\n❌ 却下`, components: [] });
  }
});

async function onPublishButton(i) {
  if (!ALLOWED.has(i.user.id)) return void i.reply({ content: "権限がありません", ephemeral: true });
  const [, act, id] = i.customId.split(":");
  const job = state.jobs[id];
  if (!job || job.status !== "awaiting_approval") return void i.reply({ content: "この承認は処理済みです", ephemeral: true });
  if (act === "ng") {
    job.status = "rejected"; await save();
    await i.update({ content: `${i.message.content}\n\n❌ 公開しない(${i.user.username})`, components: [] });
    return void log(`[${id}] 公開見送り。修正する場合は #command に新しい依頼として書いてください(例: 「${id} のヒーロー画像をやり直して」)`);
  }
  // 承認 → 署名付きトークンを発行し、publisherタスクを追加
  job.approval = signApproval(APPROVAL_SECRET, job.id, i.user.id);
  job.tasks.push({
    key: "publish", to: PUBLISHER_ROLE, title: "本番公開", instructions: PUBLISH_INSTRUCTIONS,
    acceptance: ["公開URLが開け、変更が反映されている"],
    deps: job.tasks.map((t) => t.key), requiresApproval: true,
    status: "pending", attempt: 0, sentId: null, sentAt: null, summary: null,
  });
  job.status = "running"; await save();
  await i.update({ content: `${i.message.content}\n\n✅ 公開を承認(${i.user.username})`, components: [] });
  await log(`[${id}] 公開承認 by ${i.user.username}`);
  await dispatch(job);
}

client.once("ready", async () => {
  console.log(`orchestrator logged in as ${client.user.tag}`);
  for (const j of Object.values(state.jobs)) if (j.status === "running") await dispatch(j); // 再起動復帰
});
client.login(DISCORD_TOKEN);
