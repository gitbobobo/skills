// 选择规则的唯一事实源。改选择行为只改这里，route.mjs 与 route.test.mjs 随之生效。
// 数据源与更新标准见 ../references/models.md「更新来源与标准」。
//
// 结构：
//   MODELS[key]  —— 一个逻辑模型：status（auto/advisor/named）、vision（视觉分数，见下）、
//                  tasks?（限定可进入的任务类型，缺省不限；行内、白名单递补与 check --role 都按它拦）、
//                  entries（该模型的 harness 入口，数组顺序 = 用户定下的 harness 优先级）
//   vision       —— Roboflow Vision Evals 总分（playground.roboflow.com/evals，2026-10-13 版）；
//                  --vision 按它降序重排候选流，同分保持原顺序；缺省 = 0（不看图）。
//                  榜上没有的模型写估值并注明依据。
//   entries[]    —— { provider, id, options?, pool? }
//                  provider 是 delegate_task 的 providerInstanceId；id 是该 harness 上的模型 ID；
//                  options 是默认选项（路由行可用 options 覆盖/追加）；
//                  pool 决定走哪组额度窗口与共享状态的池标记，取值见 POOLS
//   ROUTES[task] —— 任务类型 → 候选组合 { model, provider, options? }，数组顺序 = 尝试
//                  顺序。「模型+harness」是固定的组合单元：provider 必须命中
//                  MODELS[model].entries 里的条目，组合的 id/options/pool 取自该条目。
//   白名单递补   —— 行内没点名的可调度模型照样可用：status:"auto" 的模型按 MODELS
//                  声明顺序、各自按 entries 顺序补在流末尾；ADVISOR_TASKS 里的任务
//                  额外放开 status:"advisor"。named 永不进自动调度流。
//
// 白名单即全部：select/named/check 只从 MODELS.entries 出目标，不维护反例清单；
// 清单外组合统一按「不在入口清单」处理（非点名 FAIL、用户点名 WARN）。

// 用户级开关（只有用户能改）：
//   - status: "named"    仅用户点名才用，自动调度与换路一律跳过
//   - status: "advisor"  只承担审查/顾问咨询，不派 implementation
//   - tasks              模型只进这些任务类型（如 Opus 只做实现顾问）
//   - PROVIDER_RULES     harness 级白名单（用户偏好 ∩ 工具限制）；硬性规则，用户点名也不豁免

// SWE-2 免费期：官方写 10-10 或 10-15 截止，后延长到本月底；2026-10-16 用户确认延至 10-31。
// UNTIL 是排他边界（now < UNTIL 为免费期），取 2026-11-01 使 10-31 全天仍在免费期内。
// 免费期内：devin 额度窗口与 devin 池的 quota 冷却都不拦 swe-2（其他 devin 模型照常拦）。
// 过期后：不再豁免额度拦截，档位回落 high；general 行位置不变（见 EXPIRY_DEMOTE）。
export const SWE2_FREE_UNTIL = "2026-11-01";

export const PROVIDER_RULES = {
  claudeAgent: {
    // 该实例的 claude-* 模型名是智谱假名，请求实际发到 GLM；只允许真 GLM 条目。
    allowModels: ["glm-5.3-flash[1m]"],
    note: "claudeAgent 的 claude-* 是智谱假名",
  },
  cursor: {
    // Cursor 上的三方模型（Opus、GPT、Gemini、Kimi、GLM 等，走 API 价）下月下线，任何情况都不调用。
    allowModels: ["grok-4.7"],
    note: "cursor 只用 grok 系列，三方模型不再调用",
  },
  acpRegistry_factory_droid: {
    // 一律注入；用户显式指定其他自治级别时按用户说的（check 里 warn）。
    forceOptions: { autonomy_level: "auto-high" },
    note: "droid 选项名是 reasoning_effort（snake_case），不是 reasoningEffort",
  },
  // 有 fastMode 选项的入口由 route.mjs 按目录选项描述符自动注入 fastMode:false；
  // codex serviceTier 保持 default。这两个不单独列 provider。
};

