// Discordに出すメッセージの文面(分かりやすさ重視。Discord/Codexに依存しない純粋な関数)

export const ROLE_LABEL = { designer: "デザイナー", writer: "ライター", qa: "チェッカー" };
export const roleLabel = (r) => ROLE_LABEL[r] ?? r;

const ICON = { pending: "⏳", sent: "🔄", done: "✅", failed: "❌", skipped: "⏭️" };
export const statusIcon = (s) => ICON[s] ?? "•";

const oneLine = (s, n = 120) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** エラーの種類ごとに、「次に何をすればいいか」を1〜2行で返す */
// Codexの利用上限エラーかどうかを見分ける(上限のときは、やり直しても無駄なので、すぐ止める)
export function detectUsageLimit(text = "") {
  if (!/hit your usage limit|usage limit/i.test(text)) return null;
  const at = text.match(/try again at ([^.\n]*?\d{1,2}:\d{2}\s*[AP]M)/i)?.[1] ?? null;
  return { at };
}

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
