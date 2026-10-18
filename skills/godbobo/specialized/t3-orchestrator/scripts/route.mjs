#!/usr/bin/env node
// 固定规则路由：输入任务类型（+已试入口），输出该用的 harness/模型/选项。
// 规则全部来自 route-data.mjs；本文件只做展开与过滤，不含可调整的策略。
//
// 子命令：
//   route.mjs select --task <key> [--hard] [--vision]
//                    [--exclude <provider/model>]... [--caps-file <path>]
//                    [--state-dir <path>] [--quota-file <path> | --no-quota | --refresh-quota] [--json]
//   route.mjs named <模型> [--provider <id>] [--caps-file ...] [--json]
//   route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named]
//   route.mjs audit [--caps-file <path>] [--json]
//                                     审计 route-data 全部入口与 ROUTES 行内 options
//                                     是否「目录可查 + 取值合法」，有问题 exit 1
//   route.mjs table [--json]          打印当前生效的路由数据（供人工核对）
//   route.mjs tasks                   列出 --task 可用取值
//
// 退出码：0 选出/校验通过；1 无可用候选或校验违规；2 参数错误。
//
// 输入来源（脚本自取，不靠模型转述）：
//   capabilities  —— --caps-file 传 orchestrator_capabilities 的 JSON；文件 mtime 超
//                    CAPS_FILE_TTL_MS 时告警，并在「不可派/无此模型」类判定上标注过期；
//                    缺省读 ${T3_CACHE_DIR:-~/.t3/caches}/<provider>.json
//                    （无法验证 canRunChildTask，只降级告警）
//   共享冷却状态  —— quota-state.mjs 的 status（--state-dir 仅供测试）
//   额度窗口      —— t3-quota.mjs collectCached()：<state-dir>/quota.json 快照 ≤TTL 直接复用，
//                    过期才实查并写回（--quota-file 用文件代替；--no-quota 跳过；--refresh-quota 强制实查）

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SWE2_FREE_UNTIL,
  PROVIDER_RULES,
  MODELS,
  TASKS,
  ADVISOR_TASKS,
  ROLE_TASKS,
  ROUTES,
  EXPIRY_DEMOTE,
  POOLS,
  QUOTA_BLOCK_PERCENT,
  QUOTA_BLOCK_RESET_MS,
  MAX_ATTEMPTS,
  VERIFIED_OPTION_VALUES,
  EFFORT_STANDARD,
  EFFORT_OPTION_IDS,
  EFFORT_EXCEPTIONS,
} from "./route-data.mjs";
import { operate, defaultCache } from "./quota-state.mjs";
import { collectCached as collectQuotaCached, quotaCachePath } from "./t3-quota.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const now = Date.now();
const swe2Free = now < Date.parse(SWE2_FREE_UNTIL);
// caps 文件时效：provider 可派性/模型清单会随安装与刷新漂移，手工落盘的快照没有 TTL 概念
// （曾因此按 3 小时前的 canRunChildTask=false 跳过首选入口）。超阈值不拒用——该文件可能
// 仍是最佳数据源——但告警并给「不可派」类判定标过期，提示刷新后复核。
const CAPS_FILE_TTL_MS = 30 * 60 * 1000;

// ---------- 参数 ----------

function parseArgs(argv) {
  const args = { exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (["hard", "vision", "json", "no-quota", "refresh-quota", "user-named"].includes(key)) args[key] = true;
      else if (key === "exclude") args.exclude.push(argv[++i]);
      else args[key] = argv[++i];
    } else if (args._ === undefined) args._ = a;
    else (args._extra ??= []).push(a);
  }
  return args;
}

const entryId = (e) => `${e.provider}/${e.id}`;

// ---------- capabilities ----------

// 选项描述符 → { type, values:Set|null }；values 仅 select 类有取值集，boolean 为 null
function optionSpec(descriptors) {
  const spec = new Map();
  for (const o of descriptors ?? []) {
    spec.set(o.id, { type: o.type, values: o.options?.length ? new Set(o.options.map((v) => v.id)) : null });
  }
  return spec;
}

