#!/usr/bin/env node
// 固定规则路由：输入任务类型（+已试入口），输出该用的 harness/模型/选项。
// 规则全部来自 route-data.mjs；本文件只做展开与过滤，不含可调整的策略。
//
// 子命令：
//   route.mjs select --task <key> [--hard] [--vision] [--implementer <model>]
//                    [--exclude <provider/model>]... [--caps-file <path>]
//                    [--state-dir <path>] [--quota-file <path> | --no-quota] [--json]
//   route.mjs named <模型> [--provider <id>] [--caps-file ...] [--json]
//   route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named]
//   route.mjs table [--json]          打印当前生效的路由数据（供人工核对）
//   route.mjs tasks                   列出 --task 可用取值
//
// 退出码：0 选出/校验通过；1 无可用候选或校验违规；2 参数错误。
//
// 输入来源（脚本自取，不靠模型转述）：
//   capabilities  —— --caps-file 传 orchestrator_capabilities 的 JSON；缺省读
//                    ${T3_CACHE_DIR:-~/.t3/caches}/<provider>.json（无法验证 canRunChildTask，只降级告警）
//   共享冷却状态  —— quota-state.mjs 的 status（--state-dir 仅供测试）
//   额度窗口      —— t3-quota.mjs collect()（--quota-file 用文件代替实查；--no-quota 跳过）

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SWE2_FREE_UNTIL,
  PROVIDER_RULES,
  BANNED_PROVIDERS,
  MODEL_BANS,
  MODELS,
  TASKS,
  ROUTES,
  DOWNGRADE,
  POOLS,
  QUOTA_BLOCK_PERCENT,
  QUOTA_BLOCK_RESET_MS,
  MAX_ATTEMPTS,
} from "./route-data.mjs";
import { operate, defaultCache } from "./quota-state.mjs";
import { collect as collectQuota } from "./t3-quota.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const now = Date.now();
const swe2Free = now < Date.parse(SWE2_FREE_UNTIL);

// ---------- 参数 ----------

function parseArgs(argv) {
  const args = { exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (["hard", "vision", "json", "no-quota", "user-named"].includes(key)) args[key] = true;
      else if (key === "exclude") args.exclude.push(argv[++i]);
      else args[key] = argv[++i];
    } else if (args._ === undefined) args._ = a;
    else (args._extra ??= []).push(a);
  }
  return args;
}

const entryId = (e) => `${e.provider}/${e.id}`;

// ---------- capabilities ----------

