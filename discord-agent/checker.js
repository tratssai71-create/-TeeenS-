// 検査役: 移植元の仕様書(spec.json)と、いまのSTUDIOの編集画面を、見比べて、違いを一覧にする。
// 文字が有るか、大きさ・太さ・色・行間・字間・フォントが合っているか、を調べる(画面の操作はしない。読むだけ)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inSpec, specDir } from "./spec-dir.js";
import { cdpSession } from "./browser-guard.js";

const norm = (t) => String(t ?? "").replace(/[\s　「」『』"'“”‘’]/g, "");
const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const rgb = (v) => { const m = String(v ?? "").match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(",").map((x) => parseFloat(x)); return { r, g, b, a }; };
const fam = (v) => String(v ?? "").split(",")[0].replace(/["']/g, "").trim().toLowerCase();

/** 文字の要素1つを、仕様書の1項目と比べて、違いの文を返す(合っていれば空) */
export function diffStyle(spec, got, text = "") {
  const out = [];
  const a = px(spec.size), b = px(got.size);
  if (a != null && b != null && Math.abs(a - b) > 1) out.push(`文字の大きさ: 仕様 ${spec.size} / STUDIO ${got.size}`);
  const wa = parseInt(spec.weight, 10), wb = parseInt(got.weight, 10);
  if (wa && wb && Math.abs(wa - wb) > 100) out.push(`太さ: 仕様 ${spec.weight} / STUDIO ${got.weight}`);
  const ca = rgb(spec.color), cb = rgb(got.color);
  if (ca && cb && ca.a > 0.05 && cb.a > 0.05 && Math.hypot(ca.r - cb.r, ca.g - cb.g, ca.b - cb.b) > 24) out.push(`色: 仕様 ${spec.color} / STUDIO ${got.color}`);
  const la = px(spec.lh), lb = px(got.lh);
  if (la != null && lb != null && Math.abs(la - lb) > Math.max(4, la * 0.15)) out.push(`行間: 仕様 ${spec.lh} / STUDIO ${got.lh}`);
  const sa = px(spec.ls) ?? 0, sb = px(got.ls) ?? 0;
  if (Math.abs(sa - sb) > 0.8) out.push(`字間: 仕様 ${spec.ls || "0"} / STUDIO ${got.ls || "0"}`);
  // 日本語の文字は、欧文フォント(Poppinsなど)の違いが見た目に出ないので、フォントは、日本語を含まない文字だけ比べる
  if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(text) && spec.font && got.font && fam(spec.font) !== fam(got.font)) out.push(`フォント: 仕様 ${spec.font} / STUDIO ${fam(got.font)}`);
  return out;
}

/**
 * @param specItems [{text, style:{size,weight,color,lh,ls,font}, section}]
 * @param studioItems [{text, size, weight, color, lh, ls, font}]
 */
export function compareSpec(specItems, studioItems) {
  const pool = studioItems.map((s) => ({ ...s, n: norm(s.text) })).filter((s) => s.n);
  const result = { ok: [], missing: [], diffs: [], pairs: [] };
  for (const it of specItems) {
    const n = norm(it.text);
    if (!n) continue;
    // 完全一致を優先。なければ、一方がもう一方を含む(文の区切り方が違うとき)ものを探す
    // 同じ文字が、ページの中に、複数あるとき(例: 本文のリンクと、フッターのリンク)は、違いがいちばん少ないものを、相手にする
    let cands = pool.filter((s) => s.n === n);
    if (!cands.length) cands = pool.filter((s) => n.length >= 6 && (s.n.includes(n) || (s.n.length >= 6 && n.includes(s.n))));
    if (!cands.length) { result.missing.push(it); continue; }
    let best = null;
    let bestHit = null;
    for (const c of cands) { const d = diffStyle(it.style ?? {}, c, it.text); if (!best || d.length < best.length) { best = d; bestHit = c; } if (!d.length) break; }
    result.pairs.push({ item: it, hit: bestHit });
    best.length ? result.diffs.push({ item: it, diffs: best }) : result.ok.push(it);
  }
  return result;
}

const EXTRACT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    out.push({ x: r.x, y: r.y, w: r.width, h: r.height, text: own, size: cs.fontSize, weight: cs.fontWeight, color: cs.color, lh: cs.lineHeight, ls: cs.letterSpacing === "normal" ? "" : cs.letterSpacing, font: cs.fontFamily });
  }
  return JSON.stringify(out);
})()`;

/** いまの編集画面(STUDIOのタブ)から、文字の要素を、すべて読む(入れ子の画面も含む) */
export async function readStudioTexts({ cdp = "http://localhost:9222" } = {}) {
  const pages = (await (await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((t) => t.type === "page" && /studio\.design/.test(t.url));
  const page = pages.find((p) => /\/editor/.test(p.url));
  if (!page) throw new Error("STUDIOの編集画面が、開かれていません");
  const s = await cdpSession(page.webSocketDebuggerUrl, 15000);
  const all = [];
  try {
    const walk = (n) => [n.frame.id, ...(n.childFrames ?? []).flatMap(walk)];
    const tree = await s.send("Page.getFrameTree");
    for (const fid of walk(tree.frameTree)) {
      try {
        const w = await s.send("Page.createIsolatedWorld", { frameId: fid });
        const r = await s.send("Runtime.evaluate", { contextId: w.executionContextId, expression: EXTRACT, returnByValue: true });
        all.push(...JSON.parse(r.result.value ?? "[]"));
      } catch {}
    }
    // 編集画面の下に出ている、いま表示している幅(例: 「1280 px」「540 px」)。PCかスマホかの判定と、拡大率に使う
    try {
      const r = await s.send("Runtime.evaluate", { returnByValue: true, expression: `(() => { const e = document.querySelector('[aria-label="ベース幅を編集"]'); const m = e ? e.textContent.match(/\\d{3,4}/) : null; return JSON.stringify(m ? parseInt(m[0], 10) : null); })()` });
      all.designW = JSON.parse(r.result.value ?? "null");
    } catch {}
    // サイト本体(最初の文字「About」と最後の文字を、両方含む、いちばん小さい要素)の位置と幅。配置の検査で、拡大率を出すために使う
    try {
      const r = await s.send("Runtime.evaluate", { returnByValue: true, expression: `(() => { const find = (t) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.includes(t)) return n.parentElement; return null; };
        const a = find(${JSON.stringify(process.env.FIRST_TEXT ?? "About")}), b = find(${JSON.stringify(process.env.LAST_TEXT ?? "TeeenS Inc")}); if (!a || !b) return JSON.stringify(null); let e = a; while (e && !e.contains(b)) e = e.parentElement; if (!e) return JSON.stringify(null); const q = e.getBoundingClientRect(); return JSON.stringify({ x: q.x, y: q.y, w: q.width, h: q.height }); })()` });
      all.root = JSON.parse(r.result.value ?? "null");
      // 編集画面の、ほかの部分(レイヤーの一覧・右パネルなど)の文字を、検査に混ぜない。キャンバス(サイト本体)の中に、収まる文字だけにする
      if (all.root) { const R = all.root; const keep = all.filter((i) => i.x == null || (i.x >= R.x - 2 && i.x + i.w <= R.x + R.w + 2 && i.y + i.h >= R.y - 2 && i.y <= R.y + R.h + 2)); all.length = 0; all.push(...keep); }
    } catch {}
  } finally { s.close(); }
  return all;
}

/** 文字の色が透明(飾りの特大文字・グラデーション文字など)の項目は、検査と制作の対象外にする */
const isOutline = (it) => { const c = rgb(it.style?.color); return !!c && c.a < 0.05; }; // 中が透明で、輪郭(縁取り)だけの文字。内容(見出しなど)なので、検査の対象。色の比較だけ、しない
const isDecor = () => false;

/** 仕様書(spec.json)の、文字の項目を、1つの配列にする。section を指定すると、そのセクション(1始まり)だけ */
export function specTextItems(spec, { section = null, device = "pc" } = {}) {
  const secs = spec?.[device]?.sections ?? [];
  const out = [];
  secs.forEach((sec, i) => {
    if (section && i + 1 !== section) return;
    for (const it of sec.items ?? []) if (it.kind !== "image" && it.text && !isDecor(it)) out.push({ ...it, section: i + 1 });
  });
  return out;
}

export function formatCheck(r, { section = null } = {}) {
  const total = r.ok.length + r.missing.length + r.diffs.length;
  const head = `🔍 検査の結果${r.device === "sp" ? "【スマホ・タブレット幅】" : ""}${section ? `(セクション${section})` : ""}: 文字 ${total}件のうち、**合っている ${r.ok.length}** / **スタイルの違い ${r.diffs.length}** / **見つからない ${r.missing.length}**`;
  const lines = [head];
  if (r.missing.length) lines.push("", "❌ 見つからない文字:", ...r.missing.slice(0, 12).map((m) => `・「${String(m.text).slice(0, 40)}」`));
  if (r.diffs.length) lines.push("", "⚠️ スタイルの違い:", ...r.diffs.slice(0, 12).map((d) => `・「${String(d.item.text).slice(0, 24)}」 ${d.diffs.join(" / ")}`));
  if (!r.missing.length && !r.diffs.length) lines.push("", "✅ 文字は、すべて、仕様書と合っています(余白・画像は、この検査の対象外です。画面で見てください)");
  if (r.layoutNote) lines.push("", `ℹ️ ${r.layoutNote}`);
  if (r.layout?.length) lines.push("", `📐 配置のずれ(目安・${r.layout.length}件。直したいときは \`!fix ${section ?? "N"} 配置\`):`, ...r.layout.slice(0, 8).map((d) => `・「${String(d.item.text).slice(0, 18)}」 ${d.diffs.join(" / ")}`));
  return lines.join("\n").slice(0, 1900);
}

