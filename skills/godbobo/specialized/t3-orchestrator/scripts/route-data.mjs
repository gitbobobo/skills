// 选择规则的唯一事实源。改选择行为只改这里，route.mjs 与 route.test.mjs 随之生效。
// 数据源与更新标准见 ../references/models.md「更新来源与标准」。
//
// 结构：
//   MODELS[key]  —— 一个逻辑模型：status（auto/advisor/named/banned）、family（审查时区分家族）、
//                  entries（该模型的 harness 入口，数组顺序 = 用户定下的 harness 优先级）
//   entries[]    —— { provider, id, options?, pool? }
//                  provider 是 delegate_task 的 providerInstanceId；id 是该 harness 上的模型 ID；
//                  options 是默认选项（路由行可用 options 覆盖/追加）；
//                  pool 决定走哪组额度窗口与共享状态的池标记，取值见 POOLS
//   ROUTES[task] —— 任务类型 → 候选 { model, provider?, options? }，数组顺序 = 尝试顺序。
//                  provider 省略时取该模型 entries[0]。某候选失败后，同模型其余入口按
//                  entries 优先级递补，然后才是行内下一个候选，最后是 DOWNGRADE 链。
//   DOWNGRADE    —— 本行候选全部不可用时降档到另一行（串行展开、去重）。

// 用户级开关（只有用户能改）：
//   - status: "named"    仅用户点名才用，自动调度与换路一律跳过
//   - status: "banned"   不主动调用；--user-named 时允许但给警告
//   - status: "advisor"  只承担审查/顾问咨询，不派 implementation
//   - PROVIDER_RULES     harness 级白名单（用户偏好 ∩ 工具限制）

// SWE-2 免费期：官方写 10-10 或 10-15 截止，用户确认 10-15（2026-10-11 仍在免费期内）。
// 免费期内：devin 额度窗口与 devin 池的 quota 冷却都不拦 swe-2（其他 devin 模型照常拦）。
// 过期后：swe-2 经 EXPIRY_DEMOTE 在 implementation 行降到 grok-4.6 之后，且不再豁免疫拦截。
export const SWE2_FREE_UNTIL = "2026-10-15";

export const PROVIDER_RULES = {
  claudeAgent: {
    // 该实例的 claude-* 模型名是智谱假名，请求实际发到 GLM；只允许真 GLM 条目。
    allowModels: ["glm-5.3-flash[1m]"],
    note: "claudeAgent 的 claude-* 是智谱假名（硬性规则，用户点名也不豁免）",
  },
  opencode: {
    // Go $10 档按模型计月限：仅 $60 档两模型放行；其余 go/* 月限 $15–30，opencode/* 是 Zen 按量。
    // 用户点名时豁免（在 check 里体现）。
    allowModels: ["opencode-go/glm-5.3-flash", "opencode-go/deepseek-v4.1-flash"],
    namedExempt: true,
    note: "opencode-go 其余模型月限 $15–30，opencode/* 为 Zen 按量",
  },
  acpRegistry_factory_droid: {
    // 一律注入；用户显式指定其他自治级别时按用户说的（check 里 warn）。
    forceOptions: { autonomy_level: "auto-high" },
    note: "droid 选项名是 reasoning_effort（snake_case），不是 reasoningEffort",
  },
  // 有 fastMode 选项的入口由 route.mjs 按目录选项描述符自动注入 fastMode:false；
  // codex serviceTier 保持 default。这两个不单独列 provider。
};

export const BANNED_PROVIDERS = {
  claudeAgent_kimi: "没有订阅",
  claudeAgent_minimax: "能力太差",
};

// 没有 entries、只用于拦截的模型（named/banned 的模型若在 MODELS 里有条目，以 MODELS 为准）。
export const MODEL_BANS = [
  { match: /^glm-5[.-]?3$/i, reason: "GLM 5.3 非 flash 没有视觉能力" },
  { match: /composer/i, reason: "Composer 已过时" },
  { match: /minimax/i, reason: "MiniMax 系列不主动调用" },
];

