// delegate-check.mjs 行为测试：每条规则都要有命中案例，尤其今天真实犯过的错。
// 运行：node --test delegate-check.test.mjs
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "delegate-check.mjs");
const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

const ok = (args) => {
  const r = run(args);
  if (r.status !== 0) throw new Error(`应放行却拦截: ${args.join(" ")}\n${r.stdout}${r.stderr}`);
};
const fail = (args, needle) => {
  const r = run(args);
  if (r.status !== 1) throw new Error(`应拦截却放行: ${args.join(" ")}\n${r.stdout}`);
  if (needle && !`${r.stdout}${r.stderr}`.includes(needle))
    throw new Error(`报错缺少 "${needle}": ${args.join(" ")}\n${r.stdout}${r.stderr}`);
};

// —— 今日真实违规（必须红）——
test("claudeAgent + claude-opus-5-5 → 红，指向 glm-5.3-flash[1m]", () =>
  fail(["--provider", "claudeAgent", "--model", "claude-opus-5-5"], "glm-5.3-flash[1m]"));
test("claudeAgent + claude-sonnet-5-5 → 红", () =>
  fail(["--provider", "claudeAgent", "--model", "claude-sonnet-5-5"], "假名"));
test("opencode + opencode-go/grok-4.7 → 红", () =>
  fail(["--provider", "opencode", "--model", "opencode-go/grok-4.7"], "$15"));

// —— 白名单放行 ——
test("claudeAgent + glm-5.3-flash[1m] → 绿", () =>
  ok(["--provider", "claudeAgent", "--model", "glm-5.3-flash[1m]"]));
test("opencode + opencode-go/deepseek-v4.1-flash → 绿", () =>
  ok(["--provider", "opencode", "--model", "opencode-go/deepseek-v4.1-flash"]));
test("opencode + opencode-go/glm-5.3-flash → 绿", () =>
  ok(["--provider", "opencode", "--model", "opencode-go/glm-5.3-flash"]));

// —— 其余 opencode 模型都红 ——
for (const m of ["opencode-go/claude-haiku-5-5", "opencode-go/gpt-6-luna", "opencode-go/kimi-k3", "opencode-go/glm-5.2", "opencode/claude-opus-5-5"]) {
  test(`opencode + ${m} → 红`, () => fail(["--provider", "opencode", "--model", m]));
}

// —— 规则 1：快速模式 ——
test("fastMode:true → 红", () =>
  fail(["--provider", "cursor", "--model", "grok-4.7", "--options", '{"fastMode":true}'], "fastMode"));
test("serviceTier:priority → 红", () =>
  fail(["--provider", "codex", "--model", "gpt-6.1-sol", "--options", '{"serviceTier":"priority"}'], "serviceTier"));
test("模型名带 -fast → 红", () =>
  fail(["--provider", "cursor", "--model", "grok-4.7-fast"], "-fast"));
test("options 数组形式 fastMode → 红", () =>
  fail(["--provider", "cursor", "--model", "grok-4.7", "--options", '[{"id":"fastMode","value":true}]'], "fastMode"));

// —— 规则 2/3 ——
test("codex + gpt-6-astra → 红（点名专用）", () =>
  fail(["--provider", "codex", "--model", "gpt-6-astra"], "点名"));
test("cursor + kimi-k3 → 红；--user-named → 绿", () => {
  fail(["--provider", "cursor", "--model", "kimi-k3"]);
  ok(["--provider", "cursor", "--model", "kimi-k3", "--user-named"]);
});
test("claudeAgent_kimi / minimax → 红", () => {
  fail(["--provider", "claudeAgent_kimi", "--model", "kimi-k3"]);
  fail(["--provider", "claudeAgent_minimax", "--model", "minimax-m3"]);
});
test("glm-5.3 非 flash → 红；glm-5.3-flash 不误伤", () => {
  fail(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3", "--options", '{"autonomy_level":"auto-high"}']);
  ok(["--provider", "acpRegistry_factory_droid", "--model", "glm-5.3-flash", "--options", '{"autonomy_level":"auto-high"}']);
});

// —— 规则 4：顾问专用不写实现 ——
test("opus/sol + role=implementation → 红；role=review → 绿", () => {
  fail(["--provider", "cursor", "--model", "claude-opus-5-5", "--role", "implementation"], "顾问");
  fail(["--provider", "codex", "--model", "gpt-6.1-sol", "--role", "implementation"], "顾问");
  ok(["--provider", "cursor", "--model", "claude-opus-5-5", "--role", "review"]);
  ok(["--provider", "codex", "--model", "gpt-6.1-sol", "--role", "design"]);
});

// —— 规则 7：droid 选项 ——
test("factory_droid 缺 autonomy_level → 红；snake_case 错误名 → 红", () => {
  fail(["--provider", "acpRegistry_factory_droid", "--model", "claude-sonnet-5-5"], "auto-high");
  fail(
    ["--provider", "acpRegistry_factory_droid", "--model", "claude-sonnet-5-5",
     "--options", '{"autonomy_level":"auto-high","reasoningEffort":"high"}'],
    "reasoning_effort",
  );
  ok(["--provider", "acpRegistry_factory_droid", "--model", "claude-sonnet-5-5",
       "--options", '{"autonomy_level":"auto-high","reasoning_effort":"high"}']);
});

// —— user-named 不放宽第 1、6、7 条（claudeAgent 白名单、droid 选项恒有效）——
test("--user-named 不豁免 claudeAgent 白名单与 droid 选项", () => {
  fail(["--provider", "claudeAgent", "--model", "claude-opus-5-5", "--user-named"], "假名");
  fail(["--provider", "acpRegistry_factory_droid", "--model", "claude-opus-5-5", "--user-named"], "auto-high");
});
test("--user-named 豁免点名/不主动调用（含 opencode 白名单）", () => {
  ok(["--provider", "opencode", "--model", "opencode-go/grok-4.7", "--user-named"]);
});

// —— 常规放行 ——
test("常规候选 → 绿", () => {
  ok(["--provider", "acpRegistry_devin", "--model", "swe-2-high", "--role", "implementation"]);
  ok(["--provider", "cursor", "--model", "grok-4.7", "--options", '{"fastMode":false}']);
});
