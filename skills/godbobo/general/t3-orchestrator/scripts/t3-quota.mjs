#!/usr/bin/env node
// 打印各 harness 的可用状态与额度窗口。只读，不打印账号与密钥。
// 1. T3 Code 缓存的 provider 快照（codex、devin、opencode 等）。
// 2. T3 缓存里没有的额度，直接查询服务商接口（查询方式参考 steipete/CodexBar）：
//    - GLM Coding Plan：GET <host>/api/monitor/usage/quota/limit
//    - Factory Droid：GET https://api.factory.ai/api/billing/limits
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const t3Home = process.env.T3CODE_HOME || join(HOME, ".t3");
const cacheDir = join(t3Home, "caches");
const STALE_HOURS = 6;
const TIMEOUT_MS = 10_000;
const now = Date.now();

function untilReset(resetMs) {
  if (!Number.isFinite(resetMs)) return "重置时间未知";
  const ms = resetMs - now;
  if (ms <= 0) return "已重置";
  const h = ms / 3_600_000;
  return h >= 48 ? `${Math.round(h / 24)}天后重置` : `${h.toFixed(1)}h后重置`;
}

function formatWindow(label, usedPercent, resetMs) {
  const used = Number.isFinite(usedPercent) ? `${Math.round(usedPercent)}%` : "?";
  const flag = usedPercent >= 90 ? " ⚠" : "";
  return `${label} ${used}${flag}（${untilReset(resetMs)}）`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function codexbarProvider(id) {
  const config =
    readJson(process.env.CODEXBAR_CONFIG || join(HOME, ".config", "codexbar", "config.json")) ??
    readJson(join(HOME, ".codexbar", "config.json"));
  return config?.providers?.find((p) => p?.id === id) ?? null;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function cacheRows() {
  let files;
  try {
    files = readdirSync(cacheDir).filter((f) => f.endsWith(".json") && !f.startsWith("acp-auth"));
  } catch (error) {
    return [`无法读取 ${cacheDir}: ${error.message}`];
  }
  const rows = [];
  for (const file of files.sort()) {
    const snap = readJson(join(cacheDir, file));
    if (!snap || typeof snap !== "object" || !snap.instanceId) continue;

    const parts = [snap.enabled === false ? "已禁用" : (snap.status ?? "?")];
    if (snap.auth?.status && snap.auth.status !== "authenticated") parts.push(`auth=${snap.auth.status}`);

    const limits = snap.usageLimits;
    if (!limits) parts.push("无额度数据");
    else if (limits.unavailable) parts.push(`额度不可读(${limits.unavailable.reason})`);
    else if (!limits.windows?.length) parts.push("无额度窗口");
    else {
      for (const w of limits.windows) {
        parts.push(formatWindow(w.label ?? w.id, w.usedPercent, w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN));
      }
    }

    const checkedAt = limits?.checkedAt ?? snap.checkedAt;
    const ageH = checkedAt ? (now - Date.parse(checkedAt)) / 3_600_000 : Number.NaN;
    if (Number.isNaN(ageH) || ageH > STALE_HOURS) {
      parts.push(`数据陈旧(${Number.isNaN(ageH) ? "?" : ageH.toFixed(1)}h前)`);
    }
    rows.push(`${snap.instanceId.padEnd(28)} ${parts.join(" | ")}`);
  }
  return rows;
}

// --- GLM Coding Plan（claudeAgent 实例走的账号） ---

function resolveGlmCredential() {
  for (const name of ["BIGMODEL_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"]) {
    if (process.env[name]) return { key: process.env[name], host: "open.bigmodel.cn", source: name };
  }
  if (process.env.Z_AI_API_KEY) {
    return { key: process.env.Z_AI_API_KEY, host: process.env.Z_AI_API_HOST || "api.z.ai", source: "Z_AI_API_KEY" };
  }
  const env = readJson(join(HOME, ".claude", "settings.json"))?.env;
  if (env?.ANTHROPIC_BASE_URL && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY)) {
    let host = "";
    try {
      host = new URL(env.ANTHROPIC_BASE_URL).host;
    } catch {}
    if (host === "open.bigmodel.cn" || host === "api.z.ai") {
      return { key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY, host, source: "~/.claude/settings.json" };
    }
  }
  const zai = codexbarProvider("zai");
  if (zai?.apiKey) {
    const host = zai.region === "bigmodel-cn" ? "open.bigmodel.cn" : "api.z.ai";
    return { key: zai.apiKey, host, source: "CodexBar 配置" };
  }
  return null;
}

function glmWindow(limit) {
  let percent = limit.percentage;
  if (Number.isInteger(limit.usage) && limit.usage > 0) {
    const used = Number.isInteger(limit.remaining)
      ? limit.usage - limit.remaining
      : Number.isInteger(limit.currentValue)
        ? limit.currentValue
        : null;
    if (used !== null) percent = (Math.max(0, Math.min(limit.usage, used)) / limit.usage) * 100;
  }
  let label;
  if (limit.type === "TIME_LIMIT") label = "MCP";
  else {
    const minutes = { 1: 1440, 3: 60, 5: 1, 6: 10080 }[limit.unit] * limit.number;
    label = minutes === 300 ? "5h" : minutes === 10080 ? "周" : minutes ? `${minutes / 60}h` : "额度";
  }
  return formatWindow(label, percent, limit.nextResetTime);
}

async function glmRow() {
  const name = "glm (claudeAgent)".padEnd(28);
  const cred = resolveGlmCredential();
  if (!cred) return `${name} 未找到 GLM 密钥（环境变量、~/.claude/settings.json 或 CodexBar 配置）`;
  try {
    const body = await getJson(`https://${cred.host}/api/monitor/usage/quota/limit`, {
      authorization: `Bearer ${cred.key}`,
      accept: "application/json",
    });
    if (body?.success !== true || body.code !== 200 || !Array.isArray(body.data?.limits)) {
      return `${name} 查询失败（${body?.msg ?? "返回格式无法识别"}）`;
    }
    const known = body.data.limits.filter((l) => ["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(l?.type));
    const order = (l) => (l.type === "TIME_LIMIT" ? 1 : 0);
    const parts = known.sort((a, b) => order(a) - order(b)).map(glmWindow);
    return `${name} ${parts.join(" | ") || "无额度窗口"}`;
  } catch (error) {
    return `${name} 查询失败（${error.message}）`;
  }
}

// --- Factory Droid ---

function resolveFactoryKey() {
  if (process.env.FACTORY_API_KEY) return process.env.FACTORY_API_KEY.trim();
  const envFile = join(HOME, ".factory", ".env");
  if (existsSync(envFile)) {
    for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim().replace(/^export\s+/, "");
      const match = line.match(/^FACTORY_API_KEY\s*=\s*(.+)$/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
      if (/^fk-\S+$/.test(line)) return line;
    }
  }
  return codexbarProvider("factory")?.apiKey ?? null;
}

function factoryWindow(label, w) {
  if (!w) return null;
  let reset = Number.NaN;
  if (Number(w.secondsRemaining) > 0) reset = now + Number(w.secondsRemaining) * 1000;
  else if (w.windowEnd != null) {
    const n = Number(w.windowEnd);
    reset = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(w.windowEnd);
  }
  // 短窗口过期后接口可能留着旧值，网页端按已重置处理。
  const expired = w.windowEnd != null && !(Number(w.secondsRemaining) > 0) && !(reset > now);
  return formatWindow(label, expired ? 0 : Math.min(100, Math.max(0, Number(w.usedPercent))), reset);
}

function ratioPercent(pool) {
  if (!pool) return Number.NaN;
  const ratio = pool.usedRatio;
  if (Number.isFinite(ratio) && ratio >= -0.001 && ratio <= 1.001) return Math.max(0, ratio * 100);
  if (pool.totalAllowance > 0 && pool.totalAllowance <= 1e12) return (pool.userTokens / pool.totalAllowance) * 100;
  return Number.isFinite(ratio) && ratio <= 100.1 ? ratio : Number.NaN;
}

async function droidRow() {
  const name = "droid (factory_droid)".padEnd(28);
  const key = resolveFactoryKey();
  if (!key) return `${name} 未配置 FACTORY_API_KEY（环境变量或 ~/.factory/.env）`;
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    origin: "https://app.factory.ai",
    referer: "https://app.factory.ai/",
    "x-factory-client": "web-app",
    authorization: `Bearer ${key}`,
  };
  try {
    const billing = await getJson("https://api.factory.ai/api/billing/limits", headers).catch(() => null);
    const pools = billing?.usesTokenRateLimitsBilling ? billing.limits : null;
    if (pools?.standard) {
      const parts = [
        factoryWindow("5h", pools.standard.fiveHour),
        factoryWindow("周", pools.standard.weekly),
        factoryWindow("月", pools.standard.monthly),
      ];
      if (pools.core) {
        parts.push(factoryWindow("Core 5h", pools.core.fiveHour), factoryWindow("Core 周", pools.core.weekly));
      }
      return `${name} ${parts.filter(Boolean).join(" | ")}`;
    }
    const legacy = await getJson("https://api.factory.ai/api/organization/subscription/usage?useCache=true", headers);
    const usage = legacy?.usage;
    if (!usage) return `${name} 查询失败（返回格式无法识别）`;
    const end = Number(usage.endDate);
    return `${name} ${formatWindow("Standard", ratioPercent(usage.standard), end)} | ${formatWindow("Premium", ratioPercent(usage.premium), end)}`;
  } catch (error) {
    return `${name} 查询失败（${error.message}）`;
  }
}

const live = await Promise.all([glmRow(), droidRow()]);
console.log(`T3 home: ${t3Home}`);
console.log([...cacheRows(), ...live].join("\n"));