function loadProviders(capsFile) {
  const warnings = [];
  const providers = new Map(); // id -> {runnable, reason?, models:Set, optionSpecs:Map<modelId,Map<optionId,{type,values}>>, optionIds, cross:boolean}
  const capsJson = capsFile ? JSON.parse(readFileSync(capsFile, "utf8")) : null;
  if (capsJson) {
    const list = Array.isArray(capsJson) ? capsJson : (capsJson.providers ?? []);
    for (const p of list) {
      const optionSpecs = new Map();
      for (const m of p.models ?? []) optionSpecs.set(m.id, optionSpec(m.options));
      providers.set(p.providerInstanceId, {
        runnable: p.canRunChildTask === true,
        cross: p.canRunCrossProviderChildTask === true,
        reason: p.canRunChildTask ? undefined : (p.constraints ?? []).join("; ") || "canRunChildTask=false",
        models: new Set((p.models ?? []).map((m) => m.id)),
        optionSpecs,
        optionIds: new Map([...optionSpecs].map(([k, v]) => [k, new Set(v.keys())])),
      });
    }
    let capsStaleMin;
    try {
      const ageMs = now - statSync(capsFile).mtimeMs;
      if (ageMs > CAPS_FILE_TTL_MS) {
        capsStaleMin = Math.round(ageMs / 60000);
        warnings.push(
          `--caps-file 是 ${capsStaleMin} 分钟前的快照（阈值 ${CAPS_FILE_TTL_MS / 60000} 分钟）：canRunChildTask、模型清单与选项取值可能已过期——重新调 orchestrator_capabilities 落盘后再选；无法刷新时去掉 --caps-file 走 ~/.t3/caches 降级判断`,
        );
      }
    } catch {}
    return { providers, warnings, live: true, capsStaleMin };
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
      providers.set(id, { runnable: false, reason: `无缓存文件 ${file}`, models: new Set(), optionSpecs: new Map(), optionIds: new Map() });
      continue;
    }
    const runnable = c.enabled === true && c.status === "ready" && c.auth?.status === "authenticated";
    const optionSpecs = new Map();
    for (const m of c.models ?? []) optionSpecs.set(m.slug ?? m.id, optionSpec(m.capabilities?.optionDescriptors));
    providers.set(id, {
      runnable,
      reason: runnable ? undefined : `缓存状态 enabled=${c.enabled} status=${c.status} auth=${c.auth?.status}`,
      models: new Set(optionSpecs.keys()),
      optionSpecs,
      optionIds: new Map([...optionSpecs].map(([k, v]) => [k, new Set(v.keys())])),
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
  if (opts["no-quota"]) return { rows: null, warnings: ["--no-quota：跳过额度窗口检查"], meta: null };
  try {
    if (opts["quota-file"]) {
      return { rows: JSON.parse(readFileSync(opts["quota-file"], "utf8")), warnings: [], meta: { source: "--quota-file" } };
    }
    const meta = await collectQuotaCached({
      cachePath: quotaCachePath(opts["state-dir"] || defaultCache()),
      refresh: opts["refresh-quota"] === true,
    });
    return { rows: meta.rows, warnings: [], meta };
  } catch (e) {
    return { rows: null, warnings: [`额度查询失败（${e.message}），跳过额度拦截`], meta: null };
  }
}

// 返回 null（放行）或拦截原因字符串
function quotaBlock(entry, quotaRows, warnings, { freeExempt = true } = {}) {
  const pool = POOLS[entry.pool];
  if (!pool || !quotaRows) return null;
  if (freeExempt && entry.model === "swe-2" && swe2Free) return null; // 免费期内 devin 额度不拦 swe-2
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

// 任意字符串（模型 key / label / 任一入口 id）→ MODELS 条目；用于 named
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

function injectOptions(entry, providers, at = now) {
  const options = { ...(entry.options ?? {}) };
  const info = providers.get(entry.provider);
  if (entry.provider === "acpRegistry_factory_droid" && options.autonomy_level === undefined) {
    options.autonomy_level = PROVIDER_RULES.acpRegistry_factory_droid.forceOptions.autonomy_level;
  }
  // fastMode 只在该模型目录规格里确实存在时注入；规格未知不猜（曾因正则兜底给没有
  // fastMode 的 cursor/claudeAgent 模型注入，被服务端拒掉）
  const specHasFast = info?.optionSpecs.get(entry.id)?.has("fastMode") ?? false;
  if (specHasFast && options.fastMode === undefined) options.fastMode = false;
  // 带期限的档位例外（如 swe-2 免费期 max）：到期自动回落 EFFORT_STANDARD
  const exc = EFFORT_EXCEPTIONS[`${entry.provider}/${entry.id}`];
  if (exc?.until && at >= Date.parse(exc.until)) {
    const k = EFFORT_OPTION_IDS.find((id) => id in options);
    if (k) options[k] = EFFORT_STANDARD;
  }
  return options;
}

// 校验 options 是否「目录可查 + 取值合法」。返回问题描述数组；
// 该模型规格未知（provider/模型不在目录里）时返回 []，不误拦。
function validateOptions(provider, modelId, options = {}, providers) {
  const specs = providers?.get(provider)?.optionSpecs.get(modelId);
  if (!specs) return [];
  const problems = [];
  const verified = VERIFIED_OPTION_VALUES[provider] ?? {};
  for (const [k, v] of Object.entries(options)) {
    const spec = specs.get(k);
    if (!spec) {
      problems.push(`${provider}/${modelId} 无选项 ${k}（可用: ${[...specs.keys()].join(", ") || "无"}）`);
      continue;
    }
    if (spec.type === "boolean") {
      if (typeof v !== "boolean") problems.push(`${provider}/${modelId} 选项 ${k} 应为 boolean，实传 ${JSON.stringify(v)}`);
      continue;
    }
    if (spec.values?.size) {
      let allowed = spec.values;
      if (verified[k]) allowed = new Set([...allowed].filter((x) => verified[k].includes(x)));
      if (!allowed.has(String(v))) {
        problems.push(`${provider}/${modelId} 选项 ${k} 非法取值 ${JSON.stringify(v)}（允许: ${[...allowed].join(", ")}）`);
      }
    }
  }
  return problems;
}

// harness 白名单（PROVIDER_RULES.allowModels）：硬性规则，用户点名也不豁免。
function allowlistViolations(provider, model) {
  const reasons = [];
  const rule = PROVIDER_RULES[provider];
  if (rule?.allowModels && !rule.allowModels.includes(model)) reasons.push(`${provider} 只允许 ${rule.allowModels.join(" / ")}（${rule.note}）`);
  return reasons;
}

// MODELS.tasks 限定：模型不承担该任务类型时返回原因，否则 null
function taskViolation(modelKey, task) {
  const tasks = MODELS[modelKey]?.tasks;
  if (!tasks || !task || tasks.includes(task)) return null;
  return `${MODELS[modelKey].label} 只承担 ${tasks.join(" / ")} 任务，不做 ${task}`;
}

// check 子命令用的全部硬性规则；select 对生成的组合也跑一遍兜底。
// providers 可选：传了才做目录取值校验（check --caps-file），不传维持原有行为。
function gateCheck({ provider, model, role, options = {}, userNamed = false }, providers) {
  const fails = [];
  const warns = [];
  const resolved = findModel(provider, model);
  const status = resolved?.status;

  // 永远生效：快速模式、harness 白名单、droid 选项
  if (options.fastMode === true || options.fastMode === "true") fails.push("fastMode 必须为 false");
  if (options.serviceTier === "priority") fails.push("codex serviceTier 保持 default，不用 priority");
  if (/-fast\b/i.test(model)) fails.push(`模型名带 -fast（${model}）`);
  fails.push(...allowlistViolations(provider, model));
  if (provider === "acpRegistry_factory_droid") {
    if (options.autonomy_level === undefined) fails.push('factory_droid 任务 options 必须带 {"autonomy_level":"auto-high"}');
    else if (options.autonomy_level !== "auto-high") warns.push(`autonomy_level=${options.autonomy_level}，非 auto-high——确认是用户指定`);
    if (options.reasoningEffort !== undefined) fails.push("factory_droid 推理档选项名是 reasoning_effort（snake_case），不是 reasoningEffort");
  }

  if (providers) fails.push(...validateOptions(provider, model, options, providers));

  const roleTask = resolved && taskViolation(resolved.key, ROLE_TASKS[role]);
  if (!userNamed) {
    if (status === "named") fails.push(`${resolved.label} 仅限用户点名才可用，自动调度与换路跳过`);
    if (status === "advisor" && role === "implementation") fails.push(`${resolved.label} 是顾问/审查专用，不承担 implementation 任务`);
    if (roleTask) fails.push(`${roleTask}（role=${role}）`);
    if (!resolved) fails.push(`${provider}/${model} 不在 route-data.mjs 任何模型的入口清单内，自动调度不得选用`);
  } else {
    if (status === "named") warns.push(`${resolved.label} 为点名专用模型——本次按用户点名放行`);
    if (resolved?.status === "advisor" && role === "implementation") warns.push(`${resolved.label} 平时不写实现；用户点名时按用户说的`);
    if (roleTask) warns.push(`${roleTask}；用户点名时按用户说的`);
    if (!resolved) warns.push(`${provider}/${model} 不在任何已知入口清单——确认模型 ID 与用户点名一致`);
  }
  return { fails, warns, resolved };
}

// ---------- 候选展开 ----------

// 候选 → 入口组合：{model, provider} 钉到该模型 entries 里 provider 匹配的条目（同一 harness 有多个入口时按 entries 顺序全部展开）；
// 不带 provider 的候选（白名单递补、named）展开该模型全部入口，entries 顺序即 harness 优先级。
function expandCandidates(cands, stream, seen, via) {
  for (const cand of cands) {
    const m = MODELS[cand.model];
    if (!m) continue;
    const entries = cand.provider ? m.entries.filter((e) => e.provider === cand.provider) : m.entries;
    entries.forEach((e, i) => {
      const k = entryId(e);
      if (seen.has(k)) return;
      seen.add(k);
      stream.push({
        model: cand.model,
        status: m.status,
        vision: m.vision ?? 0,
        provider: e.provider,
        id: e.id,
        options: { ...(e.options ?? {}), ...(i === 0 ? (cand.options ?? {}) : {}) },
        pool: e.pool,
        via: i === 0 ? (cand.via ?? via) : "same-model",
      });
    });
  }
}

// EXPIRY_DEMOTE 在候选层应用：free 为 false（SWE2_FREE_UNTIL 已过期）时按规则重排行内候选。
// free 缺省取模块级真实时间；测试可显式传值。
function applyExpiryDemote(taskKey, cands, free = swe2Free) {
  if (free) return cands;
  const out = [...cands];
  for (const d of EXPIRY_DEMOTE) {
    if (d.task !== taskKey) continue;
    const from = out.findIndex((c) => c.model === d.model);
    if (from < 0) continue;
    const [moved] = out.splice(from, 1);
    let below = -1;
    out.forEach((c, i) => { if (c.model === d.below) below = i; });
    out.splice(below < 0 ? from : below + 1, 0, moved);
  }
  return out;
}

// 白名单递补：ROUTES 行内没点名的可调度模型按 MODELS 声明顺序补在流末尾。
// status:"auto" 全任务可用；"advisor" 只进 ADVISOR_TASKS 任务；named 不进自动调度流；
// 带 tasks 的模型只进所列任务。
function whitelistCands(taskKey) {
  const allowAdvisor = ADVISOR_TASKS.includes(taskKey);
  return Object.keys(MODELS)
    .filter((k) => MODELS[k].status === "auto" || (allowAdvisor && MODELS[k].status === "advisor"))
    .filter((k) => !taskViolation(k, taskKey))
    .map((model) => ({ model }));
}

function expandRoute(taskKey, free = swe2Free) {
  const stream = [];
  const seen = new Set();
  expandCandidates(applyExpiryDemote(taskKey, ROUTES[taskKey] ?? [], free), stream, seen, "route");
  expandCandidates(whitelistCands(taskKey), stream, seen, "whitelist");
  return stream;
}

// ---------- select ----------

async function buildContext(opts) {
  const { providers, warnings: w1, capsStaleMin } = loadProviders(opts["caps-file"]);
  const { blockedEntries, blockedPools, recoveryEntries, recoveryPools, warnings: w2 } = await loadBlocked(opts["state-dir"]);
  const { rows: quotaRows, warnings: w3, meta: quotaMeta } = await loadQuota(opts);
  const quotaWarnings = new Set();
  return { providers, capsStaleMin, blockedEntries, blockedPools, recoveryEntries, recoveryPools, quotaRows, quotaMeta, quotaWarnings, warnings: [...w1, ...w2, ...w3] };
}

// 额度快照来源说明：让读输出的人知道数据多新、是不是缓存，不据此自行裁决
function quotaNote(meta) {
  if (!meta) return null;
  if (meta.source === "--quota-file") return null; // 测试/显式文件不注明
  const ageMin = Math.max(0, Math.round((now - meta.fetchedAt) / 60000));
  const src = meta.stale ? `实查失败，用 ${ageMin} 分钟前的旧快照` : meta.fromCache ? `${ageMin} 分钟前缓存` : "刚实查";
  return `额度快照：${src}（--refresh-quota 强制实查；明细跑 t3-quota.mjs）`;
}

function gateEntry(item, ctx, opts, taskKey) {
  const reasons = [];
  if (item.status === "named") reasons.push("仅限用户点名");
  // 兜底：白名单递补已按任务过滤，这里再拦一次行内错配的顾问模型
  if (item.status === "advisor" && taskKey && !ADVISOR_TASKS.includes(taskKey)) reasons.push("顾问模型不承担该任务类型");
  const tv = taskViolation(item.model, taskKey);
  if (tv) reasons.push(tv);
  reasons.push(...allowlistViolations(item.provider, item.id));
  // caps 快照过期时，这三条由它得出的拦截原因都可能失效，逐条标注逼出复核而不是默默照单全收
  const staleNote = ctx.capsStaleMin !== undefined ? `；caps 快照 ${ctx.capsStaleMin} 分钟前生成，此判定可能已过期` : "";
  const info = ctx.providers.get(item.provider);
  if (!info) reasons.push(`实例不在 capabilities/缓存清单${staleNote}`);
  else if (!info.runnable) reasons.push(`实例不可派子任务${info.reason ? `（${info.reason}）` : ""}${staleNote}`);
  else if (!info.models.has(item.id)) reasons.push(`该实例模型清单无此 ID${staleNote}`);
  if (ctx.blockedEntries.has(entryId(item))) {
    const b = ctx.blockedEntries.get(entryId(item));
    reasons.push(`入口冷却（${b.kind}，至 ${new Date(b.until).toISOString().slice(0, 16)}Z）`);
  }
  if (item.pool && ctx.blockedPools.has(item.pool)) {
    const b = ctx.blockedPools.get(item.pool);
    // 免费期内 devin 池的 quota 冷却不拦 swe-2；其他 kind（连接/配置等）照样拦
    if (!(item.model === "swe-2" && swe2Free && b.kind === "quota")) {
      reasons.push(`池冷却（${b.kind}，至 ${new Date(b.until).toISOString().slice(0, 16)}Z）`);
    }
  }
  const qb = quotaBlock(item, ctx.quotaRows, ctx.quotaWarnings);
  if (qb) reasons.push(qb);
  // 注入后的最终 options 过一遍目录校验（选项名/取值非法的入口直接跳过）
  reasons.push(...validateOptions(item.provider, item.id, injectOptions(item, ctx.providers), ctx.providers));
  return reasons;
}

function finalize(item, ctx) {
  const options = injectOptions(item, ctx.providers);
  const recovery = ctx.recoveryEntries.has(entryId(item)) || (item.pool != null && ctx.recoveryPools.has(item.pool));
  // 豁免只在「本来真会被拦」时标注：所在池额度超限或已有 quota 冷却。
  // 不标的话 PICK 落在「池 100%」的池上，容易被误读成脚本漏判而被人工推翻。
  let exempt;
  if (item.model === "swe-2" && swe2Free) {
    const waived = [];
    const qb = quotaBlock(item, ctx.quotaRows, new Set(), { freeExempt: false });
    if (qb) waived.push(qb);
    const pb = item.pool ? ctx.blockedPools.get(item.pool) : null;
    if (pb?.kind === "quota") waived.push(`池 quota 冷却至 ${new Date(pb.until).toISOString().slice(0, 16)}Z`);
    if (waived.length) exempt = `swe-2 免费期至 ${SWE2_FREE_UNTIL.slice(0, 10)}，豁免：${waived.join("；")}`;
  }
  return {
    providerInstanceId: item.provider,
    model: item.id,
    modelKey: item.model,
    options,
    pool: item.pool ?? null,
    via: item.via,
    needsRecovery: recovery,
    swe2FreeExempt: (item.model === "swe-2" && swe2Free) || undefined,
    exempt,
  };
}

function runSelect(taskKey, ctx, opts, out) {
  let stream = expandRoute(taskKey);
  const excluded = new Set(opts.exclude);
  stream = stream.filter((i) => !excluded.has(entryId(i)));

  if (opts.vision) {
    stream = [...stream].sort((a, b) => b.vision - a.vision);
    out.notes.push("--vision：候选按视觉分数降序");
  }

  const available = [];
  for (const item of stream) {
    const reasons = gateEntry(item, ctx, opts, taskKey);
    if (reasons.length) out.skipped.push({ entry: entryId(item), model: item.model, via: item.via, reasons });
    else available.push(finalize(item, ctx));
  }
  return available;
}

async function selectCmd(opts) {
  const task = opts.task;
  if (!task || !TASKS[task]) {
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
  const qn = quotaNote(ctx.quotaMeta);
  if (qn) out.notes.push(qn);

  if (opts.hard && task === "general") {
    const advisor = runSelect("design", ctx, { ...opts, vision: opts.vision }, out);
    const impl = runSelect("general", ctx, opts, out);
    out.steps = [
      { role: "design", purpose: "难题先派顾问咨询（问方案、风险、被否决方向）", pick: advisor[0] ?? null },
      { role: "implementation", purpose: "方案定下来后的实现", pick: impl[0] ?? null },
    ];
    out.alternatives = impl.slice(1, 8);
  } else {
    const available = runSelect(task, ctx, opts, out);
    out.pick = available[0] ?? null;
    out.alternatives = available.slice(1, 8);
  }

  if (out.pick?.via === "whitelist") out.notes.push("PICK 来自白名单递补：路由行的候选都不可用（见 SKIPPED），该模型不在本任务优先级行内");
  const done = out.pick ?? out.steps?.every((s) => s.pick);
  printSelect(out, opts);
  process.exit(done ? 0 : 1);
}

function printSelect(out, opts) {
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const fmt = (p) => (p ? `${p.providerInstanceId} / ${p.model}  options=${JSON.stringify(p.options)}${p.exempt ? `（${p.exempt}）` : ""}` : "无");
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
  const qn2 = quotaNote(ctx.quotaMeta);
  if (qn2) out.notes.push(qn2);
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
    const item = { model: m.key ?? query, status: m.status, vision: m.vision ?? 0, provider: e.provider, id: e.id, options: { ...(e.options ?? {}), ...extraOptions }, pool: e.pool, via: "named" };
    const reasons = [];
    reasons.push(...allowlistViolations(item.provider, item.id));
    const staleNote = ctx.capsStaleMin !== undefined ? `；caps 快照 ${ctx.capsStaleMin} 分钟前生成，此判定可能已过期` : "";
    const info = ctx.providers.get(item.provider);
    if (!info) reasons.push(`实例不在 capabilities/缓存清单${staleNote}`);
    else if (!info.runnable) reasons.push(`实例不可派子任务${info.reason ? `（${info.reason}）` : ""}${staleNote}`);
    else if (!info.models.has(item.id)) reasons.push(`该实例模型清单无此 ID${staleNote}`);
    if (ctx.blockedEntries.has(entryId(item))) reasons.push("入口冷却中");
    if (item.pool && ctx.blockedPools.has(item.pool)) {
      const b = ctx.blockedPools.get(item.pool);
      if (!(item.model === "swe-2" && swe2Free && b.kind === "quota")) reasons.push("池冷却中");
    }
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
  const { providers, warnings: capsWarnings } = opts["caps-file"] ? loadProviders(opts["caps-file"]) : { providers: undefined, warnings: [] };
  for (const w of capsWarnings) console.log(`WARN ${w}`);
  const { fails, warns } = gateCheck({ provider, model, role: opts.role, options, userNamed: opts["user-named"] }, providers);
  for (const w of warns) console.log(`WARN ${w}`);
  if (fails.length) {
    console.log(`FAIL ${provider}/${model}${opts.role ? ` role=${opts.role}` : ""}`);
    for (const f of fails) console.log(`- ${f}`);
    process.exit(1);
  }
  console.log(`OK ${provider}/${model}${opts.role ? ` role=${opts.role}` : ""}${opts["user-named"] ? " (user-named)" : ""}`);
}

// ---------- audit ----------

// 审计 route-data：全部 MODELS entries 与 ROUTES 候选的「入口 options + 行内 options」
// 合并结果，逐条核对 provider/模型在目录里、选项名与取值合法。返回问题描述数组。
function auditRouteData(providers) {
  const problems = [];
  const check = (label, provider, modelId, options) => {
    const info = providers.get(provider);
    if (!info) {
      problems.push(`${label}: ${provider} 不在目录`);
      return;
    }
    if (!info.models.has(modelId)) {
      problems.push(`${label}: ${provider}/${modelId} 不在该实例模型清单`);
      return;
    }
    // 校验注入后的最终 options（覆盖 fastMode 自动注入、行内覆盖）
    const finalOptions = injectOptions({ provider, id: modelId, options }, providers);
    for (const p of validateOptions(provider, modelId, finalOptions, providers)) problems.push(`${label}: ${p}`);
  };
  for (const [key, m] of Object.entries(MODELS)) {
    for (const e of m.entries) check(`MODELS.${key}`, e.provider, e.id, e.options ?? {});
  }
  for (const [task, cands] of Object.entries(ROUTES)) {
    for (const c of cands) {
      const m = MODELS[c.model];
      if (!m) {
        problems.push(`ROUTES.${task}: 未知模型 ${c.model}`);
        continue;
      }
      if (!c.provider) {
        problems.push(`ROUTES.${task}: ${c.model} 候选缺 provider（组合须显式钉 harness）`);
        continue;
      }
      const e = m.entries.find((x) => x.provider === c.provider);
      if (!e) {
        problems.push(`ROUTES.${task}: ${c.model} 没有 ${c.provider} 入口`);
        continue;
      }
      const tv = taskViolation(c.model, task);
      if (tv) problems.push(`ROUTES.${task}: ${tv}`);
      check(`ROUTES.${task}`, e.provider, e.id, { ...(e.options ?? {}), ...(c.options ?? {}) });
    }
  }
  return problems;
}

function auditCmd(opts) {
  const { providers, warnings } = loadProviders(opts["caps-file"]);
  const problems = auditRouteData(providers);
  if (opts.json) {
    console.log(JSON.stringify({ problems, warnings }, null, 2));
  } else {
    for (const w of warnings) console.log(`WARN ${w}`);
    if (problems.length) for (const p of problems) console.log(`PROBLEM ${p}`);
    else console.log("audit: 0 问题，全部入口目录可查、选项合法");
  }
  process.exit(problems.length ? 1 : 0);
}

// ---------- table / tasks ----------

function tableCmd(opts) {
  const data = { SWE2_FREE_UNTIL, swe2FreeNow: swe2Free, PROVIDER_RULES, MODELS, TASKS, ADVISOR_TASKS, ROLE_TASKS, ROUTES, POOLS, QUOTA_BLOCK_PERCENT, QUOTA_BLOCK_RESET_MS, MAX_ATTEMPTS };
  console.log(opts.json ? JSON.stringify(data, null, 2) : renderTable(data));
}

function renderTable({ MODELS: ms, ROUTES: rs }) {
  const lines = [];
  for (const [key, m] of Object.entries(ms)) {
    lines.push(`\n[${m.label}] status=${m.status}${m.tasks ? ` tasks=${m.tasks.join(",")}` : ""}${m.vision ? ` vision=${m.vision}` : ""}`);
    m.entries.forEach((e, i) => lines.push(`  ${i + 1}. ${e.provider} / ${e.id}  pool=${e.pool ?? "-"}  options=${JSON.stringify(e.options ?? {})}`));
  }
  lines.push("\nROUTES（行内是「模型@harness」组合的优先级；行尾自动递补白名单）:");
  for (const [task, cands] of Object.entries(rs)) {
    const tail = `auto${ADVISOR_TASKS.includes(task) ? "+advisor" : ""}`;
    lines.push(`  ${task}: ${cands.map((c) => `${c.model}@${c.provider}`).join("  →  ")}   ⇒ 递补:${tail}`);
  }
  return lines.join("\n");
}

// ---------- main ----------

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const KNOWN = new Set(["select", "named", "check", "audit", "table", "tasks"]);
  const [cmd, ...rest] = process.argv.slice(2);
  const isCmd = KNOWN.has(cmd);
  const opts = parseArgs(isCmd ? rest : process.argv.slice(2));
  try {
    if (cmd === "check") checkCmd(opts);
    else if (cmd === "audit") auditCmd(opts);
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

export { gateCheck, allowlistViolations, expandRoute, expandCandidates, whitelistCands, applyExpiryDemote, loadProviders, quotaBlock, resolveModel, findModel, validateOptions, injectOptions, auditRouteData };
