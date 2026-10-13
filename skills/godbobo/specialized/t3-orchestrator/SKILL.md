---
name: t3-orchestrator
description: T3 Code 多 harness 编排：主代理按任务难度和各 harness 额度选择子代理模型，通过 t3-code MCP 的 delegate_task 跨 harness 派活、验收，并在子代理遇到限流、额度用尽、服务过载时自动换路续跑。仅限用户主动调用。
---

用户调用本技能后，本线程余下的工作都按这里的规则进行。

你是主代理：负责定方向、拆任务、派活、验收和汇报。真正的小任务可以直接完成，避免侦察和交接比实现更长；复杂实现继续按原有路由与权限规则委派。

主代理自己中断由用户处理，本技能只管子代理。

子代理和主代理在同一个额度池时会一起消耗额度，池用尽后主代理也会中断。所以耗时长、改动多的子任务，在其他池有同档候选时优先派到其他池。

## 选目标由脚本裁决

**选哪个 harness、哪个模型，不查文档、不自己判断，一律跑 `route.mjs`。** 固定输入固定输出：任务类型和已试入口进去，`PICK` 出来就是 `delegate_task` 的 `target`（`options` 已按规则注入好）。

硬性规则（快速模式全禁、点名专用模型、不主动调用清单、顾问模型不写实现、各 harness 白名单与模型锁定入口、droid 选项名、单任务最多 4 次尝试）全部编码在 `scripts/route-data.mjs` 和 `route.mjs` 里，脚本能拦住的就别靠记忆；`route.mjs table` 可查看当前生效的全部规则数据。

```bash
# 选目标：--task 分类进去，pick/alternatives/skipped 出来
node <技能目录>/scripts/route.mjs select --task <类型> [--caps-file /tmp/t3-caps.json]
# 用户点名模型/实例时
node <技能目录>/scripts/route.mjs named <模型> [--provider <实例>] [--caps-file ...]
# 换路：把已试过的入口（含失败和刚被跳过的）逐个 --exclude
node <技能目录>/scripts/route.mjs select --task <类型> --exclude <provider/model> [--exclude ...]
# 手工拼的 target（含用户点名清单外组合）派发前兜底校验
node <技能目录>/scripts/route.mjs check --provider <id> --model <id> [--role <role>] [--options '<json>'] [--user-named]
```

- `PICK` 为空时看 `SKIPPED` 的原因，不要绕开脚本自己挑；`ALTERNATIVES` 已按换路顺序排好（同模型其他入口 → 行内下一候选 → 降档行）。
- `--task` 取值跑 `route.mjs tasks` 查看：low（小改动、机械修改、批量）、implementation（实现、修 bug、架构；难题加 `--hard` 自动输出「顾问→实现」两步）、ui、ui-minor（只按截图做小调整）、advisor（视觉/长时程规划/要第二意见时加 `--vision`）、review（带 `--implementer <实现者模型>` 自动避开同家族）、research、security（输出先审查后交叉复核两腿）。拿不准任务是否属于 low 时按 implementation。
- 脚本自行读取共享冷却状态和各池额度窗口；`--caps-file` 给的是 `orchestrator_capabilities` 的实时 JSON（开工前落盘一次即可），不给时退化为 `~/.t3/caches` 快照并告警。
- 点名清单外模型时 `named` 不识别，用 `check --user-named` 验证后手工指定 target。
- `needsRecovery: true` 的 pick 表示该入口/池有未清除的失败记录：派发前先 `claim` 并做恢复探测（见「子代理失败时」）。

调整路由规则前，可以用沙盒页人工搭配输入、眼看每个候选的跳过原因：

```bash
node <技能目录>/scripts/route-playground.mjs [--caps-file ...] [--quota-file ... | --no-quota]
# 产出自包含的 route-playground.html，浏览器直接打开
```

## 开工前

