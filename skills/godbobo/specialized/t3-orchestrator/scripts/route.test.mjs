// route.mjs 行为测试：select 的展开/过滤顺序、check 的硬性规则、named 的点名放行。
// 运行：node --test route.test.mjs
// 固定输入固定输出：caps/额度/共享状态全部用 fixture，不触网不读本机缓存。
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyExpiryDemote, expandRoute } from "./route.mjs";
import { ROUTES, SWE2_FREE_UNTIL } from "./route-data.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(DIR, "route.mjs");

// 全部实例可派子任务、模型齐全的最小 caps fixture
const CAPS = {
  providers: [
    "codex",
    "claudeAgent",
    "cursor",
    "opencode",
    "acpRegistry_devin",
    "acpRegistry_factory_droid",
  ].map((id) => ({
    providerInstanceId: id,
    canRunChildTask: true,
    canRunCrossProviderChildTask: true,
    models: [
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-6-astra",
      "glm-5.3-flash[1m]",
      "opencode-go/glm-5.3-flash",
      "opencode-go/deepseek-v4.1-flash",
      "grok-4.7",
      "grok-4.6",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5-medium",
      "claude-opus-5-5-medium",
      "claude-haiku-5-5",
      "claude-haiku-5-5-medium",
      "claude-fable-5-1",
      "claude-fable-5-1-medium",
      "claude-fable-5.1",
      "swe-2-high",
      "grok-4-7-medium",
      "grok-4-6-medium",
      "gpt-6-1-sol-medium",
      "gpt-6-astra-medium",
      "gpt-6-luna-medium",
      "glm-5-3-flash-max",
      "glm-5.3-flash",
      "glm-5p3-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4-1-flash-high",
      "kimi-k3",
      "kimi-k3-high",
    ].map((mid) => ({ id: mid, options: mid.startsWith("grok") || mid.startsWith("claude") || mid.startsWith("glm-5p3") || mid.startsWith("kimi") ? [{ id: "fastMode" }] : [] })),
  })),
};

const QUOTA_OK = [
  { key: "codex", windows: [{ label: "周", usedPercent: 10, resetMs: Date.now() + 5 * 864e5 }], extras: [] },
  { key: "cursor", windows: [{ label: "总额", usedPercent: 30, resetMs: Date.now() + 15 * 864e5 }, { label: "API", usedPercent: 20, resetMs: Date.now() + 15 * 864e5 }, { label: "Grok 周", usedPercent: 50, resetMs: Date.now() + 3 * 864e5 }], extras: [] },
  { key: "devin", windows: [{ label: "周", usedPercent: 40, resetMs: Date.now() + 4 * 864e5 }], extras: [] },
  { key: "glm", windows: [{ label: "周", usedPercent: 10, resetMs: Date.now() + 4 * 864e5 }], extras: [] },
  { key: "opencode-go", windows: [{ label: "月", usedPercent: 30, resetMs: Date.now() + 20 * 864e5 }], extras: [] },
  { key: "droid", windows: [{ label: "月", usedPercent: 25, resetMs: Date.now() + 20 * 864e5 }], extras: [] },
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "route-test-"));
  const caps = join(dir, "caps.json");
  writeFileSync(caps, JSON.stringify(CAPS));
  const quota = join(dir, "quota.json");
  writeFileSync(quota, JSON.stringify(QUOTA_OK));
  const state = join(dir, "state");
  const base = ["--caps-file", caps, "--state-dir", state, "--quota-file", quota];
  return { dir, caps, quota, state, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...opts });
const pick = (r) => `${r.stdout}`.match(/^PICK (\S+) \/ (\S+)/m);

// ============ check 子命令（原 delegate-check 断言全量迁移） ============

const ok = (args) => {
  const r = run(["check", ...args]);
  if (r.status !== 0) throw new Error(`应放行却拦截: ${args.join(" ")}\n${r.stdout}${r.stderr}`);
};
const fail = (args, needle) => {
  const r = run(["check", ...args]);
  if (r.status !== 1) throw new Error(`应拦截却放行: ${args.join(" ")}\n${r.stdout}`);
  if (needle && !`${r.stdout}${r.stderr}`.includes(needle))
    throw new Error(`报错缺少 "${needle}": ${args.join(" ")}\n${r.stdout}${r.stderr}`);
};

