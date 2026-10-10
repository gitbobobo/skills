#!/usr/bin/env node
// 打印各 harness 的额度窗口。只读，不打印账号与密钥。
// 默认输出人类可读文本；--json 输出结构化窗口供 route.mjs 消费。
// 每行结构：{ key, note?, windows: [{label, usedPercent, resetMs}], extras: [] }
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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  const key = "codex";
  const codexHome = process.env.CODEX_HOME || join(HOME, ".codex");
  const auth = readJson(join(codexHome, "auth.json"));
  const token = auth?.tokens?.access_token;
  if (!token) return { key, note: `未找到登录态（${join(codexHome, "auth.json")} 无 access_token）`, windows: [], extras: [] };
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (auth.tokens?.account_id) headers["chatgpt-account-id"] = auth.tokens.account_id;
  try {
    const body = await getJson(`${codexUsageBase(codexHome)}/wham/usage`, headers);
    const rl = body?.rate_limit;
    if (!rl?.primary_window && !rl?.secondary_window) return { key, note: "查询失败（返回格式无法识别）", windows: [], extras: [] };
    const windows = [rl.primary_window, rl.secondary_window]
      .filter(Boolean)
      .map((w) => ({ label: codexWindowLabel(w.limit_window_seconds), usedPercent: w.used_percent, resetMs: Number(w.reset_at) * 1000 }));
    const extras = [];
    if (rl.limit_reached) extras.push("已达上限");
    for (const extra of body.additional_rate_limits ?? []) {
      const w = extra?.rate_limit?.primary_window;
      if (w) {
        windows.push({ label: extra.normal_model_slug ?? extra.limit_name ?? "备用", usedPercent: w.used_percent, resetMs: Number(w.reset_at) * 1000 });
      }
    }
    return { key, windows, extras };
  } catch (error) {
    return { key, note: `查询失败（${error.message}）`, windows: [], extras: [] };
  }
}

// --- Cursor（读 Cursor.app 的本地登录态） ---

async function cursorRow() {
  const key = "cursor";
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
  if (!token) return { key, note: "未找到 Cursor.app 登录态（或用 CURSOR_SESSION_TOKEN 指定）", windows: [], extras: [] };
  // 允许传入完整 cookie 值或 "user::jwt" 形式
  if (token.includes("WorkosCursorSessionToken=")) token = token.split("WorkosCursorSessionToken=").pop().split(";")[0];
  try {
    token = decodeURIComponent(token);
  } catch {}
  if (token.includes("::")) token = token.split("::").pop();
  const payload = jwtPayload(token);
  const uid = payload?.sub?.split("|").filter(Boolean).pop();
  if (!uid) return { key, note: "登录态无法解析（非 JWT）", windows: [], extras: [] };
  if (Number.isFinite(payload.exp) && payload.exp * 1000 < now + 60_000) {
    return { key, note: `登录态已过期（${new Date(payload.exp * 1000).toISOString().slice(0, 10)}），请打开 Cursor.app 续期`, windows: [], extras: [] };
  }
  const cookie = `WorkosCursorSessionToken=${uid}%3A%3A${token}`;
  try {
    const summary = await getJson("https://cursor.com/api/usage-summary", { cookie, accept: "application/json" });
    const plan = summary?.individualUsage?.plan;
    if (!plan) return { key, note: "查询失败（返回格式无法识别）", windows: [], extras: [] };
    const cycleEnd = Date.parse(summary.billingCycleEnd);
    const total = Number.isFinite(plan.totalPercentUsed)
      ? plan.totalPercentUsed
      : plan.limit > 0
        ? (plan.used / plan.limit) * 100
        : Number.NaN;
    const windows = [
      { label: "总额", usedPercent: total, resetMs: cycleEnd },
      { label: "API", usedPercent: plan.apiPercentUsed, resetMs: cycleEnd },
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
        windows.push({ label: "Grok 周", usedPercent: sand.usagePercent, resetMs: hasLimit ? Date.parse(sand.nextResetTimestampUtc) : Number.NaN });
      }
    } catch {}
    return { key, windows, extras: [] };
  } catch (error) {
    return { key, note: `查询失败（${error.message}）`, windows: [], extras: [] };
  }
}

