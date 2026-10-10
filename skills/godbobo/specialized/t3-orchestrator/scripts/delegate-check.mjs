#!/usr/bin/env node
// delegate_task 派发前校验：把 SKILL.md「硬性规则」编成断言。
// 用法：
//   node delegate-check.mjs --provider <providerInstanceId> --model <model>
//       [--role <implementation|review|design|research|test>]
//       [--options '<json，对象或 [{id,value}] 数组>']
//       [--user-named]        用户点名该模型/实例时放宽第 2、3、4、5 条
// 退出码：0 允许；1 违反硬性规则；2 参数错误。
// 规则数据源：../SKILL.md「硬性规则」节、references/models.md 额度池表。
// 改规则先改那两处，再同步本文件常量。

const CLAUDE_AGENT_ALLOWED = "glm-5.3-flash[1m]";
const OPENCODE_ALLOWED = ["opencode-go/glm-5.3-flash", "opencode-go/deepseek-v4.1-flash"];
const NAMED_ONLY = [/-astra/i, /fable/i, /kimi-k3/i];
const BANNED_MODELS = [/composer/i, /minimax-m/i, /^glm-5[.-]?3$/i];
const BANNED_PROVIDERS = ["claudeAgent_kimi", "claudeAgent_minimax"];
const ADVISOR_ONLY = [/opus/i, /gpt-6[.-]1-sol/i];

function parseOptions(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return { __parseError: true };
  }
  if (Array.isArray(v)) {
    const out = {};
    for (const item of v) {
      if (item && typeof item === "object" && "id" in item) out[item.id] = item.value;
    }
    return out;
  }
  if (v && typeof v === "object") return v;
  return { __parseError: true };
}

function main() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const provider = get("provider");
  const model = get("model");
  const role = get("role");
  const options = parseOptions(get("options"));
  const userNamed = args.includes("--user-named");

  if (!provider || !model) {
    console.error("用法: delegate-check.mjs --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named]");
    process.exit(2);
  }
  if (options.__parseError) {
    console.error("--options 不是合法 JSON");
    process.exit(2);
  }

  const fails = [];
  const warns = [];

  // 规则 1：不用快速模式
  if (options.fastMode === true || options.fastMode === "true") {
    fails.push("fastMode 必须为 false（硬性规则 1）");
  }
  if (options.serviceTier === "priority") {
    fails.push("codex serviceTier 保持 default，不用 priority（硬性规则 1）");
  }
  if (/-fast\b/i.test(model)) {
    fails.push(`模型名带 -fast（${model}），硬性规则 1 禁止`);
  }

  // 规则 6：claudeAgent 白名单（用户点名也生效——claude-* 实际发往智谱）
  if (provider === "claudeAgent" && model !== CLAUDE_AGENT_ALLOWED) {
    fails.push(
      `claudeAgent 只允许 ${CLAUDE_AGENT_ALLOWED}；它的 claude-* 模型名是智谱假名，结论不可当真模型采纳（硬性规则 6）。` +
        `同模型的真入口见 models.md「同模型的备用入口」`,
    );
  }

  // 规则 7：droid 选项名与 autonomy_level（用户点名也生效）
  if (provider === "acpRegistry_factory_droid") {
    if (options.autonomy_level === undefined) {
      fails.push('factory_droid 任务 options 必须带 {"autonomy_level":"auto-high"}（硬性规则 7）');
    } else if (options.autonomy_level !== "auto-high") {
      warns.push(`autonomy_level=${options.autonomy_level}，默认应为 auto-high——确认是用户指定`);
    }
    if (options.reasoningEffort !== undefined) {
      fails.push("factory_droid 的推理档选项名是 reasoning_effort（snake_case），不是 reasoningEffort（硬性规则 7）");
    }
  }

  if (!userNamed) {
    // 规则 2：点名专用
    if (NAMED_ONLY.some((re) => re.test(model))) {
      fails.push(`${model} 仅限用户点名才可用，自动调度与换路跳过（硬性规则 2）`);
    }
    // 规则 3：不主动调用
    if (BANNED_PROVIDERS.includes(provider)) {
      fails.push(`${provider} 不主动调用（硬性规则 3）`);
    }
    if (BANNED_MODELS.some((re) => re.test(model))) {
      fails.push(`${model} 在不主动调用清单内（硬性规则 3）`);
    }
    // opencode 白名单（Go $10 档按模型计月限，仅放行 $60 档两模型）
    if (provider === "opencode" && !OPENCODE_ALLOWED.includes(model)) {
      fails.push(
        `opencode 只允许 ${OPENCODE_ALLOWED.join(" / ")}；` +
          `Go $10 档其余 opencode-go/* 月限仅 $15–30，opencode/* 前缀是 Zen 按量（硬性规则 3）`,
      );
    }
    // 规则 4：Opus 5.5 / GPT-6.1 Sol 不写实现
    if (role === "implementation" && ADVISOR_ONLY.some((re) => re.test(model))) {
      fails.push(`${model} 是顾问/审查专用，不承担 implementation 任务（硬性规则 4）`);
    }
  }

  for (const w of warns) console.log(`WARN ${w}`);
  if (fails.length) {
    console.log(`FAIL ${provider}/${model}${role ? ` role=${role}` : ""}`);
    for (const f of fails) console.log(`- ${f}`);
    process.exit(1);
  }
  console.log(`OK ${provider}/${model}${role ? ` role=${role}` : ""}${userNamed ? " (user-named)" : ""}`);
}

main();
