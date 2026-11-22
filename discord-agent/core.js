// 司令塔の純粋ロジック(Discord/Codexに依存しない。テスト可能)
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_MSG = 1900; // Discord 2000文字制限に余裕を持たせる

/** プランのJSON文字列(コードフェンス混じり可)を取り出す */
export function extractJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (m ? m[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("JSONが見つかりません");
  return JSON.parse(raw.slice(start, end + 1));
}

/** プランを検証し、正規化したタスク配列を返す。不正なら Error */
export function validatePlan(plan, { roles, maxTasks }) {
  const tasks = plan?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("tasks が空です");
  if (tasks.length > maxTasks) throw new Error(`タスク数が上限(${maxTasks})を超えています`);
  const keys = new Set();
  for (const t of tasks) {
    if (!t.key || keys.has(t.key)) throw new Error(`key が不正/重複: ${t.key}`);
    keys.add(t.key);
    if (!roles.includes(t.to)) throw new Error(`未知のロール: ${t.to}`);
    if (!t.title || !t.instructions) throw new Error(`${t.key}: title/instructions が必要`);
    if (t.instructions.length > 1000) throw new Error(`${t.key}: instructions が長すぎます(1000字以内)`);
  }
  for (const t of tasks) {
    t.deps = t.deps ?? [];
    t.acceptance = t.acceptance ?? [];
    for (const d of t.deps) if (!keys.has(d)) throw new Error(`${t.key}: 未知の依存 ${d}`);
  }
  // 循環検出(Kahn法)
  const indeg = new Map(tasks.map((t) => [t.key, t.deps.length]));
  const queue = tasks.filter((t) => t.deps.length === 0).map((t) => t.key);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift(); seen++;
    for (const t of tasks) if (t.deps.includes(k)) {
      indeg.set(t.key, indeg.get(t.key) - 1);
      if (indeg.get(t.key) === 0) queue.push(t.key);
    }
  }
  if (seen !== tasks.length) throw new Error("依存関係が循環しています");
  return tasks.map((t) => ({
    key: t.key, to: t.to, title: t.title, instructions: t.instructions,
    acceptance: t.acceptance, deps: t.deps,
    status: "pending", attempt: 0, sentId: null, sentAt: null, summary: null,
  }));
}

/** 今送れるタスク: 依存が全て done、pending、かつ同ロールが実行中でない */
export function readyTasks(job) {
  const done = new Set(job.tasks.filter((t) => t.status === "done").map((t) => t.key));
  const busy = new Set(job.tasks.filter((t) => t.status === "sent").map((t) => t.to));
  const out = [];
  for (const t of job.tasks) {
    if (t.status !== "pending") continue;
    if (!t.deps.every((d) => done.has(d))) continue;
    if (busy.has(t.to)) continue; // ロールごとに直列
    busy.add(t.to);
    out.push(t);
  }
  return out;
}

/** ワーカーへ送るメッセージ文字列。長すぎる場合は前段サマリを削る */
export function buildTaskMessage(job, task, timeoutMin) {
  const prev = task.deps.map((d) => {
    const x = job.tasks.find((t) => t.key === d);
    return { key: d, summary: (x?.summary ?? "").slice(0, 300) };
  });
  const make = (p) => JSON.stringify({
    v: 1, type: "task", id: task.sentId, job: job.id, to: task.to,
    requiresApproval: task.requiresApproval ? true : undefined,
    title: task.title, instructions: task.instructions, acceptance: task.acceptance,
    inputs: (p.length || task.requiresApproval)
      ? { previous: p.length ? p : undefined, approval: task.requiresApproval ? job.approval : undefined }
      : undefined,
    timeoutMin, attempt: task.attempt,
  });
  let msg = make(prev);
  for (const n of [150, 60, 0]) {
    if (msg.length <= MAX_MSG) break;
    msg = make(prev.map((p) => ({ ...p, summary: p.summary.slice(0, n) })));
  }
  if (msg.length > MAX_MSG) throw new Error(`${task.key}: タスクJSONが長すぎます`);
  return msg;
}

export const jobFinished = (job) =>
  job.tasks.every((t) => t.status === "done" || t.status === "failed" || t.status === "skipped");

// ---------- 公開承認トークン(司令塔が署名、publisherが検証) ----------
const mac = (secret, job, by, at) =>
  createHmac("sha256", secret).update(`${job}|${by}|${at}`).digest("hex");

export function signApproval(secret, job, by, at = Date.now()) {
  return { job, by, at, sig: mac(secret, job, by, at) };
}

/** 署名・ジョブ一致・有効期限(ttlMs)を検証。OKなら true */
export function verifyApproval(secret, a, expectedJob, ttlMs = 60 * 60_000, now = Date.now()) {
  if (!secret || !a || typeof a.sig !== "string") return false;
  if (a.job !== expectedJob) return false;
  if (!(now - a.at >= 0 && now - a.at <= ttlMs)) return false;
  const want = Buffer.from(mac(secret, a.job, a.by, a.at));
  const got = Buffer.from(a.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** !quick: 計画づくりを省いて、依頼文をそのまま1タスクにする */
export function quickPlan(request, role) {
  const text = request.replace(/^!quick\s*/, "").trim();
  if (!text) throw new Error("!quick のあとに依頼を書いてください");
  return validatePlan({ tasks: [{
    key: "t1", to: role, title: text.slice(0, 40), instructions: text.slice(0, 1000),
    acceptance: ["依頼どおりに完了している"], deps: [],
  }] }, { roles: [role], maxTasks: 1 });
}
