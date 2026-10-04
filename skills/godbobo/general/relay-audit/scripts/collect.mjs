#!/usr/bin/env node
// 采集 relay-audit 诊断需要的确定性数据，按项目汇总。只读打开 T3 的数据库，对仓库只做只读 git 操作。
//   - 人类消息：重复、催促、纠正、粘贴等，附上每条之前 agent 的最后一句话
//   - agent 命令：临时脚本、/tmp 目录、sleep 等待、手动起服务，以及反复执行或反复失败的命令
//   - 代码库：默认分支上新增的类型逃逸、lint 豁免、临时方案注释、跳过的测试、吞掉的错误
//   - 环境快照：AGENTS.md、PR 模板、CI、lint 配置、仓库内技能、特性地图
//
// 用法：
//   node collect.mjs [--since <ISO 时间|Nd>] [--baseline <天数>] [--project <项目名>] [--out <文件>]
//     --since     本期起点，默认取 ledger.json 的 lastRunAt，没有则 3d
//     --baseline  基线天数，默认 14，用来发现低频但反复出现的问题
//     --project   只看某个项目（T3 项目名）
//     --out       摘要文件路径，默认 <状态目录>/reports/<本期终点>-digest.md
//   node collect.mjs --count <正则> [--project <项目名>] [--baseline <天数>]
//     统计匹配的人类消息在基线和本期的次数与每日频率，提建议时用它定指标
//   node collect.mjs --thread <线程 ID 前缀> [--limit <条数>]
//     按时间顺序打印某个线程的人类消息和 agent 回复（跨项目可用）
//
// 终端只打印总览和摘要路径，细节写在摘要文件里，按项目分节。
// 状态目录：$RELAY_AUDIT_HOME，默认 ~/.local/state/relay-audit；T3 目录：$T3_HOME，默认 ~/.t3

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const DAY = 864e5;
const STATE_DIR = process.env.RELAY_AUDIT_HOME ?? join(homedir(), ".local/state/relay-audit");
const LEDGER_PATH = join(STATE_DIR, "ledger.json");
const DB_PATH = join(process.env.T3_HOME ?? join(homedir(), ".t3"), "userdata/statev2.sqlite");
// 已采纳之后的条目才需要复盘指标
const REVIEW_STATUSES = new Set(["adopted", "done", "verified", "ineffective"]);
const SELF_MARKER = /relay-audit/i;

if (!existsSync(DB_PATH)) fail(`找不到 T3 数据库：${DB_PATH}`);
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const REQUIRED = {
  projection_projects: ["project_id", "title", "workspace_root", "deleted_at"],
  orchestration_v2_projection_threads: ["thread_id", "project_id", "title", "updated_at", "deleted_at", "payload_json"],
  orchestration_v2_projection_messages: ["thread_id", "role", "created_at", "payload_json"],
  orchestration_v2_projection_turn_items: ["thread_id", "type", "updated_at", "payload_json"],
  scheduled_tasks: ["prompt"],
};
for (const [table, cols] of Object.entries(REQUIRED)) {
  const have = new Set(db.prepare("select name from pragma_table_info(?)").all(table).map((r) => r.name));
  const missing = cols.filter((c) => !have.has(c));
  if (missing.length) {
    fail(`T3 数据库结构变了：${table} 缺少 ${missing.join(", ")}（表不存在时会全部缺失）。先更新 collect.mjs，不要在旧结构上继续分析。`);
  }
}