// 目录取值集会漂移，这里记录「实测收窄集」：校验时生效集 = 目录集 ∩ 本表（本表有的项才收窄）。
// acpRegistry_devin.thought_level：2026-10-11 19:24 实时目录与本机缓存都把全部 122 个模型
// 列成五档 low/medium/high/xhigh/max，19:29 两者都回落到三档 medium/high/max；服务端校验在
// 两个时间点始终只收 medium/high/max。不能只信目录，本表钉住实测集。探测方法（2026-10-11）：delegate_task 同时传一个
// 必然非法的 mode 值，请求被选项校验拦下、不起 agent，报错文本列出该模型真实允许集；
// 覆盖 route-data 全部 13 个 devin 入口 + adaptive/swe-1-7-lightning-medium/swe-1-7-medium/
// glm-5-2/一个 fusion 模型共 18 个，结果一致。low 一律被拒；xhigh 在无活跃会话时偶尔绕过
// 校验返回成功，但不落 modelSelection，等于白传。已落库跑通（statev2.sqlite
// orchestration_v2_projection_runs 的 modelSelection.options）：swe-2-high/max ×1054、
// claude-opus-5-5-medium/high ×20、gpt-6-1-sol-medium/high ×1、deepseek-v4-1-flash-high/medium ×1。
export const VERIFIED_OPTION_VALUES = {
  acpRegistry_devin: { thought_level: ["medium", "high", "max"] },
};

// 档位标准：主代理派发一律 high。偏离必须登记到 EFFORT_EXCEPTIONS，写明 value + reason；
// 有期限的优惠必须同时登记 until，到期由 route.mjs 的 injectOptions 自动回落 high。
// route.test.mjs 会校验每个入口要么声明 high，要么在例外表里。
export const EFFORT_STANDARD = "high";

// 各 harness 的档位选项名（cursor 随模型而异，故按名字集合识别）
export const EFFORT_OPTION_IDS = ["thought_level", "reasoningEffort", "reasoning_effort", "effort", "reasoning", "variant"];

// key 是 `${provider}/${id}`。
//   value  省略 = 该入口无档位选项可设；给值 = 允许偏离 EFFORT_STANDARD 的档位
//   until  可选，ISO 日期；到期后该入口自动回落 EFFORT_STANDARD（由 route.mjs 的 injectOptions 执行）
//   reason 必填
export const EFFORT_EXCEPTIONS = {
  "claudeAgent/glm-5.3-flash[1m]": { reason: "目录里该模型没有任何选项，无档位可设" },
  "acpRegistry_devin/swe-2-high": {
    value: "max",
    until: SWE2_FREE_UNTIL,
    reason: "免费期内不占 devin 额度，FrontierCode 实测 max 50.0% 是其最优档；到期后回落 high",
  },
};

