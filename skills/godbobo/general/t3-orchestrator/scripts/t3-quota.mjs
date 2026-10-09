#!/usr/bin/env node
// 打印各 harness 的额度窗口。只读，不打印账号与密钥。
// 全部用本机凭证直查服务商接口（查询方式参考 steipete/CodexBar 的
// docs/providers.md 与各 provider 文档）：
//   - Codex：~/.codex/auth.json 的 OAuth token
//     → GET <chatgpt_base_url>/backend-api/wham/usage（默认 chatgpt.com）
//   - Cursor：Cursor.app state.vscdb 的 cursorAuth/accessToken 拼
//     WorkosCursorSessionToken cookie
//     → GET cursor.com/api/usage-summary、POST cursor.com/api/dashboard/get-sand-usage-status
//   - Devin：~/.local/share/devin/credentials.toml 的 windsurf_api_key
//     → GET app.devin.ai/api/<org>/billing/quota/usage（org 取 ~/.config/devin/config.json）
//   - opencode go：~/.local/share/opencode/auth.json 的 opencode-go key
//     → GET opencode.ai/zen/go/v1/usage
//   - GLM Coding Plan：GET <host>/api/monitor/usage/quota/limit
//   - Factory Droid：GET https://api.factory.ai/api/billing/limits
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
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

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readTomlString(path, key) {
  const match = readText(path)?.match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n]+)`, "m"));
  return match?.[1]?.trim() || null;
}

function codexbarProvider(id) {
  const config =
    readJson(process.env.CODEXBAR_CONFIG || join(HOME, ".config", "codexbar", "config.json")) ??
    readJson(join(HOME, ".codexbar", "config.json"));
  return config?.providers?.find((p) => p?.id === id) ?? null;
}

async function getJson(url, headers, init) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function jwtPayload(token) {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function decodeSqliteValue(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array && value.length > 0) {
    // Cursor 可能以无 BOM 的 UTF-16LE 存 ASCII token（隔字节为 NUL）。
    if (
      value.length % 2 === 0 &&
      Array.from({ length: value.length / 2 }, (_, i) => i).every(
        (i) => value[i * 2] > 0 && value[i * 2] < 128 && value[i * 2 + 1] === 0,
      )
    ) {
      const decoded = Buffer.from(value).toString("utf16le").trim();
      if (decoded) return decoded;
    }
    return Buffer.from(value).toString("utf8");
  }
  return null;
}

async function sqliteItem(dbPath, key) {
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1").get(key);
      return decodeSqliteValue(row?.value);
    } finally {
      db.close();
    }
  } catch {
    // node:sqlite 不可用时退回 sqlite3 CLI。
    try {
      const out = execFileSync(
        "sqlite3",
        ["-readonly", dbPath, `SELECT value FROM ItemTable WHERE key = '${key}' LIMIT 1;`],
        { encoding: "utf8", timeout: 8_000 },
      );
      return out.replace(/\0/g, "").trim() || null;
    } catch {
      return null;
    }
  }
}

// --- Codex（ChatGPT 账号 OAuth，读 ~/.codex/auth.json） ---

function codexUsageBase(codexHome) {
  // chatgpt_base_url 覆盖 backend-api 根地址；注释行（含缩进注释）不生效。
  const active = readText(join(codexHome, "config.toml"))
    ?.split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const match = active?.match(/^\s*chatgpt_base_url\s*=\s*["']([^"']+)["']/m);
  return (match?.[1] ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
}

function codexWindowLabel(seconds) {
  const known = { 18000: "5h", 86400: "日", 604800: "周", 2592000: "月" };
  if (known[seconds]) return known[seconds];
  return Number.isFinite(seconds) ? `${Math.round(seconds / 3600)}h` : "额度";
}

async function codexRow() {
  const name = "codex".padEnd(28);
  const codexHome = process.env.CODEX_HOME || join(HOME, ".codex");
  const auth = readJson(join(codexHome, "auth.json"));
  const token = auth?.tokens?.access_token;
  if (!token) return `${name} 未找到登录态（${join(codexHome, "auth.json")} 无 access_token）`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (auth.tokens?.account_id) headers["chatgpt-account-id"] = auth.tokens.account_id;
  try {
    const body = await getJson(`${codexUsageBase(codexHome)}/wham/usage`, headers);
    const rl = body?.rate_limit;
    if (!rl?.primary_window && !rl?.secondary_window) return `${name} 查询失败（返回格式无法识别）`;
    const parts = [rl.primary_window, rl.secondary_window]
      .filter(Boolean)
      .map((w) => formatWindow(codexWindowLabel(w.limit_window_seconds), w.used_percent, Number(w.reset_at) * 1000));
    if (rl.limit_reached) parts.push("已达上限");
    for (const extra of body.additional_rate_limits ?? []) {
      const w = extra?.rate_limit?.primary_window;
      if (w) {
        parts.push(formatWindow(extra.normal_model_slug ?? extra.limit_name ?? "备用", w.used_percent, Number(w.reset_at) * 1000));
      }
    }
    return `${name} ${parts.join(" | ")}`;
  } catch (error) {
    return `${name} 查询失败（${error.message}）`;
  }
}

// --- Cursor（读 Cursor.app 的本地登录态） ---

async function cursorRow() {
  const name = "cursor".padEnd(28);
  let token = process.env.CURSOR_SESSION_TOKEN ?? null;
  if (!token) {
    const dbCandidates = [
      join(HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
      join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "Cursor", "User", "globalStorage", "state.vscdb"),
    ];
    for (const db of dbCandidates) {
      token = await sqliteItem(db, "cursorAuth/accessToken");
      if (token) break;
    }
  }
  if (!token) return `${name} 未找到 Cursor.app 登录态（或用 CURSOR_SESSION_TOKEN 指定）`;
  // 允许传入完整 cookie 值或 "user::jwt" 形式
  if (token.includes("WorkosCursorSessionToken=")) token = token.split("WorkosCursorSessionToken=").pop().split(";")[0];
  try {
    token = decodeURIComponent(token);
  } catch {}
  if (token.includes("::")) token = token.split("::").pop();
  const payload = jwtPayload(token);
  const uid = payload?.sub?.split("|").filter(Boolean).pop();
  if (!uid) return `${name} 登录态无法解析（非 JWT）`;
  if (Number.isFinite(payload.exp) && payload.exp * 1000 < now + 60_000) {
    return `${name} 登录态已过期（${new Date(payload.exp * 1000).toISOString().slice(0, 10)}），请打开 Cursor.app 续期`;
  }
  const cookie = `WorkosCursorSessionToken=${uid}%3A%3A${token}`;
  try {
    const summary = await getJson("https://cursor.com/api/usage-summary", { cookie, accept: "application/json" });
    const plan = summary?.individualUsage?.plan;
    if (!plan) return `${name} 查询失败（返回格式无法识别）`;
    const cycleEnd = Date.parse(summary.billingCycleEnd);
    const total = Number.isFinite(plan.totalPercentUsed)
      ? plan.totalPercentUsed
      : plan.limit > 0
        ? (plan.used / plan.limit) * 100
        : Number.NaN;
    const parts = [
      formatWindow("总额", total, cycleEnd),
      formatWindow("API", plan.apiPercentUsed, cycleEnd),
    ];
    // Grok Bot（Sand）是 Grok 模型的周额度池；失败不影响主结果。
    try {
      const sand = await getJson(
        "https://cursor.com/api/dashboard/get-sand-usage-status",
        { cookie, origin: "https://cursor.com", "content-type": "application/json", accept: "application/json" },
        { method: "POST", body: "{}" },
      );
      const hasLimit = sand?.includedLimitZero === false || sand?.hasNonZeroIncludedLimit === true;
      const trialEnd = Date.parse(sand?.sandTrialExpiresAt);
      const hasTrial = !hasLimit && Number.isFinite(trialEnd) && trialEnd > now;
      if ((hasLimit || hasTrial) && Number.isFinite(sand?.usagePercent)) {
        parts.push(formatWindow("Grok 周", sand.usagePercent, hasLimit ? Date.parse(sand.nextResetTimestampUtc) : Number.NaN));
      }
    } catch {}
    return `${name} ${parts.join(" | ")}`;
  } catch (error) {
    return `${name} 查询失败（${error.message}）`;
  }
}

// --- Devin（读 devin CLI 的 credentials.toml） ---

async function devinRow() {
  const name = "devin".padEnd(28);
  const credPath = join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "devin", "credentials.toml");
  let token = process.env.DEVIN_BEARER_TOKEN || process.env.DEVIN_AUTHORIZATION || readTomlString(credPath, "windsurf_api_key");
  token = token?.replace(/^Bearer\s+/i, "");
  if (!token) return `${name} 未找到凭证（${credPath} 的 windsurf_api_key，或 DEVIN_BEARER_TOKEN）`;
  const org =
    process.env.DEVIN_ORGANIZATION ||
    process.env.DEVIN_ORG ||
    readJson(join(HOME, ".config", "devin", "config.json"))?.devin?.org_id;
  if (!org) return `${name} 未找到 org id（~/.config/devin/config.json 的 devin.org_id，或 DEVIN_ORG）`;
  try {
    const body = await getJson(`https://app.devin.ai/api/${encodeURIComponent(org)}/billing/quota/usage`, {
      authorization: `Bearer ${token}`,
      "x-cog-org-id": org,
      accept: "application/json",
    });
    if (body?.is_quota_plan !== true) return `${name} 非额度计费或返回无法识别`;
    const parts = [];
    if (!body.hide_daily_quota) parts.push(formatWindow("日", Number(body.daily_percentage), Date.parse(body.daily_reset_at)));
    parts.push(formatWindow("周", Number(body.weekly_percentage), Date.parse(body.weekly_reset_at)));
    const overage = Number(body.overage_balance);
    if (Number.isFinite(overage) && overage !== 0) parts.push(`超额余额 $${overage.toFixed(2)}`);
    return `${name} ${parts.join(" | ")}`;
  } catch (error) {
    return `${name} 查询失败（${error.message}）`;
  }
}