function loadProviders(capsFile) {
  const warnings = [];
  const providers = new Map(); // id -> {runnable, reason?, models:Set, optionIds:Map<modelId,Set>, cross:boolean}
  const capsJson = capsFile ? JSON.parse(readFileSync(capsFile, "utf8")) : null;
  if (capsJson) {
    const list = Array.isArray(capsJson) ? capsJson : (capsJson.providers ?? []);
    for (const p of list) {
      const optionIds = new Map();
      for (const m of p.models ?? []) optionIds.set(m.id, new Set((m.options ?? []).map((o) => o.id)));
      providers.set(p.providerInstanceId, {
        runnable: p.canRunChildTask === true,
        cross: p.canRunCrossProviderChildTask === true,
        reason: p.canRunChildTask ? undefined : (p.constraints ?? []).join("; ") || "canRunChildTask=false",
        models: new Set((p.models ?? []).map((m) => m.id)),
        optionIds,
      });
    }
    return { providers, warnings, live: true };
  }
  const cacheDir = process.env.T3_CACHE_DIR || join(homedir(), ".t3", "caches");
  const wanted = new Set();
  for (const m of Object.values(MODELS)) for (const e of m.entries) wanted.add(e.provider);
  for (const id of wanted) {
    const file = join(cacheDir, `${id}.json`);
    let c = null;
    try {
      c = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (!c) {
      providers.set(id, { runnable: false, reason: `无缓存文件 ${file}`, models: new Set(), optionIds: new Map() });
      continue;
    }
    const runnable = c.enabled === true && c.status === "ready" && c.auth?.status === "authenticated";
    providers.set(id, {
      runnable,
      reason: runnable ? undefined : `缓存状态 enabled=${c.enabled} status=${c.status} auth=${c.auth?.status}`,
      models: new Set((c.models ?? []).map((m) => m.slug ?? m.id)),
      optionIds: new Map(),
    });
  }
  warnings.push("未提供 --caps-file，用 ~/.t3/caches 快照判断可用性（无法验证 canRunChildTask）");
  return { providers, warnings, live: false };
}

// ---------- 冷却状态与额度 ----------

async function loadBlocked(stateDir) {
  try {
    const state = await operate(stateDir || defaultCache(), "status");
    const blockedEntries = new Map();
    const blockedPools = new Map();
    const recoveryEntries = new Map();
    const recoveryPools = new Map();
    for (const [k, r] of Object.entries(state.records ?? {})) {
      const blocked = r.retryAt > now || r.probe?.until > now;
      const until = Math.max(r.retryAt, r.probe?.until ?? 0);
      if (k.startsWith("entry:")) {
        if (blocked) blockedEntries.set(k.slice(6), { until, kind: r.kind });
        else recoveryEntries.set(k.slice(6), { kind: r.kind });
      } else if (k.startsWith("pool:")) {
        if (blocked) blockedPools.set(k.slice(5), { until, kind: r.kind });
        else recoveryPools.set(k.slice(5), { kind: r.kind });
      }
    }
    return { blockedEntries, blockedPools, recoveryEntries, recoveryPools, warnings: [] };
  } catch (e) {
    return { blockedEntries: new Map(), blockedPools: new Map(), recoveryEntries: new Map(), recoveryPools: new Map(), warnings: [`共享状态读取失败（${e.message}），按无冷却处理`] };
  }
}

async function loadQuota(opts) {
  if (opts["no-quota"]) return { rows: null, warnings: ["--no-quota：跳过额度窗口检查"] };
  try {
    const rows = opts["quota-file"] ? JSON.parse(readFileSync(opts["quota-file"], "utf8")) : await collectQuota();
    return { rows, warnings: [] };
  } catch (e) {
    return { rows: null, warnings: [`额度查询失败（${e.message}），跳过额度拦截`] };
  }
}

// 返回 null（放行）或拦截原因字符串
function quotaBlock(entry, quotaRows, warnings) {
  const pool = POOLS[entry.pool];
  if (!pool || !quotaRows) return null;
  if (entry.model === "swe-2" && swe2Free) return null; // 免费期内 devin 额度不拦 swe-2
  const row = quotaRows.find((r) => r.key === pool.quotaKey);
  if (!row) return null;
  if (!row.windows?.length) {
    if (row.note) warnings.add(`额度 ${pool.quotaKey}：${row.note}，该池按未拦截处理`);
    return null;
  }
  for (const label of pool.windows) {
    const w = row.windows.find((x) => x.label === label);
    if (w && Number(w.usedPercent) >= QUOTA_BLOCK_PERCENT && w.resetMs - now > QUOTA_BLOCK_RESET_MS) {
      return `额度池 ${entry.pool} ${label} 窗口 ${Math.round(w.usedPercent)}%，${new Date(w.resetMs).toISOString().slice(0, 13)}Z 重置（>24h）`;
    }
  }
  return null;
}

// ---------- 模型解析 ----------

// provider/model 具体组合 → MODELS 条目
function findModel(provider, id) {
  for (const [key, m] of Object.entries(MODELS)) {
    if (m.entries.some((e) => e.provider === provider && e.id === id)) return { key, ...m };
  }
  return null;
}

// 任意字符串（模型 key / label / 任一入口 id）→ MODELS 条目；用于 --implementer、named
function resolveModel(query) {
  const q = String(query).toLowerCase();
  const hits = [];
  for (const [key, m] of Object.entries(MODELS)) {
    const ids = m.entries.map((e) => e.id.toLowerCase());
    if (key.toLowerCase() === q || m.label.toLowerCase() === q || ids.includes(q)) hits.push({ key, ...m, exact: true });
    else if (key.toLowerCase().includes(q) || ids.some((i) => i.includes(q)) || m.label.toLowerCase().includes(q))
      hits.push({ key, ...m, exact: false });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact));
  return hits;
}

