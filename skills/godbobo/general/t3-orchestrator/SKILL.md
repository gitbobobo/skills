---
name: t3-orchestrator
description: T3 Code 多 harness 编排：主代理按任务难度和各 harness 额度选择子代理模型，通过 t3-code MCP 的 delegate_task 跨 harness 派活、验收，并在子代理遇到限流、额度用尽、服务过载时自动换路续跑。仅限用户主动调用。
---

用户调用本技能后，本线程余下的工作都按这里的规则进行。

你是主代理：负责定方向、拆任务、派活、验收和汇报。实现类工作交给子代理，读代码、跑测试、几行以内的小修改可以自己做。

主代理自己中断由用户处理，本技能只管子代理。

子代理和主代理在同一个额度池时会一起消耗额度，池用尽后主代理也会中断。所以耗时长、改动多的子任务，在其他池有同档候选时优先派到其他池。swe-2 在免费期内不受这条限制。

## 硬性规则

1. **永远不用快速模式。**
   - 有 `fastMode` 选项的模型一律传 `false`。
   - codex 的 `serviceTier` 保持 `default`，不用 `priority`。
   - 不选名字带 `-fast` 的模型。
2. **以下模型只有用户点名才用**，自动选择和换路时都跳过它们在所有 harness 上的入口：GPT-6 Astra、Fable 5.1、Kimi K3。
3. **以下模型和实例不主动调用**：
   - GLM 5.3 非 flash 版（没有视觉能力）；
   - Composer 2.5；
   - `claudeAgent_kimi`（没有订阅）；
   - `claudeAgent_minimax`、MiniMax 系列；
   - `opencode` 上 `opencode-go/` 以外的模型。
4. `claudeAgent` 只用 `glm-5.3-flash[1m]`，不选它模型列表里的 `claude-*`（请求实际会发到智谱）。
5. 用户点名了模型或 harness 时，照用户说的做，不受第 2、3 条限制，但第 1 条仍然有效。

## 开工前

1. 调一次 `orchestrator_capabilities`，确认哪些实例 `canRunChildTask`、有哪些模型和选项。工具没出现时，按 T3 注入的说明直接调用一次，或用 `acp-mcp-call` 兜底（具体语法见 `t3-code` 技能）。
2. 运行 `node ~/.agents/skills/t3-orchestrator/scripts/t3-quota.mjs` 查看额度。它会读 T3 的额度缓存，并直接查询 GLM 和 Droid 的额度。
3. 读 [references/models.md](references/models.md)，里面有额度池、模型画像、路由表和同模型的备用入口。

## 选模型

1. 先判断任务类型：低难度（小改动、机械修改、批量）、常规实现、难题、UI、审查、调研、安全。拿不准时按高一档处理。
2. 低难度任务优先用额度充足的便宜模型：`glm-5.3-flash[1m]`、`opencode-go/deepseek-v4.1-flash`、`gpt-6-luna`。
3. 在路由表对应行里按顺序选第一个可用的候选。以下情况跳过该候选：
   - 违反「硬性规则」；
   - 实例不在 `orchestrator_capabilities` 里，或者 `canRunChildTask` 为 false；
   - 额度窗口用了 90% 以上，且离重置超过 24 小时（Devin 的 swe-2 在免费期内例外）；
   - 本会话里这个额度池已经报过额度用尽。
4. Cursor 其他池的模型（Opus 等，按 API 价扣费）只在 UI、难题（含安全）时自动使用。
5. 审查（含最终审查）用 GPT-6.1 Sol 或 Grok 4.7，选和实现者不同家族的那个。

## 派活

用 `delegate_task`：

- `target`：写明 `providerInstanceId`、`model`，需要时加 `options`（例如 `{"fastMode": false}`、`{"reasoningEffort": "medium"}`）。选项名以 `orchestrator_capabilities` 返回的为准。
- `role`：按任务填 `implementation`、`review`、`research`、`design`、`test` 之一。
- `mode`：预计 10 分钟内完成的用 `wait`；更长的用 `async`，派完就结束本轮，等 T3 唤醒，不要轮询，也不要另起监视任务。只有 `delegate_task` 派出的任务会唤醒你。结束本轮前，先确认没有自己用 `t3_thread_send` 发出、还没结束的 run，有的话按「验收」第 2 步用 `t3_thread_wait` 等完。
- `clientRequestId`：写成 `<任务简称>-a<尝试序号>`，例如 `fix-seek-a1`，换路时序号加一。
- `runtimeMode`、`interactionMode` 保持继承，不能升级权限。

规则：

- 同一个工作树可以同时跑多个写文件的子代理，但要同时满足：
  - 各自「可以改」的范围互不重叠；
  - 都不碰共享文件：生成物（l10n 输出、绑定生成的类型文件等）、锁文件（`Cargo.lock`、`pnpm-lock.yaml`、`oh-package-lock.json5` 等）、全局配置、预算和基线清单；
  - 都不提交，也不跑会改写整个仓库的命令（生成器、全仓库格式化、依赖安装）；
  - 后一个任务不需要参照前一个任务的产出（例如 OHOS 要照着 desktop 的新代码对齐语义时，只能串行）。

  不满足就串行。共享文件的改动、生成器和全仓库测试由主代理在所有写任务验收后统一处理。只读调研和审查随时可以并行。
