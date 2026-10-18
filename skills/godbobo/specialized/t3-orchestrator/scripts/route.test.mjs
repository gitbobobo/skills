// route.mjs 行为测试：select 的展开/过滤顺序、check 的硬性规则、named 的点名放行。
// 运行：node --test route.test.mjs
// 固定输入固定输出：caps/额度/共享状态全部用 fixture，不触网不读本机缓存。
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyExpiryDemote, expandRoute, expandCandidates, whitelistCands, allowlistViolations, loadProviders, validateOptions, injectOptions, auditRouteData } from "./route.mjs";
import { MODELS, ROUTES, SWE2_FREE_UNTIL, VERIFIED_OPTION_VALUES, EFFORT_STANDARD, EFFORT_OPTION_IDS, EFFORT_EXCEPTIONS } from "./route-data.mjs";
import { collectCached, quotaCachePath, QUOTA_CACHE_TTL_MS } from "./t3-quota.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(DIR, "route.mjs");
const CAPS_FILE = join(DIR, "fixtures", "caps-trimmed.json");

// caps fixture：实时 orchestrator_capabilities 裁剪到 route-data 用到的 provider/模型，
// canRunChildTask/canRunCrossProviderChildTask 归一化为 true（测试按全部实例可派子任务跑；
// 实时目录里该 flag 也会漂移）。重新生成方法见 references/models.md「选项与档位」。
const CAPS = JSON.parse(readFileSync(CAPS_FILE, "utf8"));

const QUOTA_OK = [
  { key: "codex", windows: [{ label: "周", usedPercent: 10, resetMs: Date.now() + 5 * 864e5 }], extras: [] },
  { key: "cursor", windows: [{ label: "总额", usedPercent: 30, resetMs: Date.now() + 15 * 864e5 }, { label: "API", usedPercent: 20, resetMs: Date.now() + 15 * 864e5 }, { label: "Cursor 模型", usedPercent: 50, resetMs: Date.now() + 15 * 864e5 }], extras: [] },
  { key: "devin", windows: [{ label: "周", usedPercent: 40, resetMs: Date.now() + 4 * 864e5 }], extras: [] },
  { key: "glm", windows: [{ label: "周", usedPercent: 10, resetMs: Date.now() + 4 * 864e5 }], extras: [] },
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

test("check: cursor 只用 grok，三方模型恒红（用户点名也不豁免）", () => {
  ok(["--provider", "cursor", "--model", "grok-4.7"]);
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "kimi-k3", "glm-5p3-flash", "gpt-6.1-sol"]) {
    fail(["--provider", "cursor", "--model", model], "三方模型");
    fail(["--provider", "cursor", "--model", model, "--user-named"], "三方模型");
  }
});

test("check: 清单外组合非点名恒红、用户点名降级 warn", () => {
  // grok 只登记了 cursor 入口、glm-5.3-flash 只登记了 claudeAgent——其他 provider 上的同名/变体都是清单外组合
  fail(["--provider", "acpRegistry_devin", "--model", "grok-4-6-medium"], "入口清单");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "grok-4.7", "--options", '{"autonomy_level":"auto-high"}'], "入口清单");
  fail(["--provider", "acpRegistry_devin", "--model", "glm-5-3-flash-max"], "入口清单");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3-flash", "--options", '{"autonomy_level":"auto-high"}'], "入口清单");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3", "--options", '{"autonomy_level":"auto-high"}'], "入口清单");
  ok(["--provider", "acpRegistry_devin", "--model", "grok-4-6-medium", "--user-named"]);
  ok(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3-flash", "--options", '{"autonomy_level":"auto-high"}', "--user-named"]);
});

test("route-data: 全部入口满足 harness 白名单", () => {
  const bad = [];
  for (const [key, m] of Object.entries(MODELS))
    for (const e of m.entries) for (const r of allowlistViolations(e.provider, e.id)) bad.push(`${key}: ${r}`);
  if (bad.length) throw new Error(bad.join("\n"));
});