test("check: claudeAgent 假名恒红", () => {
  fail(["--provider", "claudeAgent", "--model", "claude-opus-5-5"], "glm-5.3-flash[1m]");
  fail(["--provider", "claudeAgent", "--model", "claude-opus-5-5", "--user-named"], "假名");
  ok(["--provider", "claudeAgent", "--model", "glm-5.3-flash[1m]"]);
});

test("check: opencode 白名单", () => {
  ok(["--provider", "opencode", "--model", "opencode-go/glm-5.3-flash"]);
  ok(["--provider", "opencode", "--model", "opencode-go/deepseek-v4.1-flash"]);
  fail(["--provider", "opencode", "--model", "opencode-go/grok-4.7"], "$15");
  fail(["--provider", "opencode", "--model", "opencode/claude-opus-5-5"]);
  ok(["--provider", "opencode", "--model", "opencode-go/grok-4.7", "--user-named"]);
});

test("check: 快速模式恒红", () => {
  fail(["--provider", "cursor", "--model", "grok-4.7", "--options", '{"fastMode":true}'], "fastMode");
  fail(["--provider", "codex", "--model", "gpt-6.1-sol", "--options", '{"serviceTier":"priority"}'], "serviceTier");
  fail(["--provider", "cursor", "--model", "grok-4.7-fast"], "-fast");
});

test("check: 点名/不主动调用/顾问不写实现", () => {
  fail(["--provider", "codex", "--model", "gpt-6-astra"], "点名");
  fail(["--provider", "cursor", "--model", "kimi-k3"]);
  ok(["--provider", "cursor", "--model", "kimi-k3", "--user-named"]);
  fail(["--provider", "claudeAgent_kimi", "--model", "kimi-k3"]);
  fail(["--provider", "claudeAgent_minimax", "--model", "minimax-m3"]);
  fail(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3", "--options", '{"autonomy_level":"auto-high"}']);
  fail(["--provider", "cursor", "--model", "claude-opus-5-5", "--role", "implementation"], "顾问");
  fail(["--provider", "codex", "--model", "gpt-6.1-sol", "--role", "implementation"], "顾问");
  ok(["--provider", "cursor", "--model", "claude-opus-5-5", "--role", "review"]);
});

test("check: 清单外组合红（用户点名降级为 warn）", () => {
  fail(["--provider", "cursor", "--model", "gpt-6.1-sol"], "不在 route-data.mjs");
  ok(["--provider", "cursor", "--model", "gpt-6.1-sol", "--user-named"]);
});

test("check: droid 选项名", () => {
  fail(["--provider", "acpRegistry_factory_droid", "--model", "claude-sonnet-5-5"], "auto-high");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "claude-sonnet-5-5", "--options", '{"autonomy_level":"auto-high","reasoningEffort":"high"}'], "reasoning_effort");
  ok(["--provider", "acpRegistry_factory_droid", "--model", "claude-sonnet-5-5", "--options", '{"autonomy_level":"auto-high","reasoning_effort":"high"}']);
});

// ============ select ============