/**
 * 配置のずれ(目安)。仕様書の幅1280pxのときの、文字の位置・幅・高さ(行数)と、STUDIOの編集画面(拡大・縮小されている)を、同じ尺度にそろえて比べる。
 * 縦の位置は、同じセクションの、最初の文字からの距離で比べる(上の方のずれが、下に響かないように)。
 */
export function layoutDiffs(result, spec1280, root, designW = 1280) {
  if (!root || !spec1280?.sections) return [];
  const scale = root.w / designW, out = [];
  const bySec = new Map();
  for (const p of result.pairs ?? []) { if (!p.hit || p.hit.x == null) continue; (bySec.get(p.item.section) ?? bySec.set(p.item.section, []).get(p.item.section)).push(p); }
  for (const [sec, pairs] of bySec) {
    const specItems = (spec1280.sections[sec - 1]?.items ?? []).filter((i) => i.kind !== "image" && i.text);
    const find = (it) => specItems.find((x) => norm(x.text) === norm(it.text) && x.y != null);
    const first = pairs.map((p) => ({ p, s: find(p.item) })).find((q) => q.s);
    if (!first) continue;
    for (const p of pairs) {
      const sp = find(p.item); if (!sp) continue;
      const d = [];
      const x = (p.hit.x - root.x) / scale, w = p.hit.w / scale, h = p.hit.h / scale;
      if (Math.abs(x - sp.x) > 12) d.push(`位置(左): 仕様 ${Math.round(sp.x)}px / STUDIO ${Math.round(x)}px`);
      if (Math.abs(w - sp.w) > Math.max(30, sp.w * 0.12)) d.push(`幅: 仕様 ${Math.round(sp.w)}px / STUDIO ${Math.round(w)}px`);
      if (Math.abs(h - sp.h) > Math.max(10, sp.h * 0.25)) d.push(`高さ(行数): 仕様 ${Math.round(sp.h)}px / STUDIO ${Math.round(h)}px`);
      if (p !== first.p) {
        const dySpec = sp.y - first.s.y, dyHit = (p.hit.y - first.p.hit.y) / scale;
        if (Math.abs(dySpec - dyHit) > 24) d.push(`縦の位置(先頭の文字から): 仕様 ${Math.round(dySpec)}px / STUDIO ${Math.round(dyHit)}px`);
      }
      if (d.length) out.push({ item: p.item, diffs: d });
    }
  }
  return out;
}