// ---------- 选项注入与硬性校验 ----------

function injectOptions(entry, providers) {
  const options = { ...(entry.options ?? {}) };
  const info = providers.get(entry.provider);
  if (entry.provider === "acpRegistry_factory_droid" && options.autonomy_level === undefined) {
    options.autonomy_level = PROVIDER_RULES.acpRegistry_factory_droid.forceOptions.autonomy_level;
  }
  const hasFast =
    (info?.optionIds.get(entry.id)?.has("fastMode") ?? false) || (!info?.optionIds.size && /^cursor|^claudeAgent/.test(entry.provider));
  if (hasFast && options.fastMode === undefined) options.fastMode = false;
  return options;
}

// check 子命令用的全部硬性规则；select 对生成的组合也跑一遍兜底。
function gateCheck({ provider, model, role, options = {}, userNamed = false }) {
  const fails = [];
  const warns = [];
  const resolved = findModel(provider, model);
  const status = resolved?.status;

  // 永远生效：快速模式、claudeAgent 假名、droid 选项
  if (options.fastMode === true || options.fastMode === "true") fails.push("fastMode 必须为 false");
  if (options.serviceTier === "priority") fails.push("codex serviceTier 保持 default，不用 priority");
  if (/-fast\b/i.test(model)) fails.push(`模型名带 -fast（${model}）`);
  const claudeRule = PROVIDER_RULES.claudeAgent;
  if (provider === "claudeAgent" && !claudeRule.allowModels.includes(model)) {
    fails.push(`claudeAgent 只允许 ${claudeRule.allowModels.join(" / ")}；claude-* 是智谱假名，真入口见 route-data.mjs MODELS`);
  }
  if (provider === "acpRegistry_factory_droid") {
    if (options.autonomy_level === undefined) fails.push('factory_droid 任务 options 必须带 {"autonomy_level":"auto-high"}');
    else if (options.autonomy_level !== "auto-high") warns.push(`autonomy_level=${options.autonomy_level}，非 auto-high——确认是用户指定`);
    if (options.reasoningEffort !== undefined) fails.push("factory_droid 推理档选项名是 reasoning_effort（snake_case），不是 reasoningEffort");
  }

  if (!userNamed) {
    if (status === "named") fails.push(`${resolved.label} 仅限用户点名才可用，自动调度与换路跳过`);
    if (BANNED_PROVIDERS[provider]) fails.push(`${provider} 不主动调用（${BANNED_PROVIDERS[provider]}）`);
    const ban = MODEL_BANS.find((b) => b.match.test(model));
    if (status === "banned" || ban) fails.push(`${model} 不主动调用（${resolved?.label ?? ""} ${ban?.reason ?? ""}）`.trim());
    const oc = PROVIDER_RULES.opencode;
    if (provider === "opencode" && !oc.allowModels.includes(model)) fails.push(`opencode 只允许 ${oc.allowModels.join(" / ")}；${oc.note}`);
    if (status === "advisor" && role === "implementation") fails.push(`${resolved.label} 是顾问/审查专用，不承担 implementation 任务`);
    if (!resolved) fails.push(`${provider}/${model} 不在 route-data.mjs 任何模型的入口清单内，自动调度不得选用`);
  } else {
    if (status === "banned" || MODEL_BANS.some((b) => b.match.test(model))) warns.push(`${model} 在不主动调用清单，确认用户确实点名`);
    if (status === "named") warns.push(`${resolved.label} 为点名专用模型——本次按用户点名放行`);
    if (resolved?.status === "advisor" && role === "implementation") warns.push(`${resolved.label} 平时不写实现；用户点名时按用户说的`);
    if (!resolved) warns.push(`${provider}/${model} 不在任何已知入口清单——确认模型 ID 与用户点名一致`);
  }
  return { fails, warns, resolved };
}

// ---------- 候选展开 ----------

