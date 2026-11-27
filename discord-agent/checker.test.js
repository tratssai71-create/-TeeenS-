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
test("sectionPrompt: 長いセクションでも、最後の指示まで切れない/ヘッダーは上/輪郭だけの文字は、その旨を添えて作る", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ kind: "text", text: `文字${i}`.padEnd(30, "あ"), style: { size: "14px", weight: "400", color: "rgb(1,1,1)", font: "Poppins" } }));
  items.push({ kind: "text", text: "Page", style: { size: "100px", color: "rgba(0, 0, 0, 0)" } });
  const spec = { pc: { sections: [{ tag: "header", h: 79, bg: "#fff", layout: {}, items }, { tag: "section", h: 500, bg: "#fff", layout: {}, items: items.slice(0, 2) }] } };
  const p1 = sectionPrompt(spec, 1, { project: "テスト" });
  assert.ok(p1.length > 1900); assert.ok(p1.endsWith("公開はしない。")); assert.match(p1, /一番上/); assert.match(p1, /「テスト」/);
  assert.match(p1, /輪郭だけの文字/);
  assert.match(sectionPrompt(spec, 2), /セクション1の直後/);
  assert.equal(sectionPrompt(spec, 9), null);
});

import { fixPrompt } from "./checker.js";
test("fixPrompt: 違いが無ければ null、あれば、直す文になる", () => {
  assert.equal(fixPrompt({ ok: [1], diffs: [], missing: [] }, 1), null);
  const p = fixPrompt({ ok: [], diffs: [{ item: { text: "About" }, diffs: ["文字の大きさ: 仕様 16.5px / STUDIO 15px"] }], missing: [{ text: "Page" }] }, 1, { project: "T" });
  assert.match(p, /「T」/); assert.match(p, /About/); assert.match(p, /Page/); assert.ok(p.endsWith("公開はしない。"));
});

import { applyAccepted } from "./checker.js";
test("applyAccepted: 許容した違いは、外れて、全部外れたら『合っている』に移る", () => {
  const r = { ok: [], missing: [], diffs: [{ item: { text: "料金プラン" }, diffs: ["色: 仕様 a / STUDIO b"] }, { item: { text: "別" }, diffs: ["太さ: 仕様 800 / STUDIO 400"] }] };
  const out = applyAccepted(r, [{ text: "料金プラン", field: "色" }]);
  assert.equal(out.diffs.length, 1); assert.equal(out.ok.length, 1); assert.equal(out.diffs[0].item.text, "別");
});

test("compareSpec: 同じ文字が複数あるとき、違いが少ないほうを相手にする", () => {
  const st2 = { size: "14px", weight: "400", color: "rgb(1, 1, 1)", lh: "20px", ls: "", font: "x" };
  const r = compareSpec([{ text: "料金プラン", style: st2 }], [{ text: "料金プラン", ...st2, size: "12.5px" }, { text: "料金プラン", ...st2 }]);
  assert.equal(r.ok.length, 1); assert.equal(r.diffs.length, 0);
});

import { layoutDiffs } from "./checker.js";
test("layoutDiffs: 拡大率をそろえて、位置・幅・高さ・縦の間隔のずれを出す", () => {
  const spec1280 = { sections: [{ items: [
    { kind: "text", text: "見出しです", x: 100, y: 1000, w: 600, h: 50 },
    { kind: "text", text: "本文です", x: 100, y: 1100, w: 600, h: 80 },
  ] }] };
  // STUDIOは、0.5倍で表示。キャンバスの左端 x=50。見出しは、仕様どおり。本文は、右に40px(仕様の尺度で)・下に60pxずれている
  const root = { x: 50, y: 0, w: 640 };
  const result = { pairs: [
    { item: { text: "見出しです", section: 1 }, hit: { x: 50 + 100 * 0.5, y: 500, w: 300, h: 25 } },
    { item: { text: "本文です", section: 1 }, hit: { x: 50 + 140 * 0.5, y: 500 + 160 * 0.5, w: 300, h: 40 } },
  ] };
  const out = layoutDiffs(result, spec1280, root);
  assert.equal(out.length, 1);
  assert.equal(out[0].item.text, "本文です");
  assert.ok(out[0].diffs.some((d) => d.startsWith("位置(左)")));
  assert.ok(out[0].diffs.some((d) => d.startsWith("縦の位置")));
});