1. 调一次 `orchestrator_capabilities` 并把返回 JSON 落盘（例如 `/tmp/t3-caps.json`），route.mjs 的 `--caps-file` 用它判断 `canRunChildTask`、模型清单和选项名。MCP 工具没出现时，按 T3 注入的说明直接调用一次，或用 `acp-mcp-call` 兜底（具体语法见 `t3-code` 技能）输出重定向到文件。落盘后跑 `route.mjs audit --caps-file /tmp/t3-caps.json` 核对路由数据与目录一致（输出问题即按提示修 route-data.mjs）。
2. 运行 `node ~/.agents/skills/t3-orchestrator/scripts/t3-quota.mjs` 查看额度（`--json` 给 route.mjs 用，它会自己调）。它用本机凭证直查所有 harness（Codex、Cursor、Devin、GLM、Droid），不依赖 T3 缓存。
3. 读取共享失败状态：`node <技能目录>/scripts/quota-state.mjs status`。每次换路也读；用法与池边界见 [references/quota-state.md](references/quota-state.md)。
4. 指定实现、独立审查和最终验证三类职责。最终验证默认由主代理负责，也可明确交给一个验证子代理；整个任务始终只有一个最终验证负责人，交接时先结束旧负责人的检查。

## 派活

用 `delegate_task`：

- `target`：用 route.mjs 输出的 `providerInstanceId`、`model`、`options`，不自行增减选项。
- `role`：按任务填 `implementation`、`review`、`research`、`design`、`test` 之一。
- `mode`：委派任务用 `async`，靠完成事件唤醒。派完处理剩余独立工作，然后结束本轮等待事件；不另起监视任务。追加修复和复审也新建 `delegate_task`，不能用子线程的 `t3_thread_send` 代替委派。
- 保存每轮的 `taskId`、`childThreadId`、`clientRequestId`。taskId 用于 `task_status` / `task_cancel`；childThreadId 只用于读原始证据。每轮 clientRequestId 不同，同一轮工具重试沿用原值，换路增加尝试序号。
- `runtimeMode`、`interactionMode` 保持继承，不能升级权限。

规则：

- 同一个工作树可以同时跑多个写文件的子代理，但要同时满足：
  - 各自「可以改」的范围互不重叠；
  - 都不碰共享文件：生成物（l10n 输出、绑定生成的类型文件等）、锁文件（`Cargo.lock`、`pnpm-lock.yaml`、`oh-package-lock.json5` 等）、全局配置、预算和基线清单；
  - 都不提交，也不跑会改写整个仓库的命令（生成器、全仓库格式化、依赖安装）；
  - 后一个任务不需要参照前一个任务的产出（例如 OHOS 要照着 desktop 的新代码对齐语义时，只能串行）。

  不满足就串行。共享文件和生成器由主代理在所有写任务验收后统一处理；最终完整验证由唯一负责人在写入收敛后安排。只读调研和审查可并行。
- 任务要引用的名字来自共享生成物或词表（l10n key、FFI/接口签名、生成的绑定等）时，派活前主代理先查证现有条目，把可用名单写进「背景」；缺的条目先作为前置任务串行产出。子代理只引用名单内的名字，需要新条目时在回报里提出，由主代理统一登记。
- 并行派写任务时，在每个子代理的「范围」里写明同一工作树还有哪些任务在改哪些目录，要求它不碰、不回滚 `git status` 里的这些改动；「验收标准」只写本范围的定向检查（单个 crate 的 `cargo check`/`cargo test`、单个包的 lint）。并行的 cargo 命令会争用同一个 target 目录，`Blocking waiting for file lock` 是正常等待，不要当成卡死去结束进程。
- 实现、审查和需要执行命令的调研都走 `delegate_task`，方便看到失败原因并换路。当前 harness 自带的子代理只用于不执行命令的只读探索（读文件、搜索）。自带子代理在后台运行时，需要审批的工具（shell、写文件）会被自动拒绝，它跑不了构建和测试，只能交回没验证过的改动。
- 顾问任务只读：「范围」里写明不改任何文件、不执行写命令，「验收标准」只要结论、理由和被否决方案的依据；回报的意见由主代理裁决后转述给实现代理，实现代理不直接和顾问来回对话。
- 只有用户明确要求新线程时，才用 `create_threads` 或 `t3_thread_launch`。
- 派端到端验证或截图任务时，把项目 AGENTS.md 的相关约束原文写进「约束」，注明场景首次开始时间、已消耗时间、重复崩溃计数和现有统一入口。时限、停止条件跨代理、重试、编译策略及基线工作树累计；Musiver 按其项目规则执行单场景 15 分钟、同一崩溃两次停止，其他项目读取自身规则。
- 截图前预检已有产物、harness 入口与上传条件，优先复用现有设施。环境事实只写查证过的；失败回报具体原因和替代证据，只释放本任务拥有的设备和进程。
- 重命令遵守机器的调度入口与资源限额；限额取设备配置，不在本技能写死。审查者默认只读源码及已有证据，需额外重检查时提出请求，由最终验证负责人安排。

