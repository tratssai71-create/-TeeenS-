// 起動ランチャー(Windows/Mac/Linux共通)
//   node run.js director          司令塔
//   node run.js designer          ワーカー(.env.designer を読む)
//   node run.js all               存在する .env.* を全部別プロセスで起動
import { existsSync, readdirSync } from "node:fs";
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
  process.loadEnvFile(file);
  if (role !== "director") process.env.AGENT_NAME ??= role;
  await import(role === "director" ? "./orchestrator.js" : "./bot.js");
}
