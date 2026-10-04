# 模型与额度参考

调研日期：2026-10-03。模型 ID 以 `orchestrator_capabilities` 实时返回为准，这里的 ID 只是当时的快照。更新方法见文末「更新来源与标准」。

基准说明：FrontierCode（Cognition 维护，按代码能否合并评分）和 CursorBench 是第三方统一 harness 的榜单；Terminal-Bench、DeepSWE 多为厂商自报，不同版本不能横比。

## 额度池

| 池 | 实例 | 额度怎么看 | 说明 |
|---|---|---|---|
| Cursor 模型池 | `cursor` 上的 grok-4.x | 不可读，只能看失败 | 包含用量明显多，主力池 |
| Cursor 其他池 | `cursor` 上的 Opus、GPT、Gemini 等 | 不可读 | 按 API 价扣费，只在 UI、难题（含安全）时用 |
| Codex Pro | `codex` | 脚本可读（周） | 更高推理档多耗额度；Astra 约是 Sol 的 3 倍，只限点名 |
| Devin | `acpRegistry_devin`（脚本里 `devin` 行的周额度是同一账号） | 脚本可读（周） | swe-2 免费期内不占额度（官方写 10-10 或 10-15 截止）；周额度 100% 时 swe-2 仍可用，其他模型不行 |
| 智谱 GLM Coding Plan | `claudeAgent` | 脚本直接查询（5h、MCP 月） | 只用 `glm-5.3-flash[1m]`；额度充足；闲时（含周末）半价 |
| opencode go | `opencode` 上的 `opencode-go/*` | 脚本可读（5h、周、月） | 只用 `opencode-go/` 前缀的模型 |
| Factory | `acpRegistry_factory_droid` | 脚本直接查询，需要 `FACTORY_API_KEY` | **暂停使用**，用户点名也要先提醒。acp-daemon 不支持 `--mcp-servers`，T3 注入 MCP 后会话打不开（[Factory-AI/factory#9](https://github.com/Factory-AI/factory/issues/9)），本机 10-03、10-04 失败 3 次。下面各表已移除它的入口；修复后从 git 历史恢复 |
| 不使用 | `claudeAgent_kimi`（没有订阅）、`claudeAgent_minimax`（能力太差） | — | 用户点名也要先提醒 |

## 模型画像

状态：**自动** = 可以自动选；**点名** = 只有用户点名才用；**不用** = 不主动调用。

| 模型 | 状态 | 定位 | 关键数据 | 擅长 | 短板 |
|---|---|---|---|---|---|
| Opus 5.5 | 自动（Cursor 其他池限 UI、难题） | 前沿，综合第一 | FrontierCode 第 1（medium 54.6%，$0.80）；CursorBench high 56.0% | 长时程、终端任务、规划、审查 | max 档极浪费；安全、生物、ML kernel 类任务会被静默回退到旧模型 |
| GPT-6.1 Sol | 自动 | 日常主力 | FrontierCode medium 50.2%，$0.36，性价比最高 | 审查（首选）、实现、调试 | 输出比 6 Sol 多 10–30% |
| SWE-2 | 自动 | 接近前沿，便宜 | FrontierCode max 50.0%（$1.18） | 端到端测试覆盖；被质疑时会重新推导；探索聚焦 | 多小时级终端长任务弱于 Opus |
| Grok 4.7 | 自动 | 前沿，长任务 | FrontierCode high 47.6%（$6.65）；CursorBench xhigh 46.3% | 审查（用户实测适合）、长时程任务、自我验证、文档类知识工作 | 慢（小任务均 177s，Opus 34s），输出 token 约 4.5 倍；UI 口碑一般；500k 上下文双倍价 |
| Grok 4.6 | 自动 | 前沿偏下 | FrontierCode high 48.0%（$2.88） | 同池里比 4.7 更省 | 长终端任务弱 |
| GLM 5.3 Flash | 自动，低难度优先 | 便宜，额度充足 | CursorBench max 36.8%，$0.39 | 低难度、批量；原生多模态，能看截图 | 能力有上限 |
| DeepSeek V4.1 Flash | 自动，低难度优先 | 便宜，额度充足 | 厂商数据为主，未上第三方榜 | 低难度、批量 | 上一代在 FrontierCode 有违规联网记录 |
| GPT-6 Luna | 自动，低难度优先 | 极便宜，额度充足 | FrontierCode max 42.4%，$0.10 | 低难度、批量 | 工具坏了时有 28.7% 不告诉用户，必须严格验收 |
| GPT-6 Astra | 点名 | 旗舰 | FrontierCode max 53.3%；Frontend Arena 第 1 | 难 bug、前端 UI | 额度消耗太快 |
| Fable 5.1 | 点名 | 顶级 | Frontend Arena 第 2；$10/$50 | UI、写作、超大问题 | 额度消耗太快；输出不稳定 |
| Kimi K3 | 点名 | 开源前沿 | FrontierCode 44.2%；Frontend Arena 开源第 1 | 前端生成、看图 | 额度消耗太快；边界用例不稳 |
| GLM 5.3（非 flash） | 不用 | 开源旗舰 | FrontierCode max 40.1%，但 $16.91 | 安全 | 没有视觉能力；max 档 token 极多 |
| Composer 2.5 | 不用 | 便宜、快 | FrontierCode 25.6% | — | 已过时 |
| MiniMax-M3 | 不用 | 便宜 | FrontierCode 14.7% | — | 能力太差 |
| 其他旧模型 | 不用 | — | — | — | glm-5.2、gpt-6-sol、gpt-5.6 系列、gemini flash 系列（步数极多） |

## 路由表

每行按顺序尝试，前一个不可用、额度告急或失败后再试下一个。所有候选都不开快速模式。

| 任务 | 候选（实例 / 模型 / 选项） |
|---|---|
| 低难度（小改动、机械修改、批量） | `claudeAgent` / `glm-5.3-flash[1m]` → `opencode` / `opencode-go/deepseek-v4.1-flash` → `codex` / `gpt-6-luna` / `{"reasoningEffort": "high"}` → `acpRegistry_devin` / `swe-2-high` |
| 常规实现、修 bug | `acpRegistry_devin` / `swe-2-high`（免费期内优先） → `codex` / `gpt-6.1-sol` / `{"reasoningEffort": "medium"}` → `acpRegistry_devin` / `gpt-6-1-sol-medium` → `cursor` / `grok-4.6` / `{"fastMode": false}` |
| 难题、架构、疑难 bug | `cursor` / `claude-opus-5-5` / `{"effort": "high", "fastMode": false}` → `acpRegistry_devin` / `claude-opus-5-5-medium` → `codex` / `gpt-6.1-sol` / `{"reasoningEffort": "xhigh"}` |
| UI、前端视觉 | `cursor` / `claude-opus-5-5` / `{"effort": "high", "fastMode": false}` → `codex` / `gpt-6.1-sol` / `{"reasoningEffort": "high"}`；只需按截图做小调整时用 `claudeAgent` / `glm-5.3-flash[1m]` |
| 代码审查（含最终审查） | `codex` / `gpt-6.1-sol` / `{"reasoningEffort": "high"}` → `cursor` / `grok-4.7` / `{"fastMode": false, "contextWindow": "256k"}` → `acpRegistry_devin` / `gpt-6-1-sol-medium`。实现者是 GPT 系列时先用 Grok 4.7 |
| 调研、写文档 | `cursor` / `grok-4.6` 或 `grok-4.7` / `{"fastMode": false, "contextWindow": "256k"}` → `codex` / `gpt-6.1-sol` |
| 安全、漏洞 | `cursor` / `claude-opus-5-5` / `{"effort": "high", "fastMode": false}`，再用 `codex` / `gpt-6.1-sol` / `{"reasoningEffort": "high"}` 交叉复核（Opus 可能静默回退） |

## 同模型的备用入口

| 模型 | 入口 |
|---|---|
| Opus 5.5 | `cursor` `claude-opus-5-5` · `acpRegistry_devin` `claude-opus-5-5-medium` |
| GPT-6.1 Sol | `codex` `gpt-6.1-sol` · `acpRegistry_devin` `gpt-6-1-sol-medium` |
| GPT-6 Luna | `codex` `gpt-6-luna` · `acpRegistry_devin` `gpt-6-luna-medium` · `opencode` `opencode-go/gpt-6-luna` |
| GLM 5.3 Flash | `claudeAgent` `glm-5.3-flash[1m]` · `opencode` `opencode-go/glm-5.3-flash` · `acpRegistry_devin` `glm-5-3-flash-max` · `cursor` `glm-5p3-flash` |
| DeepSeek V4.1 Flash | `opencode` `opencode-go/deepseek-v4.1-flash` · `acpRegistry_devin` `deepseek-v4-1-flash-high` |
| Grok 4.7 / 4.6 | `cursor` `grok-4.7` / `grok-4.6` · `acpRegistry_devin` `grok-4-7-medium` / `grok-4-6-medium` · `opencode` `opencode-go/grok-4.7` / `opencode-go/grok-4.6` |
| SWE-2 | 只有 `acpRegistry_devin` `swe-2-high`。Devin Fusion（`fusion-<主模型>-sidekick-swe-2-medium`）适合大量机械工作，判断本身就是交付物时不要用 |

用户点名时的入口：

| 模型 | 入口 |
|---|---|
| GPT-6 Astra | `codex` `gpt-6-astra` · `acpRegistry_devin` `gpt-6-astra-medium` |
| Fable 5.1 | `cursor` `claude-fable-5-1` · `acpRegistry_devin` `claude-fable-5-1-medium` |
| Kimi K3 | `cursor` `kimi-k3` · `acpRegistry_devin` `kimi-k3-high` · `opencode` `opencode-go/kimi-k3` |

## 更新来源与标准

### 来源

| 用途 | 来源 |
|---|---|
| 实际可用的模型 ID 与选项 | `orchestrator_capabilities`；或 `~/.t3/caches/<实例>.json` 的 `models` |
| 第三方统一榜（排序主依据） | FrontierCode：https://cognition.com/frontiercode；CursorBench：https://cursor.com/cursorbench |
| 厂商发布与系统卡 | OpenAI https://openai.com/news 与 https://deploymentsafety.openai.com；Anthropic https://www.anthropic.com/news；xAI https://x.ai/news；Cognition https://cognition.com/blog；智谱 https://docs.z.ai；DeepSeek https://api-docs.deepseek.com |
| 价格与额度规则 | Cursor https://cursor.com/docs/models-and-pricing；Devin https://docs.devin.ai/desktop/models；Codex https://help.openai.com（搜 Codex usage limits）；GLM Coding Plan https://docs.z.ai/devpack/overview；opencode go https://opencode.ai/docs/go/；Factory https://factory.ai/pricing |
| 额度查询接口（脚本失效时对照） | https://github.com/steipete/CodexBar 的 `docs/providers.md`、`docs/zai.md`、`docs/factory.md` |
| 本机实际表现 | `~/.t3/userdata/statev2.sqlite`，必须以只读方式打开（`sqlite3 "file:...?mode=ro"`），统计 `projection_thread_activities` 中 `runtime.error` 的按 provider 分布 |

### 标准

1. **只有用户能改的规则**：快速模式、点名专用、不主动调用这三类限制由用户决定。更新时可以提出建议，不能自行改动。
2. **排序依据**：先看 FrontierCode 和 CursorBench 的分数和每任务成本；厂商自报数字只用来在第三方数据缺失或分数接近时参考，并在表里注明「厂商」。
3. **加入自动路由**，须同时满足：
   - 用户现有订阅里至少一个 harness 能用；
   - 第三方榜上的分数比该行现有候选低不超过 5 分，且每任务成本或额度消耗更低；或者分数更高、成本相近；
   - 不属于用户限定的模型。
4. **降级或移出**，满足任一即可：
   - 同厂商出了价格相同或更低的新版本；
   - 第三方分数落后该行第一名 10 分以上；
   - 本机记录显示该入口反复失败。
5. **有期限的优惠**（免费期、促销价）：写明截止日期，到期后重新排序。
6. **每个数字都要能追溯**：写明来源；调研日期写在文件开头。

### 流程

1. 对比 `orchestrator_capabilities` 的模型列表和本文件，找出新增、下线和改名的模型。
2. 按上面的来源核对新增模型与价格、额度变化。
3. 运行 `scripts/t3-quota.mjs`，确认各额度查询仍然正常。
4. 把建议的改动列成表（模型、原状态、新状态、理由、来源）交给用户确认。
5. 用户确认后再改本文件，并更新调研日期。