子代理看不到父对话，提示词必须自带全部背景。按下面的模板写：

```text
## 背景
<项目、模块、为什么要改；已确定的方向和否决过的方案>

## 任务
<要做什么，做到哪一步为止>

## 范围
工作目录：<绝对路径>
执行环境：<目标 exec 的 shell 方言——子代理看不到父环境，必须写明；cmd.exe 填「`&&` 连接、`dir`/`type`/`findstr`/`rg`、无 `ls`/`head`/`sed`/`grep`/heredoc、含引号或多行的脚本先写临时文件再跑」，POSIX bash 填 bash>
可以改：<文件或目录>
不要碰：<文件或目录>

## 约束
<编码规范、需要用到的技能（写明技能名，例如 $git-prefs）、禁止事项（例如不要提交、不要开 PR、不要回滚已有改动）>
harness 拒绝执行工具时（例如 `Permission denied for this tool`、`was denied because this agent is running in the background`），立即停止，在回报里写明被拒的工具和命令。不要换别的工具绕过，也不要在无法验证的情况下继续改代码。

## 验证与资源
最终验证负责人：<主代理或指定验证子代理>
本任务最小检查：<准确命令及范围；不能自行扩展为全仓库构建>
留给最终负责人：<完整验证与生成步骤>
调度入口与资源需求：<已有入口、构建/设备需求、排队约定>

## 验收标准
<需要满足的行为、最小检查覆盖>

## 回报与交接
改动文件与完成步骤；实际命令、工作目录、源码状态（提交及脏改动的快照/摘要）、工具链版本、退出码、原始日志和报告路径；未完成步骤、失败原因、仍在运行的任务/进程及归属、剩余验证。
截图任务同时回报首次开始时间、累计耗时、崩溃计数与替代证据。
```

## 子代理失败时

失败的 `summary` 开头是 provider 的错误原文。按原文分类：

| 类型 | 典型原文 | 处理 |
|---|---|---|
| 临时过载或连接失败 | `at capacity`、`server_is_overloaded`、`503`、`stream disconnected`、`Reconnecting... 5/5`、`runtime stream failed`、`Aborted` | 只记录该入口冷却，确认旧尝试退出后换路 |
| 额度或限流 | 明确的 `usage limit` / `quota` / `credits` 耗尽；`429`、`exceeded retry limit` 需看原文 | 已确认额度耗尽才记录 quota；仅 rate limit 按单入口记录。只有已确认共用额度的入口才共用池标记，不能仅因 429 封禁整个池 |
| 配置或环境 | `provider_unavailable`、`model_unavailable`、`Invalid value ... model`、`is not enabled`、`auth`、`Provider session failed to open`、`does not exist` | 不在原目标重试；重新调 `orchestrator_capabilities` 落盘，换入口 |
| 启动即失败 | 开始后 1 分钟内失败，期间没有任何工具调用，原文不属于上面几类（例如 `Provider turn failed`） | 按配置或环境处理 |
| 权限被拒 | `Permission denied for this tool`、`was denied because this agent is running in the background` | 不在原目标重试。如果用的是 harness 自带子代理，改用 `delegate_task` 重新派；如果已经是 `delegate_task`，不能升级权限，停下向用户报告被拒的工具 |
| 任务没做好 | 状态是 completed，但结果不达标 | 不算 harness 故障，见「验收」 |
| 长时间无新消息 | activity 很久没有新内容 | `status=working` 不算活着——请求流挂死时状态停 working、零事件。查子线程 provider 日志文件 mtime/大小是否增长、实际编译进程、锁持有者和排队状态；仍在编译或合法排队就继续等待。确认无实际进展再取消，退出确认后才换路 |

把已查证的失败类别与重置时间写入共享状态；未知重置初始冷却 30 分钟，到期通过 `claim` 争取唯一恢复探测，恢复失败带原 token 延长冷却，成功带原 token 清除标记；过期结果不影响新探测。单入口故障不封禁模型家族。首次派活及每次换路都先检查并认领入口和已确认的池。只有 claim 的 `recovery: false` 才派正式实现；`recovery: true` 先做一次轻量额度/连接查询，以 token 回报后重新检查。失败消耗整个探测 token，旧结果不能再清除其他 scope 的故障。具体命令见额度状态参考，池 ID 见 [references/models.md](references/models.md)「额度池」。

