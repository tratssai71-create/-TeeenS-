// いま作業している「サイトごとの仕様書フォルダ」。spec-out/active.json の dir(既定は spec-out)。サイトごとに、仕様書・許容(accepted)・見比べ画像を、分ける。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export const specDir = () => { try { const d = JSON.parse(readFileSync("spec-out/active.json", "utf8")).dir; if (typeof d === "string" && /^spec-out(\/|$)/.test(d) && !d.includes("..")) return d; } catch {} return "spec-out"; };
export const setSpecDir = (dir) => { mkdirSync("spec-out", { recursive: true }); writeFileSync("spec-out/active.json", JSON.stringify({ dir }, null, 2)); };
export const slugFor = (src) => String(src).replace(/^https?:\/\//, "").replace(/^file:\/\//, "").replace(/\/index\.html?$/i, "").replace(/[^\w぀-ヿ㐀-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(-40) || "site";
export const inSpec = (...p) => join(specDir(), ...p);