/** 「この違いは、これでよい」と、人が決めた項目(spec-out/accepted.json)。[{text:"文字の一部", field:"色"}] */
export function loadAccepted(path = inSpec("accepted.json")) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return []; } }
export function addAccepted(text, field, path = inSpec("accepted.json")) {
  const list = loadAccepted(path);
  if (!list.some((a) => a.text === text && a.field === field)) list.push({ text, field });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2) + "\n");
  return list;
}
/** 許容された違いを、結果から外す(違いが全部許容されたら、「合っている」に移す) */
export function applyAccepted(result, accepted = []) {
  if (!accepted.length) return result;
  const ok = [...result.ok], diffs = [];
  for (const d of result.diffs) {
    const rest = d.diffs.filter((line) => !accepted.some((a) => norm(d.item.text).includes(norm(a.text)) && line.startsWith(a.field)));
    rest.length ? diffs.push({ ...d, diffs: rest }) : ok.push(d.item);
  }
  return { ...result, ok, diffs };
}

export async function checkStudio({ specPath = inSpec("spec.json"), section = null, cdp, device = null } = {}) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const studio = await readStudioTexts({ cdp });
  const dw = studio.designW ?? 1280;
  device = device ?? (dw < 700 ? "sp" : "pc"); // 編集画面が、スマホ・タブレットの幅なら、スマホの仕様で検査する
  const accAll = loadAccepted();
  // 「画像で代用」と決めた文字は、STUDIOに文字として無くてよい(検査の対象から外す)
  const specItems = specTextItems(spec, { section, device }).filter((it) => !accAll.some((x) => x.field === "画像" && norm(it.text).includes(norm(x.text))));
  const res = applyAccepted(compareSpec(specItems, studio), accAll);
  res.device = device; res.designW = dw;
  // 配置: 仕様書を取ったときの幅と、STUDIOの表示幅が、同じときだけ比べる(PCは1280px、スマホは spec.spWidth)
  const specW = device === "sp" ? spec.spWidth ?? 390 : 1280;
  const specLayout = device === "sp" ? spec.sp : spec.pc1280;
  const sameSections = specLayout?.sections?.length === spec[device]?.sections?.length; // セクションの数が違うときは、番号が合わないので、比べない
  const acc = loadAccepted();
  if (dw !== specW) res.layoutNote = `STUDIOの表示幅(${dw}px)と、仕様書の幅(${specW}px)が違うので、配置は比べていません。仕様書を \`SP_WIDTH=${dw} npm run spec -- …\` で、取り直すと、比べられます`;
  res.layout = (dw === specW && sameSections ? layoutDiffs(res, specLayout, studio.root, dw) : []).map((d) => ({ ...d, diffs: d.diffs.filter((line) => !acc.some((a) => norm(d.item.text).includes(norm(a.text)) && line.startsWith(a.field))) })).filter((d) => d.diffs.length);
  return res;
}