// ROUTES 行 → 展开为入口流：[行候选, 该模型其余入口（换路第 1 步）, 下一行候选..., 降档行（换路第 3 步）]
function expandCandidates(cands, stream, seen, via) {
  for (const cand of cands) {
    const m = MODELS[cand.model];
    if (!m) continue;
    const primary = cand.provider ? m.entries.find((e) => e.provider === cand.provider) : m.entries[0];
    const ordered = primary ? [primary, ...m.entries.filter((e) => e !== primary)] : [...m.entries];
    ordered.forEach((e, i) => {
      const k = entryId(e);
      if (seen.has(k)) return;
      seen.add(k);
      stream.push({
        model: cand.model,
        family: m.family,
        status: m.status,
        vision: m.vision === true,
        provider: e.provider,
        id: e.id,
        options: { ...(e.options ?? {}), ...(i === 0 ? (cand.options ?? {}) : {}) },
        pool: e.pool,
        via: i === 0 ? (cand.via ?? via) : "same-model",
        leg: cand.leg,
      });
    });
  }
}

function expandRoute(taskKey) {
  const stream = [];
  const seen = new Set();
  const seenTasks = new Set();
  const visit = (key, via) => {
    if (seenTasks.has(key)) return; // DOWNGRADE 链允许成环（advisor↔review），展开一次即止
    seenTasks.add(key);
    expandCandidates(ROUTES[key] ?? [], stream, seen, via);
    const down = DOWNGRADE[key];
    if (down) visit(down, "downgrade");
  };
  visit(taskKey, "route");
  return stream;
}

// ---------- select ----------

async function buildContext(opts) {
  const { providers, warnings: w1 } = loadProviders(opts["caps-file"]);
  const { blockedEntries, blockedPools, recoveryEntries, recoveryPools, warnings: w2 } = await loadBlocked(opts["state-dir"]);
  const { rows: quotaRows, warnings: w3 } = await loadQuota(opts);
  const quotaWarnings = new Set();
  return { providers, blockedEntries, blockedPools, recoveryEntries, recoveryPools, quotaRows, quotaWarnings, warnings: [...w1, ...w2, ...w3] };
}

function gateEntry(item, ctx, opts) {
  const reasons = [];
  if (item.status === "named") reasons.push("仅限用户点名");
  if (BANNED_PROVIDERS[item.provider]) reasons.push(`${item.provider} ${BANNED_PROVIDERS[item.provider]}`);
  const rule = PROVIDER_RULES[item.provider];
  if (rule?.allowModels && !rule.allowModels.includes(item.id) && !(rule.namedExempt && opts["user-named"])) {
    reasons.push(`${item.provider} 白名单仅 ${rule.allowModels.join(" / ")}`);
  }
  const info = ctx.providers.get(item.provider);
  if (!info) reasons.push("实例不在 capabilities/缓存清单");
  else if (!info.runnable) reasons.push(`实例不可派子任务${info.reason ? `（${info.reason}）` : ""}`);
  else if (!info.models.has(item.id)) reasons.push("该实例模型清单无此 ID");
  if (ctx.blockedEntries.has(entryId(item))) {
    const b = ctx.blockedEntries.get(entryId(item));
    reasons.push(`入口冷却（${b.kind}，至 ${new Date(b.until).toISOString().slice(0, 16)}Z）`);
  }
  if (item.pool && ctx.blockedPools.has(item.pool)) {
    const b = ctx.blockedPools.get(item.pool);
    reasons.push(`池冷却（${b.kind}，至 ${new Date(b.until).toISOString().slice(0, 16)}Z）`);
  }
  const qb = quotaBlock(item, ctx.quotaRows, ctx.quotaWarnings);
  if (qb) reasons.push(qb);
  return reasons;
}

function finalize(item, ctx) {
  const options = injectOptions(item, ctx.providers);
  const recovery = ctx.recoveryEntries.has(entryId(item)) || (item.pool != null && ctx.recoveryPools.has(item.pool));
  return {
    providerInstanceId: item.provider,
    model: item.id,
    modelKey: item.model,
    family: item.family,
    options,
    pool: item.pool ?? null,
    via: item.via,
    needsRecovery: recovery,
    swe2FreeExempt: (item.model === "swe-2" && swe2Free) || undefined,
  };
}