// --- Devin（读 devin CLI 的 credentials.toml） ---

async function devinRow() {
  const key = "devin";
  const credPath = join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "devin", "credentials.toml");
  let token = process.env.DEVIN_BEARER_TOKEN || process.env.DEVIN_AUTHORIZATION || readTomlString(credPath, "windsurf_api_key");
  token = token?.replace(/^Bearer\s+/i, "");
  if (!token) return { key, note: `未找到凭证（${credPath} 的 windsurf_api_key，或 DEVIN_BEARER_TOKEN）`, windows: [], extras: [] };
  const org =
    process.env.DEVIN_ORGANIZATION ||
    process.env.DEVIN_ORG ||
    readJson(join(HOME, ".config", "devin", "config.json"))?.devin?.org_id;
  if (!org) return { key, note: "未找到 org id（~/.config/devin/config.json 的 devin.org_id，或 DEVIN_ORG）", windows: [], extras: [] };
  try {
    const body = await getJson(`https://app.devin.ai/api/${encodeURIComponent(org)}/billing/quota/usage`, {
      authorization: `Bearer ${token}`,
      "x-cog-org-id": org,
      accept: "application/json",
    });
    if (body?.is_quota_plan !== true) return { key, note: "非额度计费或返回无法识别", windows: [], extras: [] };
    const windows = [];
    if (!body.hide_daily_quota) windows.push({ label: "日", usedPercent: Number(body.daily_percentage), resetMs: Date.parse(body.daily_reset_at) });
    windows.push({ label: "周", usedPercent: Number(body.weekly_percentage), resetMs: Date.parse(body.weekly_reset_at) });
    const extras = [];
    const overage = Number(body.overage_balance);
    if (Number.isFinite(overage) && overage !== 0) extras.push(`超额余额 $${overage.toFixed(2)}`);
    return { key, windows, extras };
  } catch (error) {
    return { key, note: `查询失败（${error.message}）`, windows: [], extras: [] };
  }
}

// --- opencode go ---