/** 仕様書の、1セクションから、Codexへの「作ってください」の依頼文を作る(!build N 用) */
export function sectionPrompt(spec, n, { device = "pc", project = "" } = {}) {
  const sec = spec?.[device]?.sections?.[n - 1];
  if (!sec) return null;
  const L = sec.layout ?? {};
  const lines = [
    `STUDIO${project ? "の「" + project + "」" : ""}の編集画面(別のプロジェクトが開いていたら、一覧から「" + (project || "対象") + "」を開き直す)で、${sec.tag === "header" ? "ページの**一番上**(ほかのセクションより上)" : sec.tag === "footer" ? "ページの**一番下**" : `すでに作ったセクションの下(セクション${n - 1}の直後)`}に、新しい${sec.tag === "header" ? "ヘッダー" : "セクション"}(セクション${n})を1つ作ってください。仕様書(${specDir()}/spec.md)の「${device === "pc" ? "PC" : "スマホ"}」の ${n} 番目と同じ内容です。見本画像は spec-out/shots/ にあります。`,
    `- 全体: 背景 ${sec.bg} / 高さの目安 ${sec.h}px / 並べ方 ${L.display ?? "block"}${L.dir ? " " + L.dir : ""}${L.gap && L.gap !== "normal" ? " 間隔" + L.gap : ""}${L.justify ? " 横:" + L.justify : ""}${L.align ? " 縦:" + L.align : ""} / 余白 ${L.pad ?? ""}`,
    "- 中身(上から順。文字は、一字一句、そのまま):",
  ];
  for (const it of sec.items ?? []) {
    const outline = isOutline(it) ? ` / 輪郭だけの文字(中は透明。縁取り${it.style?.stroke ?? ""}で見せている。STUDIOで縁取りが作れなければ、通常の色の文字で作り、そのことを報告する)` : "";
    if (it.kind === "image") { lines.push(`  ・画像 ${it.w}×${it.h}(代わりの画像「${it.alt || ""}」。画像ファイルの差し替えは、あとで人がやるので、画像の枠だけ作る)`); continue; }
    const st = it.style ?? {};
    lines.push(`  ・${it.kind === "heading" ? "見出し(" + it.tag + ")" : it.kind === "link" ? "リンク → " + (it.href ?? "") : "文字"}「${it.text}」 ${st.size ?? ""} / 太さ${st.weight ?? ""} / 色${isOutline(it) ? "(透明)" : st.color ?? ""}${st.lh ? " / 行間" + st.lh : ""}${st.ls ? " / 字間" + st.ls : ""} / ${fam(st.font)}${/[぀-ヿ㐀-鿿]/.test(it.text ?? "") ? "(日本語は Noto Sans JP)" : ""}` + outline + (it.box ? ` / 文字を包む箱: 背景${it.box.bg} 角丸${it.box.radius} 余白${it.box.pad}${it.box.border ? " 枠" + it.box.border : ""} 大きさ${it.box.w}×${it.box.h}` : ""));
  }
  lines.push("制作ルール(手順書)を守って。作ったあとは、仕様書と合っているか自分で点検して、違う点・自信のない点を正直に報告して。公開はしない。");
  return lines.join("\n"); // Codexに渡す文なので、Discordの文字数の上限では切らない(切ると、後ろの項目と「公開しない」が消える)
}

