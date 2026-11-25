import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, validatePlan, readyTasks, buildTaskMessage, jobFinished } from "./core.js";

const opt = { roles: ["designer", "writer", "qa"], maxTasks: 8 };
const mk = (o = {}) => ({ key: "a", to: "writer", title: "t", instructions: "i", ...o });

test("extractJson: コードフェンスと前後の文章を許容", () => {
  assert.deepEqual(extractJson('前置き\n```json\n{"tasks":[1]}\n```\n後書き'), { tasks: [1] });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.throws(() => extractJson("なし"));
});

test("validatePlan: 正常/異常", () => {
  assert.equal(validatePlan({ tasks: [mk()] }, opt)[0].status, "pending");
  assert.throws(() => validatePlan({ tasks: [] }, opt));
  assert.throws(() => validatePlan({ tasks: [mk({ to: "x" })] }, opt), /未知のロール/);
  assert.throws(() => validatePlan({ tasks: [mk(), mk()] }, opt), /重複/);
  assert.throws(() => validatePlan({ tasks: [mk({ deps: ["zz"] })] }, opt), /未知の依存/);
  assert.throws(() => validatePlan({ tasks: [mk({ key: "a", deps: ["b"] }), mk({ key: "b", deps: ["a"] })] }, opt), /循環/);
  assert.throws(() => validatePlan({ tasks: [mk({ instructions: "x".repeat(1001) })] }, opt), /長すぎ/);
});

test("readyTasks: 依存解決とロール直列", () => {
  const tasks = validatePlan({ tasks: [
    mk({ key: "w1", to: "writer" }),
    mk({ key: "d1", to: "designer", deps: ["w1"] }),
    mk({ key: "d2", to: "designer" }),
    mk({ key: "q1", to: "qa", deps: ["d1", "d2"] }),
  ] }, opt);
  const job = { id: "j1", tasks };
  assert.deepEqual(readyTasks(job).map((t) => t.key), ["w1", "d2"]); // d1は依存待ち
  job.tasks[0].status = "done"; job.tasks[2].status = "sent";
  assert.deepEqual(readyTasks(job).map((t) => t.key), []); // designerは実行中
  job.tasks[2].status = "done";
  assert.deepEqual(readyTasks(job).map((t) => t.key), ["d1"]);
});

test("buildTaskMessage: 2000文字以内に収める", () => {
  const tasks = validatePlan({ tasks: [
    mk({ key: "a", instructions: "y".repeat(900) }),
    mk({ key: "b", deps: ["a"], instructions: "z".repeat(900) }),
  ] }, opt);
  tasks[0].status = "done"; tasks[0].summary = "s".repeat(5000);
  tasks[1].sentId = "j1-b-a1"; tasks[1].attempt = 1;
  const msg = buildTaskMessage({ id: "j1", tasks }, tasks[1], 30);
  assert.ok(msg.length <= 1900);
  assert.equal(JSON.parse(msg).to, "writer");
});

test("jobFinished", () => {
  assert.equal(jobFinished({ tasks: [{ status: "done" }, { status: "failed" }] }), true);
  assert.equal(jobFinished({ tasks: [{ status: "done" }, { status: "sent" }] }), false);
});

import { signApproval, verifyApproval } from "./core.js";

test("公開承認トークン: 署名・ジョブ・期限", () => {
  const a = signApproval("secret", "j1", "u1", 1000);
  assert.equal(verifyApproval("secret", a, "j1", 60_000, 2000), true);
  assert.equal(verifyApproval("other", a, "j1", 60_000, 2000), false);        // 鍵違い
  assert.equal(verifyApproval("secret", a, "j2", 60_000, 2000), false);       // 別ジョブ
  assert.equal(verifyApproval("secret", a, "j1", 60_000, 1000 + 60_001), false); // 期限切れ
  assert.equal(verifyApproval("secret", { ...a, by: "evil" }, "j1", 60_000, 2000), false); // 改ざん
  assert.equal(verifyApproval("secret", undefined, "j1"), false);
  assert.equal(verifyApproval("", a, "j1", 60_000, 2000), false);
});

test("公開タスクにだけ承認トークンが付く", () => {
  const tasks = validatePlan({ tasks: [mk({ key: "a" })] }, opt);
  tasks.push({ key: "publish", to: "publisher", title: "p", instructions: "i", acceptance: [], deps: ["a"],
    requiresApproval: true, status: "pending", attempt: 1, sentId: "j1-publish-a1", summary: null });
  tasks[0].status = "done";
  const job = { id: "j1", tasks, approval: signApproval("s", "j1", "u1") };
  const msg = JSON.parse(buildTaskMessage(job, tasks[1], 30));
  assert.equal(msg.inputs.approval.sig, job.approval.sig);
  tasks[0].sentId = "j1-a-a1";
  assert.equal(JSON.parse(buildTaskMessage(job, tasks[0], 30)).inputs?.approval, undefined);
});

import { quickPlan } from "./core.js";
test("quickPlan: 計画を省いて1タスクにする", () => {
  const p = quickPlan("!quick 見出しを「テスト」に変えて", "designer");
  assert.equal(p.length, 1);
  assert.equal(p[0].to, "designer");
  assert.equal(p[0].instructions, "見出しを「テスト」に変えて");
  assert.throws(() => quickPlan("!quick   ", "designer"));
});

test("公開タスクには requiresApproval が付く", () => {
  const tasks = validatePlan({ tasks: [mk({ key: "a", to: "designer" })] }, opt);
  tasks.push({ key: "publish", to: "designer", title: "p", instructions: "i", acceptance: [], deps: ["a"],
    requiresApproval: true, status: "pending", attempt: 1, sentId: "j1-publish-a1", summary: null });
  tasks[0].status = "done"; tasks[0].sentId = "j1-a-a1";
  const job = { id: "j1", tasks, approval: signApproval("s", "j1", "u1") };
  assert.equal(JSON.parse(buildTaskMessage(job, tasks[1], 30)).requiresApproval, true);
  assert.equal(JSON.parse(buildTaskMessage(job, tasks[0], 30)).requiresApproval, undefined);
});

test("extractExpectedText: 依頼文から変更後の文字を取り出す", async () => {
  const { extractExpectedText } = await import("./core.js");
  assert.equal(extractExpectedText("STUDIOの「あああ(サンプル)」のホーム最上部の見出しを「公開テスト4」に変えて"), "公開テスト4");
  assert.equal(extractExpectedText("見出しを「テスト」に変えて。変えたら再読み込みして"), "テスト");
  assert.equal(extractExpectedText("時刻の記録を入れて"), null);
});

test("extractQuestions: 質問だけのプランを見分ける", async () => {
  const { extractQuestions } = await import("./core.js");
  assert.deepEqual(extractQuestions({ questions: ["どのプロジェクト?", "何時?", " ", "3", "4"] }), ["どのプロジェクト?", "何時?", "3"]);
  assert.equal(extractQuestions({ tasks: [{ key: "a" }], questions: ["x"] }), null);
  assert.equal(extractQuestions({ questions: [] }), null);
  assert.equal(extractQuestions({}), null);
});
