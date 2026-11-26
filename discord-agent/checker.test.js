import test from "node:test";
import assert from "node:assert/strict";
import { diffStyle, compareSpec, specTextItems } from "./checker.js";

const st = { size: "36px", weight: "700", color: "rgb(34, 34, 34)", lh: "49.68px", ls: "1.44px", font: "Poppins" };
test("diffStyle: 合っていれば空、違えば日本語で出る", () => {
  assert.deepEqual(diffStyle(st, { ...st, size: "36.5px" }), []);
  assert.equal(diffStyle(st, { ...st, size: "28px" }).length, 1);
  assert.match(diffStyle(st, { ...st, color: "rgb(255, 0, 0)" })[0], /色/);
  assert.match(diffStyle(st, { ...st, font: "Noto Sans JP, sans-serif" })[0], /フォント/);
});
test("compareSpec: 一致・違い・見つからない を分ける", () => {
  const spec = [{ text: "見た人が動く", style: st }, { text: "無料で相談する", style: st }, { text: "存在しない文字です", style: st }];
  const got = [{ text: "「見た人が動く」", ...st }, { text: "無料で相談する", ...st, size: "20px" }];
  const r = compareSpec(spec, got);
  assert.equal(r.ok.length, 1); assert.equal(r.diffs.length, 1); assert.equal(r.missing.length, 1);
});
test("specTextItems: セクション指定と、画像の除外", () => {
  const spec = { pc: { sections: [{ items: [{ kind: "text", text: "a" }] }, { items: [{ kind: "image" }, { kind: "heading", text: "b" }] }] } };
  assert.equal(specTextItems(spec).length, 2);
  assert.deepEqual(specTextItems(spec, { section: 2 }).map((x) => x.text), ["b"]);
});

import { sectionPrompt } from "./checker.js";
test("sectionPrompt: 長いセクションでも、最後の指示まで切れない/ヘッダーは上/飾り文字は作らない", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ kind: "text", text: `文字${i}`.padEnd(30, "あ"), style: { size: "14px", weight: "400", color: "rgb(1,1,1)", font: "Poppins" } }));
  items.push({ kind: "text", text: "Page", style: { size: "100px", color: "rgba(0, 0, 0, 0)" } });
  const spec = { pc: { sections: [{ tag: "header", h: 79, bg: "#fff", layout: {}, items }, { tag: "section", h: 500, bg: "#fff", layout: {}, items: items.slice(0, 2) }] } };
  const p1 = sectionPrompt(spec, 1, { project: "テスト" });
  assert.ok(p1.length > 1900); assert.ok(p1.endsWith("公開はしない。")); assert.match(p1, /一番上/); assert.match(p1, /「テスト」/);
  assert.match(p1, /飾りの文字「Page」/);
  assert.match(sectionPrompt(spec, 2), /セクション1の直後/);
  assert.equal(sectionPrompt(spec, 9), null);
});
