// 起動ランチャー(Windows/Mac/Linux共通)
//   node run.js director          司令塔
//   node run.js designer          ワーカー(.env.designer を読む)
//   node run.js all               存在する .env.* を全部別プロセスで起動
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

const role = process.argv[2];
if (!role) { console.error("使い方: node run.js <director|designer|writer|qa|publisher|all>"); process.exit(1); }

if (role === "all") {
  const roles = readdirSync(".").filter((f) => /^\.env\.[a-z]+$/.test(f)).map((f) => f.slice(5));
  if (!roles.length) { console.error(".env.<ロール> ファイルがありません"); process.exit(1); }
  for (const r of roles) {
    const c = spawn(process.execPath, ["run.js", r], { stdio: "inherit" });
    c.on("exit", (code) => console.log(`[${r}] 終了 code=${code}`));
  }
} else {
  const file = `.env.${role}`;
  if (!existsSync(file)) { console.error(`${file} がありません(.env.${role === "director" ? "director" : "worker"}.example をコピーして作成)`); process.exit(1); }
  // 二重起動の防止: 同じ役割のBotが、すでに動いていたら、起動しない(Chromeの取り合いや、返信の重複を防ぐ)
  const lock = `.lock-${role}`;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch {}
    if (alive) {
      console.error(`[${role}] すでに動いています(pid ${pid})。二重に起動すると、動作がぶつかります。\n先に、ターミナルのウィンドウをすべて閉じるか、次のコマンドで止めてください:\n  pkill -f "node run.js"`);
      process.exit(1);
    }
  }
  writeFileSync(lock, String(process.pid));
  const unlock = () => { try { if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); } catch {} };
  process.on("exit", unlock);
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { unlock(); process.exit(0); });
  process.loadEnvFile(file);
  if (role !== "director") process.env.AGENT_NAME ??= role;
  await import(role === "director" ? "./orchestrator.js" : "./bot.js");
}