function runSelect(taskKey, ctx, opts, out) {
  let stream = expandRoute(taskKey);
  const excluded = new Set(opts.exclude);
  stream = stream.filter((i) => !excluded.has(entryId(i)));

  if (taskKey === "review" && opts.implementer) {
    const impl = resolveModel(opts.implementer)[0];
    if (impl) {
      stream = [...stream.filter((i) => i.family !== impl.family), ...stream.filter((i) => i.family === impl.family)];
      out.notes.push(`实现者 ${impl.label}（${impl.family}）：审查优先选不同家族`);
    } else out.warnings.push(`--implementer ${opts.implementer} 无法识别家族，按默认顺序`);
  }
  if (opts.vision) {
    stream = [...stream.filter((i) => i.vision), ...stream.filter((i) => !i.vision)];
    out.notes.push("--vision：视觉能力模型提前");
  }

  const available = [];
  for (const item of stream) {
    const reasons = gateEntry(item, ctx, opts);
    if (reasons.length) out.skipped.push({ entry: entryId(item), model: item.model, via: item.via, reasons });
    else available.push(finalize(item, ctx));
  }
  return available;
}

async function selectCmd(opts) {
  const task = opts.task;
  if (!task || !ROUTES[task]) {
    console.error(`--task 必填且须为: ${Object.keys(TASKS).join(" | ")}`);
    process.exit(2);
  }
  const out = { task, attempt: 1 + opts.exclude.length, pick: null, alternatives: [], skipped: [], notes: [], warnings: [] };
  if (out.attempt > MAX_ATTEMPTS) {
    out.error = `已试 ${opts.exclude.length} 个入口，超过单任务 ${MAX_ATTEMPTS} 次上限——停下向用户报告每次尝试的入口和失败原因`;
    printSelect(out, opts);
    process.exit(1);
  }
  const ctx = await buildContext(opts);
  out.warnings.push(...ctx.warnings, ...ctx.quotaWarnings);

  const pickFrom = (stream, leg) => {
    const avail = [];
    for (const item of stream) {
      const reasons = gateEntry(item, ctx, opts);
      if (reasons.length) out.skipped.push({ entry: entryId(item), model: item.model, leg, reasons });
      else avail.push(finalize(item, ctx));
    }
    return avail;
  };

  if (opts.hard && task === "implementation") {
    const advisor = runSelect("advisor", ctx, { ...opts, vision: opts.vision }, out);
    const impl = runSelect("implementation", ctx, opts, out);
    out.steps = [
      { role: "design", purpose: "难题先派顾问咨询（问方案、风险、被否决方向）", pick: advisor[0] ?? null },
      { role: "implementation", purpose: "方案定下来后的实现", pick: impl[0] ?? null },
    ];
    out.alternatives = impl.slice(1, 8);
  } else if (task === "security") {
    // 两腿：每条腿的候选 = 本腿 ROUTES 候选 + 降档行（DOWNGRADE.security）兜底，各自独立展开去重
    const fallbackCands = (ROUTES[DOWNGRADE.security] ?? []).map((c) => ({ ...c, via: "downgrade" }));
    const legs = [...new Set(ROUTES.security.map((c) => c.leg ?? "main"))];
    out.steps = legs.map((leg) => {
      const cands = ROUTES.security.filter((c) => (c.leg ?? "main") === leg);
      const stream = [];
      expandCandidates([...cands, ...fallbackCands], stream, new Set(), "route");
      const avail = pickFrom(stream, leg);
      const purpose = leg === "review" ? "安全审查（Opus 可能静默回退旧模型，注意核对实际模型）" : "交叉复核";
      return { role: "review", leg, purpose, pick: avail[0] ?? null };
    });
  } else {
    const available = runSelect(task, ctx, opts, out);
    out.pick = available[0] ?? null;
    out.alternatives = available.slice(1, 8);
  }

  const done = out.pick ?? out.steps?.every((s) => s.pick);
  printSelect(out, opts);
  process.exit(done ? 0 : 1);
}