async function opencodeRow() {
  const key = "opencode-go";
  const authPath = join(process.env.XDG_DATA_HOME || join(HOME, ".local", "share"), "opencode", "auth.json");
  const auth = readJson(authPath);
  const apiKey = process.env.OPENCODE_API_KEY || auth?.["opencode-go"]?.key || auth?.opencode?.key;
  if (!apiKey) return { key, note: `未找到 API key（${authPath} 的 opencode-go，或 OPENCODE_API_KEY）`, windows: [], extras: [] };
  try {
    const body = await getJson("https://opencode.ai/zen/go/v1/usage", {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    });
    const usage = body?.usage;
    if (!usage?.rolling) return { key, note: "查询失败（返回格式无法识别）", windows: [], extras: [] };
    const windows = [
      ["rolling", "5h"],
      ["weekly", "周"],
      ["monthly", "月"],
    ]
      .filter(([field]) => usage[field] && Number.isFinite(usage[field].percent))
      .map(([field, label]) => ({ label, usedPercent: usage[field].percent, resetMs: Date.parse(usage[field].resetsAt) }));
    return { key, windows, extras: [], note: windows.length ? undefined : "无额度窗口" };
  } catch (error) {
    return { key, note: `查询失败（${error.message}）`, windows: [], extras: [] };
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
  return { label, usedPercent: percent, resetMs: limit.nextResetTime };
}

async function glmRow() {
  const key = "glm";
  const cred = resolveGlmCredential();
  if (!cred) return { key, note: "未找到 GLM 密钥（环境变量、~/.claude/settings.json 或 CodexBar 配置）", windows: [], extras: [] };
  try {
    const body = await getJson(`https://${cred.host}/api/monitor/usage/quota/limit`, {
      authorization: `Bearer ${cred.key}`,
      accept: "application/json",
    });
    if (body?.success !== true || body.code !== 200 || !Array.isArray(body.data?.limits)) {
      return { key, note: `查询失败（${body?.msg ?? "返回格式无法识别"}）`, windows: [], extras: [] };
    }
    const known = body.data.limits.filter((l) => ["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(l?.type));
    const order = (l) => (l.type === "TIME_LIMIT" ? 1 : 0);
    const windows = known.sort((a, b) => order(a) - order(b)).map(glmWindow);
    return { key, windows, extras: [], note: windows.length ? undefined : "无额度窗口" };
  } catch (error) {
    return { key, note: `查询失败（${error.message}）`, windows: [], extras: [] };
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
  return { label, usedPercent: expired ? 0 : Math.min(100, Math.max(0, Number(w.usedPercent))), resetMs: reset };
}

function ratioPercent(pool) {
  if (!pool) return Number.NaN;
  const ratio = pool.usedRatio;
  if (Number.isFinite(ratio) && ratio >= -0.001 && ratio <= 1.001) return Math.max(0, ratio * 100);
  if (pool.totalAllowance > 0 && pool.totalAllowance <= 1e12) return (pool.userTokens / pool.totalAllowance) * 100;
  return Number.isFinite(ratio) && ratio <= 100.1 ? ratio : Number.NaN;
}

async function droidRow() {
  const key = "droid";
  const apiKey = resolveFactoryKey();
  if (!apiKey) return { key, note: "未配置 FACTORY_API_KEY（环境变量或 ~/.factory/.env）", windows: [], extras: [] };
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    origin: "https://app.factory.ai",
    referer: "https://app.factory.ai/",
    "x-factory-client": "web-app",
    authorization: `Bearer ${apiKey}`,
  };
  try {
    const billing = await getJson("https://api.factory.ai/api/billing/limits", headers).catch(() => null);
    const pools = billing?.usesTokenRateLimitsBilling ? billing.limits : null;
    if (pools?.standard) {
      const windows = [
        factoryWindow("5h", pools.standard.fiveHour),
        factoryWindow("周", pools.standard.weekly),
        factoryWindow("月", pools.standard.monthly),
      ];
      if (pools.core) {
        windows.push(factoryWindow("Core 5h", pools.core.fiveHour), factoryWindow("Core 周", pools.core.weekly));
      }
      return { key, windows: windows.filter(Boolean), extras: [] };
    }
    const legacy = await getJson("https://api.factory.ai/api/organization/subscription/usage?useCache=true", headers);
    const usage = legacy?.usage;
    if (!usage) return { key, note: "查询失败（返回格式无法识别）", windows: [], extras: [] };
    const end = Number(usage.endDate);
    return {
      key,
      windows: [
        { label: "Standard", usedPercent: ratioPercent(usage.standard), resetMs: end },
        { label: "Premium", usedPercent: ratioPercent(usage.premium), resetMs: end },
      ],
      extras: [],
    };
  } catch (error) {
    return { key, note: `查询失败（${error.message}）`, windows: [], extras: [] };
  }
}

const DISPLAY = { codex: "codex", cursor: "cursor", devin: "devin", glm: "glm (claudeAgent)", "opencode-go": "opencode-go", droid: "droid (factory_droid)" };

export async function collect() {
  const jobs = [codexRow, cursorRow, devinRow, glmRow, opencodeRow, droidRow];
  return Promise.all(
    jobs.map((fn) =>
      fn().catch((error) => ({ key: fn.name.replace(/Row$/, ""), note: `查询失败（${error.message}）`, windows: [], extras: [] })),
    ),
  );
}

function formatRow(row) {
  const name = (DISPLAY[row.key] ?? row.key).padEnd(28);
  const parts = (row.windows ?? []).map((w) => formatWindow(w.label, w.usedPercent, w.resetMs)).concat(row.extras ?? []);
  if (row.note && !parts.length) return `${name} ${row.note}`;
  if (row.note) parts.push(row.note);
  return `${name} ${parts.join(" | ")}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rows = await collect();
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else console.log(rows.map(formatRow).join("\n"));
}
