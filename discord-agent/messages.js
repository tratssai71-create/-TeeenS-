// Discordに出すメッセージの文面(分かりやすさ重視。Discord/Codexに依存しない純粋な関数)

export const ROLE_LABEL = { designer: "デザイナー", writer: "ライター", qa: "チェッカー" };
export const roleLabel = (r) => ROLE_LABEL[r] ?? r;

const ICON = { pending: "⏳", sent: "🔄", done: "✅", failed: "❌", skipped: "⏭️" };
export const statusIcon = (s) => ICON[s] ?? "•";

const oneLine = (s, n = 120) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** エラーの種類ごとに、「次に何をすればいいか」を1〜2行で返す */
// Codexの利用上限エラーかどうかを見分ける(上限のときは、やり直しても無駄なので、すぐ止める)
export function detectUsageLimit(text = "", now = Date.now()) {
  if (!/hit your usage limit|usage limit/i.test(text)) return null;
  const at = text.match(/try again at ([^.\n]*?\d{1,2}:\d{2}\s*[AP]M)/i)?.[1] ?? null;
  return { at, atMs: parseResetTime(at, now) };
}

/** "Nov 25th, 2026 2:21 AM" や "3:38 PM"(今日。過ぎていれば明日)を、時刻(ms)にする。読めなければ null */
export function parseResetTime(str, now = Date.now()) {
  if (!str) return null;
  const s = str.replace(/(\d)(st|nd|rd|th)\b/i, "$1").trim();
  const time = s.match(/(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!time) return null;
  if (/[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4}/.test(s)) { const t = new Date(s).getTime(); return Number.isNaN(t) ? null : t; }
  let h = Number(time[1]) % 12; if (/pm/i.test(time[3])) h += 12;
  const d = new Date(now); d.setHours(h, Number(time[2]), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 時刻(ms)を、「11/25 15:38」のように見せる */
export const fmtTime = (ms) => new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function hintFor(error, summary = "") {
  switch (error) {
    case "usage_limit": {
      const at = summary.match(/再開できる時刻: (.+)/)?.[1];
      return `Codex(ChatGPT)の利用上限です。やり直しても失敗するため、止めました。${at ? `${at} 以降に、もう一度依頼してください。` : "上限が解除されてから、もう一度依頼してください。"}プランやクレジットは、chatgpt.com/settings/usage で確認できます。`;
    }
    case "browser_down":
      return "専用Chromeが閉じています。ターミナルで `npm run browser` を実行して、STUDIOにログインしたまま開いてください。そのあと、もう一度依頼してください。";
    case "approval_invalid":
      return "公開の承認が確認できませんでした。#approve の「公開する」を、もう一度押してください(承認は1時間で期限切れになります)。";
    case "login_required":
      return "STUDIOのログインが切れています。専用Chromeで、STUDIOにログインし直してください。";
    case "not_ready":
    case "cdp_error":
      return "STUDIOの画面の準備に失敗しました(自動でやり直します)。続くときは、専用Chromeを終了して `npm run browser` で開き直してください。";
    case "verify_failed":
      return "Codexは完了と報告しましたが、Botが再読み込みして確認したところ、変更後の文字が見つかりませんでした(保存されていない可能性があります。自動でやり直します)。";
    case "no_result_marker":
      return "Codexの報告が不完全でした(自動でやり直します)。";
    case "reported_failed":
      return "Codexが、依頼を完了できなかったと報告しました。内容を確認して、依頼を言い換えるか、もう少し細かく分けてください。";
    case "reported_blocked":
      return "人の対応が必要です。報告の内容を確認してください(ログイン切れ、想定外の画面など)。";
    default:
      if (/タイムアウト|無応答/.test(summary)) return "ワーカー(デザイナー)が応答しませんでした。Botのターミナルが動いているか確認してください。";
      return "";
  }
}

export function formatPlan(job) {
  const steps = job.tasks.map((t, i) => {
    const acc = t.acceptance?.length ? `\n   ✔ ${t.acceptance.map((a) => oneLine(a, 60)).join(" / ")}` : "";
    const dep = t.deps?.length ? `(「${t.deps.join("」「")}」のあと)` : "";
    return `${i + 1}. **${roleLabel(t.to)}** — ${oneLine(t.title, 70)} ${dep}${acc}`;
  });
  return [
    `📋 **[${job.id}] 計画案**`,
    `依頼: ${oneLine(job.request, 100)}`,
    "",
    ...steps,
    "",
    "内容を確認して、「実行」か「却下」を押してください。",
  ].join("\n");
}

export function formatDone(job) {
  const failed = job.tasks.filter((t) => t.status !== "done");
  const lines = job.tasks.map((t) => `${statusIcon(t.status)} ${oneLine(t.title, 50)} — ${oneLine(t.summary, 110)}`);
  const hints = [...new Set(failed.map((t) => hintFor(t.error, t.summary)).filter(Boolean))];
  return [
    failed.length ? `❌ **[${job.id}] うまくいきませんでした**(公開は行っていません)` : `✅ **[${job.id}] 完了しました**`,
    ...lines,
    ...(hints.length ? ["", "👉 次にやること:", ...hints.map((h) => `・${h}`)] : []),
  ].join("\n");
}

export function formatApproval(job) {
  const lines = job.tasks.map((t) => `• ${oneLine(t.title, 50)} — ${oneLine(t.summary, 140)}`);
  return [
    `🔔 **[${job.id}] 公開の承認をお願いします**`,
    `依頼: ${oneLine(job.request, 100)}`,
    "",
    "やったこと:",
    ...lines,
    "",
    "⚠️ 「公開する」を押すと、**本番のサイトに反映**されます。専用Chromeの画面で、変更内容を確認してから押してください。",
  ].join("\n");
}

/** 1件の作業の、段階ごとの秒数(ms)。無い段階は null */
export function stageTimes(job, t) {
  const m = t.timing; if (!m) return null;
  const start = job.receivedAt ?? job.createdAt;
  return {
    受付送信: t.sentAt - start, 受信: m.recvAt - t.sentAt, ブラウザ整備: m.guardMs, 先開き: m.preopenMs,
    Codex: m.codexMs, Bot確認: m.verifyMs, 集約: t.doneAt - m.endAt, 合計: t.doneAt - start,
  };
}

/** !report 用: 今日の件数・成功率・段階ごとの平均秒数 */
export function buildReport(jobs, now = Date.now()) {
  const day = (ms) => new Date(ms).toDateString();
  const today = Object.values(jobs).filter((j) => (j.receivedAt ?? j.createdAt) && day(j.receivedAt ?? j.createdAt) === day(now));
  if (!today.length) return "今日の依頼は、まだありません";
  const done = today.filter((j) => j.tasks.every((t) => t.status === "done")).length;
  const fail = today.filter((j) => j.status === "failed").length;
  const rows = []; // 成功した作業の、段階ごとの時間
  for (const j of today) for (const t of j.tasks) if (t.status === "done" && t.to !== "publisher") { const s = stageTimes(j, t); if (s) rows.push(s); }
  const avg = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null && !Number.isNaN(x)); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length / 1000).toFixed(1) + "秒" : null; };
  const keys = ["ブラウザ整備", "先開き", "Codex", "Bot確認", "集約", "合計"];
  const lines = [`📊 **今日のレポート**: 依頼 ${today.length}件 / 作業完了 ${done}件 / 失敗 ${fail}件(成功率 ${Math.round((done / today.length) * 100)}%)`];
  if (rows.length) {
    lines.push(`平均(成功 ${rows.length}件): ` + keys.map((k) => (avg(k) ? `${k} ${avg(k)}` : null)).filter(Boolean).join(" / "));
    const stages = keys.filter((k) => k !== "合計").map((k) => [k, Number(String(avg(k)).replace("秒", ""))]).filter(([, v]) => !Number.isNaN(v)).sort((a, b) => b[1] - a[1]);
    if (stages.length) lines.push(`最長の段階: ${stages[0][0]}(${stages[0][1]}秒)`);
    const best = rows.map((r) => r["合計"]).filter((x) => x != null).sort((a, b) => a - b)[0];
    if (best != null) lines.push(`最速: ${(best / 1000).toFixed(1)}秒`);
  }
  return lines.join("\n");
}