function printSelect(out, opts) {
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const fmt = (p) => (p ? `${p.providerInstanceId} / ${p.model}  options=${JSON.stringify(p.options)}` : "无");
  for (const n of out.notes) console.log(`# ${n}`);
  for (const w of out.warnings) console.log(`WARN ${w}`);
  if (out.error) console.log(`ERROR ${out.error}`);
  if (out.steps) {
    for (const s of out.steps) console.log(`STEP [${s.role}] ${s.purpose}\n  → ${fmt(s.pick)}`);
    if (out.steps.some((s) => !s.pick)) console.log("某一步无可用候选——见下方 skipped");
  } else {
    console.log(`PICK ${fmt(out.pick)}`);
    if (!out.pick) console.log("无可用候选——见下方 skipped，或全部进入冷却；不要再自行挑选");
  }
  if (out.pick?.needsRecovery) console.log("注意：该入口/池有过失败记录，派发前先 claim 并做恢复探测");
  if (out.alternatives?.length) {
    console.log("ALTERNATIVES（按换路顺序）:");
    for (const a of out.alternatives) console.log(`  - ${fmt(a)}  via=${a.via}`);
  }
  if (out.skipped?.length) {
    console.log("SKIPPED:");
    for (const s of out.skipped) console.log(`  - ${s.entry} [${s.via ?? ""}] ${s.reasons.join("；")}`);
  }
}

// ---------- named ----------

async function namedCmd(opts) {
  const query = opts._;
  if (!query) {
    console.error("用法: route.mjs named <模型> [--provider <id>] [--caps-file <path>] [--json]");
    process.exit(2);
  }
  const hits = resolveModel(query);
  if (!hits.length) {
    console.error(`无法识别模型 "${query}"。已知模型: ${Object.values(MODELS).map((m) => m.label).join("、")}`);
    console.error("用户点名清单外模型时，用 route.mjs check --user-named 验证后再手工指定 target。");
    process.exit(2);
  }
  const m = hits[0];
  const out = { named: m.label, status: m.status, pick: null, alternatives: [], skipped: [], warnings: [], notes: [] };
  if (m.status !== "named") out.warnings.push(`${m.label} 状态是 ${m.status}，不是点名专用——确认用户确实点名了它`);
  let entries = m.entries;
  if (opts.provider) entries = entries.filter((e) => e.provider === opts.provider);
  if (!entries.length) {
    console.error(`${m.label} 在 ${opts.provider} 上没有入口`);
    process.exit(2);
  }
  const ctx = await buildContext(opts);
  out.warnings.push(...ctx.warnings, ...ctx.quotaWarnings);
  let extraOptions = {};
  if (opts.options) {
    try {
      extraOptions = JSON.parse(opts.options);
    } catch {
      console.error("--options 不是合法 JSON");
      process.exit(2);
    }
  }
  const avail = [];
  for (const e of entries) {
    const item = { model: m.key ?? query, family: m.family, status: m.status, vision: m.vision === true, provider: e.provider, id: e.id, options: { ...(e.options ?? {}), ...extraOptions }, pool: e.pool, via: "named" };
    const reasons = [];
    if (BANNED_PROVIDERS[item.provider]) reasons.push(`${item.provider} ${BANNED_PROVIDERS[item.provider]}`);
    const rule = PROVIDER_RULES[item.provider];
    if (rule?.allowModels && !rule.allowModels.includes(item.id) && !rule.namedExempt) reasons.push(`${item.provider} 白名单仅 ${rule.allowModels.join(" / ")}（${rule.note ?? ""}）`);
    const info = ctx.providers.get(item.provider);
    if (!info) reasons.push("实例不在 capabilities/缓存清单");
    else if (!info.runnable) reasons.push(`实例不可派子任务${info.reason ? `（${info.reason}）` : ""}`);
    else if (!info.models.has(item.id)) reasons.push("该实例模型清单无此 ID");
    if (ctx.blockedEntries.has(entryId(item))) reasons.push("入口冷却中");
    if (item.pool && ctx.blockedPools.has(item.pool)) reasons.push("池冷却中");
    const qb = quotaBlock(item, ctx.quotaRows, ctx.quotaWarnings);
    if (qb) reasons.push(qb);
    if (reasons.length) out.skipped.push({ entry: entryId(item), reasons });
    else avail.push(finalize(item, ctx));
  }
  out.pick = avail[0] ?? null;
  out.alternatives = avail.slice(1);
  printSelect(out, opts);
  process.exit(out.pick ? 0 : 1);
}