// --- opencode go ---

async function opencodeRow() {
  const name = "opencode-go".padEnd(28);
  const authPath = join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "opencode", "auth.json");
  const auth = readJson(authPath);
  const key = process.env.OPENCODE_API_KEY || auth?.["opencode-go"]?.key || auth?.opencode?.key;
  if (!key) return `${name} 未找到 API key（${authPath} 的 opencode-go，或 OPENCODE_API_KEY）`;
  try {
    const body = await getJson("https://opencode.ai/zen/go/v1/usage", {
      authorization: `Bearer ${key}`,
      accept: "application/json",
    });
    const usage = body?.usage;
    if (!usage?.rolling) return `${name} 查询失败（返回格式无法识别）`;
    const parts = [
      ["rolling", "5h"],
      ["weekly", "周"],
      ["monthly", "月"],
    ]
      .filter(([field]) => usage[field] && Number.isFinite(usage[field].percent))
      .map(([field, label]) => formatWindow(label, usage[field].percent, Date.parse(usage[field].resetsAt)));
    return `${name} ${parts.join(" | ") || "无额度窗口"}`;
  } catch (error) {
    return `${name} 查询失败（${error.message}）`;
  }
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

const jobs = [codexRow, cursorRow, devinRow, glmRow, opencodeRow, droidRow];
const rows = await Promise.all(
  jobs.map((fn) => fn().catch((error) => `${fn.name.replace(/Row$/, "").padEnd(28)} 查询失败（${error.message}）`)),
);
console.log(rows.join("\n"));