export const MODELS = {
  "opus-5.5": {
    label: "Opus 5.5",
    family: "anthropic",
    status: "advisor",
    vision: true,
    entries: [
      // claude 系 harness 优先级：devin > droid > cursor（cursor 走 API 价月池殿后）
      { provider: "acpRegistry_devin", id: "claude-opus-5-5-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "claude-opus-5-5", options: { reasoning_effort: "high" }, pool: "factory" },
      { provider: "cursor", id: "claude-opus-5-5", options: { effort: "high" }, pool: "cursor-api" },
    ],
  },
  "gpt-6.1-sol": {
    label: "GPT-6.1 Sol",
    family: "openai",
    status: "advisor",
    entries: [
      { provider: "codex", id: "gpt-6.1-sol", options: { reasoningEffort: "high" }, pool: "codex-pro" },
      { provider: "acpRegistry_devin", id: "gpt-6-1-sol-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "gpt-6.1-sol", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
  "swe-2": {
    label: "SWE-2",
    family: "cognition",
    status: "auto",
    entries: [{ provider: "acpRegistry_devin", id: "swe-2-high", options: { thought_level: "max" }, pool: "devin" }],
    // fusion-<主模型>-sidekick-swe-2-medium 是模型组合不是模型，不进自动路由；大量机械工作可人工用。
  },
  "grok-4.7": {
    label: "Grok 4.7",
    family: "xai",
    status: "auto",
    entries: [
      { provider: "cursor", id: "grok-4.7", options: { reasoning_effort: "high", contextWindow: "256k" }, pool: "cursor-grok" },
      { provider: "acpRegistry_devin", id: "grok-4-7-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "grok-4.7", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
  "grok-4.6": {
    label: "Grok 4.6",
    family: "xai",
    status: "auto",
    entries: [
      { provider: "cursor", id: "grok-4.6", options: { effort: "high" }, pool: "cursor-grok" },
      { provider: "acpRegistry_devin", id: "grok-4-6-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "grok-4.6", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
  "sonnet-5.5": {
    label: "Sonnet 5.5",
    family: "anthropic",
    status: "auto",
    entries: [
      { provider: "acpRegistry_devin", id: "claude-sonnet-5-5-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "claude-sonnet-5-5", options: { reasoning_effort: "high" }, pool: "factory" },
      { provider: "cursor", id: "claude-sonnet-5-5", options: { reasoning_effort: "high" }, pool: "cursor-api" },
    ],
  },
  "haiku-5.5": {
    label: "Haiku 5.5",
    family: "anthropic",
    status: "auto",
    entries: [
      { provider: "acpRegistry_devin", id: "claude-haiku-5-5-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "cursor", id: "claude-haiku-5-5", options: { reasoning_effort: "high" }, pool: "cursor-api" },
      // droid 没有 haiku-5-5
    ],
  },
  "glm-5.3-flash": {
    label: "GLM 5.3 Flash",
    family: "zhipu",
    status: "auto",
    vision: true,
    entries: [
      // 入口顺序即用户定下的优先级：Coding Plan 额度最足 > Go $60 池 > Factory 池 > Devin > Cursor
      { provider: "claudeAgent", id: "glm-5.3-flash[1m]", pool: "glm-plan" },
      { provider: "opencode", id: "opencode-go/glm-5.3-flash", options: { variant: "high" }, pool: "opencode-go" },
      { provider: "acpRegistry_factory_droid", id: "glm-5.3-flash", options: { reasoning_effort: "high" }, pool: "factory" },
      { provider: "acpRegistry_devin", id: "glm-5-3-flash-max", options: { thought_level: "high" }, pool: "devin" },
      { provider: "cursor", id: "glm-5p3-flash", options: { reasoning: "high" }, pool: "cursor-api" },
    ],
  },
  "deepseek-v4.1-flash": {
    label: "DeepSeek V4.1 Flash",
    family: "deepseek",
    status: "auto",
    entries: [
      { provider: "opencode", id: "opencode-go/deepseek-v4.1-flash", options: { variant: "high" }, pool: "opencode-go" },
      { provider: "acpRegistry_factory_droid", id: "deepseek-v4.1-flash", options: { reasoning_effort: "high" }, pool: "factory" },
      { provider: "acpRegistry_devin", id: "deepseek-v4-1-flash-high", options: { thought_level: "high" }, pool: "devin" },
    ],
  },
  "gpt-6-luna": {
    label: "GPT-6 Luna",
    family: "openai",
    status: "auto",
    entries: [
      { provider: "codex", id: "gpt-6-luna", options: { reasoningEffort: "high" }, pool: "codex-pro" },
      { provider: "acpRegistry_devin", id: "gpt-6-luna-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "gpt-6-luna", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
  "gpt-6-astra": {
    label: "GPT-6 Astra",
    family: "openai",
    status: "named",
    entries: [
      { provider: "codex", id: "gpt-6-astra", options: { reasoningEffort: "high" }, pool: "codex-pro" },
      { provider: "acpRegistry_devin", id: "gpt-6-astra-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "gpt-6-astra", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
  "fable-5.1": {
    label: "Fable 5.1",
    family: "anthropic",
    status: "named",
    vision: true,
    entries: [
      { provider: "acpRegistry_devin", id: "claude-fable-5-1-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "claude-fable-5.1", options: { reasoning_effort: "high" }, pool: "factory" },
      { provider: "cursor", id: "claude-fable-5-1", options: { effort: "high" }, pool: "cursor-api" },
    ],
  },
  "kimi-k3": {
    label: "Kimi K3",
    family: "moonshot",
    status: "named",
    vision: true,
    entries: [
      { provider: "cursor", id: "kimi-k3", options: { reasoning: "high" }, pool: "cursor-api" },
      { provider: "acpRegistry_devin", id: "kimi-k3-high", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "kimi-k3", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
};

// 任务类型 → 候选行。select 的 --task 取值即这里的 key。
export const TASKS = {
  low: "低难度：小改动、机械修改、批量",
  implementation: "实现、修 bug、架构、疑难 bug",
  ui: "UI、前端视觉",
  "ui-minor": "只需按截图做的小视觉调整",
  advisor: "顾问咨询：方案定型、卡壳、方向分歧",
  review: "代码审查（含最终审查）",
  research: "调研、写文档",
  security: "安全、漏洞（两腿：先审查再交叉复核）",
};

export const ROUTES = {
  low: [
    { model: "glm-5.3-flash", provider: "claudeAgent" },
    { model: "glm-5.3-flash", provider: "opencode" },
    { model: "deepseek-v4.1-flash", provider: "opencode" },
    { model: "gpt-6-luna", provider: "codex" },
    { model: "swe-2", provider: "acpRegistry_devin" },
  ],
  implementation: [
    { model: "glm-5.3-flash", provider: "claudeAgent" }, // 用户确认：implementation 首选 glm-5.3-flash
    { model: "swe-2", provider: "acpRegistry_devin" }, // 免费期内紧随 glm；到期后由 EXPIRY_DEMOTE 降到 grok-4.6 之后
    { model: "grok-4.6", provider: "cursor" },
    { model: "sonnet-5.5", provider: "acpRegistry_devin" },
  ],
  ui: [
    { model: "sonnet-5.5", provider: "acpRegistry_devin" },
    { model: "swe-2", provider: "acpRegistry_devin" },
    { model: "grok-4.7", provider: "cursor" },
  ],
  "ui-minor": [
    { model: "glm-5.3-flash", provider: "claudeAgent" },
    { model: "glm-5.3-flash", provider: "opencode" },
  ],
  // 档位不在这里设：所有入口统一 high（见 EFFORT_STANDARD），各 harness 选项名不同
  // （codex reasoningEffort、cursor effort/reasoning_effort/reasoning、droid
  // reasoning_effort、devin thought_level、opencode variant），逐入口声明。
  advisor: [
    { model: "gpt-6.1-sol", provider: "codex" },
    { model: "opus-5.5", provider: "acpRegistry_devin" },
    // --vision（视觉、长时程规划）时 Opus 入口提前
  ],
  review: [
    { model: "gpt-6.1-sol", provider: "codex" },
    { model: "grok-4.7", provider: "cursor" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_devin" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_factory_droid" },
    { model: "grok-4.7", provider: "acpRegistry_factory_droid" },
    // --implementer 与实现者同家族的候选自动后移
  ],
  // 调研/写文档优先 GLM/DS 便宜档；不用 opus、sol 这类前沿模型；降档到 low 而非 review（避免 sol 经降档混回来）。
  research: [
    { model: "glm-5.3-flash" },
    { model: "deepseek-v4.1-flash" },
    { model: "grok-4.6", provider: "cursor" },
    { model: "grok-4.7", provider: "cursor" },
    { model: "haiku-5.5" },
  ],
  security: [
    // 两腿任务：leg 标记区分，select 输出 steps
    { model: "opus-5.5", provider: "acpRegistry_devin", leg: "review" },
    { model: "gpt-6.1-sol", provider: "codex", leg: "crosscheck" },
  ],
};

// 本行候选全部不可用时降档展开另一行（递归去重）。
export const DOWNGRADE = {
  implementation: "low",
  ui: "implementation",
  "ui-minor": "low",
  advisor: "review",
  review: "advisor",
  research: "low",
  security: "review",
};

// SWE2_FREE_UNTIL 到期后生效的行内重排（models.md「更新标准」第 5 条：到期后重新排序）。
// 把 task 行内 model 候选移到该行 below 模型最后一个候选之后；below 不在行内则保持原位。
export const EXPIRY_DEMOTE = [{ task: "implementation", model: "swe-2", below: "grok-4.6" }];

// 入口 pool → t3-quota.mjs --json 里的窗口。窗口任一满足「用量 ≥90% 且重置 >24h」即拦截。
// pool 为 null 的入口不查额度（理论上不该出现）。
export const POOLS = {
  "codex-pro": { quotaKey: "codex", windows: ["周", "月"] }, // 5h 窗口重置必 <24h，不参与拦截
  "cursor-grok": { quotaKey: "cursor", windows: ["Cursor 模型"] },
  "cursor-api": { quotaKey: "cursor", windows: ["API", "总额"] },
  devin: { quotaKey: "devin", windows: ["日", "周", "月"] },
  "glm-plan": { quotaKey: "glm", windows: ["周", "月", "MCP"] },
  "opencode-go": { quotaKey: "opencode-go", windows: ["周", "月"] },
  factory: { quotaKey: "droid", windows: ["周", "月", "Standard", "Premium"] },
};

export const QUOTA_BLOCK_PERCENT = 90;
export const QUOTA_BLOCK_RESET_MS = 24 * 3600 * 1000;
export const MAX_ATTEMPTS = 4;