test("check: 快速模式恒红", () => {
  fail(["--provider", "cursor", "--model", "grok-4.7", "--options", '{"fastMode":true}'], "fastMode");
  fail(["--provider", "codex", "--model", "gpt-6.1-sol", "--options", '{"serviceTier":"priority"}'], "serviceTier");
  fail(["--provider", "cursor", "--model", "grok-4.7-fast"], "-fast");
});

test("入口：经符号链接调用（~/.config/devin/skills 形态）照常执行", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "route-link-"));
  try {
    const link = join(dir, "scripts");
    symlinkSync(DIR, link);
    const r = spawnSync(process.execPath, [join(link, "route.mjs"), "check", "--provider", "codex", "--model", "gpt-6-astra"], { encoding: "utf8" });
    if (r.status !== 1 || !r.stdout.includes("入口清单")) throw new Error(`符号链接调用应拦下清单外模型（exit=${r.status}）: ${r.stdout}${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check: 顾问不写实现", () => {
  fail(["--provider", "acpRegistry_devin", "--model", "claude-opus-5-5-medium", "--role", "implementation"], "顾问");
  fail(["--provider", "codex", "--model", "gpt-6.1-sol", "--role", "implementation"], "顾问");
  ok(["--provider", "acpRegistry_devin", "--model", "claude-opus-5-5-medium", "--role", "review"]);
});

test("check: 清单外组合红（用户点名降级为 warn）", () => {
  fail(["--provider", "codex", "--model", "gpt-5.6"], "不在 route-data.mjs");
  ok(["--provider", "codex", "--model", "gpt-5.6", "--user-named"]);
});

test("check: droid 选项名", () => {
  fail(["--provider", "acpRegistry_factory_droid", "--model", "claude-opus-5-5"], "auto-high");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "claude-opus-5-5", "--options", '{"autonomy_level":"auto-high","reasoningEffort":"high"}'], "reasoning_effort");
  ok(["--provider", "acpRegistry_factory_droid", "--model", "claude-opus-5-5", "--options", '{"autonomy_level":"auto-high","reasoning_effort":"high"}']);
});

// ============ select ============

test("select: general 行首选 claudeAgent GLM（用户确认）", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "general", ...f.base]);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const m = pick(r);
    if (m?.[1] !== "claudeAgent" || m?.[2] !== "glm-5.3-flash[1m]") throw new Error(`pick 错误: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: --exclude 按行内组合顺序递补", () => {
  const f = fixture();
  try {
    const r = run([
      "select", "--task", "general",
      "--exclude", "claudeAgent/glm-5.3-flash[1m]",
      ...f.base,
    ]);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const m = pick(r);
    if (m?.[1] !== "acpRegistry_devin" || m?.[2] !== "swe-2-high") throw new Error(`应递补行内下一组合: ${r.stdout}`);
    // 组合是固定单元：advisor 排除 sol@codex 后按行序给 opus@devin，同模型备用入口排在原钉位
    const r2 = run([
      "select", "--task", "advisor",
      "--exclude", "codex/gpt-6.1-sol",
      ...f.base,
    ]);
    const m2 = pick(r2);
    if (m2?.[1] !== "acpRegistry_devin" || m2?.[2] !== "claude-opus-5-5-medium")
      throw new Error(`应给行内下一组合 opus@devin: ${r2.stdout}`);
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
    const r = run(["select", "--task", "general", ...f.base]);
    const m = pick(r);
    if (m?.[1] !== "acpRegistry_devin" || m?.[2] !== "swe-2-high") throw new Error(`应跳到 devin swe-2: ${r.stdout}`);
    if (!r.stdout.includes("claudeAgent/glm-5.3-flash[1m]")) throw new Error(`skipped 应列出被跳过的首选: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

// caps 文件没有 TTL 机制：只能靠 mtime 检查告警。过期不拒用，但「不可派/无此模型」
// 判定要逐条标注，否则旧 canRunChildTask=false 会被当作实时事实（真实事故：devin
// 二进制在快照后装好，路由却按 3 小时前的不可派标记跳过了首选入口）。
test("select: caps 文件超 30 分钟 → 告警且不可派判定标注过期", () => {
  const f = fixture();
  try {
    const caps = JSON.parse(JSON.stringify(CAPS));
    caps.providers.find((p) => p.providerInstanceId === "claudeAgent").canRunChildTask = false;
    writeFileSync(f.caps, JSON.stringify(caps));
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(f.caps, old, old);
    const r = run(["select", "--task", "general", ...f.base]);
    const m = pick(r);
    if (m?.[1] !== "acpRegistry_devin") throw new Error(`过期不拒用，仍应跳到 devin swe-2: ${r.stdout}`);
    if (!/--caps-file 是 \d+ 分钟前的快照/.test(r.stdout)) throw new Error(`应有快照过期告警: ${r.stdout}`);
    if (!/claudeAgent\/glm-5\.3-flash\[1m\].*此判定可能已过期/s.test(r.stdout)) throw new Error(`不可派判定应标注过期: ${r.stdout}`);
    // 重写文件刷新 mtime 后不再告警
    writeFileSync(f.caps, JSON.stringify(caps));
    const r2 = run(["select", "--task", "general", ...f.base]);
    if (/--caps-file 是 \d+ 分钟前的快照/.test(r2.stdout)) throw new Error(`新鲜 caps 不应告警: ${r2.stdout}`);
    if (/此判定可能已过期/.test(r2.stdout)) throw new Error(`新鲜 caps 的 skip 原因不应带过期标注: ${r2.stdout}`);
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
    const r = run(["select", "--task", "general", ...f.base]);
    const m = pick(r);
    if (m?.[1] === "claudeAgent") throw new Error(`glm 池 95% 应拦 claudeAgent: ${r.stdout}`);
    if (!/glm-plan/.test(r.stdout)) throw new Error(`skipped 应注明 glm-plan 拦截: ${r.stdout}`);
    // 额度将重置（<24h）则不拦
    quota.find((r) => r.key === "glm").windows = [{ label: "5h", usedPercent: 99, resetMs: Date.now() + 3 * 36e5 }];
    writeFileSync(f.quota, JSON.stringify(quota));
    const r2 = run(["select", "--task", "general", ...f.base]);
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
      // 只留 devin/cursor 可派 + cursor 额度打满 + devin 周窗口打满：advisor 行内组合全被拦，递补 swe-2（白名单）可用
      const caps = JSON.parse(JSON.stringify(CAPS));
      for (const p of caps.providers) if (!["acpRegistry_devin", "cursor"].includes(p.providerInstanceId)) p.canRunChildTask = false;
      writeFileSync(f.caps, JSON.stringify(caps));
      const quota = JSON.parse(JSON.stringify(QUOTA_OK));
      quota.find((r) => r.key === "cursor").windows = [{ label: "Cursor 模型", usedPercent: 95, resetMs: Date.now() + 15 * 864e5 }];
      quota.find((r) => r.key === "devin").windows = [{ label: "周", usedPercent: 100, resetMs: Date.now() + 4 * 864e5 }];
      writeFileSync(f.quota, JSON.stringify(quota));
      const r = run(["select", "--task", "advisor", ...f.base]);
      const m = pick(r);
      if (m?.[1] !== "acpRegistry_devin" || m?.[2] !== "swe-2-high") throw new Error(`应选豁免的 swe-2: ${r.stdout}`);
      // 豁免生效时必须标注（额度超限 + 池冷却都算），否则 PICK 落在「池 100%」上易被误读推翻
      if (!/swe-2-high.*豁免：/s.test(r.stdout)) throw new Error(`swe-2 豁免应在输出标注理由: ${r.stdout}`);
      // 其他 devin 模型照常拦：opus 的 devin 入口必须出现在 skipped 且原因是池冷却
      if (!/acpRegistry_devin\/claude-opus-5-5-medium.*池冷却/s.test(r.stdout)) throw new Error(`opus devin 入口应仍被池冷却拦下: ${r.stdout}`);
    } finally {
      f.cleanup();
    }
  },
);

test("quota 快照缓存：新鲜复用、过期刷新、实查失败回退旧快照", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-cache-"));
  const cachePath = join(dir, "quota.json");
  try {
    const sentinel = [{ key: "x", windows: [], extras: [] }];
    let calls = 0;
    const fake = async () => (calls++, [{ key: "y", windows: [], extras: [] }]);

    // 新鲜缓存：不打实查
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now() - 1000, rows: sentinel }));
    const r1 = await collectCached({ cachePath, collectImpl: fake });
    if (!r1.fromCache || r1.rows[0].key !== "x" || calls !== 0) throw new Error(`新鲜缓存应直接复用: ${JSON.stringify(r1)} calls=${calls}`);

    // 过期缓存：实查并写回
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now() - QUOTA_CACHE_TTL_MS - 1000, rows: sentinel }));
    const r2 = await collectCached({ cachePath, collectImpl: fake });
    if (r2.fromCache || r2.rows[0].key !== "y" || calls !== 1) throw new Error(`过期应实查: ${JSON.stringify(r2)} calls=${calls}`);
    const wrote = JSON.parse(readFileSync(cachePath, "utf8"));
    if (wrote.rows[0].key !== "y") throw new Error("实查后应写回快照");

    // 实查失败 + 旧快照：stale 回退
    const boom = async () => { throw new Error("net down"); };
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now() - QUOTA_CACHE_TTL_MS - 1000, rows: sentinel }));
    const r3 = await collectCached({ cachePath, collectImpl: boom });
    if (!r3.stale || r3.rows[0].key !== "x") throw new Error(`应回退旧快照: ${JSON.stringify(r3)}`);

    // 实查失败 + 无缓存：抛错
    rmSync(cachePath, { force: true });
    let threw = false;
    try { await collectCached({ cachePath, collectImpl: boom }); } catch { threw = true; }
    if (!threw) throw new Error("无快照且实查失败应抛错");

    // refresh=true 跳过新鲜缓存
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), rows: sentinel }));
    const r5 = await collectCached({ cachePath, refresh: true, collectImpl: fake });
    if (r5.fromCache || calls !== 2) throw new Error(`refresh 应跳过缓存: ${JSON.stringify(r5)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("select: 不传 --quota-file 时用 <state-dir>/quota.json 快照，不刷新文件", () => {
  const f = fixture();
  try {
    mkdirSync(f.state, { recursive: true });
    // 哨兵：glm 月窗口打满 → claudeAgent 被拦、swe-2 递补。实查拿不到这个组合，可证走缓存
    const snap = { fetchedAt: Date.now(), rows: [{ key: "glm", windows: [{ label: "月", usedPercent: 95, resetMs: Date.now() + 20 * 864e5 }], extras: [] }] };
    const cacheFile = quotaCachePath(f.state);
    writeFileSync(cacheFile, JSON.stringify(snap));
    const r = run(["select", "--task", "general", "--caps-file", f.caps, "--state-dir", f.state]);
    const m = pick(r);
    if (m?.[1] !== "acpRegistry_devin" || m?.[2] !== "swe-2-high") throw new Error(`应按快照拦下 glm 递补 swe-2: ${r.stdout}`);
    if (!/额度快照：.*缓存/.test(r.stdout)) throw new Error(`应注明快照来源: ${r.stdout}`);
    if (JSON.parse(readFileSync(cacheFile, "utf8")).fetchedAt !== snap.fetchedAt) throw new Error("新鲜快照不应被覆写");
  } finally {
    f.cleanup();
  }
});

test("general 行：GLM flash → SWE-2 → deepseek，免费期前后不变（用户定）", () => {
  const want = ["glm-5.3-flash", "swe-2", "deepseek-v4.1-flash"];
  for (const free of [true, false]) {
    const row = applyExpiryDemote("general", ROUTES.general, free).map((c) => c.model);
    if (JSON.stringify(row.slice(0, 3)) !== JSON.stringify(want)) throw new Error(`free=${free} 行序错: ${row.join(",")}`);
    const ids = expandRoute("general", free).map((s) => `${s.provider}/${s.id}`);
    if (!(ids.indexOf("acpRegistry_devin/swe-2-high") < ids.indexOf("pi/commandcode/deepseek/deepseek-v4.1-flash"))) throw new Error(`free=${free} 展开后 swe-2 应在 deepseek 之前: ${ids.join(",")}`);
  }
});

// 白名单递补：行内没点名的 status:"auto" 模型按 MODELS 声明顺序补在流尾，
// 任何任务都能用；advisor 模型只进 advisor 任务；named 永不进自动流。
test("expandRoute: 全部 auto 模型都在流内，行尾按 MODELS 顺序递补", () => {
  // general 行已钉全部 auto 组合（glm/swe-2/deepseek），递补段为空
  const impl = expandRoute("general");
  const models = impl.map((i) => i.model);
  const autos = Object.keys(MODELS).filter((k) => MODELS[k].status === "auto");
  for (const k of autos) if (!models.includes(k)) throw new Error(`缺 auto 模型 ${k}`);
  // 顾问模型不进 general；named 永不进自动流
  for (const t of ["general"]) {
    const ms = expandRoute(t).map((i) => i.model);
    for (const k of ["opus-5.5", "gpt-6.1-sol", "grok-4.7"])
      if (ms.includes(k)) throw new Error(`${k} 不应出现在 ${t} 流`);
  }
  // advisor 行内全是顾问组合，auto 模型按 MODELS 声明顺序补在行尾
  const tail = expandRoute("advisor").filter((i) => i.via === "whitelist");
  if (tail.map((i) => i.model).join(",") !== "swe-2,glm-5.3-flash,deepseek-v4.1-flash")
    throw new Error(`递补应为 swe-2,glm,deepseek: ${JSON.stringify(tail.map((i) => i.model))}`);
});

test("expandRoute: 行内是「模型@harness」固定组合，顺序即声明顺序", () => {
  // advisor 行：各模型首选 harness 在前，同模型备用 harness 排在各自钉位（不再连着展开）
  const adv = expandRoute("advisor").filter((i) => i.via === "route").map((i) => `${i.provider}/${i.id}`);
  const want = [
    "codex/gpt-6.1-sol",
    "acpRegistry_devin/claude-opus-5-5-medium",
    "cursor/grok-4.7",
    "acpRegistry_devin/gpt-6-1-sol-medium",
    "acpRegistry_factory_droid/claude-opus-5-5",
    "acpRegistry_factory_droid/gpt-6.1-sol",
  ];
  if (JSON.stringify(adv) !== JSON.stringify(want)) throw new Error(`advisor 行组合顺序错: ${adv.join(",")}`);
  // 不带 provider 的候选（白名单递补）仍展开该模型全部入口并按 entries 顺序标 same-model
  const m = MODELS["gpt-6.1-sol"];
  const stream = [];
  expandCandidates([{ model: "gpt-6.1-sol" }], stream, new Set(), "whitelist");
  if (stream.map((i) => i.provider).join(",") !== "codex,acpRegistry_devin,acpRegistry_factory_droid")
    throw new Error(`裸模型候选应展开全部入口: ${JSON.stringify(stream.map((i) => i.provider))}`);
  if (stream[0].via !== "whitelist" || stream[1].via !== "same-model") throw new Error(`via 标记错: ${stream.map((i) => i.via)}`);
  if (m.entries.length !== 3) throw new Error("夹具假设 sol 三个入口");
});

test("expandRoute: advisor 白名单含顾问模型，general 不含", () => {
  const keys = whitelistCands("advisor").map((c) => c.model);
  for (const k of ["opus-5.5", "gpt-6.1-sol", "grok-4.7"]) if (!keys.includes(k)) throw new Error(`advisor 白名单应含顾问模型 ${k}`);
  if (!keys.includes("swe-2")) throw new Error("advisor 白名单应含 auto 模型");
  for (const t of ["general"]) {
    const tk = whitelistCands(t).map((c) => c.model);
    for (const k of ["opus-5.5", "gpt-6.1-sol", "grok-4.7"]) if (tk.includes(k)) throw new Error(`${t} 白名单不应含顾问模型 ${k}`);
  }
  // 非 auto/advisor 状态永不进任何任务的白名单（当前 MODELS 没有 named 条目，此断言防未来误加）
  const nonAuto = Object.keys(MODELS).filter((k) => !["auto", "advisor"].includes(MODELS[k].status));
  for (const t of Object.keys(ROUTES)) {
    const ks = whitelistCands(t).map((c) => c.model);
    for (const k of nonAuto) if (ks.includes(k)) throw new Error(`${t} 白名单不应含 ${MODELS[k].status} 模型 ${k}`);
  }
});

test("select: 路由行全不可用时白名单递补出 PICK 并注明", () => {
  const f = fixture();
  try {
    const caps = JSON.parse(JSON.stringify(CAPS));
    for (const p of caps.providers) if (p.providerInstanceId !== "claudeAgent") p.canRunChildTask = false;
    writeFileSync(f.caps, JSON.stringify(caps));
    // advisor 行内全是顾问组合（codex/devin/droid/cursor 均不可派），递补到 auto 里的 glm
    const r = run(["select", "--task", "advisor", ...f.base]);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const m = pick(r);
    if (m?.[1] !== "claudeAgent" || m?.[2] !== "glm-5.3-flash[1m]") throw new Error(`应递补 glm: ${r.stdout}`);
    if (!r.stdout.includes("白名单递补")) throw new Error(`应注明 PICK 来自递补: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: general --vision 按视觉分数降序（SWE-2 → GLM → DeepSeek）", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "general", "--vision", "--json", ...f.base]);
    const out = JSON.parse(r.stdout);
    const order = [out.pick, ...out.alternatives].map((p) => p.model).join(",");
    const want = "swe-2-high,glm-5.3-flash[1m],commandcode/deepseek/deepseek-v4.1-flash,opendesign/deepseek-v4.1-flash";
    if (order !== want) throw new Error(`vision 顺序不对: ${order}`);
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
    if (!r.stdout.includes('"thought_level":"high"')) throw new Error(`devin 入口应输出 thought_level: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

// devin 的 thought_level 实测只认 VERIFIED_OPTION_VALUES 里的收窄集（目录宣称五档是过度宣称），
// 且 slug 后缀只是默认档。每个 devin 入口必须显式声明实测档，否则静默回落到 slug 默认。
test("route-data: devin 入口都声明合法 thought_level", () => {
  const allowed = VERIFIED_OPTION_VALUES.acpRegistry_devin.thought_level;
  const bad = [];
  for (const [key, m] of Object.entries(MODELS))
    for (const e of m.entries)
      if (e.provider === "acpRegistry_devin" && !allowed.includes(e.options?.thought_level))
        bad.push(`${key}:${e.id}`);
  if (bad.length) throw new Error(`devin 入口缺 thought_level 或档位非法: ${bad.join(", ")}`);
});

// 档位标准：主代理派发一律 EFFORT_STANDARD（high）。每个入口必须恰好声明一个档位选项；
// 偏离只能经 EFFORT_EXCEPTIONS 登记（value 给定档位 + reason 必填，until 表期限）。
test("route-data: 每个入口恰好一个档位选项且为 high（例外须登记 value/reason）", () => {
  const bad = [];
  for (const [id, exc] of Object.entries(EFFORT_EXCEPTIONS)) {
    if (!exc.reason) bad.push(`例外 ${id} 缺 reason`);
  }
  for (const [key, m] of Object.entries(MODELS)) {
    for (const e of m.entries) {
      const id = `${e.provider}/${e.id}`;
      const effortKeys = Object.keys(e.options ?? {}).filter((k) => EFFORT_OPTION_IDS.includes(k));
      const exc = EFFORT_EXCEPTIONS[id];
      if (exc && exc.value === undefined) {
        if (effortKeys.length) bad.push(`${key}:${id} 例外登记为无档位可设却仍声明了 ${effortKeys.join(",")}`);
        continue;
      }
      if (effortKeys.length !== 1) {
        bad.push(`${key}:${id} ${effortKeys.length === 0 ? "未声明档位" : `声明了多个档位选项 ${effortKeys.join(",")}`}`);
        continue;
      }
      const k = effortKeys[0];
      const want = exc?.value ?? EFFORT_STANDARD;
      if (e.options[k] !== want) bad.push(`${key}:${id} 选项 ${k}=${e.options[k]}，应为 ${want}`);
    }
  }
  if (bad.length) throw new Error(`档位标准违规:\n${bad.join("\n")}`);
});

test("injectOptions: 带期限的档位例外到期自动回落 high", () => {
  const { providers } = loadProviders(CAPS_FILE);
  const before = Date.parse(SWE2_FREE_UNTIL) - 1000;
  const after = Date.parse(SWE2_FREE_UNTIL) + 1000;
  const entry = { provider: "acpRegistry_devin", id: "swe-2-high", options: { thought_level: "max" } };
  const free = injectOptions(entry, providers, before);
  if (free.thought_level !== "max") throw new Error(`免费期内应保持 max: ${JSON.stringify(free)}`);
  const expired = injectOptions(entry, providers, after);
  if (expired.thought_level !== "high") throw new Error(`到期后应回落 high: ${JSON.stringify(expired)}`);
  // 无 until 的普通入口不受时间影响
  const grok = injectOptions({ provider: "cursor", id: "grok-4.7", options: { reasoning_effort: "high" } }, providers, after);
  if (grok.reasoning_effort !== "high") throw new Error(`无期限入口不应被改: ${JSON.stringify(grok)}`);
});

// fastMode 一律由 injectOptions 按目录注入，不得写死在路由数据里（曾因此给没有
// fastMode 的模型传了不存在的选项）。
test("route-data: 任何 entry 与 ROUTES 行内 options 都不得出现 fastMode", () => {
  const bad = [];
  for (const [key, m] of Object.entries(MODELS))
    for (const e of m.entries) if ("fastMode" in (e.options ?? {})) bad.push(`MODELS.${key}:${e.provider}/${e.id}`);
  for (const [task, cands] of Object.entries(ROUTES))
    for (const c of cands) if ("fastMode" in (c.options ?? {})) bad.push(`ROUTES.${task}:${c.model}`);
  if (bad.length) throw new Error(`fastMode 应由注入负责: ${bad.join(", ")}`);
});

test("audit: 裁剪夹具上 route-data 全部入口 0 问题", () => {
  const { providers } = loadProviders(CAPS_FILE);
  const problems = auditRouteData(providers);
  if (problems.length) throw new Error(`audit 发现问题:\n${problems.join("\n")}`);
});

test("injectOptions: fastMode 只在目录规格存在时注入", () => {
  const { providers } = loadProviders(CAPS_FILE);
  const grok = injectOptions({ provider: "cursor", id: "grok-4.7", options: { reasoning_effort: "high" } }, providers);
  if (grok.fastMode !== false) throw new Error(`cursor/grok-4.7 有 fastMode，应注入 false: ${JSON.stringify(grok)}`);
  const opus = injectOptions({ provider: "acpRegistry_factory_droid", id: "claude-opus-5-5", options: {} }, providers);
  if ("fastMode" in opus) throw new Error(`droid/claude-opus-5-5 无 fastMode，不应注入: ${JSON.stringify(opus)}`);
  const glm = injectOptions({ provider: "claudeAgent", id: "glm-5.3-flash[1m]", options: {} }, providers);
  if ("fastMode" in glm) throw new Error(`claudeAgent/glm-5.3-flash[1m] 无任何选项，不应注入: ${JSON.stringify(glm)}`);
});

test("validateOptions: devin thought_level 按实测收窄集校验", () => {
  const { providers } = loadProviders(CAPS_FILE);
  // 模拟 2026-10-11 19:24 真实出现过的目录过度宣称：人为把取值集改回五档，
  // 收窄集仍应把 xhigh 判为非法（若只靠目录集，此时 xhigh 会被误放行）
  const spec = providers.get("acpRegistry_devin").optionSpecs.get("swe-2-high").get("thought_level");
  spec.values = new Set(["low", "medium", "high", "xhigh", "max"]);
  const bad = validateOptions("acpRegistry_devin", "swe-2-high", { thought_level: "xhigh" }, providers);
  if (!bad.length) throw new Error("xhigh 应判非法（即使目录宣称有）");
  const good = validateOptions("acpRegistry_devin", "swe-2-high", { thought_level: "high" }, providers);
  if (good.length) throw new Error(`high 应合法: ${good.join("; ")}`);
  // 模型规格未知时不误拦
  const unknown = validateOptions("acpRegistry_devin", "不存在的模型", { thought_level: "xhigh" }, providers);
  if (unknown.length) throw new Error(`规格未知应返回空: ${unknown.join("; ")}`);
});

test("select: --hard 输出顾问+实现两步", () => {
  const f = fixture();
  try {
    const r = run(["select", "--task", "general", "--hard", "--json", ...f.base]);
    const out = JSON.parse(r.stdout);
    if (out.steps?.[0]?.role !== "design" || out.steps?.[1]?.role !== "implementation") throw new Error(`steps 结构错: ${r.stdout}`);
    if (out.steps[0].pick?.model !== "gpt-6.1-sol") throw new Error(`顾问步应选 sol: ${r.stdout}`);
    if (out.steps[1].pick?.model !== "glm-5.3-flash[1m]") throw new Error(`实现步应选 glm: ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("select: 已移除的任务类型退出 2，tasks 只列两个任务", () => {
  const f = fixture();
  try {
    for (const t of ["low", "ui-minor", "research", "review", "security", "implementation", "ui"]) {
      const r = run(["select", "--task", t, ...f.base]);
      if (r.status !== 2) throw new Error(`${t} 应退出 2: ${r.status} ${r.stdout}${r.stderr}`);
    }
    const tasks = run(["tasks"]);
    for (const t of ["general", "advisor"]) if (!new RegExp(`^${t}\\s`, "m").test(tasks.stdout)) throw new Error(`tasks 缺 ${t}: ${tasks.stdout}`);
    for (const t of ["low", "ui-minor", "research", "review", "security", "implementation", "ui"]) if (new RegExp(`^${t}\\s`, "m").test(tasks.stdout)) throw new Error(`tasks 不应再含 ${t}`);
  } finally {
    f.cleanup();
  }
});

test("select: 超过 4 次尝试上限退出 1", () => {
  const f = fixture();
  try {
    const r = run([
      "select", "--task", "general",
      "--exclude", "claudeAgent/glm-5.3-flash[1m]",
      "--exclude", "acpRegistry_devin/swe-2-high",
      "--exclude", "pi/commandcode/deepseek/deepseek-v4.1-flash",
      "--exclude", "codex/gpt-6.1-sol",
      ...f.base,
    ]);
    if (r.status !== 1 || !r.stdout.includes("4 次")) throw new Error(`应拒绝第 5 次: ${r.status} ${r.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("named: 点名模型按入口优先级出列并对非 named 状态告警", () => {
  const f = fixture();
  try {
    // 当前 MODELS 没有 named 条目；用 sol 验证 named 子命令的解析、入口顺序与状态告警
    const r = run(["named", "sol", ...f.base]);
    const m = pick(r);
    if (m?.[1] !== "codex" || m?.[2] !== "gpt-6.1-sol") throw new Error(`sol 首选应 codex: ${r.stdout}`);
    if (!r.stdout.includes("不是点名专用")) throw new Error(`应对 advisor 状态告警: ${r.stdout}`);
    const r2 = run(["named", "sol", "--provider", "acpRegistry_devin", ...f.base]);
    const m2 = pick(r2);
    if (m2?.[2] !== "gpt-6-1-sol-medium") throw new Error(`点名定 harness 应过滤: ${r2.stdout}`);
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
    const r = run(["select", "--task", "general", "--state-dir", join(dir, "state"), "--quota-file", quota], { env: { ...process.env, T3_CACHE_DIR: caches } });
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
    if (table.SWE2_FREE_UNTIL !== "2026-11-01" || table.MAX_ATTEMPTS !== 4) throw new Error("路由数据注入不完整");
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