- 并行派写任务时，在每个子代理的「范围」里写明同一工作树还有哪些任务在改哪些目录，要求它不碰、不回滚 `git status` 里的这些改动；「验收标准」只写本范围的定向检查（单个 crate 的 `cargo check`/`cargo test`、单个包的 lint）。并行的 cargo 命令会争用同一个 target 目录，`Blocking waiting for file lock` 是正常等待，不要当成卡死去结束进程。
- 实现、审查和需要执行命令的调研都走 `delegate_task`，方便看到失败原因并换路。当前 harness 自带的子代理只用于不执行命令的只读探索（读文件、搜索）。自带子代理在后台运行时，需要审批的工具（shell、写文件）会被自动拒绝，它跑不了构建和测试，只能交回没验证过的改动。
- 只有用户明确要求新线程时，才用 `create_threads` 或 `t3_thread_launch`。
- 派端到端验证或截图任务时，把项目 AGENTS.md 里关于端到端验证的约束原文写进「约束」。环境事实只写查证过的，不要猜（例如把用户的工作电脑说成 CI 机），也不要建议约束以外的手段。

子代理看不到父对话，提示词必须自带全部背景。按下面的模板写：

```text
## 背景
<项目、模块、为什么要改；已确定的方向和否决过的方案>

## 任务
<要做什么，做到哪一步为止>

## 范围
工作目录：<绝对路径>
可以改：<文件或目录>
不要碰：<文件或目录>

## 约束
<编码规范、需要用到的技能（写明技能名，例如 $git-commit）、禁止事项（例如不要提交、不要开 PR、不要回滚已有改动）>
harness 拒绝执行工具时（例如 `Permission denied for this tool`、`was denied because this agent is running in the background`），立即停止，在回报里写明被拒的工具和命令。不要换别的工具绕过，也不要在无法验证的情况下继续改代码。

## 验收标准
<需要跑的命令、需要满足的行为>

## 回报
改了哪些文件、各自做了什么、跑了哪些检查及结果、没做完的部分和原因。
```

## 子代理失败时

失败的 `summary` 开头是 provider 的错误原文。按原文分类：

| 类型 | 典型原文 | 处理 |
|---|---|---|
| 临时过载 | `at capacity`、`server_is_overloaded`、`503`、`stream disconnected`、`Reconnecting... 5/5`、`runtime stream failed`、`Aborted` | 不在原目标重试，直接换同模型的其他入口 |
| 额度或限流 | `usage limit`、`hit your usage limit`、`429`、`exceeded retry limit`、`quota`、`credits` | 本会话内把这个额度池标记为不可用，换同模型的其他入口 |
| 配置或环境 | `provider_unavailable`、`model_unavailable`、`Invalid value ... model`、`is not enabled`、`auth`、`Provider session failed to open`、`does not exist` | 不在原目标重试；重新调 `orchestrator_capabilities`，换入口 |
| 启动即失败 | 开始后 1 分钟内失败，期间没有任何工具调用，原文不属于上面几类（例如 `Provider turn failed`） | 按配置或环境处理 |
| 权限被拒 | `Permission denied for this tool`、`was denied because this agent is running in the background` | 不在原目标重试。如果用的是 harness 自带子代理，改用 `delegate_task` 重新派；如果已经是 `delegate_task`，不能升级权限，停下向用户报告被拒的工具 |
| 任务没做好 | 状态是 completed，但结果不达标 | 不算 harness 故障，见「验收」 |
| 长时间没进展 | `running`，但 `t3_thread_read` 的 activity 视图很久没有新内容 | `task_cancel`，然后按临时过载处理 |

换路顺序：

1. 同模型的其他入口（见「同模型的备用入口」）；
2. 路由表同一行的下一个候选；
3. 降一档的候选。

以上都可以自动进行，不用先问用户，最后在汇报里说明。换路时同样遵守「硬性规则」，不会因为其他候选都失败就去用只限用户点名的模型。同一个子任务最多尝试 4 次，用完了就停下，向用户报告每次尝试的入口和失败原因。

## 续跑

换路前先弄清上一次尝试做到了哪一步：

1. 用 `t3_thread_read` 读失败的子线程（`childThreadId`），用 activity 视图看它改了什么、卡在哪；
2. 在工作目录看 `git status` 和 `git diff`。

新的提示词沿用原模板，在「背景」末尾加上：

```text
上一次尝试由 <实例/模型> 执行，因 <错误类型> 中断。
已完成：<步骤>
工作区已有的改动：<文件列表>
先核对这些改动是否正确，在此基础上继续，不要从头开始，也不要回滚。
```

## 验收

1. 自己看 diff，跑验收标准里的命令。不能只信子代理的回报。
2. 不达标时：
   - 小问题用 `t3_thread_send`（`mode: "queue"`）把具体问题发回同一个子线程，上下文还在，成本最低。这样追加的 run 结束时不会唤醒你，发完要在同一轮里调 `t3_thread_wait`，传入返回的 `threadId` 和 `runId`；返回 `timedOut: true` 就再调一次，不要结束本轮。结束后用 `t3_thread_read` 读子线程最后的回报，再按第 1 步验收；
   - 修复量大、预计超过 15 分钟的，不用 `t3_thread_send`，按「续跑」重新 `delegate_task` 一个 `async` 任务，靠完成通知唤醒；
   - 方向错了或者反复改不对，换高一档的模型，按「续跑」重新派活。
3. 改动较大时，派一个审查子代理做最终审查：实现者是 GPT 系列时用 Grok 4.7，其他情况用 GPT-6.1 Sol。主代理自己看过 diff 不能代替这一步。

## 汇报

结束时简短说明：

- 每个子任务由哪个实例和模型完成，是否换过路、为什么换；
- 验收跑了什么、结果如何；
- 额度上的变化：哪个池报了用尽、什么时候重置。

## 更新模型参考

用户要求更新模型与额度参考时，按 [references/models.md](references/models.md) 末尾的「更新来源与标准」执行：先列出改动建议，用户确认后再改文件。