换路：把刚失败的入口加进 `--exclude` 再跑一次 `route.mjs select`，用新的 `PICK`。`ALTERNATIVES` 的顺序就是换路顺序（同模型其他入口 → 行内下一候选 → 降档行），不用先问用户，最后在汇报里说明。换路不会放出点名专用模型，超过单任务 4 次尝试脚本直接拒绝——停下向用户报告每次尝试的入口和失败原因。

## 续跑

换路前先弄清上一次尝试做到了哪一步：

1. 用 `t3_thread_read` 读失败的子线程（`childThreadId`），用 activity 视图看它改了什么、卡在哪；
2. 用 `task_status` 与原始日志/实际进程交叉核对。需要取消时调 `task_cancel`；取消请求本身不是退出确认。确认旧写者及其构建子进程已退出、锁已释放，才能启动下一尝试。投影与实际不一致时继续查证，不复制启动同一写任务；仅可结束本任务拥有的进程。
3. 在工作目录看 `git status` 和 `git diff`，核对已完成步骤、失败日志、后台任务及剩余验证。

新的提示词沿用原模板，在「背景」末尾加上：

```text
上一次尝试由 <实例/模型> 执行，因 <错误类型> 中断。
已完成：<步骤与已有检查证据>
工作区已有的改动：<文件列表和源码状态>
失败日志：<原始路径>
后台任务：<PID/任务ID、归属、已确认退出或仍运行>
剩余验证：<检查与唯一负责人>
截图边界：<首次开始时间、累计耗时与崩溃计数，续跑不重置>
先核对这些改动是否正确，在此基础上继续，不要从头开始，也不要回滚。
```

## 验收与本地审查

1. 主代理亲自读实际 diff、原始日志和测试报告，核对证据对应的源码、脏改动、工具链及覆盖范围，不能仅采信子代理自述。已有证据与最终源码一致且覆盖充分时复核采用；证据缺失、源码或工具链变化、有疑点时补跑相应检查。必要的独立行为核验仍执行。
2. 不达标时，无论修复大小都新建一次 `delegate_task`，带原始意图、上轮发现、修复回应、未解决异议和完整续跑证据；保存新 taskId，async 等完成事件。方向错误或反复修不好按路由升档。每个子任务最多 4 次故障换路尝试，不能靠新建任务重置计数。
3. 按风险安排审查：小改动由主代理检查；需要独立审查的常规改动派 `route.mjs select --task review --implementer <实现者模型>` 选出的不同家族审查者；高风险改动用两模型 `$code-review-panel`——并发（文件锁/互斥、跨进程共享状态、进程或 PID 生命周期与复用、看门狗/清理守护）、取消边界、播放、安全或公共接口，命中其一即 panel，不留裁量。合格 panel 就是该轮最终本地审查，不再加一个审查者重复同一份 diff。
4. 后续轮只复核已修问题、修改范围与相关回归，仍完整传递原始意图、上轮发现及未解决异议；出现新风险则扩展相关审查范围。创建 PR 后交给云端审查与 `$pr-review-loop`，仅用户要求或风险实质扩大时重启本地 panel。
5. 所有写任务与生成步骤收敛后，唯一最终验证负责人完成最终完整验证；可按第 1 步条件复核采用已有检查证据，不降低整体覆盖。验收完成标准是最终源码、必要行为核验和所有有效审查问题都有可核查证据。

## 汇报

结束时简短说明：

- 每个子任务由哪个实例和模型完成，是否换过路、为什么换；
- 验收跑了什么、结果如何；
- 额度上的变化：哪个池报了用尽、什么时候重置。

## 更新模型与路由规则

用户要求更新模型与额度参考时，按 [references/models.md](references/models.md) 末尾的「更新来源与标准」执行：先列出改动建议，用户确认后再改。

选择规则（模型状态、各模型的 harness 入口优先级、路由行、降档链、池映射）的唯一事实源是 `scripts/route-data.mjs`，改完跑 `node --test scripts/route.test.mjs`；`references/models.md` 只保留额度池、模型画像与更新标准。