// ---------- check ----------

function checkCmd(opts) {
  const provider = opts.provider;
  const model = opts.model;
  if (!provider || !model) {
    console.error("用法: route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named]");
    process.exit(2);
  }
  let options = {};
  if (opts.options) {
    try {
      const v = JSON.parse(opts.options);
      options = Array.isArray(v) ? Object.fromEntries(v.map((i) => [i.id, i.value])) : v;
    } catch {
      console.error("--options 不是合法 JSON");
      process.exit(2);
    }
  }
  const { fails, warns } = gateCheck({ provider, model, role: opts.role, options, userNamed: opts["user-named"] });
  for (const w of warns) console.log(`WARN ${w}`);
  if (fails.length) {
    console.log(`FAIL ${provider}/${model}${opts.role ? ` role=${opts.role}` : ""}`);
    for (const f of fails) console.log(`- ${f}`);
    process.exit(1);
  }
  console.log(`OK ${provider}/${model}${opts.role ? ` role=${opts.role}` : ""}${opts["user-named"] ? " (user-named)" : ""}`);
}

// ---------- table / tasks ----------

function tableCmd(opts) {
  const data = { SWE2_FREE_UNTIL, swe2FreeNow: swe2Free, PROVIDER_RULES, BANNED_PROVIDERS, MODEL_BANS, MODELS, TASKS, ROUTES, DOWNGRADE, POOLS, QUOTA_BLOCK_PERCENT, QUOTA_BLOCK_RESET_MS, MAX_ATTEMPTS };
  console.log(opts.json ? JSON.stringify(data, null, 2) : renderTable(data));
}

function renderTable({ MODELS: ms, ROUTES: rs, DOWNGRADE: dg }) {
  const lines = [];
  for (const [key, m] of Object.entries(ms)) {
    lines.push(`\n[${m.label}] status=${m.status} family=${m.family}${m.vision ? " vision" : ""}`);
    m.entries.forEach((e, i) => lines.push(`  ${i + 1}. ${e.provider} / ${e.id}  pool=${e.pool ?? "-"}  options=${JSON.stringify(e.options ?? {})}`));
  }
  lines.push("\nROUTES:");
  for (const [task, cands] of Object.entries(rs)) {
    lines.push(`  ${task}: ${cands.map((c) => `${c.provider ?? "首选"}/${MODELS[c.model]?.entries.find((e) => e.provider === c.provider)?.id ?? c.model}${c.leg ? `(${c.leg})` : ""}`).join("  →  ")}${dg[task] ? `   ⇒ 降档:${dg[task]}` : ""}`);
  }
  return lines.join("\n");
}

// ---------- main ----------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const KNOWN = new Set(["select", "named", "check", "table", "tasks"]);
  const [cmd, ...rest] = process.argv.slice(2);
  const isCmd = KNOWN.has(cmd);
  const opts = parseArgs(isCmd ? rest : process.argv.slice(2));
  try {
    if (cmd === "check") checkCmd(opts);
    else if (cmd === "named") await namedCmd(opts);
    else if (cmd === "table") tableCmd(opts);
    else if (cmd === "tasks") {
      for (const [k, v] of Object.entries(TASKS)) console.log(`${k.padEnd(14)} ${v}`);
    } else {
      // 默认 select：route.mjs --task X 与 route.mjs select --task X 等价
      await selectCmd(opts);
    }
  } catch (e) {
    console.error(e.stack ?? e.message);
    process.exit(2);
  }
}

export { gateCheck, expandRoute, expandCandidates, loadProviders, quotaBlock, resolveModel, findModel };