const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<私钥已隐藏>"],
  [/\b(?:sk|fsk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, "<密钥已隐藏>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<密钥已隐藏>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<密钥已隐藏>"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "<密钥已隐藏>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<令牌已隐藏>"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1<令牌已隐藏>"],
  [/((?:api[_-]?key|token|secret|password|passwd|密钥|密码|口令)\s*[:=：]\s*)\S+/gi, "$1<已隐藏>"],
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1<凭证已隐藏>@"],
];
const redact = (s) => REDACTIONS.reduce((acc, [re, to]) => acc.replace(re, to), s ?? "");
const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const head = (s, n) => {
  const t = oneLine(redact(s));
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const tail = (s, n) => {
  const t = oneLine(redact(s));
  return t.length > n ? `…${t.slice(-n)}` : t;
};
const localTime = (iso) => {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const perDay = (n, ms) => (ms > 0 ? n / (ms / DAY) : 0);
const fmtRate = (r) => r.toFixed(r >= 10 ? 0 : 1);

// ---------- 线程模式 ----------
const threadArg = argValue("--thread");
if (threadArg) {
  const t = db
    .prepare(
      `select t.thread_id, t.title, p.title as project from orchestration_v2_projection_threads t
       left join projection_projects p on p.project_id = t.project_id where t.thread_id like ? || '%' limit 2`,
    )
    .all(threadArg);
  if (t.length !== 1) fail(t.length ? `前缀 ${threadArg} 匹配到多个线程，请给更长的前缀` : `找不到线程 ${threadArg}`);
  const limit = Number(argValue("--limit") ?? 80);
  const rows = db
    .prepare(
      `select * from (select role, created_at, payload_json from orchestration_v2_projection_messages
       where thread_id = ? order by created_at desc limit ?) order by created_at`,
    )
    .all(t[0].thread_id, limit);
  console.log(`# 《${head(t[0].title ?? "", 80)}》 项目：${t[0].project ?? "?"}  ID：${t[0].thread_id}\n`);
  for (const r of rows) {
    const p = parseJson(r.payload_json);
    const who = r.role === "user" ? (p.createdBy === "user" ? "你" : "自动消息") : "agent";
    console.log(`[${localTime(r.created_at)}] ${who}：${head(p.text ?? "", r.role === "user" ? 800 : 500)}\n`);
  }
  process.exit(0);
}

// ---------- 时间窗口 ----------
const ledger = existsSync(LEDGER_PATH) ? parseJson(readFileSync(LEDGER_PATH, "utf8")) : {};
ledger.items ??= [];
const now = Date.now();
const windowEnd = new Date(now).toISOString();
const sinceArg = argValue("--since") ?? ledger.lastRunAt ?? "3d";
const daysMatch = /^(\d+(?:\.\d+)?)d$/.exec(sinceArg);
const sinceMs = daysMatch ? now - Number(daysMatch[1]) * DAY : Date.parse(sinceArg);
if (Number.isNaN(sinceMs)) fail(`无法解析 --since：${sinceArg}`);
const since = new Date(sinceMs).toISOString();
const baselineStart = new Date(Math.min(sinceMs, now - Number(argValue("--baseline") ?? 14) * DAY)).toISOString();
const projectFilter = argValue("--project");

// ---------- 读数据 ----------
const projects = new Map(
  db.prepare("select project_id, title, workspace_root from projection_projects where deleted_at is null").all().map((p) => [p.project_id, p]),
);
const threads = new Map();
for (const t of db
  .prepare("select thread_id, project_id, title, payload_json from orchestration_v2_projection_threads where deleted_at is null and updated_at >= ?")
  .all(baselineStart)) {
  const p = parseJson(t.payload_json);
  threads.set(t.thread_id, {
    id: t.thread_id,
    project: projects.get(t.project_id)?.title ?? "(无项目)",
    title: t.title ?? "",
    subagent: p.lineage?.relationshipToParent === "subagent",
  });
}
const scheduledPrompts = new Set(db.prepare("select prompt from scheduled_tasks").all().map((r) => oneLine(r.prompt ?? "")));

const NUDGE = /^(继续|按推荐|按建议|确认|开工|开始|需要|好的?|可以|行|嗯|对|是的?|同意|没问题|就这样|ok|okay|go|yes|y)[。.!！~～\s]*$/i;
const CORRECTION = /^(不对|不是|还是|又|为什么|怎么还|没有|并没有|仍然|依然)|还是(没|不|有|看不)|没生效|不生效|看不到|没改|改错/;
const PASTE = /```|https?:\/\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\bat .+:\d+:\d+|Error:|Exception|Traceback|报错|审查意见|日志/i;
const HANDOFF = /怎么操作|应该怎么(做|选|弄|设置)|需要我(做|操作)|告诉我.*(步骤|怎么)|我来操作/;
const tagsOf = (text) => {
  const t = text.trim();
  const tags = [];
  if (t.length <= 12 && NUDGE.test(t)) tags.push("催促");
  if (/^[/$][\w-]+/.test(t)) tags.push("调用技能");
  if (CORRECTION.test(t)) tags.push("纠正");
  if (HANDOFF.test(t)) tags.push("交给你做");
  if (t.length > 800 || PASTE.test(t)) tags.push("粘贴");
  return tags;
};
const clusterKey = (text) =>
  oneLine(
    text
      .replace(/https?:\/\/\S+/g, "<链接>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<ID>")
      .replace(/#?\d+/g, "<数字>"),
  ).slice(0, 40);

const excludedThreads = new Set();
const human = [];
for (const r of db
  .prepare("select thread_id, created_at, payload_json from orchestration_v2_projection_messages where role = 'user' and created_at >= ? order by created_at")
  .all(baselineStart)) {
  const thread = threads.get(r.thread_id);
  if (!thread || thread.subagent) continue;
  const p = parseJson(r.payload_json);
  const text = p.text ?? "";
  if (SELF_MARKER.test(text)) excludedThreads.add(thread.id);
  if (p.createdBy !== "user" || !text.trim() || scheduledPrompts.has(oneLine(text))) continue;
  human.push({ thread, project: thread.project, at: r.created_at, text, tags: tagsOf(text), key: clusterKey(text), inWindow: r.created_at >= since });
}
const msgs = human.filter((m) => !excludedThreads.has(m.thread.id) && (!projectFilter || m.project === projectFilter));
const windowMs = now - sinceMs;
const baselineMs = sinceMs - Date.parse(baselineStart);

// ---------- 统计模式 ----------
const countArg = argValue("--count");
if (countArg) {
  const re = new RegExp(countArg, "i");
  const hit = msgs.filter((m) => re.test(m.text));
  const w = hit.filter((m) => m.inWindow).length;
  const b = hit.length - w;
  console.log(`/${countArg}/${projectFilter ? ` 项目 ${projectFilter}` : ""}`);
  console.log(`基线 ${baselineStart} → ${since}：${b} 次，${fmtRate(perDay(b, baselineMs))}/天`);
  console.log(`本期 ${since} → ${windowEnd}：${w} 次，${fmtRate(perDay(w, windowMs))}/天`);
  const byProject = {};
  for (const m of hit) byProject[m.project] = (byProject[m.project] ?? 0) + 1;
  console.log(`分项目：${Object.entries(byProject).map(([k, v]) => `${k} ${v}`).join("，") || "无"}`);
  process.exit(0);
}

// ---------- 汇总 ----------
const prevAssistant = db.prepare(
  "select payload_json from orchestration_v2_projection_messages where thread_id = ? and role = 'assistant' and created_at < ? order by created_at desc limit 1",
);
const agentTail = (m, n) => {
  const text = parseJson(prevAssistant.get(m.thread.id, m.at)?.payload_json).text;
  return text ? tail(text, n) : "（线程首条消息）";
};

const clusters = new Map();
for (const m of msgs) {
  const c = clusters.get(m.key) ?? { key: m.key, sample: m.text, total: 0, inWindow: 0, projects: new Set(), items: [] };
  c.total += 1;
  if (m.inWindow) c.inWindow += 1;
  c.projects.add(m.project);
  c.items.push(m);
  clusters.set(m.key, c);
}
const isRepeat = (m) => clusters.get(m.key).total >= 3;

const signalCounts = new Map();
for (const r of db
  .prepare(
    `select thread_id, type, count(*) as n from orchestration_v2_projection_turn_items
     where type in ('error', 'run_interrupt_request', 'user_input_request') and updated_at >= ? group by thread_id, type`,
  )
  .all(since)) {
  const thread = threads.get(r.thread_id);
  if (!thread || excludedThreads.has(thread.id)) continue;
  const s = signalCounts.get(thread.project) ?? { error: 0, subagentError: 0, run_interrupt_request: 0, user_input_request: 0 };
  s[r.type === "error" && thread.subagent ? "subagentError" : r.type] += r.n;
  signalCounts.set(thread.project, s);
}

// agent 执行的命令（含子代理线程）。反复手搭的脚本和环境说明缺一个现成的 CLI
const AD_HOC = [
  ["临时脚本", /\b(python3?|node|ruby|bash|sh)\s+(-[ce]\b|-\s*<<)/],
  ["手搓超时", /perl\s+-e\s+['"]alarm/],
  ["长时间 sleep 等待", /\bsleep\s+([5-9]|\d{2,})\b/],
  ["手动起服务", /\bnohup\b|&\s*disown|&\s*\)/],
  ["/tmp 临时目录", /\/tmp\//],
];
// 读文件、查状态这类只读命令重复很正常，不算信号
const READ_ONLY = /^(sed -n|cat|nl|rg|grep|ls|head|tail|wc|find|pwd|echo|git (status|diff|log|show|branch)|Preparing|Running)\b/;
const commandKey = (input) =>
  input
    .replace(/^\s*\/bin\/(ba|z)?sh\s+-l?c\s+["']?/, "")
    .replace(/^\s*(cd\s+\S+\s*&&\s*)+/, "")
    .replace(/^(\w+=\S+\s+)+/, "")
    .replace(/\/Users\/[^\s'"]+|~\/[^\s'"]+|\/tmp\/[^\s'"]+/g, "<路径>")
    .replace(/\d+/g, "<n>")
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
const commands = [];
for (const r of db
  .prepare("select thread_id, updated_at, payload_json from orchestration_v2_projection_turn_items where type = 'command_execution' and updated_at >= ?")
  .all(baselineStart)) {
  const thread = threads.get(r.thread_id);
  if (!thread || excludedThreads.has(thread.id)) continue;
  const p = parseJson(r.payload_json);
  if (!p.input) continue;
  commands.push({ project: thread.project, inWindow: r.updated_at >= since, input: p.input, failed: typeof p.exitCode === "number" && p.exitCode !== 0 });
}
const commandStats = (name) => {
  const list = commands.filter((c) => c.project === name && c.inWindow);
  const cats = AD_HOC.map(([label, re]) => ({ label, hits: list.filter((c) => re.test(c.input)) }));
  const keys = new Map();
  for (const c of list) {
    const k = commandKey(c.input);
    const e = keys.get(k) ?? { key: k, n: 0, failed: 0 };
    e.n += 1;
    if (c.failed) e.failed += 1;
    keys.set(k, e);
  }
  return { total: list.length, failed: list.filter((c) => c.failed).length, cats, keys: [...keys.values()].sort((a, b) => b.n - a.n) };
};

const git = (root, gitArgs) =>
  execFileSync("git", ["-C", root, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 });
const remoteOf = (root) => {
  try {
    return redact(git(root, ["remote", "get-url", "origin"]).trim());
  } catch {
    return null;
  }
};

// 坏模式：agent 会照着已有写法扩写，这些一旦出现就会扩散
const GARDEN = [
  ["类型逃逸", /@ts-ignore|@ts-expect-error|@ts-nocheck|\bas any\b|:\s*any\b|#\s*type:\s*ignore/],
  ["lint 豁免", /eslint-disable|biome-ignore|oxlint-disable|swiftlint:disable|#\[allow\(|@Suppress|#\s*noqa|\/\/\s*nolint/],
  ["待办与临时方案注释", /(\/\/|#|\/\*|--)\s*(TODO|FIXME|HACK|XXX)\b|workaround|临时方案|暂时|兼容旧/i],
  ["跳过的测试", /\.skip\(|\bx(it|describe|test)\(|t\.Skip\(|#\[ignore\]|XCTSkip/],
  ["吞掉错误", /catch\s*(\([^)]*\))?\s*\{\s*\}|\btry\?\s|_\s*=\s*err\b|\.ok\(\);/],
];
const SKIP_FILE = /(^|\/)(node_modules|vendor|dist|build|target|\.next|Pods|generated|__snapshots__)\/|\.lock$|lock\.(json|ya?ml)$|\.min\.js$|\.snap$|\.(md|mdx|txt)$/;
const gardenCache = new Map();
const gardenScan = (root) => {
  if (gardenCache.has(root)) return gardenCache.get(root);
  let result = null;
  try {
    let ref = "HEAD";
    try {
      ref = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    } catch {}
    const lastCommit = git(root, ["log", "-1", "--format=%cI", ref]).trim();
    const out = git(root, ["log", ref, `--since=${baselineStart}`, "--no-merges", "-p", "--unified=0", "--no-color", "--no-ext-diff", "--format=__C__%cI"]);
    const stats = Object.fromEntries(GARDEN.map(([label]) => [label, { w: 0, b: 0, files: {} }]));
    const commitCount = { w: 0, b: 0 };
    let inWindow = false;
    let file = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("__C__")) {
        inWindow = new Date(line.slice(5)).toISOString() >= since;
        commitCount[inWindow ? "w" : "b"] += 1;
      } else if (line.startsWith("+++ ")) {
        file = line.slice(6);
      } else if (line.startsWith("+") && !SKIP_FILE.test(file)) {
        for (const [label, re] of GARDEN) {
          if (!re.test(line)) continue;
          const s = stats[label];
          if (inWindow) {
            s.w += 1;
            s.files[file] = (s.files[file] ?? 0) + 1;
          } else s.b += 1;
        }
      }
    }
    result = { ref, lastCommit, stats, commitCount };
  } catch {}
  gardenCache.set(root, result);
  return result;
};

const envSnapshot = (root) => {
  try {
    const files = git(root, ["ls-files"]).split("\n");
    const has = (re) => files.filter((f) => re.test(f));
    return {
      agentsMd: has(/(^|\/)(AGENTS|CLAUDE)\.md$/).length,
      prTemplate: has(/^\.github\/(pull_request_template\.md|PULL_REQUEST_TEMPLATE\/)/i).length > 0,
      ci: has(/^\.github\/workflows\/.+\.ya?ml$/).length,
      lint: has(/(^|\/)(eslint\.config\.\w+|\.eslintrc(\.\w+)?|biome\.jsonc?|\.?oxlintrc\.json|\.swiftlint\.ya?ml|clippy\.toml|\.golangci\.ya?ml|ruff\.toml|\.rubocop\.yml)$/).length,
      skills: [...new Set(has(/^\.(agents|claude|cursor|devin)\/skills\/[^/]+\/SKILL\.md$/).map((f) => f.split("/")[2]))],
      featureMap: has(/feature[-_]?map/i),
    };
  } catch {
    return null;
  }
};
const rootOf = (name) => {
  const root = [...projects.values()].find((p) => p.title === name)?.workspace_root;
  return root && existsSync(root) ? root : null;
};

const countCommandArg = argValue("--count-command");
if (countCommandArg) {
  const re = new RegExp(countCommandArg, "i");
  const hit = commands.filter((c) => (!projectFilter || c.project === projectFilter) && re.test(c.input));
  const w = hit.filter((c) => c.inWindow).length;
  console.log(`agent 命令 /${countCommandArg}/${projectFilter ? ` 项目 ${projectFilter}` : ""}`);
  console.log(`基线：${hit.length - w} 次，${fmtRate(perDay(hit.length - w, baselineMs))}/天；本期：${w} 次，${fmtRate(perDay(w, windowMs))}/天`);
  process.exit(0);
}

// 复盘指标：kind 为 message（默认，人类消息）、command（agent 命令）或 garden（代码库坏模式，pattern 填类别名）
const metricCounts = (metric) => {
  const scope = metric.projects?.length ? metric.projects : null;
  const re = metric.pattern ? new RegExp(metric.pattern, "i") : null;
  if (metric.kind === "garden") {
    let w = 0;
    let b = 0;
    for (const name of scope ?? []) {
      const s = rootOf(name) && gardenScan(rootOf(name))?.stats[metric.pattern];
      if (s) {
        w += s.w;
        b += s.b;
      }
    }
    return { w, b };
  }
  const pool =
    metric.kind === "command"
      ? commands.filter((c) => (!scope || scope.includes(c.project)) && (!re || re.test(c.input)))
      : human.filter(
          (m) => !excludedThreads.has(m.thread.id) && (!scope || scope.includes(m.project)) && (!re || re.test(m.text)) && (!metric.tag || m.tags.includes(metric.tag)),
        );
  const w = pool.filter((x) => x.inWindow).length;
  return { w, b: pool.length - w };
};

const windowMsgs = msgs.filter((m) => m.inWindow);
const projectNames = [...new Set(windowMsgs.map((m) => m.project))].sort(
  (a, b) => windowMsgs.filter((m) => m.project === b).length - windowMsgs.filter((m) => m.project === a).length,
);
const countTag = (list, tag) => list.filter((m) => m.tags.includes(tag)).length;

const summary = [];
summary.push(`# relay-audit 摘要`);
summary.push("");
summary.push(`本期：${since} → ${windowEnd}（${(windowMs / DAY).toFixed(1)} 天）；基线从 ${baselineStart} 起（不含本期 ${(baselineMs / DAY).toFixed(1)} 天）`);
summary.push(`已排除：子代理线程、自动消息、定时任务提示词，以及 ${excludedThreads.size} 个提到 relay-audit 的线程`);
summary.push("");

const reviewItems = ledger.items.filter((it) => it.metric && REVIEW_STATUSES.has(it.status));
if (reviewItems.length) {
  summary.push(`## 复盘：已采纳条目的指标`);
  summary.push("");
  summary.push(`| ID | 状态 | 项目 | 指标 | 提出时 /天 | 基线 /天 | 本期 /天 |`);
  summary.push(`|---|---|---|---|---|---|---|`);
  for (const it of reviewItems) {
    const { w, b } = metricCounts(it.metric);
    const kind = { command: "命令", garden: "代码库" }[it.metric.kind] ?? "消息";
    const metricDesc = [kind, it.metric.pattern && `/${it.metric.pattern}/`, it.metric.tag && `标签:${it.metric.tag}`].filter(Boolean).join(" ");
    summary.push(
      `| ${it.id} | ${it.status} | ${it.metric.projects?.join(",") || "全部"} | ${metricDesc} | ${it.metric.baselinePerDay ?? "?"} | ${fmtRate(perDay(b, baselineMs))} | ${fmtRate(perDay(w, windowMs))} |`,
    );
  }
  summary.push("");
}

summary.push(`## 总览（本期）`);
summary.push("");
summary.push(`| 项目 | 线程 | 人类消息 | 催促 | 纠正 | 粘贴 | 交给你做 | 中断 | agent 提问 | 错误（主/子代理） |`);
summary.push(`|---|---|---|---|---|---|---|---|---|---|`);
for (const name of projectNames) {
  const list = windowMsgs.filter((m) => m.project === name);
  const s = signalCounts.get(name) ?? {};
  summary.push(
    `| ${name} | ${new Set(list.map((m) => m.thread.id)).size} | ${list.length} | ${countTag(list, "催促")} | ${countTag(list, "纠正")} | ${countTag(list, "粘贴")} | ${countTag(list, "交给你做")} | ${s.run_interrupt_request ?? 0} | ${s.user_input_request ?? 0} | ${s.error ?? 0}/${s.subagentError ?? 0} |`,
  );
}
summary.push("");

summary.push(`## 环境快照`);
summary.push("");
summary.push(`坏模式按"本期 /天（基线 /天）"统计默认分支上新增的行，类别见摘要文件。命令统计含子代理线程。`);
summary.push("");
summary.push(`| 项目 | AGENTS.md | PR 模板 | CI | lint 配置 | 仓库内技能 | 特性地图 | 坏模式新增 | agent 命令（失败） | 临时脚本 |`);
summary.push(`|---|---|---|---|---|---|---|---|---|---|`);
for (const name of projectNames) {
  const root = rootOf(name);
  const env = root && envSnapshot(root);
  const garden = root && gardenScan(root);
  const cmd = commandStats(name);
  const gardenCell = garden
    ? (() => {
        const w = Object.values(garden.stats).reduce((a, s) => a + s.w, 0);
        const b = Object.values(garden.stats).reduce((a, s) => a + s.b, 0);
        return `${fmtRate(perDay(w, windowMs))}（${fmtRate(perDay(b, baselineMs))}）`;
      })()
    : "-";
  summary.push(
    env
      ? `| ${name} | ${env.agentsMd} | ${env.prTemplate ? "有" : "无"} | ${env.ci} | ${env.lint} | ${env.skills.length} | ${env.featureMap.length ? "有" : "无"} | ${gardenCell} | ${cmd.total}（${cmd.failed}） | ${cmd.cats[0].hits.length} |`
      : `| ${name} | 非 git 仓库 | | | | | | | ${cmd.total}（${cmd.failed}） | ${cmd.cats[0].hits.length} |`,
  );
}
summary.push("");

const repeats = [...clusters.values()].filter((c) => c.total >= 3).sort((a, b) => b.total - a.total);
const crossRepeats = repeats.filter((c) => c.projects.size >= 2);
summary.push(`## 跨项目重复的消息（基线+本期 ≥3 次，≥2 个项目）`);
summary.push("");
if (!crossRepeats.length) summary.push("无");
for (const c of crossRepeats) {
  summary.push(`- ${c.total} 次（本期 ${c.inWindow}），${c.projects.size} 个项目（${[...c.projects].join("、")}）：「${head(c.sample, 160)}」`);
}
summary.push("");

const detail = [...summary];
for (const name of projectNames) {
  const all = msgs.filter((m) => m.project === name);
  const list = all.filter((m) => m.inWindow);
  const root = rootOf(name);
  detail.push(`## 项目：${name}`);
  detail.push("");
  detail.push(`根目录：${root ?? "?"}；远程：${(root && remoteOf(root)) ?? "无"}`);
  detail.push("");

  const env = root && envSnapshot(root);
  if (env) {
    detail.push(`### 环境`);
    detail.push("");
    detail.push(`- AGENTS.md/CLAUDE.md ${env.agentsMd} 个；PR 模板${env.prTemplate ? "有" : "无"}；CI 工作流 ${env.ci} 个；lint 配置 ${env.lint} 个`);
    detail.push(`- 仓库内技能：${env.skills.join("、") || "无"}`);
    detail.push(`- 特性地图：${env.featureMap.slice(0, 5).join("、") || "无"}`);
    detail.push("");
  }

  const garden = root && gardenScan(root);
  if (garden) {
    detail.push(`### 坏模式新增（${garden.ref}，最后提交 ${garden.lastCommit}；本期 ${garden.commitCount.w} 个提交，基线 ${garden.commitCount.b} 个）`);
    detail.push("");
    for (const [label, s] of Object.entries(garden.stats)) {
      if (!s.w && !s.b) continue;
      const files = Object.entries(s.files).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} ×${n}`);
      detail.push(`- ${label}：本期 ${s.w}（${fmtRate(perDay(s.w, windowMs))}/天），基线 ${fmtRate(perDay(s.b, baselineMs))}/天${files.length ? `；集中在 ${files.join("、")}` : ""}`);
    }
    detail.push("");
  }

  const cmd = commandStats(name);
  if (cmd.total) {
    detail.push(`### agent 命令（本期 ${cmd.total} 条，失败 ${cmd.failed} 条）`);
    detail.push("");
    for (const { label, hits } of cmd.cats) {
      if (!hits.length) continue;
      detail.push(`- ${label} ${hits.length} 次，例：${hits.slice(-2).map((c) => `\`${head(c.input, 160)}\``).join("；")}`);
    }
    const frequent = cmd.keys.filter((k) => !READ_ONLY.test(k.key) && (k.n >= 5 || k.failed >= 3)).slice(0, 10);
    if (frequent.length) detail.push(`- 反复执行的命令：${frequent.map((k) => `\`${k.key}\` ×${k.n}${k.failed ? `（失败 ${k.failed}）` : ""}`).join("，")}`);
    detail.push("");
  }

  const local = repeats
    .map((c) => ({ c, here: c.items.filter((m) => m.project === name) }))
    .filter(({ here }) => here.length >= 3 || here.some((m) => m.inWindow));
  if (local.length) {
    detail.push(`### 重复的消息`);
    detail.push("");
    for (const { c, here } of local) {
      detail.push(`- 本项目 ${here.length} 次（本期 ${here.filter((m) => m.inWindow).length}，全部项目 ${c.total}）[${here[0].tags.join("/") || "-"}]：「${head(c.sample, 200)}」`);
      for (const m of here.filter((x) => x.inWindow).slice(-2)) {
        detail.push(`  - ${localTime(m.at)} 《${head(m.thread.title, 40)}》 agent 停在：${agentTail(m, 220)}`);
      }
    }
    detail.push("");
  }

  const nudges = list.filter((m) => m.tags.includes("催促") && !isRepeat(m));
  if (nudges.length) {
    detail.push(`### 其他催促（${nudges.length} 次）`);
    detail.push("");
    for (const m of nudges.slice(-8)) {
      detail.push(`- ${localTime(m.at)} 「${head(m.text, 20)}」 《${head(m.thread.title, 40)}》 agent 停在：${agentTail(m, 220)}`);
    }
    detail.push("");
  }

  const rest = list.filter((m) => !isRepeat(m) && !m.tags.includes("催促"));
  if (rest.length) {
    detail.push(`### 其余人类消息（${rest.length} 条，时间顺序）`);
    detail.push("");
    for (const m of rest) {
      detail.push(`- ${localTime(m.at)} [${m.tags.join("/") || "-"}] 《${head(m.thread.title, 40)}》 线程 ${m.thread.id.slice(0, 8)}`);
      detail.push(`  - agent 结尾：${agentTail(m, 260)}`);
      detail.push(`  - 你：${head(m.text, 420)}`);
    }
    detail.push("");
  }
}

const outPath = argValue("--out") ?? join(STATE_DIR, "reports", `${windowEnd.slice(0, 16).replace(/[:T]/g, "-")}-digest.md`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, detail.join("\n"));
console.log(summary.join("\n"));
console.log(`windowEnd: ${windowEnd}`);
console.log(`完整摘要（按项目分节）：${outPath}`);
