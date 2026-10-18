# 模型与额度参考

调研日期：2026-10-11。模型 ID 以 `orchestrator_capabilities` 实时返回为准，这里的 ID 只是当时的快照。更新方法见文末「更新来源与标准」。

基准说明：FrontierCode（Cognition 维护，按代码能否合并评分）和 CursorBench 是第三方统一 harness 的榜单；Terminal-Bench、DeepSWE 多为厂商自报，不同版本不能横比。

## 额度池

池 ID 是 `quota-state.mjs` 记录/认领冷却用的 `--pool` 取值，与 `route-data.mjs` 的 `POOLS` 一一对应。额度窗口阈值（≥90% 且重置 >24h 才拦）与窗口映射也由 `POOLS` 定义。

| 池 ID | 实例 | 额度怎么看 | 说明 |
|---|---|---|---|
| `cursor-grok` | `cursor` 上的 grok-4.x | 脚本可读（「Cursor 模型」月窗口 = Dashboard 的 Cursor Models，含 Composer；Grok Bot 周额度与此无关） | 包含用量明显多，主力池；grok 系列只走这里 |
| `codex-pro` | `codex` | 脚本可读（5h、周） | 更高推理档多耗额度 |
| `devin` | `acpRegistry_devin`（脚本里 `devin` 行的周额度是同一账号） | 脚本可读（周） | swe-2 免费期内不占额度（用户确认延至 10-31，`SWE2_FREE_UNTIL`）；周额度 100% 时 swe-2 仍可用，其他模型不行。slug 的 `-medium/-high/-max` 后缀只是默认档，实际档位见「选项与档位」 |
| `glm-plan` | `claudeAgent` | 脚本直接查询（5h、MCP 月） | 只用 `glm-5.3-flash[1m]`，也是 GLM 5.3 Flash 唯一入口；额度充足；闲时（含周末）半价 |
| `factory` | `acpRegistry_factory_droid` | 脚本直接查询，需要 `FACTORY_API_KEY` | 模型最全，适合作为同模型的备用入口。需 droid ≥0.234.0（修复 acp-daemon `--mcp-servers`，[Factory-AI/factory#9](https://github.com/Factory-AI/factory/issues/9)） |
| `commandcode` | `pi` 上的 `commandcode/*` | 脚本直接查询（5h、周、月；凭证读 `~/.commandcode/auth.json`） | Command Code GOAT 套餐，模型 ID 即 slug。5h/周窗口在首次请求后才开始计，未开窗时只有月窗口；额外购买的额度不受窗口限制 |
| `opendesign` | `pi` 上的 `opendesign/*` | 脚本直接查询（5h、周、钱包余额）；需控制面密钥，首次跑 `t3-quota.mjs --login-opendesign` 在浏览器批准一次 | OpenDesign Design Plan，`deepseek-v4.1-flash` 的备用入口。pi 配置里的 `sk-amr-…` 只能调模型、查不了额度；套餐窗口用尽后转扣钱包余额 |
| — | `cursor` 上的三方模型（Opus、GPT、Gemini、Kimi、GLM 等） | — | 下月下线，任何情况都不调用（用户点名也不行） |

## 模型画像

状态：**自动** = 可以自动选；**顾问** = 自动用于审查和咨询，不承担写代码的实现任务；**点名** = 只有用户点名才用；**不用** = 不在 `MODELS`（白名单外），`check` 按「不在入口清单」拦。

| 模型 | 状态 | 定位 | 关键数据 | 擅长 | 短板 |
|---|---|---|---|---|---|
| Opus 5.5 | 顾问（仅实现顾问） | 前沿，综合第一 | FrontierCode 第 1（medium 54.6%，$0.80）；CursorBench high 56.0% | 方案咨询、视觉判断、长时程规划意见 | 不写实现（额度有限）；不做代码审查与安全复核，只在 `--hard` 顾问步出现（用户定，`tasks: ["design"]`）；max 档极浪费；安全、生物、ML kernel 类任务会被静默回退到旧模型 |
| GPT-6.1 Sol | 顾问 | 审查与咨询主力 | FrontierCode medium 50.2%，$0.36，性价比最高 | 审查（首选）、方案咨询、调试思路 | 不写实现（额度有限）；输出比 6 Sol 多 10–30% |
| SWE-2 | 自动 | 接近前沿，便宜 | FrontierCode max 50.0%（$1.18） | 端到端测试覆盖；被质疑时会重新推导；探索聚焦；基于 Kimi K3，原生看图 | 多小时级终端长任务弱于 Opus；无官方视觉数据 |
| Grok 4.7 | 顾问 | 前沿，长任务 | FrontierCode high 47.6%（$6.65）；CursorBench xhigh 46.3% | 审查（用户实测适合）、长时程任务、自我验证、文档类知识工作 | 慢（小任务均 177s，Opus 34s），输出 token 约 4.5 倍；UI 口碑一般；500k 上下文双倍价 |
| GLM 5.3 Flash | 自动，低难度优先 | 便宜，额度充足 | CursorBench max 36.8%，$0.39 | 低难度、批量；原生多模态，能看截图 | 能力有上限 |
| DeepSeek V4.1 Flash | 自动 | 便宜、快 | Artificial Analysis MMMU-Pro 77% | general 行尾备选；原生多模态 | 视觉弱于 GLM 5.3 Flash 与 SWE-2 |
| GLM 5.3（非 flash） | 不用 | 开源旗舰 | FrontierCode max 40.1%，但 $16.91 | 安全 | 没有视觉能力；max 档 token 极多 |
| Composer 2.5 | 不用 | 便宜、快 | FrontierCode 25.6% | — | 已过时 |
| MiniMax-M3 | 不用 | 便宜 | FrontierCode 14.7% | — | 能力太差 |
| 其他旧模型 | 不用 | — | — | — | glm-5.2、gpt-6-sol、gpt-5.6 系列、gemini flash 系列（步数极多）；grok-4.6、claude-sonnet-5-5、gpt-6-luna、gpt-6-astra、claude-fable-5-1、kimi-k3（2026-10-18 用户移出路由） |

## 路由规则在哪里

路由数据（模型状态与入口、ROUTES 组合优先级行、白名单递补、POOLS）的唯一事实源是 `scripts/route-data.mjs`，结构见其文件头；`route.mjs table` 查看当前生效数据。画像表「状态」列对应 `MODELS.status`：自动 → `auto`、顾问 → `advisor`、点名 → `named`；「不用」即不写进 `MODELS`。括注的任务限定（如「仅实现顾问」）对应 `MODELS.tasks`。

## 选项与档位

各 harness 的思考档选项名不同（2026-10-11 按实时目录核对）：

| harness | 选项名 | 备注 |
|---|---|---|
| devin | `thought_level` | 服务端只收 medium/high/max；目录取值集会漂移 |
| codex | `reasoningEffort` | 另有 `serviceTier`，保持 default 不用 priority |
| droid | `reasoning_effort` | snake_case；另有必传的 `autonomy_level`（调度一律 auto-high） |
| cursor | `effort` / `reasoning_effort` | 随模型而异，须逐模型看目录；grok 还有 `fastMode`、`contextWindow` |
| claudeAgent | 无 | `glm-5.3-flash[1m]` 一个选项都没有 |
| pi | `thinking` | off/minimal/low/medium/high |

档位取值规则（用户定）：**主代理派发一律 `high`**。每个入口显式声明一个档位选项且值为 `high`，不依赖 slug 后缀和 harness 默认；偏离必须登记到 `route-data.mjs` 的 `EFFORT_EXCEPTIONS` 并写明 `reason`，由 `route.test.mjs` 强制校验。例外分两种：`claudeAgent/glm-5.3-flash[1m]` 目录里没有任何选项可设（无 `value`）；`acpRegistry_devin/swe-2-high` 免费期内用 `max`（FrontierCode 实测最优档，免费期不占额度），登记了 `until: SWE2_FREE_UNTIL`——有期限的优惠必须登记 `until`，到期由 `route.mjs` 的 `injectOptions` 自动回落 `high`，路由数据里声明的仍是真实意图值。

目录取值集会漂移，不能只信目录：devin 目录曾短暂把全部模型的 `thought_level` 列成五档，服务端校验始终只收 medium/high/max。实测收窄集记录在 `route-data.mjs` 的 `VERIFIED_OPTION_VALUES`，校验时生效集 = 目录集 ∩ 收窄集；探测方法见该常量的注释。

`fastMode` 不写进路由数据：`route.mjs` 只在目录规格里确实存在该选项时自动注入 `fastMode:false`（曾按 provider 名猜测，给没有该选项的 cursor 模型传了 `fastMode`，被服务端拒掉）。

### 持续校验：`route.mjs audit`

```bash
node scripts/route.mjs audit --caps-file /tmp/t3-caps.json   # 有问题逐条打印并 exit 1
```

审计 `route-data.mjs` 全部 entries 与 ROUTES 候选的合并 options：provider/模型在目录里、选项名存在、取值在生效集内。`check --caps-file` 对手工拼的组合做同样的取值校验；select 时对注入后的最终 options 也跑一遍，非法入口直接进 skipped。

测试用的裁剪夹具 `scripts/fixtures/caps-trimmed.json` 只含 route-data 用到的 provider/模型/选项。目录变化后重新生成：取实时 `orchestrator_capabilities` 落盘，按 `route-data.mjs` 里 entries 的 provider/模型 id 过滤 providers 与 models（保留模型完整选项描述），并把 `canRunChildTask`/`canRunCrossProviderChildTask` 归一化为 true（测试按全部实例可派子任务跑；该 flag 在实时目录里也会漂移）后写回该文件。

## 更新来源与标准

### 来源

| 用途 | 来源 |
|---|---|
| 实际可用的模型 ID 与选项 | `orchestrator_capabilities`；或 `~/.t3/caches/<实例>.json` 的 `models` |
| 第三方统一榜（排序主依据） | FrontierCode：https://cognition.com/frontiercode；CursorBench：https://cursor.com/cursorbench |
| 视觉分数（`MODELS.vision`） | Roboflow Vision Evals 总分：https://playground.roboflow.com/evals；榜上缺的模型按 MMMU-Pro（Vals、Artificial Analysis）估值并在 `route-data.mjs` 注明 |
| 厂商发布与系统卡 | OpenAI https://openai.com/news 与 https://deploymentsafety.openai.com；Anthropic https://www.anthropic.com/news；xAI https://x.ai/news；Cognition https://cognition.com/blog；智谱 https://docs.z.ai |
| 价格与额度规则 | Cursor https://cursor.com/docs/models-and-pricing；Devin https://docs.devin.ai/desktop/models；Codex https://help.openai.com（搜 Codex usage limits）；GLM Coding Plan https://docs.z.ai/devpack/overview；Factory https://factory.ai/pricing；Command Code https://commandcode.ai/docs/resources/usage-limits；OpenDesign https://open-design.ai |
| 额度查询接口（脚本失效时对照） | https://github.com/steipete/CodexBar 的 `docs/providers.md`、`docs/zai.md`、`docs/factory.md`；Command Code 看 `command-code` CLI 包的 `/usage` 实现；OpenDesign 看 npm 包 `opencode-opendesign-auth` |
| 本机实际表现 | `~/.t3/userdata/statev2.sqlite`，必须以只读方式打开（`sqlite3 "file:...?mode=ro"`），统计 `projection_thread_activities` 中 `runtime.error` 的按 provider 分布 |

### 标准

1. **只有用户能改的规则**：快速模式、点名专用（`status:"named"`）、harness 白名单（`PROVIDER_RULES.allowModels`）、顾问定位（`status:"advisor"` 不写实现）、任务限定（`MODELS.tasks`）这五类限制由用户决定。更新时可以提出建议，不能自行改动。模型不入选不需要登记——不写进 `MODELS` 即不可选。
2. **排序依据**：先看 FrontierCode 和 CursorBench 的分数和每任务成本；厂商自报数字只用来在第三方数据缺失或分数接近时参考，并在表里注明「厂商」。
3. **加入自动路由**，须同时满足：
   - 用户现有订阅里至少一个 harness 能用（在 `MODELS` 加 entries，顺序即用户认可的 harness 优先级）；
   - 第三方榜上的分数比该行现有候选低不超过 5 分，且每任务成本或额度消耗更低；或者分数更高、成本相近；
   - 不属于用户限定的模型。
4. **降级或移出**，满足任一即可：
   - 同厂商出了价格相同或更低的新版本；
   - 第三方分数落后该行第一名 10 分以上；
   - 本机记录显示该入口反复失败。
5. **有期限的优惠**（免费期、促销价）：写明截止日期并编码为脚本常量（如 `SWE2_FREE_UNTIL`），到期后重新排序。
6. **每个数字都要能追溯**：写明来源；调研日期写在文件开头。

### 流程

1. 对比 `orchestrator_capabilities` 的模型列表和 `scripts/route-data.mjs` 的 entries，找出新增、下线和改名的模型；选项规格变化后重新生成 `scripts/fixtures/caps-trimmed.json`。
2. 按上面的来源核对新增模型与价格、额度变化；核对完跑 `route.mjs audit --caps-file <实时 caps>` 确认全部入口目录可查、选项合法。
3. 运行 `scripts/t3-quota.mjs` 与 `scripts/t3-quota.mjs --json`，确认各额度查询仍然正常。
4. 把建议的改动列成表（模型、原状态、新状态、理由、来源）交给用户确认。
5. 用户确认后改 `scripts/route-data.mjs` 与本文件（画像表同步状态列），跑 `node --test scripts/route.test.mjs`，并更新调研日期。