// 目录取值集会漂移，这里记录「实测收窄集」：校验时生效集 = 目录集 ∩ 本表（本表有的项才收窄）。
// acpRegistry_devin.thought_level：目录曾短暂把全部模型列成五档 low/medium/high/xhigh/max，
// 服务端校验始终只收 medium/high/max。不能只信目录，本表钉住实测集。探测方法：delegate_task
// 同时传一个必然非法的 mode 值，请求被选项校验拦下、不起 agent，报错文本列出该模型真实允许集。
// low 一律被拒；xhigh 偶尔绕过校验返回成功，但不落 modelSelection，等于白传。
export const VERIFIED_OPTION_VALUES = {
  acpRegistry_devin: { thought_level: ["medium", "high", "max"] },
};

// 档位标准：主代理派发一律 high。偏离必须登记到 EFFORT_EXCEPTIONS，写明 value + reason；
// 有期限的优惠必须同时登记 until，到期由 route.mjs 的 injectOptions 自动回落 high。
// route.test.mjs 会校验每个入口要么声明 high，要么在例外表里。
export const EFFORT_STANDARD = "high";

// 各 harness 的档位选项名（cursor 随模型而异，故按名字集合识别）
export const EFFORT_OPTION_IDS = ["thought_level", "reasoningEffort", "reasoning_effort", "effort", "thinking"];

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
    status: "advisor",
    // 用户定：只做实现顾问（--task design），不做代码审查与安全复核
    tasks: ["design"],
    vision: 82.0,
    entries: [
      // claude 系 harness 优先级：devin > droid
      { provider: "acpRegistry_devin", id: "claude-opus-5-5-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "claude-opus-5-5", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
  "gpt-6.1-sol": {
    label: "GPT-6.1 Sol",
    status: "advisor",
    vision: 81.7,
    entries: [
      { provider: "codex", id: "gpt-6.1-sol", options: { reasoningEffort: "high" }, pool: "codex-pro" },
      { provider: "acpRegistry_devin", id: "gpt-6-1-sol-medium", options: { thought_level: "high" }, pool: "devin" },
      { provider: "acpRegistry_factory_droid", id: "gpt-6.1-sol", options: { reasoning_effort: "high" }, pool: "factory" },
    ],
  },
  "swe-2": {
    label: "SWE-2",
    status: "auto",
    // 榜上无 SWE-2，取基座 Kimi K3 的 56.0；Cognition 只做了编码向后训练，未发布视觉数据。
    vision: 56.0,
    entries: [{ provider: "acpRegistry_devin", id: "swe-2-high", options: { thought_level: "max" }, pool: "devin" }],
    // fusion-<主模型>-sidekick-swe-2-medium 是模型组合不是模型，不进自动路由；大量机械工作可人工用。
  },
  "grok-4.7": {
    label: "Grok 4.7",
    status: "advisor",
    vision: 63.5,
    entries: [
      { provider: "cursor", id: "grok-4.7", options: { reasoning_effort: "high", contextWindow: "256k" }, pool: "cursor-grok" },
    ],
  },
  "glm-5.3-flash": {
    label: "GLM 5.3 Flash",
    status: "auto",
    vision: 55.8,
    entries: [{ provider: "claudeAgent", id: "glm-5.3-flash[1m]", pool: "glm-plan" }],
  },
  "deepseek-v4.1-flash": {
    label: "DeepSeek V4.1 Flash",
    status: "auto",
    // 估值：榜上无该模型。Artificial Analysis MMMU-Pro 77%（同榜 Opus 5.5 88%），
    // 而 GLM 5.3 Flash / Kimi K3 在 Vals MMMU-Pro 为 86.0% / 88.2%，明显落后二者，取略低于 GLM。
    vision: 50,
    // pi harness 上的两个套餐入口：Command Code 优先，OpenDesign Design Plan 备用。
    // 模型 ID 即 slug（<pi 子提供商>/<模型>）；选项名 thinking（off/minimal/low/medium/high）。
    entries: [
      { provider: "pi", id: "commandcode/deepseek/deepseek-v4.1-flash", options: { thinking: "high" }, pool: "commandcode" },
      { provider: "pi", id: "opendesign/deepseek-v4.1-flash", options: { thinking: "high" }, pool: "opendesign" },
    ],
  },
};

// 白名单递补额外放开 status:"advisor" 的任务（见文件头）。select 的 --task 取值即 TASKS 的 key。
// design / review 与 delegate_task 的 role 同名，check --role 直接按它套用 MODELS.tasks 限定。
export const ADVISOR_TASKS = ["review", "design"];

export const TASKS = {
  general: "普通任务：写代码、修 bug、架构、机械与批量改动、调研与文档、UI 与前端视觉（重视觉加 --vision）",
  design: "实现顾问：审主代理的方案/设计稿、修不收敛时要第二意见（UI/UX 方案加 --vision）",
  review: "审查：代码审查、安全复核；要两个不同模型就跑两次（第二次 --exclude-model 第一次 PICK 的 model=）",
};

// 组合规则见文件头（audit 会查 provider 是否命中 entries）。档位不在这里设，逐入口声明（见 EFFORT_STANDARD）。
export const ROUTES = {
  general: [
    // 用户确认首选 GLM flash，其次 SWE-2
    { model: "glm-5.3-flash", provider: "claudeAgent" },
    { model: "swe-2", provider: "acpRegistry_devin" },
    { model: "deepseek-v4.1-flash", provider: "pi" },
  ],
  // 审查：先出各模型首选 harness，再出同模型备用 harness；Opus 不做审查（tasks 限定）。
  review: [
    { model: "gpt-6.1-sol", provider: "codex" },
    { model: "grok-4.7", provider: "cursor" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_devin" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_factory_droid" },
  ],
  // 实现顾问。
  design: [
    { model: "gpt-6.1-sol", provider: "codex" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_devin" },
    { model: "gpt-6.1-sol", provider: "acpRegistry_factory_droid" },
    { model: "opus-5.5", provider: "acpRegistry_devin" },
    { model: "opus-5.5", provider: "acpRegistry_factory_droid" },
    { model: "grok-4.7", provider: "cursor" },
  ],
};

// SWE2_FREE_UNTIL 到期后生效的行内重排（models.md「更新标准」第 5 条：到期后重新排序）。
// 把 task 行内 model 候选移到该行 below 模型最后一个候选之后；below 不在行内则保持原位。
// 形如 { task: "general", model: "swe-2", below: "deepseek-v4.1-flash" }。
// 目前为空：用户定 swe-2 到期后在 general 行位置不变。
export const EXPIRY_DEMOTE = [];

// 入口 pool → t3-quota.mjs --json 里的窗口。窗口任一满足「用量 ≥90% 且重置 >24h」即拦截。
// pool 为 null 的入口不查额度、不记池冷却。
export const POOLS = {
  "codex-pro": { quotaKey: "codex", windows: ["周", "月"] }, // 5h 窗口重置必 <24h，不参与拦截
  "cursor-grok": { quotaKey: "cursor", windows: ["Cursor 模型"] },
  devin: { quotaKey: "devin", windows: ["日", "周", "月"] },
  "glm-plan": { quotaKey: "glm", windows: ["周", "月", "MCP"] },
  factory: { quotaKey: "droid", windows: ["周", "月", "Standard", "Premium"] },
  commandcode: { quotaKey: "commandcode", windows: ["周", "月"] }, // 5h 窗口不参与拦截
  opendesign: { quotaKey: "opendesign", windows: ["周"] }, // Design Plan 只有 5h/7 天窗口；用尽后转扣钱包余额
};

export const QUOTA_BLOCK_PERCENT = 90;
export const QUOTA_BLOCK_RESET_MS = 24 * 3600 * 1000;
export const MAX_ATTEMPTS = 4;
