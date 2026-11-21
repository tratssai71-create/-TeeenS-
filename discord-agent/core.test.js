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