/** !progress 用: 全セクションの検査結果を、1つの表にする */
export async function progressTable({ specPath = inSpec("spec.json"), cdp, device = null } = {}) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const studio = await readStudioTexts({ cdp });
  device = device ?? ((studio.designW ?? 1280) < 700 ? "sp" : "pc");
  const secs = spec?.[device]?.sections ?? [];
  const rows = secs.map((_, i) => {
    const r = applyAccepted(compareSpec(specTextItems(spec, { section: i + 1, device }), studio), loadAccepted());
    const total = r.ok.length + r.diffs.length + r.missing.length;
    const done = total > 0 && r.missing.length === 0 && r.diffs.length === 0;
    const none = total > 0 && r.ok.length + r.diffs.length === 0;
    return `${done ? "✅" : none ? "⬜" : "🔶"} セクション${i + 1}: 合っている${r.ok.length} / 違い${r.diffs.length} / 無い${r.missing.length}`;
  });
  return `📋 進み具合${device === "sp" ? "【スマホ・タブレット幅】" : ""}(✅=文字がすべて合っている / 🔶=作業中 / ⬜=未着手)\n${rows.join("\n")}`;
}

/** !fix N 用: 検査の結果(違い・見つからない文字)から、「ここを直してください」の依頼文を作る。直すところがなければ null */
export function fixPrompt(result, n, { project = "", layout = false } = {}) {
  const mobile = result.device === "sp" ? `**今は、モバイルサイズの画面(幅${result.designW}px)の話です。** 編集画面の下の「モバイルサイズに切り替える」ボタンで、モバイルサイズにしてから、直してください。PCサイズ(デフォルトサイズ)の見た目は、変えないでください。` : "";
  if (layout) {
    if (!result.layout?.length) return null;
    return [mobile, `STUDIO${project ? "の「" + project + "」" : ""}の、セクション${n}の、**配置**を、仕様書(${specDir()}/spec.md)と、見本画像に合わせて直してください。検査の結果、次のずれがありました(幅1280pxの画面で比べた、おおよその数字です)。ここだけを直し、ほかは変えないでください。`, ...result.layout.slice(0, 12).map((d) => `・「${String(d.item.text).slice(0, 30)}」 ${d.diffs.join(" / ")}`), "余白(パディング・マージン)や、並べ方(縦横・間隔・幅)で合わせて、絶対位置は使わないでください。直せない項目は、理由を書いて報告してください。直したあとは、画面で確かめて、正直に報告してください。公開はしない。"].join("\n");
  }
  if (!result.diffs.length && !result.missing.length) return null;
  const lines = [mobile, `STUDIO${project ? "の「" + project + "」" : ""}の、セクション${n}を、仕様書(${specDir()}/spec.md)に合わせて直してください。検査の結果、次の違いがありました。ここだけを直し、ほかは変えないでください。`];
  if (result.diffs.length) lines.push("【スタイルの違い】", ...result.diffs.map((d) => `・「${String(d.item.text).slice(0, 40)}」 ${d.diffs.join(" / ")}`));
  if (result.missing.length) lines.push("【STUDIOに無い文字(追加するか、仕様書にある文字が正しく入っているか確認する)】", ...result.missing.map((m) => `・「${String(m.text).slice(0, 60)}」`));
  lines.push("直せない項目(その書体が選べない、など)は、無理に別の方法を探し回らず、理由を書いて報告してください。直したあとは、画面で確かめて、正直に報告してください。公開はしない。");
  return lines.filter(Boolean).join("\n");
}

