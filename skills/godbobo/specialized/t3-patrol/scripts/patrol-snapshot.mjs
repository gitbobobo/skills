#!/usr/bin/env node
// 巡检快照：经 T3 MCP 的 HTTP 端点一次性收集所有环境的候选线程与尾部消息，
// 只输出判定需要的字段，避免把 t3_thread_list / t3_thread_read 的原始大 JSON 灌进上下文。
//
// 用法：node patrol-snapshot.mjs [--self <本线程 id>] [--tail 4] [--chars 600]
// 依赖环境变量 T3_MCP_URL、T3_MCP_BEARER_TOKEN（T3 注入；缺席时退出码 2，改用 MCP 工具手工取证）。

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SELF = opt("self", null);
const TAIL = Number(opt("tail", 4));
const CHARS = Number(opt("chars", 600));
const ACTIVE_MS = 2 * 3600 * 1000; // 有在审 PR 的线程，最近一次 run 结束多久内仍算占用
const LIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const URL_ = process.env.T3_MCP_URL;
const TOKEN = process.env.T3_MCP_BEARER_TOKEN;

let sid = null;
let seq = 0;
async function rpc(method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
  };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(URL_, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }) });
  sid = res.headers.get("mcp-session-id") || sid;
  const text = await res.text();
  const m = text.match(/^data: (.*)$/m);
  const msg = JSON.parse(m ? m[1] : text);
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text ?? "error"}`);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

const clip = (s, n = CHARS) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
// 尾部消息保留首尾：代理常在长汇报末尾才提问或说「等你合并」，只截开头会把这句截掉。
const clipEnds = (s, n = CHARS) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const head = Math.floor(n * 0.4);
  return `${t.slice(0, head)} …[略]… ${t.slice(t.length - (n - head))}`;
};
const isReviewBot = (t) => /^代码审查 · PR #\d+/.test(t.title);
const isSubagent = (t) => t.parentThreadId || t.threadId.startsWith("thread:delegated-task:");

async function listAll(environmentId) {
  const out = [];
  let cursor = 0;
  for (;;) {
    const page = await call("t3_thread_list", { allProjects: true, settled: false, limit: 100, cursor, ...(environmentId ? { environmentId } : {}) });
    out.push(...page.threads);
    if (page.nextCursor == null) return out;
    cursor = page.nextCursor;
  }
}

async function tailOf(environmentId, t) {
  const env = environmentId ? { environmentId } : {};
  // 读首条用户消息（任务原文）与尾部若干条消息；只留 user/assistant 文本。
  const head = await call("t3_thread_read", { threadId: t.threadId, limit: 1, maxCharsPerItem: CHARS, ...env });
  // 尾部窗口里可能全是工具调用而没有消息（默认视图只回消息），窗口逐级放大到读到为止。
  let meta = head;
  let msgs = [];
  for (const back of [40, 200, 1000]) {
    let after = Math.max(0, (t.itemCount ?? 0) - back);
    const items = [];
    for (let guard = 0; guard < 20; guard++) {
      const r = await call("t3_thread_read", { threadId: t.threadId, afterPosition: after, limit: 50, maxCharsPerItem: 20000, ...env });
      meta = r;
      items.push(...r.items);
      if (!r.hasMore || r.nextPosition == null) break;
      after = r.nextPosition;
    }
    msgs = items.filter((i) => i.type === "user_message" || i.type === "assistant_message");
    if (msgs.length >= TAIL || after === 0) break;
  }
  const first = head.items.find((i) => i.type === "user_message");
  const lastMsgAt = Date.parse(msgs.at(-1)?.updatedAt ?? "") || null;
  return {
    ...(t.status === "running" ? await spinOf(environmentId, t, lastMsgAt) : {}),
    task: clip(first?.text, 300),
    pendingRequestCount: meta.thread?.pendingRequestCount ?? 0,
    lastRunEndedAt: (meta.recentRuns ?? []).map((r) => r.completedAt ?? r.startedAt ?? r.requestedAt).filter(Boolean).sort().at(-1) ?? null,
    runs: (meta.recentRuns ?? []).slice(0, 3).map((r) => `${r.ordinal}:${r.status}${r.startedAt ? "" : "(未启动)"}@${r.completedAt ?? r.startedAt ?? r.requestedAt}`),
    tail: msgs.slice(-TAIL).map((i) => `[${i.updatedAt?.slice(5, 16)} ${i.type === "user_message" ? (i.createdBy === "user" ? "用户" : "注入") : "代理"}] ${clipEnds(i.text)}`),
  };
}

// 在跑线程的空转迹象：最近 30 个工具调用里有几种不同命令、距最后一条消息多少分钟。
// 退化循环会反复执行同一类命令，只看消息尾部时它和正常干活没有区别。
async function spinOf(environmentId, t, lastMsgAt) {
  const env = environmentId ? { environmentId } : {};
  const r = await call("t3_thread_read", { threadId: t.threadId, view: "activity", afterPosition: Math.max(0, (t.itemCount ?? 0) - 40), limit: 60, maxCharsPerItem: 200, ...env });
  const calls = r.items.filter((i) => i.type === "command_execution" || i.type === "dynamic_tool").slice(-30);
  const norm = (i) => String(i.text ?? i.title ?? "").replace(/\s+/g, " ").slice(0, 120);
  return {
    recentToolCalls: calls.length,
    distinctRecentCommands: new Set(calls.map(norm)).size,
    sampleCommand: calls.length ? clip(norm(calls.at(-1)), 160) : null,
    minutesSinceLastMessage: lastMsgAt ? Math.round((Date.now() - lastMsgAt) / 60000) : null,
  };
}

async function snapshotEnv(env) {
  const now = Date.now();
  const all = await listAll(env.isLocal ? null : env.environmentId);
  const top = all.filter((t) => !isSubagent(t));
  const candidates = top.filter((t) => !isReviewBot(t) && t.threadId !== SELF);
  const enriched = await Promise.all(
    candidates.map(async (t) => {
      const base = {
        id: t.threadId,
        link: t.link,
        title: clip(t.title, 80),
        createdBy: t.createdBy,
        status: t.status,
        updatedAt: t.updatedAt,
        projectId: t.projectId,
        model: `${t.providerInstanceId}/${t.model}`,
        prs: (t.pullRequests ?? []).map((p) => `${p.repository}#${p.number}:${p.state}${p.watching === false ? "(unwatched)" : ""}`),
      };
      try {
        // watching 状态以 list_thread_pull_requests 为准：t3_thread_list 的快照字段会漏标，
        // 「PR open 但没挂监听」是高频故障，每轮都要显式采。
        const tail = await tailOf(env.isLocal ? null : env.environmentId, t);
        const livePrs = (await call("list_thread_pull_requests", { threadId: t.threadId, ...(env.isLocal ? {} : { environmentId: env.environmentId }) }).catch(() => null))?.pullRequests;
        const prs = livePrs
          ? livePrs.map((p) => `${p.repository}#${p.number}:${p.state}${p.watching === false ? "(unwatched)" : ""}`)
          : base.prs;
        return { ...base, prs, ...tail };
      } catch (e) {
        return { ...base, error: String(e.message ?? e) };
      }
    }),
  );
  // 占用名额的线程：有活跃 run 的（含 Fast Ship 审查线程），或 PR 仍 open、最近 2 小时内跑过的（两轮审查之间
  // 线程会暂时 completed，但工作树和编译资源还占着）。PR 已合并/关闭、没有 PR 又没在跑的线程不占名额。
  // 不用 updatedAt：同步会批量刷新它。
  const byId = new Map(enriched.map((x) => [x.id, x]));
  const occupying = top.filter((t) => {
    if (LIVE.has(t.status)) return true;
    const prs = t.pullRequests ?? [];
    if (!prs.some((p) => p.state === "open")) return false;
    const ended = Date.parse(byId.get(t.threadId)?.lastRunEndedAt ?? "");
    return Number.isFinite(ended) && now - ended < ACTIVE_MS;
  });
  const active = occupying.length;
  const occupyingTitles = occupying.map((t) => clip(t.title, 40));
  return { environmentId: env.environmentId, label: env.label, activeTopLevel: active, occupying: occupyingTitles, candidates: enriched };
}

async function main() {
  if (!URL_ || !TOKEN) {
    console.error("缺少 T3_MCP_URL / T3_MCP_BEARER_TOKEN：改用 MCP 工具按技能步骤手工取证。");
    process.exit(2);
  }
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t3-patrol", version: "1" } });
  const links = await call("t3_environment_links", {});
  const envs = [{ environmentId: links.environmentId, label: "本机", isLocal: true }];
  const unreachable = [];
  for (const l of links.links ?? []) {
    if (l.status === "reachable") envs.push({ environmentId: l.environmentId, label: l.label });
    else unreachable.push({ environmentId: l.environmentId, label: l.label, status: l.status, error: l.lastError });
  }
  const results = await Promise.all(
    envs.map((e) => snapshotEnv(e).catch((err) => ({ environmentId: e.environmentId, label: e.label, error: String(err.message ?? err) }))),
  );
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), unreachable, environments: results }, null, 1));
}

// 技能常经符号链接安装：比较 realpath，否则直接运行时静默不执行。
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