test("select: low 行首选 claudeAgent GLM", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "low", ...f.base]);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const m = pick(r);
    if (m?.[1] !== "claudeAgent" || m?.[2] !== "glm-5.3-flash[1m]") throw new Error(`pick 错误: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: implementation 行首选 claudeAgent GLM（用户确认）", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "implementation", ...f.base]);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const m = pick(r);
    if (m?.[1] !== "claudeAgent" || m?.[2] !== "glm-5.3-flash[1m]") throw new Error(`pick 错误: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: --exclude 按展开顺序递补（同模型入口先于下一行候选）", () => {
  const f = fixture();
  try {
    const r = run([
      "select", "--task", "low",
      "--exclude", "claudeAgent/glm-5.3-flash[1m]",
      ...f.base,
    ]);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const m = pick(r);
    if (m?.[1] !== "opencode" || m?.[2] !== "opencode-go/glm-5.3-flash") throw new Error(`同模型递补顺序错误: ${r.stdout}`);
    const r2 = run([
      "select", "--task", "low",
      "--exclude", "claudeAgent/glm-5.3-flash[1m]",
      "--exclude", "opencode/opencode-go/glm-5.3-flash",
      ...f.base,
    ]);
    const m2 = pick(r2);
    // 同模型第三入口 droid 应先于行内下一候选 deepseek
    if (m2?.[1] !== "acpRegistry_factory_droid" || m2?.[2] !== "glm-5.3-flash")
      throw new Error(`same-model 应优先于下一行候选: ${r2.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: 实例不可派子任务时整实例跳过", () => {
  const f = fixture();
  try {
    const caps = JSON.parse(JSON.stringify(CAPS));
    caps.providers.find((p) => p.providerInstanceId === "claudeAgent").canRunChildTask = false;
    writeFileSync(f.caps, JSON.stringify(caps));
    const r = run(["select", "--task", "low", ...f.base]);
    const m = pick(r);
    if (m?.[1] !== "opencode") throw new Error(`应跳到 opencode: ${r.stdout}`);
    if (!r.stdout.includes("claudeAgent/glm-5.3-flash[1m]")) throw new Error(`skipped 应列出被跳过的首选: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: 额度窗口 ≥90% 且 >24h 重置 → 该池入口全拦", () => {
  const f = fixture();
  try {
    const quota = JSON.parse(JSON.stringify(QUOTA_OK));
    quota.find((r) => r.key === "glm").windows = [{ label: "月", usedPercent: 95, resetMs: Date.now() + 20 * 864e5 }];
    writeFileSync(f.quota, JSON.stringify(quota));
    const r = run(["select", "--task", "low", ...f.base]);
    const m = pick(r);
    if (m?.[1] === "claudeAgent") throw new Error(`glm 池 95% 应拦 claudeAgent: ${r.stdout}`);
    if (!/glm-plan/.test(r.stdout)) throw new Error(`skipped 应注明 glm-plan 拦截: ${r.stdout}`);
    // 额度将重置（<24h）则不拦
    quota.find((r) => r.key === "glm").windows = [{ label: "5h", usedPercent: 99, resetMs: Date.now() + 3 * 36e5 }];
    writeFileSync(f.quota, JSON.stringify(quota));
    const r2 = run(["select", "--task", "low", ...f.base]);
    const m2 = pick(r2);
    if (m2?.[1] !== "claudeAgent") throw new Error(`短窗口快重置不应拦: ${r2.stdout}`);
  } finally {
    f.cleanup();
  }
});

test(
  "select: devin 池 quota 冷却不拦免费期 swe-2",
  { skip: Date.now() >= Date.parse(SWE2_FREE_UNTIL) && "SWE-2 免费期已过" },
  () => {
    const f = fixture();
    try {
      mkdirSync(f.state, { recursive: true });
      writeFileSync(
        join(f.state, "state.json"),
        JSON.stringify({
          version: 1,
          records: { "pool:devin": { kind: "quota", failures: 1, retryAt: Date.now() + 36e5, generation: "test-gen" } },
        }),
      );
      // droid 不可派 + cursor 两池额度打满：ui 行只剩 swe-2 可用
      const caps = JSON.parse(JSON.stringify(CAPS));
      caps.providers.find((p) => p.providerInstanceId === "acpRegistry_factory_droid").canRunChildTask = false;
      writeFileSync(f.caps, JSON.stringify(caps));
      const quota = JSON.parse(JSON.stringify(QUOTA_OK));
      quota.find((r) => r.key === "cursor").windows = [
        { label: "API", usedPercent: 95, resetMs: Date.now() + 15 * 864e5 },
        { label: "Grok 周", usedPercent: 95, resetMs: Date.now() + 3 * 864e5 },
      ];
      writeFileSync(f.quota, JSON.stringify(quota));
      const r = run(["select", "--task", "ui", ...f.base]);
      const m = pick(r);
      if (m?.[1] !== "acpRegistry_devin" || m?.[2] !== "swe-2-high") throw new Error(`应选豁免的 swe-2: ${r.stdout}`);
      // 其他 devin 模型照常拦：sonnet 的 devin 入口必须出现在 skipped 且原因是池冷却
      if (!/acpRegistry_devin\/claude-sonnet-5-5-medium.*池冷却/s.test(r.stdout)) throw new Error(`sonnet devin 入口应仍被池冷却拦下: ${r.stdout}`);
    } finally {
      f.cleanup();
    }
  },
);

test("EXPIRY_DEMOTE: 免费期后 implementation 行 swe-2 降到 grok-4.6 之后", () => {
  const expired = applyExpiryDemote("implementation", ROUTES.implementation, false).map((c) => c.model);
  const want = ["glm-5.3-flash", "grok-4.6", "swe-2", "sonnet-5.5"];
  if (JSON.stringify(expired) !== JSON.stringify(want)) throw new Error(`过期后行序错: ${expired.join(",")}`);
  const free = applyExpiryDemote("implementation", ROUTES.implementation, true).map((c) => c.model);
  if (free[1] !== "swe-2") throw new Error(`免费期内 swe-2 应紧随 glm: ${free.join(",")}`);
  // 展开流层面：过期后 grok-4.6 全部入口排在 swe-2 之前
  const ids = expandRoute("implementation", false).map((s) => `${s.provider}/${s.id}`);
  const swe = ids.indexOf("acpRegistry_devin/swe-2-high");
  const lastGrok = ids.lastIndexOf("acpRegistry_factory_droid/grok-4.6");
  if (!(swe > -1 && lastGrok > -1 && swe > lastGrok)) throw new Error(`展开后 swe-2 应排在 grok-4.6 全部入口之后: ${ids.join(",")}`);
});

test("select: review + implementer 同家族后移", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "review", "--implementer", "gpt-6.1-sol", ...f.base]);
    const m = pick(r);
    if (m?.[2] !== "grok-4.7") throw new Error(`openai 实现应选 grok 审查: ${r.stdout}`);
    const r2 = run(["select", "--task", "review", "--implementer", "swe-2-high", ...f.base]);
    const m2 = pick(r2);
    if (m2?.[2] !== "gpt-6.1-sol") throw new Error(`非 openai 实现按默认顺序应选 sol: ${r2.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: --vision 顾问提前视觉模型", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "advisor", "--vision", ...f.base]);
    const m = pick(r);
    if (m?.[1] !== "acpRegistry_devin" || m?.[2] !== "claude-opus-5-5-medium") throw new Error(`vision 顾问应选 devin opus: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: --hard 输出顾问+实现两步", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "implementation", "--hard", "--json", ...f.base]);
    const out = JSON.parse(r.stdout);
    if (out.steps?.[0]?.role !== "design" || out.steps?.[1]?.role !== "implementation") throw new Error(`steps 结构错: ${r.stdout}`);
    if (out.steps[0].pick?.model !== "gpt-6.1-sol") throw new Error(`顾问步应选 sol: ${r.stdout}`);
    if (out.steps[1].pick?.model !== "glm-5.3-flash[1m]") throw new Error(`实现步应选 glm: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: security 两腿各自出 pick", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "security", "--json", ...f.base]);
    const out = JSON.parse(r.stdout);
    if (out.steps?.length !== 2) throw new Error(`security 应两腿: ${r.stdout}`);
    if (out.steps[0].pick?.model !== "claude-opus-5-5-medium" || out.steps[0].pick?.providerInstanceId !== "acpRegistry_devin") throw new Error(`审查腿应 devin opus: ${r.stdout}`);
    if (out.steps[1].pick?.model !== "gpt-6.1-sol") throw new Error(`复核腿应 sol: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: 超过 4 次尝试上限退出 1", () => {
  const f = fixture();
  try {
    const r = run([
      "select", "--task", "low",
      "--exclude", "claudeAgent/glm-5.3-flash[1m]",
      "--exclude", "opencode/opencode-go/glm-5.3-flash",
      "--exclude", "acpRegistry_factory_droid/glm-5.3-flash",
      "--exclude", "acpRegistry_devin/glm-5-3-flash-max",
      ...f.base,
    ]);
    if (r.status !== 1 || !r.stdout.includes("4 次")) throw new Error(`应拒绝第 5 次: ${r.status} ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("named: 点名模型按入口优先级出列", () => {
  const f = fixture();
  try {
    const r = run(["named", "astra", ...f.base]);
    const m = pick(r);
    if (m?.[1] !== "codex" || m?.[2] !== "gpt-6-astra") throw new Error(`astra 首选应 codex: ${r.stdout}`);
    const r2 = run(["named", "astra", "--provider", "acpRegistry_devin", ...f.base]);
    const m2 = pick(r2);
    if (m2?.[2] !== "gpt-6-astra-medium") throw new Error(`点名定 harness 应过滤: ${r2.stdout}`);
    const bad = run(["named", "不存在的模型", ...f.base]);
    if (bad.status !== 2) throw new Error(`未知模型应退出 2: ${bad.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: 无 caps-file 时读 T3_CACHE_DIR 缓存并告警", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-cache-"));
  try {
    const quota = join(dir, "quota.json");
    writeFileSync(quota, JSON.stringify(QUOTA_OK));
    const caches = join(dir, "caches");
    mkdirSync(caches);
    writeFileSync(join(caches, "acpRegistry_devin.json"), JSON.stringify({ enabled: true, status: "ready", auth: { status: "authenticated" }, models: [{ slug: "swe-2-high" }] }));
    const r = run(["select", "--task", "implementation", "--state-dir", join(dir, "state"), "--quota-file", quota], { env: { ...process.env, T3_CACHE_DIR: caches } });
    if (!r.stdout.includes("无法验证 canRunChildTask")) throw new Error(`应告警缓存降级: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============ route-playground.mjs：沙盒生成器 ============

test("playground: 生成的 HTML 自包含且 JSON 块可解析", () => {
  const f = fixture();
  const out = join(f.dir, "pg.html");
  try {
    const r = spawnSync(process.execPath, [join(DIR, "route-playground.mjs"), "--caps-file", f.caps, "--quota-file", f.quota, "-o", out], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`生成失败: ${r.stderr}`);
    const h = readFileSync(out, "utf8");
    if (h.includes("__ROUTE_DATA__") || h.includes("__CAPS__") || h.includes("__QUOTA__")) throw new Error("占位符未注入");
    const blobs = [...h.matchAll(/<script id="(route-data|caps-data|quota-data)" type="application\/json">([\s\S]*?)<\/script>/g)];
    if (blobs.length !== 3) throw new Error(`应有 3 个 JSON 块: ${blobs.length}`);
    for (const [, , json] of blobs) JSON.parse(json);
    const table = JSON.parse(blobs[0][2]);
    if (table.SWE2_FREE_UNTIL !== "2026-10-15" || table.MAX_ATTEMPTS !== 4) throw new Error("路由数据注入不完整");
    const caps = JSON.parse(blobs[1][2]);
    if (!caps.providers.every((p) => p.canRunChildTask === true)) throw new Error("caps 未按 fixture 初始化");
    if (!h.includes("SELFTEST")) throw new Error("沙盒自测块缺失");
  } finally {
    f.cleanup();
  }
});

test("playground: --no-quota 与默认合成 caps 也能出页", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-test-"));
  const out = join(dir, "pg.html");
  try {
    const r = spawnSync(process.execPath, [join(DIR, "route-playground.mjs"), "--no-quota", "-o", out], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`生成失败: ${r.stderr}`);
    if (!r.stderr.includes("--caps-file")) throw new Error(`应提示合成 caps: ${r.stderr}`);
    const h = readFileSync(out, "utf8");
    const quota = JSON.parse(h.match(/<script id="quota-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    if (quota.length !== 0) throw new Error("--no-quota 应置空额度数据");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
