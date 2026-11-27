import { Client, GatewayIntentBits, AttachmentBuilder } from "discord.js";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyApproval, extractExpectedText, normalizeCommand } from "./core.js";
import { roleLabel, detectUsageLimit, fmtTime } from "./messages.js";
import { prepareBrowser, verifyText, openEditor, captureScreenshot } from "./browser-guard.js";
import { specDir, setSpecDir, slugFor, inSpec } from "./spec-dir.js";
import { checkStudio, formatCheck, sectionPrompt, progressTable, fixPrompt, addAccepted, imagePrompt, readStudioTexts } from "./checker.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, mkdirSync } from "node:fs";

const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const {
  AGENT_NAME = "agent", DISCORD_TOKEN, WORKDIR = process.cwd(),
  CODEX_ARGS = "--sandbox workspace-write --skip-git-repo-check",
  TIMEOUT_MIN = "30",
} = process.env;
const CHANNELS = new Set(list(process.env.CHANNEL_IDS));
// ワーカーモード(司令塔からのタスク受信)。未設定なら無効
const { TASKS_CHANNEL_ID, LOG_CHANNEL_ID, ORCHESTRATOR_BOT_ID } = process.env;
const seenTasks = new Set(); // 二重実行防止
// publisherなど「承認必須」のワーカー: 司令塔が署名した公開承認がなければ実行しない
const REQUIRE_APPROVAL = env_flag(process.env.REQUIRE_APPROVAL);
const { APPROVAL_SECRET } = process.env;
function env_flag(v) { return v === "1" || v === "true"; }
const ALLOWED = new Set(list(process.env.ALLOWED_USER_IDS));

if (!DISCORD_TOKEN || (!CHANNELS.size && !TASKS_CHANNEL_ID) || !ALLOWED.size) {
  console.error("DISCORD_TOKEN / ALLOWED_USER_IDS と、CHANNEL_IDS か TASKS_CHANNEL_ID を .env に設定してください");
  process.exit(1);
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message ?? e));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Developer Portal で有効化が必要
  ],
});

let current = null;      // 実行中の子プロセス
let chain = Promise.resolve(); // タスクは1件ずつ直列実行

// 連続する同じ行を「×N」にまとめる(進捗の表示を短くする)
function compress(lines) {
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.text === l) last.n++; else out.push({ text: l, n: 1 });
  }
  return out.map((o) => (o.n > 1 ? `${o.text} ×${o.n}` : o.text));
}

// 受け取った文字列を、1行ずつコールバックに渡す
function lineSplitter(cb) {
  let buf = "";
  return (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const p of parts) cb(p.replace(/\r$/, ""));
  };
}

// codex exec の出力から、人が見て分かる進捗(使っている道具、Codexの発言、セッションID)だけを取り出す
function makeProgress(push, { session = true } = {}) {
  let mode = null;
  return (line) => {
    const s = line.trim();
    const sid = s.match(/^session id:\s*(\S+)/);
    if (sid) return session && push(`🧾 セッション: \`${sid[1]}\`(あとで \`codex resume ${sid[1]}\` で、やり取りを見られます)`);
    if (s === "codex") { mode = "codex"; return; }
    const tool = s.match(/^mcp:\s*(\S+)\s+started/);
    if (tool) { mode = null; return push(`🔧 ${tool[1]}`); }
    if (/^(user|exec|tokens used)$/.test(s) || s.startsWith("mcp:")) { mode = null; return; }
    if (mode === "codex" && s && !/^-+$/.test(s)) push(`💬 ${s.slice(0, 300)}`);
  };
}

function runCodex(prompt, onLine, resumeId, images = []) {
  return new Promise(async (resolve) => {
    const dir = await mkdtemp(join(tmpdir(), "codex-"));
    const outFile = join(dir, "last.txt");
    // ブラウザ操作などのMCPを、確認なし(無人)で使えるようにする。MCP_AUTO_APPROVE=名前,名前 で変更(空で無効)
    const approve = list(process.env.MCP_AUTO_APPROVE ?? "playwright")
      .flatMap((s) => ["-c", `mcp_servers.${s}.default_tools_approval_mode="approve"`]);
    const win = process.platform === "win32";
    const base = ["exec", ...CODEX_ARGS.split(/\s+/).filter(Boolean), ...approve, ...(DIRECT_TOOLS ? ["-c", "features.deferred_tool_world_state=false"] : []),
      "-C", WORKDIR, "--output-last-message", outFile];
    // 通常: 指示文は stdin("-")。会話の続き(resume): 前のセッションに続けて実行する
    // 画像(見本の画面・ユーザーが貼った画像)を、Codexに見せる。通常は -i をオプションの手前に(複数指定の形)、resume は、1枚ごとに -i
    const imgsTop = images.flatMap((f) => ["-i", f]);
    const args = resumeId ? [...base, "resume", ...imgsTop, resumeId, win ? "-" : (prompt.startsWith("-") ? " " + prompt : prompt)] : ["exec", ...imgsTop, ...base.slice(1), "-"];
    // Windowsでは codex が .cmd のため shell 経由。その場合は、指示文を引数に載せずstdinで渡す(コマンド注入を避ける)
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], shell: win });
    if (!resumeId || win) child.stdin.end(prompt); else child.stdin.end();
    current = child;
    let log = "";
    const feedOut = onLine ? lineSplitter(onLine) : null;
    const feedErr = onLine ? lineSplitter(onLine) : null;
    child.stdout.on("data", (d) => { log += d; feedOut?.(d); });
    child.stderr.on("data", (d) => { log += d; feedErr?.(d); });
    const timer = setTimeout(() => child.kill("SIGTERM"), Number(TIMEOUT_MIN) * 60_000);
    child.on("close", async (code, sig) => {
      clearTimeout(timer);
      current = null;
      let last = "";
      try { last = (await readFile(outFile, "utf8")).trim(); } catch {}
      await rm(dir, { recursive: true, force: true });
      resolve({ code, sig, text: last || log.trim().slice(-1500) || "(出力なし)", sessionId: log.match(/session id:\s*(\S+)/)?.[1] });
    });
    child.on("error", async (e) => {
      clearTimeout(timer); current = null;
      resolve({ code: -1, text: `起動失敗: ${e.message}` });
    });
  });
}

// Discordの2000文字制限に合わせて分割
function chunks(s, n = 1900) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

