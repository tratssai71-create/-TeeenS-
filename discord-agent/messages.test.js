import test from "node:test";
import assert from "node:assert/strict";
import { formatPlan, formatDone, formatApproval, hintFor, roleLabel, detectUsageLimit, parseResetTime, fmtTime } from "./messages.js";

const job = (tasks, extra = {}) => ({ id: "j9", request: "見出しを変えて", tasks, ...extra });
const t = (o = {}) => ({ key: "a", to: "designer", title: "見出しを変更", deps: [], acceptance: ["見出しが変わる"], status: "done", summary: "変更しました", ...o });

test("役割名が日本語になる", () => { assert.equal(roleLabel("designer"), "デザイナー"); assert.equal(roleLabel("x"), "x"); });

test("計画案: 番号・役割・確認事項・案内が入る", () => {
  const s = formatPlan(job([t(), t({ key: "b", title: "確認", deps: ["a"], acceptance: [] })]));
  assert.match(s, /\[j9\] 計画案/); assert.match(s, /1\. \*\*デザイナー\*\* — 見出しを変更/);
  assert.match(s, /✔ 見出しが変わる/); assert.match(s, /「a」のあと/); assert.match(s, /「実行」か「却下」/);
});

test("完了: 成功と失敗で見出しと次の手順が変わる", () => {
  assert.match(formatDone(job([t()])), /✅ \*\*\[j9\] 完了しました/);
  const f = formatDone(job([t({ status: "failed", error: "browser_down", summary: "" })]));
  assert.match(f, /❌/); assert.match(f, /npm run browser/); assert.match(f, /公開は行っていません/);
});

test("承認画面: 本番に反映される旨の注意が入る", () => {
  const s = formatApproval(job([t()]));
  assert.match(s, /公開の承認をお願いします/); assert.match(s, /本番のサイトに反映/); assert.match(s, /変更しました/);
});

test("hintFor: 種類ごとの案内", () => {
  assert.match(hintFor("approval_invalid"), /もう一度/); assert.match(hintFor("reported_blocked"), /人の対応/);
  assert.match(hintFor(null, "タイムアウト(ワーカー無応答)"), /Bot/); assert.equal(hintFor(null, "ok"), "");
});

test("長い文は、1行に切り詰める", () => {
  const s = formatDone(job([t({ summary: "あ".repeat(500) + "\n改行" })]));
  assert.ok(!s.includes("\n改行")); assert.ok(s.length < 400);
});

test("detectUsageLimit: Codexの上限エラーを見分けて、再開時刻を取り出す", () => {
  const t = "ERROR: You've hit your usage limit. Upgrade to Pro or try again at Nov 25th, 2026 2:21 AM.";
  assert.equal(detectUsageLimit(t).at, "Nov 25th, 2026 2:21 AM");
  assert.equal(detectUsageLimit("普通のエラー"), null);
  assert.match(hintFor("usage_limit", "再開できる時刻: Nov 25th, 2026 2:21 AM"), /Nov 25th, 2026 2:21 AM 以降/);
});

test("parseResetTime: 英語の再開時刻を、時刻(ms)にする", () => {
  const now = new Date(2026, 10, 25, 13, 0, 0).getTime(); // 2026-11-25 13:00(ローカル)
  assert.equal(parseResetTime("3:38 PM", now), new Date(2026, 10, 25, 15, 38).getTime());
  assert.equal(parseResetTime("11:05 AM", now), new Date(2026, 10, 26, 11, 5).getTime()); // 過ぎているので、明日
  assert.equal(parseResetTime("Nov 25th, 2026 2:21 AM", now), new Date(2026, 10, 25, 2, 21).getTime());
  assert.equal(parseResetTime("よく分からない", now), null);
  assert.equal(parseResetTime(null, now), null);
  assert.equal(detectUsageLimit("You've hit your usage limit. try again at 3:38 PM.", now).atMs, new Date(2026, 10, 25, 15, 38).getTime());
});