/** セクションの画像を、元のファイルから、アップロードして、空の枠に置く依頼文。画像が無いセクションは null */
export function imagePrompt(spec, n, { project = "", device = "pc" } = {}) {
  const sec = spec?.[device]?.sections?.[n - 1];
  const imgs = (sec?.items ?? []).filter((i) => i.kind === "image" && i.src);
  if (!imgs.length) return null;
  const lines = [`STUDIO${project ? "の「" + project + "」" : ""}の、セクション${n}にある、**画像の空の枠(グレーの枠)**に、元のサイトの画像ファイルを、アップロードして置いてください。上から下、左から右の順に、次の${imgs.length}枚です。`];
  imgs.forEach((im, i) => {
    let path = im.src;
    if (/^file:/.test(path)) { try { path = decodeURIComponent(new URL(path).pathname); } catch {} }
    lines.push(`${i + 1}. ファイル: ${path} / 大きさ: 横${im.w}px × 縦${im.h}px${im.alt ? ` / 説明(alt): 「${im.alt}」` : ""}`);
  });
  lines.push("画像の部品が、まだ無い場所(ロゴなど)は、標準の画像部品を、置いてから、アップロードしてください。置いたら、枠の大きさを、上の大きさに合わせて、縦横の比率を、保ってください(引き伸ばさない)。画像の説明(alt)も、入れてください。ほかの部分は、変えないでください。ファイルを選ぶ操作ができなかったときは、どこまでできたか、教えてください。公開はしない。");
  return lines.join("\n");
}