// --- ワーカーモード: #tasks のJSONタスクを処理 ---
// 手順書(playbook)とプロジェクトURL一覧を、作業指示に添える(試行錯誤を減らして速くする)
const readIf = (p) => { try { return existsSync(p) ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const PLAYBOOK = readIf(process.env.PLAYBOOK_FILE ?? "docs/studio-playbook.md");
let PROJECTS = "";
try {
  const pj = JSON.parse(readIf(process.env.PROJECTS_FILE ?? "projects.json") || "{}");
  PROJECTS = Object.keys(pj).map((n) => `- ${n}`).join("\n");
} catch {}

// チャット用: 最初のメッセージにだけ添える前提(会話の続きでは、すでに伝わっている)
let BUILD_PROJECT = process.env.BUILD_PROJECT ?? "discord テスト"; // !build で、制作する先のSTUDIOプロジェクト名
const CHAT_PREAMBLE = [
  "あなたは、Webサイト制作チームの『デザイナー』です。Discordのチャットで、ユーザーと会話しながら、STUDIOの編集作業を進めます。",
  "**話し方**: ユーザーは、気軽に、お願いする感じで話しかけます(「ここ、もうちょい濃くして」のような、くだけた言い方、ざっくりした頼み方)。あなたも、親しみやすい、やさしい口調で返す(です・ます調で、堅すぎない。専門用語は避け、使うときは、ひとこと説明する)。返事は、短く。次の形にする: ①やったこと(1〜2行) ②気になる点・できなかったこと(あれば) ③次にできること(1つだけ、提案)。頼みがざっくりしていても、仕様書や見本から、読み取れる範囲は、自分で決めて進める。本当に分からないときだけ、質問を1つだけする(選択肢を添える)。",
  PROJECTS ? `STUDIOのプロジェクト(編集画面は、直接URLではなく、必ず https://app.studio.design/projects の一覧から、該当プロジェクトの「デザインエディタ」を押して開く):\n${PROJECTS}` : "",
  PLAYBOOK ? `操作手順:\n${PLAYBOOK}` : "",
  "ブラウザ操作は、登録済みの Playwright の道具(playwright/browser_*)だけを使う。cua_repl など別の道具は使わない。ブラウザは、すでに、STUDIOのプロジェクト一覧が、1タブだけ開いた状態に整えてある。新しいタブは開かず、そのタブで、対象プロジェクトの「デザインエディタ」を押して開く。",
  "このチャットでは、公開は行わない(右上の「公開」ボタンは押さない)。公開が必要なときは、#command で依頼して、承認ボタンを使うよう案内する。",
  "**必須(編集を伴う作業)**: 完了を報告する前に、必ず、ページを再読み込み(browser_evaluate で `() => location.reload()` を実行する。F5キーは効かない。URLを開き直さない)して、変更が保存されていることを確かめる。報告には「再読み込み後に、○○と表示されていた」と、確認した内容を書く。再読み込みで確認できなかったら、完了にせず、`RESULT: FAILED` と書く。",
  "**すでに編集画面が開いているとき(前の会話の続き)**は、一覧に戻さず、そのタブでそのまま作業を続ける。開いていなければ、一覧から「デザインエディタ」を押して開く。",
  `**セクションを作るとき(制作)**: 移植元の仕様書(依頼文に書いてある spec.md。見本画像は、同じフォルダの shots/)があれば、先に読む。作るのは、1回の依頼につき、1セクションだけ。STUDIOの制作ルール(手順書の「制作ルール」。標準装備・blank を避ける・リッチテキストと絶対位置は必要なときだけ)を守る。作り終えたら、文字・大きさ・色・余白・配置が、仕様書と合っているかを自分で点検して、合っていない点を直してから報告する。画面のスクリーンショットは、報告のあとに、Botが自動で貼る(自分で撮らなくてよい)。報告には、「仕様書と違う点・自信のない点」を、正直に書く。`,
  "作業のあとは、何をしたかを1〜3行で報告する。分からないことは、推測で進めず、質問する。",
  "**育てるための記録**: 作業の最後に、STUDIOの操作で「次からは、こうすると速い・確実」と分かったことが、あれば、1行だけ「📝 学び: …」と書く(なければ書かない)。うまくいかなかった操作と、その代わりに、うまくいった操作を、具体的に書く。",
].filter(Boolean).join("\n\n");

// チャンネルごとの会話セッションを覚えておく(再起動しても続けられる)
const SESSIONS_FILE = process.env.CHAT_SESSIONS_FILE ?? "chat-sessions.json";
let sessions = {};
try { sessions = JSON.parse(readIf(SESSIONS_FILE) || "{}"); } catch {}
const saveSessions = () => { try { writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch {} };

// Botが完了後に再読み込みして確認できる依頼では、Codexに再読み込みをさせない(以前は、F5が効かず、約25秒を無駄にした)
const BOT_VERIFY_LINE = "**再読み込みは、しない。スクリーンショットも撮らない。**変更したら、変更後の文字が、画面(または右パネル)に出たことだけを確認して、すぐに報告する(完了後に、Bot自身が、再読み込みして、保存を確認する)。";
const RELOAD_LINE = "**必須(編集を伴う作業)**: 完了を報告する前に、ページを再読み込みして、保存を確認する。再読み込みは、browser_evaluate で `() => location.reload()` を実行する(F5キーは効かない)。そのあと、browser_wait_for で、確認したい文字が出るまで待つ(固定秒数では待たない)。報告には「再読み込み後に、○○と表示されていた」と書く。確認できなかったら `RESULT: FAILED`。";
const DIRECT_TOOLS = process.env.DIRECT_TOOLS === "1"; // 実測: 起動直後は道具が未準備で、効果なし。既定はオフ(1 で試せる)
const SPEED_LINE = "**速く進めるための決まり**: Playwrightの道具は、exec の中で `tools.mcp__playwright__browser_*` として呼ぶ。" + (DIRECT_TOOLS ? "道具は、最初から呼べる。**最初から、直接呼ぶ。** ただし「is not a function」と出たときだけ、1回だけ `text(ALL_TOOLS.filter(x=>/mcp__playwright/.test(x.name)).map(x=>x.name))` を実行して(ブラウザ側の起動待ちのため)、すぐ同じ操作をやり直す。それ以外では、ALL_TOOLS は使わない。" : "最初の1回だけ、`text(ALL_TOOLS.filter(x=>/mcp__playwright/.test(x.name)).map(x=>x.name))` で道具を読み込む(読み込む前は「関数ではない」と出る)。そのあとは、探し直さない。") + "呼び方: browser_snapshot({}) の結果は r.content[0].text / browser_click({target:\"e123\"})(引数名は ref ではなく target) / browser_find({text:\"文字\"}) または ({regex:\"...\"})(query は使えない) / browser_evaluate({function:\"() => ...\"}) / browser_press_key({key}) / browser_type / browser_wait_for({text}) / browser_tabs({action:\"list\"})。1回の exec で、複数の操作を、まとめて実行する。";
const CHANGED_TO_LINE = "文字を変更した場合は、最終行(RESULT行)の1つ前に、`CHANGED_TO: 変更後の文字` と、変更後の文字だけを、そのまま1行で書く(Botが、これを読んで、再読み込み後の画面と照合する)。";
const EDITOR_OPEN_LINE = "**編集画面は、Botが、いま一覧から開いている最中(「デザインエディタ」のクリックは、済み)。一覧から開く手順は、しない。**browser_wait_for({text:\"コンテンツ編集モードに切り替える\"}) で、編集画面が出るまで待つ。30秒待っても出ないときだけ、自分で一覧から開く。**exec は、2回だけにする**: (1回目) browser_wait_for → browser_evaluate で `main h1` の今の文字を読む → 「コンテンツ編集モードに切り替える」ボタンを押す → browser_find で、その文字を持つ右パネルの paragraph の ref を探す、までを1回の exec で行う。(2回目) browser_type で新しい文字を入れる → blur → `main h1` を読んで、新しい文字になったことを確かめる、までを1回の exec で行う。最後の確認だけの exec は、増やさない。";
function buildPrompt(t, botVerifies = false, askChangedTo = false, editorOpening = false) {
  const acc = (t.acceptance ?? []).map((a) => `- ${a}`).join("\n");
  return [
    `タスク: ${t.title ?? t.id}`,
    t.instructions ?? "",
    t.inputs ? `入力: ${JSON.stringify(t.inputs)}` : "",
    acc ? `受け入れ基準:\n${acc}` : "",
    PROJECTS ? `STUDIOのプロジェクト(編集画面は、直接URLではなく、必ず https://app.studio.design/projects の一覧から、該当プロジェクトの「デザインエディタ」を押して開く):\n${PROJECTS}` : "",
    PLAYBOOK ? `操作手順:\n${PLAYBOOK}` : "",
    "ブラウザ操作は、登録済みの Playwright の道具(playwright/browser_*)だけを使う。cua_repl など別の道具は使わない。ブラウザは、すでに、STUDIOのプロジェクト一覧が、1タブだけ開いた状態に整えてある。新しいタブは開かず、そのタブで、対象プロジェクトの「デザインエディタ」を押して開く。",
    SPEED_LINE,
    editorOpening ? EDITOR_OPEN_LINE : "",
    botVerifies ? BOT_VERIFY_LINE : RELOAD_LINE,
    botVerifies && askChangedTo ? CHANGED_TO_LINE : "",
    "最後に、何をしたかと確認結果を簡潔に報告し、**最終行**に次のどれか1つだけを書く: 依頼どおり完了したなら `RESULT: OK` / 一部でも未実施・失敗なら `RESULT: FAILED` / 人の対応が必要なら `RESULT: BLOCKED`。",
  ].filter(Boolean).join("\n\n");
}

// 作業の前に、専用Chromeを毎回同じ状態に整える(古いタブを閉じる→キャッシュ消去→STUDIOの一覧を開いて待つ)。BROWSER_CHECK=0 で無効
const BROWSER_CDP = process.env.BROWSER_CDP ?? "http://localhost:9222";
const restartChrome = () => new Promise((resolve) => {
  // 固まった専用Chromeだけを終了して(ふだん使いのChromeは対象外)、起動スクリプトでもう一度開く
  spawn("pkill", ["-f", "studio-chrome-profile"]).on("close", () => {
    setTimeout(() => { spawn("bash", ["scripts/browser.sh"], { stdio: "ignore", detached: true }).unref(); resolve(); }, 2000);
  });
});
let chatLimitUntil = 0; // 会話モードで、Codexの利用上限に当たったとき、再開できる時刻(ms)
let needDeep = false; // 直前の作業が失敗したときだけ、次は「タブ作り直し+キャッシュ消去」の念入りな整備をする
async function ensureBrowser(log = () => {}, { keepEditor = false } = {}) {
  if (process.env.BROWSER_CHECK === "0") return { ok: true };
  const deep = needDeep || process.env.BROWSER_DEEP === "1";
  const r = await prepareBrowser({
    deep, keepEditor,
    cdp: BROWSER_CDP,
    startUrl: process.env.BROWSER_START_URL ?? "https://app.studio.design/projects",
    readyText: process.env.BROWSER_READY_TEXT ?? "プロジェクト",
    autoRestart: process.env.BROWSER_AUTORESTART !== "0",
    restart: restartChrome, log,
  });
  if (r.ok) needDeep = false;
  return r;
}
// 画面のスクリーンショットを、Discordに貼る(SCREENSHOT=0 で止める)
async function postShot(ch, label, { bottom = false } = {}) {
  if (process.env.SCREENSHOT === "0" || !ch) return;
  const png = await captureScreenshot({ cdp: BROWSER_CDP });
  if (!png) return void ch.send("(画面のスクリーンショットは、撮れませんでした)").catch(() => {});
  const files = [new AttachmentBuilder(png, { name: `studio-${Date.now()}.png` })];
  let note = label;
  if (bottom) { // 制作では、新しい部分が、ページの下にできるので、一番下まで動かした画面も、続けて貼る
    const low = await captureScreenshot({ cdp: BROWSER_CDP, scroll: "bottom" });
    if (low) { files.push(new AttachmentBuilder(low, { name: `studio-bottom-${Date.now()}.png` })); note += "(1枚目: いまの画面 / 2枚目: 一番下までスクロールした画面)"; }
  }
  await ch.send({ content: `📸 ${note}`, files }).catch(() => {});
}
const BROWSER_ERR = {
  browser_down: "専用Chromeが起動していません。ターミナルで `npm run browser` を実行して、STUDIOにログインしたまま開いてください。",
  login_required: "STUDIOのログインが切れています。専用Chromeで、STUDIOにログインし直してください(ログイン後、そのまま開いておきます)。",
  not_ready: "STUDIOの画面が、40秒待っても表示されませんでした。ネットワークやSTUDIO側の状態を確認して、もう一度送ってください。",
  cdp_error: "専用Chromeとの接続に失敗しました。もう一度送ってください。続く場合は、専用Chromeを終了して `npm run browser` で開き直してください。",
};

async function chatTurn(ch, channelId, userText, { openProject = false, images = [], skipCodex = false } = {}) {
  stopRequested = false;
  await ch.send("🧹 ブラウザを整えています…").catch(() => {});
  const br = await ensureBrowser(() => {}, { keepEditor: !openProject }); // !build は、制作先のプロジェクトを、確実に開くため、一覧から始める
  if (!br.ok) { await ch.send(`⛔ ${BROWSER_ERR[br.code] ?? br.code}`); return { ok: false, why: "browser" }; }
  if (openProject) { const o = await openEditor({ cdp: BROWSER_CDP, name: BUILD_PROJECT }); await ch.send(o.clicked ? `🚪 「${BUILD_PROJECT}」の編集画面を先に開きました` : `ℹ️ 「${BUILD_PROJECT}」の先開きは、できませんでした(${o.detail})`).catch(() => {}); }
  if (skipCodex) return { ok: true }; // 準備(ブラウザを整えて、編集画面を開く)だけで、Codexは使わない
  const buf = []; let sentN = 0;
  let opCount = 0, statusMsg = null;
  const flush = async () => {
    if (!buf.length) return;
    const lines = buf.splice(0);
    const talk = lines.filter((x) => !x.startsWith("🔧 "));
    opCount += lines.length - talk.length; // 道具の呼び出しの行は、1行ずつ出さず、回数だけ数える(画面がうるさくなるため)
    const t = compress(talk).join("\n").slice(0, 1900);
    if (t && sentN++ < 40) await ch.send(t).catch(() => {});
    if (lines.length > talk.length) { // 操作の回数は、新しい投稿を増やさず、1つの投稿を、書き換えて見せる
      const label = `⏳ 作業中…(操作 ${opCount}回)`;
      if (!statusMsg) statusMsg = await ch.send(label).catch(() => null);
      else await statusMsg.edit(label).catch(() => {});
    }
  };
  const timer = setInterval(flush, 4000);
  const typing = setInterval(() => ch.sendTyping().catch(() => {}), 8000);
  ch.sendTyping().catch(() => {});
  const fresh = (t) => `${CHAT_PREAMBLE}\n\nユーザー: ${t}`;
  const sid = sessions[channelId];
  let said = ""; // 途中で💬として流した発言(最後の返事と重複して2回出るのを防ぐ)
  const mkProg = () => makeProgress((x) => { buf.push(x); if (x.startsWith("💬 ")) said += x.slice(3); }, { session: false });
  let r = await runCodex(sid ? userText : fresh(userText), mkProg(), sid, images);
  const limHit = r.code !== 0 ? detectUsageLimit(r.text) : null;
  if (limHit) { // 上限のときは、会話を作り直さず(余計に消費するため)、再開の時刻だけ案内する
    clearInterval(timer); clearInterval(typing);
    chatLimitUntil = limHit.atMs ?? Date.now() + 30 * 60 * 1000;
    await ch.send(`⏸ Codex(ChatGPT)の利用上限に達しました。再開できる時刻: **${limHit.at ?? fmtTime(chatLimitUntil)}**。それまでは、\`!check\` \`!progress\` \`!shot\` だけ使えます。`);
    return { ok: false, why: "limit" };
  }
  if (sid && r.code !== 0 && !r.sig && !stopRequested) { // 前の会話を引き継げなかったときだけ、新しく始める(!stop や時間切れで止めたときは、やり直さない)
    buf.push("(前の会話を引き継げなかったので、新しい会話で続けます)");
    delete sessions[channelId];
    r = await runCodex(fresh(userText), mkProg(), undefined, images);
  }
  clearInterval(timer); clearInterval(typing);
  if (r.sessionId) { sessions[channelId] = r.sessionId; saveSessions(); }
  await flush();
  if (statusMsg) await statusMsg.edit(`✅ 作業の操作: ${opCount}回`).catch(() => {});
  const body = r.code === 0 ? r.text : `うまくいきませんでした(code=${r.code}${r.sig ? ", " + r.sig : ""})\n${r.text}`;
  const norm = (s) => s.replace(/\s+/g, "");
  const dup = r.code === 0 && said && norm(said).includes(norm(r.text).slice(0, 40));
  if (!dup) for (const p of chunks(body)) await ch.send(p);
  // 育てる記録: Codexが書いた「📝 学び: …」を、docs/lessons.md に、日付つきで貯める(あとで、手順書に取り込む)
  for (const m of r.text.matchAll(/📝\s*学び[:：]\s*(.+)/g)) { try { appendFileSync("docs/lessons.md", `- ${new Date().toISOString().slice(0, 10)} ${m[1].trim()}\n`); } catch {} }
  if (r.code === 0) await postShot(ch, "いまのSTUDIOの画面", { bottom: true });
  return { ok: r.code === 0, r };
}

// 見本の画面(仕様書を作ったときの、そのセクションの画像)の場所。無ければ null
function specShot(n) {
  try {
    const spec = JSON.parse(readFileSync(inSpec("spec.json"), "utf8"));
    const rel = spec?.pc?.sections?.[n - 1]?.shot;
    const f = rel ? join(specDir(), rel) : null;
    return f && existsSync(f) ? join(process.cwd(), f) : null;
  } catch { return null; }
}
const SHOT_NOTE = "\n\n添付した画像は、移植元(参考サイト)の、このセクションの見た目です。文字だけでなく、大きさ・余白・配置・背景の飾りも、この画像に合わせてください(飾りの図形など、標準部品で作れないものは、無理に作らず、理由を報告してください)。";
// ユーザーが、Discordに貼った画像を、一時フォルダに保存して、Codexに見せる
async function downloadImages(msg) {
  const out = [];
  for (const a of msg.attachments?.values?.() ?? []) {
    if (!/^image\//.test(a.contentType ?? "")) continue;
    try {
      const r = await fetch(a.url, { signal: AbortSignal.timeout(15000) });
      const f = join(await mkdtemp(join(tmpdir(), "discord-img-")), (a.name || "image.png").replace(/[^\w.\-]/g, "_"));
      await writeFile(f, Buffer.from(await r.arrayBuffer()));
      out.push(f);
    } catch {}
  }
  return out;
}
// ---- ディレクター(自動): 作る → 検査 → 違いがあれば直す を、自動で繰り返す。公開は、しない ----
let autoCancel = false;
let autoRounds = 0; // いま、何回目の検査か(記録用)
let stopRequested = false; // !stop で止めたときに、会話の「やり直し」(再実行)をしないための印
const AUTO_MAX_ROUNDS = Number(process.env.AUTO_MAX_ROUNDS ?? 3);
async function autoSection(ch, n) {
  const t0 = Date.now();
  autoRounds = 0;
  const say = (t) => ch.send(`🧭 ディレクター: ${t}`).catch(() => {});
  let spec;
  try { spec = JSON.parse(readFileSync(inSpec("spec.json"), "utf8")); } catch (e) { await say(`仕様書を読めませんでした(${e.message})`); return "stop"; }
  const first = sectionPrompt(spec, n, { project: BUILD_PROJECT });
  if (!first) { await say(`セクション${n}は、仕様書にありません`); return "stop"; }
  await say(`セクション${n}を、自動で作ります。「作る → 検査 → 違いがあれば直す」を、最大${AUTO_MAX_ROUNDS}回まで繰り返します。公開はしません。止めたいときは \`!stop\`。`);
  // 0) すでに、STUDIOに作ってある(途中まで)セクションは、作り直さず(重複を避ける)、仕様書との違いを直すだけにする
  const shot = specShot(n);
  // 制作先のプロジェクトの編集画面を、先に開いて、読み込みを待つ(違うプロジェクトが開いていると、検査が、別のものを見てしまう)
  if (!(await chatTurn(ch, ch.id, "(準備)", { openProject: true, skipCodex: true })).ok) { await say("制作先の編集画面を、開けませんでした。ここで止めます。"); return "stop"; }
  for (let i = 0; i < 45; i++) { try { const tt = await readStudioTexts({ cdp: BROWSER_CDP }); if (tt.root && tt.length > 20) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
  let exists = false;
  try { const c0 = await checkStudio({ section: n, cdp: BROWSER_CDP }); const tot = c0.ok.length + c0.diffs.length + c0.missing.length; exists = tot > 0 && c0.ok.length + c0.diffs.length >= tot * 0.5; } catch {}
  let t = { ok: true };
  if (exists) {
    await say(`セクション${n}は、すでに、STUDIOに作ってあります。作り直さず、仕様書との違いを、直します。`);
  } else {
  // 1) 作る(失敗したら、理由を聞いて、別のやり方で、もう1回だけ)
    t = await chatTurn(ch, ch.id, shot ? first + SHOT_NOTE : first, { openProject: true, images: shot ? [shot] : [] });
    if (t.why === "limit") return "limit";
    if (!t.ok) {
      if (autoCancel) return "cancel";
      await say("うまくいかなかったようです。理由を聞いて、別のやり方で、もう1回だけ試します。");
      t = await chatTurn(ch, ch.id, "さっきの作業は、うまくいきませんでした。何がうまくいかなかったかを1行で言ってから、別のやり方で、もう一度、やってください。公開はしないでください。", {});
      if (t.why === "limit") return "limit";
      if (!t.ok) { await say(`**ここで止めます。人の確認が必要です。** 2回続けて、うまくいきませんでした。画面を見て、どこで詰まっているか、教えてください。`); return "stop"; }
    }
  }
  // 2) 検査 → 直す
  let prev = null;
  for (let round = 1; round <= AUTO_MAX_ROUNDS; round++) {
    if (autoCancel) return "cancel";
    autoRounds = round;
    let res;
    try { res = await checkStudio({ section: n, cdp: BROWSER_CDP }); } catch (e) { await say(`検査できませんでした(${e.message})。ここで止めます。`); return "stop"; }
    const left = res.diffs.length + res.missing.length;
    await ch.send(formatCheck(res, { section: n })).catch(() => {});
    if (!left) { await say(`✅ セクション${n}は、文字が、すべて、仕様書と合いました。(${Math.round((Date.now() - t0) / 60000 * 10) / 10}分)` + (res.layout?.length ? `\n📐 配置のずれが ${res.layout.length}件 あります(目安)。直すなら \`!fix ${n} 配置\` を送ってください。` : "")); return "ok"; }
    const sig = JSON.stringify([res.diffs.map((d) => d.item.text + d.diffs.join()), res.missing.map((m) => m.text)]);
    if (sig === prev) {
      const field = (d) => d.diffs[0].split(/[:：]/)[0];
      const cmds = res.diffs.slice(0, 5).map((d) => `\`!accept ${String(d.item.text).replace(/\s+/g, "").slice(0, 8)} ${field(d)}\``);
      await say(`**これ以上は、自動では、直せませんでした。** 同じ違いが、${left}件、残っています。人の判断が必要です。\n・「これでよい」なら、次を送ってください(検査から外れます): ${cmds.join(" / ") || "(文字が見つからない項目です。STUDIOに入れるか、省くか、教えてください)"}\n・直したいなら、やり方を、普通の言葉で教えてください(手順書に入れます)。`);
      return "stuck";
    }
    prev = sig;
    if (round === AUTO_MAX_ROUNDS) break;
    await say(`違いが${left}件あります。直します(${round}/${AUTO_MAX_ROUNDS - 1}回目)。`);
    t = await chatTurn(ch, ch.id, fixPrompt(res, n, { project: BUILD_PROJECT }) + (shot ? SHOT_NOTE : ""), { images: shot ? [shot] : [] });
    if (t.why === "limit") return "limit";
    if (!t.ok) { await say("直す作業が、うまくいきませんでした。ここで止めます。人の確認が必要です。"); return "stop"; }
  }
  await say(`${AUTO_MAX_ROUNDS}回まで試しましたが、まだ違いが残っています。人の判断が必要です。`);
  return "stuck";
}

// ---- 1サイト・1回の指示で、完成まで: !site <元のHTML> [STUDIOのプロジェクト名] ----
// 仕様書づくり → 全セクション制作(!auto) → 画像 → 配置 → 見た目の近さ(低いところを、見本の画像を見せて直す)→ 最終報告。
// 止まるとき: 利用上限・!stop・同じ違いが残る(人の判断が必要)。もう一度 !site を送ると、済んだところを飛ばして、続きから動く。
const siteStateFile = () => inSpec("site-state.json");
const VISUAL_MIN = Number(process.env.VISUAL_MIN ?? 70); // 見た目の近さが、これ未満のセクションは、直す
const SITE_VISUAL_ROUNDS = Number(process.env.SITE_VISUAL_ROUNDS ?? 2);
const runNode = (args, ms = 6 * 60 * 1000) => new Promise((res) => execFile("node", args, { timeout: ms, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout ?? ""), err: String(stderr || err?.message || "") })));
const loadSiteState = () => { try { return JSON.parse(readFileSync(siteStateFile(), "utf8")); } catch { return {}; } };
const saveSiteState = (st) => { try { writeFileSync(siteStateFile(), JSON.stringify(st, null, 2)); } catch {} };
async function siteFlow(ch, src, project) {
  const say = (t) => ch.send(`🧭 ディレクター: ${t}`).catch(() => {});
  const stopped = () => autoCancel || chatLimitUntil > Date.now();
  if (project) BUILD_PROJECT = project;
  const dir = `spec-out/${slugFor(src)}`;
  if (specDir() !== dir) { mkdirSync(dir, { recursive: true }); setSpecDir(dir); } // サイトごとに、仕様書・許容・見比べ画像を、分ける
  let st = loadSiteState();
  if (st.src !== src) st = { src, project: BUILD_PROJECT, imagesDone: [], started: new Date().toISOString() };
  st.project = BUILD_PROJECT;
  // 1) 仕様書(新しいサイトのとき、または、まだ無いとき)
  if (!existsSync(inSpec("spec.json")) || st.specFor !== src) {
    await say(`仕様書を作ります(元: ${src})…`);
    const r = await runNode(["scripts/make-spec.js", src, specDir()]);
    if (!r.ok) { await say(`仕様書を作れませんでした: ${r.err.slice(0, 200)}`); return "stop"; }
    st.specFor = src; saveSiteState(st);
    const cov = await runNode(["scripts/spec-coverage.js", src, specDir()]);
    await say(`仕様書ができました。${(cov.out.split("\n")[0] || "").trim()}`);
  }
  let spec = JSON.parse(readFileSync(inSpec("spec.json"), "utf8"));
  const N = spec.pc.sections.length;
  const human = []; // 人の判断が必要なもの
  await say(`**${BUILD_PROJECT}** に、${N}セクションを、作っていきます。公開はしません。止めたいときは \`!stop\`(あとで、もう一度 \`!site\` を送ると、続きから動きます)。`);
  // 制作先の編集画面を、先に開いて、読み込みを待つ(違うプロジェクトを、見てしまわないように)
  if (!(await chatTurn(ch, ch.id, "(準備)", { openProject: true, skipCodex: true })).ok) { await say("制作先の編集画面を、開けませんでした。ここで止めます。"); return "stop"; }
  for (let i = 0; i < 45; i++) { try { const tt = await readStudioTexts({ cdp: BROWSER_CDP }); if (tt.root && tt.length > 20) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
  // 2) 全セクションを作る(すでに合っているところは、飛ばす)
  for (let n = 1; n <= N; n++) {
    if (stopped()) return "stop";
    try { const c = await checkStudio({ section: n, cdp: BROWSER_CDP }); if (c.ok.length > 0 && !c.diffs.length && !c.missing.length) continue; } catch {}
    const t0 = Date.now(); const r = await autoSection(ch, n);
    try { appendFileSync("docs/director-log.csv", `${new Date().toISOString()},${n},${r},${autoRounds},${Math.round((Date.now() - t0) / 1000)}\n`); } catch {}
    if (r === "limit" || r === "cancel" || r === "stop") return r;
    if (r === "stuck") human.push(`セクション${n}: 文字の違いが、自動では、直せませんでした`);
  }
  // 3) 画像
  for (let n = 1; n <= N; n++) {
    if (stopped()) return "stop";
    if (st.imagesDone.includes(n)) continue;
    const ip = imagePrompt(spec, n, { project: BUILD_PROJECT }); if (!ip) continue;
    await say(`セクション${n}の画像を、アップロードして、置きます。`);
    const t = await chatTurn(ch, ch.id, ip, { openProject: false });
    if (t.why === "limit") return "limit";
    if (!t.ok) { human.push(`セクション${n}: 画像を置けませんでした`); continue; }
    st.imagesDone.push(n); saveSiteState(st);
  }
  // 4) 配置(2回まで)
  for (let n = 1; n <= N; n++) {
    for (let k = 0; k < 2; k++) {
      if (stopped()) return "stop";
      let c; try { c = await checkStudio({ section: n, cdp: BROWSER_CDP }); } catch { break; }
      if (!c.layout?.length) break;
      await say(`セクション${n}の配置を直します(${c.layout.length}件・${k + 1}/2回目)。`);
      const t = await chatTurn(ch, ch.id, fixPrompt(c, n, { project: BUILD_PROJECT, layout: true }), {});
      if (t.why === "limit") return "limit";
      if (!t.ok) break;
    }
  }
  // 5) 見た目の近さ(低いセクションを、見本の画像と、いまの画像を見せて、直す)
  let scores = [];
  for (let round = 0; round <= SITE_VISUAL_ROUNDS; round++) {
    if (stopped()) return "stop";
    const cr = await runNode(["scripts/compare-images.js", src, inSpec("compare")]);
    if (!cr.ok) { human.push(`見た目の近さを測れませんでした: ${cr.err.slice(0, 120)}`); break; }
    try { scores = JSON.parse(readFileSync(inSpec("compare", "scores.json"), "utf8")).sections ?? []; } catch { scores = []; }
    const low = scores.filter((x) => x.score < VISUAL_MIN);
    if (!low.length || round === SITE_VISUAL_ROUNDS) break;
    await say(`見た目の近さが ${VISUAL_MIN} 未満のセクションを、見本と見比べて直します(${round + 1}/${SITE_VISUAL_ROUNDS}回目): ${low.map((x) => `${x.n}(${x.score})`).join(", ")}`);
    for (const x of low) {
      if (stopped()) return "stop";
      const t = await chatTurn(ch, ch.id, `STUDIOの「${BUILD_PROJECT}」の、セクション${x.n}を、見本に近づけてください。添付した画像は、左が見本(元のサイト)、右がいまのSTUDIOです。違うところ(余白・大きさ・並び・色・要素の足りなさ)を、画像から読み取って、標準部品で直してください。文字の中身・リンク・すでに合っている部分は、変えないでください。画像のファイル(写真など)が空の枠のままなら、それは、別の作業なので、触らないでください。直せないもの(背景の飾り・アニメーションなど)は、理由を書いて報告してください。公開はしない。`, { images: x.image && existsSync(x.image) ? [resolve(x.image)] : [] });
      if (t.why === "limit") return "limit";
    }
  }
  // 6) 最終報告
  st.finished = new Date().toISOString(); saveSiteState(st);
  const table = scores.map((x) => `${x.score >= 80 ? "🟢" : x.score >= VISUAL_MIN ? "🟡" : "🔴"}セクション${x.n}: ${x.score}`).join(" / ");
  let textState = ""; try { textState = (await progressTable({ cdp: BROWSER_CDP })).split("\n").slice(1).filter((l) => !l.startsWith("✅")).join("\n"); } catch {}
  await say(`**自動の作業が、終わりました**(${BUILD_PROJECT}・${N}セクション)。\n見た目の近さ: ${table || "(測れませんでした)"}\n${textState ? `文字が、まだ合っていないセクション:\n${textState}\n` : "文字は、すべてのセクションで、仕様書と合っています。\n"}${human.length ? `人の判断が必要なもの:\n${human.map((h) => `・${h}`).join("\n")}\n` : ""}\`!compare\` で、画像を見られます。気になるところは、普通の言葉で、伝えてください。`);
  return "ok";
}

async function handleTask(msg, t) {
  if (seenTasks.has(t.id)) return;
  seenTasks.add(t.id);
  // 公開タスク(requiresApproval か、IDに -publish- を含む)は、署名付きの公開承認がなければ実行しない
  const isPublish = t.requiresApproval === true || String(t.id).includes("-publish-");
  if ((REQUIRE_APPROVAL || isPublish) && !verifyApproval(APPROVAL_SECRET, t.inputs?.approval, t.job)) {
    await msg.channel.send(JSON.stringify({
      v: 1, type: "result", id: t.id, from: AGENT_NAME, status: "blocked",
      summary: "有効な公開承認がないため実行しません", error: "approval_invalid",
    }));
    return;
  }
  // ほかの作業(会話・!build・!auto)と、同じ専用Chromeを使うので、順番待ちの列に入れてから、ブラウザを整える
  chain = chain.then(() => runTask(msg, t, isPublish)).catch((e) => console.error(e));
}

async function runTask(msg, t, isPublish) {
  const timing = { recvAt: Date.now() }; // 段階ごとの所要時間(ms)。結果JSONに載せて、ディレクターが #log に出す
  const logCh = LOG_CHANNEL_ID ? await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null) : null;
  await logCh?.send(`🧹 [${roleLabel(AGENT_NAME)}] ブラウザを整えています(古いタブを閉じて、STUDIOの一覧を開きます)…`);
  const br = await ensureBrowser((m) => logCh?.send(`🔧 ${m}`).catch(() => {}), { keepEditor: isPublish }); // 公開は、直前の編集画面から行うので、一覧に戻さない
  timing.guardMs = Date.now() - timing.recvAt;
  if (!br.ok) {
    await logCh?.send(`⛔ [${roleLabel(AGENT_NAME)}] 作業できません\n👉 ${BROWSER_ERR[br.code] ?? br.code}`);
    await msg.channel.send(JSON.stringify({
      v: 1, type: "result", id: t.id, from: AGENT_NAME,
      status: br.code === "browser_down" || br.code === "login_required" ? "blocked" : "failed",
      summary: BROWSER_ERR[br.code] ?? br.code, error: br.code,
    }));
    return;
  }
  await logCh?.send(`🛠️ [${roleLabel(AGENT_NAME)}] 作業を始めました: ${t.title ?? t.id}`);
  try {
      // 作業の様子を、数秒ごとに #log へ流す(裏で動いていても、何をしているか分かるように)
      const buf = []; let sentN = 0;
      const flush = async () => {
        if (!buf.length || !logCh) return;
        const text = compress(buf.splice(0)).join("\n").slice(0, 1900);
        if (sentN++ < 40) await logCh.send(text).catch(() => {});
      };
      const timer = setInterval(flush, 4000);
      timing.codexStartAt = Date.now();
      const knownExpected = isPublish ? null : extractExpectedText(t.instructions ?? t.title ?? "");
      // 依頼に「○○」に変えて、がなくても、Codexに CHANGED_TO: を書かせて、Botが確認する(Codexに再読み込みさせない)
      const botVerifies = !isPublish && (process.env.VERIFY_MODE ?? "warn") !== "off" && process.env.BROWSER_CHECK !== "0";
      // Botが先に、対象プロジェクトの「デザインエディタ」を押しておく(読み込みの待ちを、Codexの起動と並行させる)。EDITOR_PREOPEN=0 で無効
      let editorOpening = false;
      const projName = (t.instructions ?? t.title ?? "").match(/STUDIOの「([^」]+)」/)?.[1];
      if (!isPublish && process.env.EDITOR_PREOPEN !== "0" && process.env.BROWSER_CHECK !== "0" && projName) {
        const t0 = Date.now();
        const o = await openEditor({ cdp: BROWSER_CDP, name: projName });
        timing.preopenMs = Date.now() - t0;
        editorOpening = o.clicked;
        await logCh?.send(o.clicked ? `🚪 [${roleLabel(AGENT_NAME)}] 編集画面を先に開きました: ${o.detail}` : `ℹ️ 編集画面の先開きは、しませんでした(${o.detail}。Codexが自分で開きます)`).catch(() => {});
      }
      const r = await runCodex(buildPrompt(t, botVerifies, !knownExpected, editorOpening), makeProgress((x) => buf.push(x)));
      timing.codexMs = Date.now() - timing.codexStartAt;
      clearInterval(timer);
      await flush();
      // 完了の判定: 終了コードだけでなく、Codex自身の「RESULT: OK/FAILED/BLOCKED」を見る(未実施なのに完了扱いを防ぐ)
      const lim = r.code !== 0 ? detectUsageLimit(r.text) : null;
      const mk = [...r.text.matchAll(/RESULT:\s*(OK|FAILED|BLOCKED)/gi)].pop()?.[1]?.toUpperCase();
      const status = lim ? "blocked" : r.code !== 0 ? "failed" : mk === "OK" ? "done" : mk === "BLOCKED" ? "blocked" : "failed";
      const why = lim ? "usage_limit" : r.code !== 0 ? `code=${r.code}${r.sig ? " " + r.sig : ""}` : mk ? (mk === "OK" ? null : `reported_${mk.toLowerCase()}`) : "no_result_marker";
      // Bot自身の確認: Codexが「完了」と言っても、再読み込みして、変更後の文字が本当にあるかを見る。VERIFY_MODE=off で無効 / strict で、見つからなければ失敗にする(既定: warn=警告だけ)
      let finalStatus = status, verifyNote = null;
      const VERIFY_MODE = process.env.VERIFY_MODE ?? "warn";
      const expected = isPublish ? null : (knownExpected ?? r.text.match(/CHANGED_TO:\s*(.+)/)?.[1]?.trim().replace(/^[「"']|[」"']$/g, "") ?? null);
      if (status === "done" && expected && VERIFY_MODE !== "off" && process.env.BROWSER_CHECK !== "0") {
        await logCh?.send(`🔍 [${roleLabel(AGENT_NAME)}] Bot自身で、再読み込みして「${expected}」を確認しています…`).catch(() => {});
        const t0 = Date.now();
        const v = await verifyText({ cdp: BROWSER_CDP, expected });
        timing.verifyMs = Date.now() - t0;
        if (v.status === "verified") verifyNote = `Botが再読み込み後に「${expected}」を確認しました`;
        else if (v.status === "not_found") {
          verifyNote = `⚠️ ${v.detail}`;
          if (VERIFY_MODE === "strict") finalStatus = "failed";
        } else verifyNote = `(Botでの確認はできませんでした: ${v.detail})`;
        await logCh?.send(`${v.status === "verified" ? "✅" : v.status === "not_found" ? "⚠️" : "ℹ️"} ${verifyNote}`).catch(() => {});
      }
      timing.endAt = Date.now();
      if (finalStatus === "done" && !isPublish) await postShot(logCh, `[${t.id}] 作業後のSTUDIOの画面`);
      if (finalStatus !== "done") needDeep = true; // 失敗の後は、次に念入りに整える
      const result = {
        v: 1, type: "result", id: t.id, from: AGENT_NAME, status: finalStatus,
        summary: lim ? `Codexの利用上限に達しました。再開できる時刻: ${lim.at ?? "不明"}` : r.text.replace(/RESULT:\s*(OK|FAILED|BLOCKED)/gi, "").replace(/CHANGED_TO:.*\n?/g, "").trim().slice(0, 1500),
        error: finalStatus !== status ? "verify_failed" : why, timing,
        ...(lim?.atMs ? { limitUntil: lim.atMs } : {}),
      };
      if (verifyNote) result.summary = `${result.summary}\n${verifyNote}`.slice(0, 1500);
      await msg.channel.send(JSON.stringify(result));
      await logCh?.send(`${finalStatus === "done" ? "✅" : "❌"} [${roleLabel(AGENT_NAME)}] 作業を終えました(${finalStatus === "done" ? "完了" : finalStatus === "blocked" ? "要対応" : "失敗"}): ${t.title ?? t.id}`);
  
  } catch (e) { // どこかで例外が出ても、ディレクターに「失敗」を返す(返さないと、30分以上、待たされる)
    console.error(e);
    await msg.channel.send(JSON.stringify({ v: 1, type: "result", id: t.id, from: AGENT_NAME, status: "failed", summary: `作業中にエラーが出ました: ${String(e?.message ?? e).slice(0, 200)}`, error: "worker_exception" })).catch(() => {});
  }
}

client.on("messageCreate", async (msg) => {
  if (TASKS_CHANNEL_ID && msg.channelId === TASKS_CHANNEL_ID) {
    // 司令塔Botの発言のみ受け付ける
    if (!msg.author.bot || msg.author.id !== ORCHESTRATOR_BOT_ID) return;
    let t;
    try { t = JSON.parse(msg.content); } catch { return; }
    if (t?.type === "task" && t.to === AGENT_NAME && t.id) await handleTask(msg, t);
    return;
  }
  if (msg.author.bot) return;
  if (!CHANNELS.has(msg.channelId)) return;
  if (!ALLOWED.has(msg.author.id)) return; // 許可ユーザー以外は無視

  const text = normalizeCommand(msg.content);
  if (!text) return;

  if (text === "!stop") {
    autoCancel = true; // 自動作業(!auto)も、次の区切りで止める
    stopRequested = true;
    if (current) { current.kill("SIGTERM"); return void msg.reply(`[${AGENT_NAME}] 中断しました`); }
    return void msg.reply(`[${AGENT_NAME}] 実行中のタスクはありません`);
  }
  if (text === "!shot") { await postShot(msg.channel, "いまのSTUDIOの画面", { bottom: true }); return; } // Codexを使わず、画面だけ貼る
  // 検査役: 仕様書(spec-out/spec.json)と、いまのSTUDIOの編集画面を見比べて、違いを一覧にする。!check / !check 2(セクション2だけ)
  if (/^!check(\s+\d+)?$/.test(text)) {
    const section = Number(text.split(/\s+/)[1]) || null;
    try { await msg.reply(formatCheck(await checkStudio({ section, cdp: BROWSER_CDP }), { section })); }
    catch (e) { await msg.reply(`検査できませんでした: ${e.message}(仕様書は \`npm run spec -- 移植元のHTML\` で作ります。編集画面を開いてから送ってください)`); }
    return;
  }
  if (text === "!progress") {
    try { await msg.reply(await progressTable({ cdp: BROWSER_CDP })); } catch (e) { await msg.reply(`進み具合を出せませんでした: ${e.message}`); }
    return;
  }
  if (text === "!limit clear") { chatLimitUntil = 0; return void msg.reply("利用上限の記録を、消しました"); }
  if (text === "!lessons") { // 貯まった「学び」を見る
    const t = readIf("docs/lessons.md");
    return void msg.reply(t ? `📝 学びの記録(新しい順に最大8件)\n${t.split("\n").filter(Boolean).slice(-8).reverse().join("\n")}`.slice(0, 1900) : "まだ、学びの記録は、ありません");
  }
  // 1サイト・1回の指示で、完成まで: !site <元のHTMLのパス> [STUDIOのプロジェクト名]
  const sm = text.match(/^!site\s+("[^"]+"|'[^']+'|\S+)(?:\s+(.+))?$/); // パスに空白があるときは、"…" で囲む
  if (sm) {
    if (chatLimitUntil > Date.now()) return void msg.reply(`⏸ Codex(ChatGPT)の利用上限中です。${fmtTime(chatLimitUntil)} 以降に、もう一度送ってください`);
    const src = sm[1].replace(/^["']|["']$/g, "").replace(/^file:\/\//, "");
    if (!/^https?:/.test(src) && !existsSync(src)) return void msg.reply(`元のHTMLが見つかりません: ${src}`);
    autoCancel = false;
    msg.react("🧭").catch(() => {});
    chain = chain.then(async () => {
      const r = await siteFlow(msg.channel, src, sm[2]?.trim());
      if (r !== "ok") await msg.channel.send(`🧭 ディレクター: 途中で止まりました(${r === "limit" ? "利用上限。再開は、時刻のあとに、もう一度 !site" : r === "cancel" ? "中断" : "停止"})。同じ \`!site\` を、もう一度、送ると、済んだところを飛ばして、続きから動きます。`).catch(() => {});
    }).catch((e) => console.error(e));
    return;
  }
  const am = text.match(/^!auto\s+(\d+)(?:\s*-\s*(\d+))?$/) ?? (text === "!auto all" ? ["", "1", String(Math.max(1, (() => { try { return JSON.parse(readFileSync(inSpec("spec.json"), "utf8")).pc.sections.length; } catch { return 1; } })()))] : null); // !auto 3 / !auto 3-5 / !auto all(すでに文字が全部合っているセクションは、飛ばす)
  if (am) {
    if (chatLimitUntil > Date.now()) return void msg.reply(`⏸ Codex(ChatGPT)の利用上限中です。${fmtTime(chatLimitUntil)} 以降に、もう一度送ってください`);
    const from = Number(am[1]), to = Number(am[2] ?? am[1]);
    autoCancel = false;
    msg.react("🧭").catch(() => {});
    chain = chain.then(async () => {
      for (let n = from; n <= to; n++) {
        // すでに、文字が、すべて合っているセクションは、飛ばす(重複して作らないため)
        try {
          const cr = await checkStudio({ section: n, cdp: BROWSER_CDP });
          if (cr.ok.length > 0 && !cr.diffs.length && !cr.missing.length) { await msg.channel.send(`🧭 ディレクター: セクション${n}は、すでに、文字が、すべて合っているので、飛ばします。`).catch(() => {}); continue; }
        } catch {}
        const t0 = Date.now();
        const r = await autoSection(msg.channel, n);
        try { appendFileSync("docs/director-log.csv", `${new Date().toISOString()},${n},${r},${autoRounds},${Math.round((Date.now() - t0) / 1000)}\n`); } catch {} // どの終わり方でも、記録する
        if (r === "limit" || r === "cancel" || r === "stop") { await msg.channel.send(`🧭 ディレクター: 自動作業を止めました(セクション${n}で${r === "limit" ? "利用上限" : r === "cancel" ? "中断" : "停止"})。`).catch(() => {}); return; }
        if (r === "stuck" && n < to) { await msg.channel.send(`🧭 ディレクター: セクション${n}に、直せない違いが残っているので、ここで一度止めます。判断をいただいたら、\`!auto ${n + 1}-${to}\` で続けられます。`).catch(() => {}); return; }
      }
      await msg.channel.send(`🧭 ディレクター: 自動作業が終わりました。\`!progress\` で、全体の進み具合を見られます。`).catch(() => {});
    }).catch((e) => console.error(e));
    return;
  }
  // 「この違いは、これでよい」と決める: !accept 料金プラン 色(文字の一部と、項目: 色/文字の大きさ/太さ/行間/字間/フォント)
  const ac = text.match(/^!accept\s+(\S+)\s+(色|画像|文字の大きさ|太さ|行間|字間|フォント|位置\(左\)|幅|高さ\(行数\)|縦の位置\(先頭の文字から\))$/);
  if (ac) { addAccepted(ac[1], ac[2]); return void msg.reply(ac[2] === "画像" ? `✅ 「${ac[1]}」は、画像で代用する、と記録しました。文字として無くても、検査では、見つからない扱いにしません。` : `✅ 「${ac[1]}」の${ac[2]}の違いは、これでよい、と記録しました。検査では、違いに数えません。`); }
  // 元のサイトと、いまのSTUDIOを、並べた画像を作って貼る(Codexは使わない。画面は、スクロールだけする)
  if (text === "!compare") {
    let src; try { const u = JSON.parse(readFileSync(inSpec("spec.json"), "utf8")).url; src = /^https?:/.test(u) ? u : decodeURIComponent(new URL(u).pathname); } catch { return void msg.reply("仕様書(spec-out/spec.json)が見つかりません"); }
    await msg.reply("🖼️ 元のサイトと、いまのSTUDIOを、並べています。1〜2分かかります…");
    execFile("node", ["scripts/compare-images.js", src, inSpec("compare")], { timeout: 6 * 60 * 1000 }, async (err, stdout, stderr) => {
      if (err) return void msg.channel.send(`並べる画像を作れませんでした: ${String(stderr || err.message).slice(0, 300)}(STUDIOの編集画面を、開いてから、もう一度)`);
      try {
        const { sections = [], files } = JSON.parse(readFileSync(inSpec("compare", "scores.json"), "utf8"));
        const mark = (v) => (v >= 80 ? "🟢" : v >= 50 ? "🟡" : "🔴");
        const list = sections.map((x) => `${mark(x.score)}セクション${x.n}: ${x.score}`).join("\n");
        await msg.channel.send({ content: `🖼️ 左=元のサイト / 右=いまのSTUDIO(上から順に${files.length}枚)\n見た目の近さ(0〜100・輪郭の重なり具合。🟢80以上 / 🟡50〜79 / 🔴50未満):\n${list}\n※画像(ロゴ・写真)が空の枠だと、下がります。数字は目安なので、画像の中身を、目で見て確かめてください。`, files: files.slice(0, 10).map((f) => new AttachmentBuilder(join(specDir(), "compare", f))) });
      } catch (e) { await msg.channel.send(`画像の送信に失敗しました: ${e.message}`); }
    });
    return;
  }
  if (text === "!help") { // コマンド表(docs/commands.md)を貼る
    const t = readIf("docs/commands.md");
    for (const c of chunks(t || "コマンド表が見つかりません(docs/commands.md)")) await msg.channel.send(c);
    return;
  }
  if (text === "!health") { // 動かす前の、点検(Codexは使わない)
    const ok = (b) => (b ? "✅" : "❌");
    const rows = [];
    let pages = null;
    try { pages = (await (await fetch(`${BROWSER_CDP}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((t) => t.type === "page"); } catch {}
    rows.push(`${ok(pages)} 専用Chrome(${BROWSER_CDP})${pages ? "" : " … 起動していません。`npm run browser` で起動してください"}`);
    if (pages) {
      const st = pages.filter((t) => /studio\.design/.test(t.url));
      rows.push(`${ok(st.length)} STUDIOのタブ ${st.length}個${st.some((t) => /\/login/.test(t.url)) ? "(ログインが切れています)" : ""}`);
      rows.push(`${ok(st.some((t) => /\/editor/.test(t.url)))} 編集画面が開いている`);
      if (pages.length > st.length) rows.push(`ℹ️ STUDIO以外のタブが ${pages.length - st.length}個 あります(作業の整え直しで、閉じられることがあります)`);
    }
    let specInfo = `❌ 仕様書(${inSpec("spec.json")})が、ありません。npm run spec -- 元のHTML で作ります`;
    try { const f = inSpec("spec.json"); const sp = JSON.parse(readFileSync(f, "utf8")); const age = Math.round((Date.now() - statSync(f).mtimeMs) / 3600000); specInfo = `✅ 仕様書: ${sp.pc.sections.length}セクション(${age}時間前に作成)/ 元: ${decodeURIComponent(String(sp.url).split("/").slice(-2).join("/"))}`; } catch {}
    rows.push(specInfo);
    let proj = ""; try { proj = Object.keys(JSON.parse(readIf(process.env.PROJECTS_FILE ?? "projects.json") || "{}")).includes(BUILD_PROJECT) ? "✅" : "❌"; } catch { proj = "❌"; }
    rows.push(`${proj} 制作先「${BUILD_PROJECT}」が projects.json にある`);
    rows.push(`${chatLimitUntil > Date.now() ? "⏸" : "✅"} Codex(ChatGPT): ${chatLimitUntil > Date.now() ? `利用上限中(${fmtTime(chatLimitUntil)} まで)` : "使えるはず(上限の記録なし)"}`);
    let acc = 0, les = 0; try { acc = JSON.parse(readFileSync(inSpec("accepted.json"), "utf8")).length; } catch {} try { les = readIf("docs/lessons.md").split("\n").filter((l) => l.startsWith("- ")).length; } catch {}
    rows.push(`ℹ️ 「これでよい」の記録 ${acc}件 / 学び ${les}件 / 画面の自動投稿 ${process.env.SCREENSHOT === "0" ? "オフ" : "オン"}`);
    return void msg.reply(`🩺 点検\n${rows.join("\n")}`.slice(0, 1900));
  }
  if (text === "!ping") return void msg.reply(`[${AGENT_NAME}] online`);

  if (text === "!new") { delete sessions[msg.channelId]; saveSessions(); return void msg.reply(`[${AGENT_NAME}] 会話をリセットしました。次のメッセージから、新しい会話を始めます`); }
  if (text === "!session") return void msg.reply(sessions[msg.channelId] ? `セッション: \`${sessions[msg.channelId]}\`(\`codex resume ${sessions[msg.channelId]}\` で、Codexで続きを見られます)` : "まだ会話が始まっていません");

  let userText = text;
  const fm = text.match(/^!fix\s+(\d+)(\s+配置)?$/);
  if (fm) { // 検査をして、見つかった違いから、直す依頼文を作って、会話に渡す(検査 → 直す の自動化)
    try {
      const n = Number(fm[1]);
      const fp = fixPrompt(await checkStudio({ section: n, cdp: BROWSER_CDP }), n, { project: BUILD_PROJECT, layout: !!fm[2] });
      if (!fp) return void msg.reply(fm[2] ? `✅ セクション${n}は、配置のずれが、ありません` : `✅ セクション${n}は、直すところが、ありません(文字は、すべて、仕様書と合っています)`);
      userText = fp;
      await msg.channel.send(`🔧 セクション${n}の違いを検査して、直す依頼文を作りました。このまま、作業に渡します。`).catch(() => {});
    } catch (e) { return void msg.reply(`検査できませんでした: ${e.message}(編集画面を開いてから、もう一度)`); }
  }
  const bm = text.match(/^!build\s+(\d+)$/);
  if (bm) { // 仕様書から、そのセクションの依頼文を作って、そのまま会話に渡す
    try {
      const spec = JSON.parse(readFileSync(inSpec("spec.json"), "utf8"));
      userText = sectionPrompt(spec, Number(bm[1]), { project: BUILD_PROJECT });
      if (!userText) return void msg.reply(`セクション${bm[1]}は、仕様書にありません(1〜${spec.pc.sections.length})`);
      await msg.channel.send(`🧱 セクション${bm[1]}の依頼文を、仕様書から作りました。このまま、作業に渡します。`).catch(() => {});
    } catch (e) { return void msg.reply(`仕様書を読めませんでした: ${e.message}(\`npm run spec -- 移植元のHTML\` で作ります)`); }
  }
  // ---- チャットモード: 同じチャンネルの会話は、同じCodexセッションで続ける ----
  if (chatLimitUntil > Date.now()) { // Codexの利用上限の間は、ブラウザの準備もせず、すぐ案内する(無駄な再試行を避ける)
    return void msg.reply(`⏸ Codex(ChatGPT)の利用上限中です。**${fmtTime(chatLimitUntil)}** 以降に、もう一度送ってください。(\`!check\` \`!progress\` \`!shot\` は、上限中でも使えます。上限が解除されたはずのときは \`!limit clear\`)`);
  }
  msg.react("👀").catch(() => {});
  const images = await downloadImages(msg);
  if (images.length && !bm && !fm) userText += "\n\n(添付した画像は、ユーザーが貼った参考画像です。見た目を、これに合わせてください)";
  if (bm) { const sh = specShot(Number(bm[1])); if (sh) { images.push(sh); userText += SHOT_NOTE; } }
  if (fm) { const sh = specShot(Number(fm[1])); if (sh) { images.push(sh); userText += SHOT_NOTE; } }
  chain = chain.then(() => chatTurn(msg.channel, msg.channelId, userText, { openProject: !!bm, images })).catch((e) => console.error(e));
});

// ネットワークの一時的な切れ(Discordとの接続の失敗)で、プロセスごと落ちないようにする
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message ?? e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message ?? e));
client.once("ready", () => console.log(`[${AGENT_NAME}] logged in as ${client.user.tag}`));
client.login(DISCORD_TOKEN);
