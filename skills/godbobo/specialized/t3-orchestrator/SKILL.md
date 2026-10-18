---
name: t3-orchestrator
description: T3 Code 多 harness 编排：route.mjs 裁决 harness/模型，delegate_task 派活、验收，限流/额度/过载自动换路续跑。仅限用户或技能点名时调用。
---

用户调用本技能后，本线程余下的工作都按这里的规则进行。

你是主代理：负责定方向、拆任务、派活、验收和汇报。真正的小任务直接完成，避免侦察和交接比实现更长；复杂实现按这里的规则委派。主代理自己中断由用户处理，本技能只管子代理。

子代理与主代理同池时一起耗额度，池尽主代理也会中断：耗时长、改动多的子任务，其他池有同档候选时派到其他池。

## 选目标由脚本裁决

**选哪个 harness、哪个模型，一律跑 `route.mjs`，不查文档、不自己挑。** 固定输入固定输出：任务类型和已试入口进去，`PICK` 出来就是 `delegate_task` 的 `target`（`options` 已按规则注入好）。硬性规则全部编码在 `scripts/route-data.mjs` 与 `route.mjs`——脚本能拦的别靠记忆；`route.mjs table` 看当前生效数据。

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

- `--task` 取值见 `route.mjs tasks`（general / advisor，拿不准按 general；advisor 只用于代码审查、安全复核）。旗标：`--hard` 出「实现顾问→实现」两步（实现顾问只从这里出），`--vision` 让候选按视觉分数降序（截图、UI 还原等看图任务用）。
- `PICK` 为空看 `SKIPPED` 原因。`ALTERNATIVES` 即换路顺序（行内「模型@harness」组合 → 白名单递补）；`via=whitelist` 说明行内候选都不可用。
- `PICK` 是额度裁决的终点：`select` 自己读共享冷却和各池额度窗口，豁免生效时 PICK 自带标注；`--refresh-quota` 强制实查。`t3-quota.mjs` 的读数只用于摸底与汇报，不是第二意见；与认知矛盾时先找豁免标注，确属数据陈旧或豁免未登记就向用户报告或修 `route-data.mjs`。
- 不给 `--caps-file` 时退化为 `~/.t3/caches` 快照并告警。
- 点名清单外的模型 `named` 不识别：先 `check --user-named` 验证再手工指定 target。
- `needsRecovery: true` 的 pick：该入口/池有未清除失败记录，派发前按 [references/failures.md](references/failures.md) 做恢复探测。

调整路由规则前可用沙盒页人工搭配输入、眼看每个候选的跳过原因：

```bash
node <技能目录>/scripts/route-playground.mjs [--caps-file ...] [--quota-file ... | --no-quota]
# 产出自包含的 route-playground.html，浏览器直接打开
```

## 开工前

1. 调一次 `orchestrator_capabilities` 并把返回 JSON 落盘（例如 `/tmp/t3-caps.json`），`--caps-file` 用它判断 `canRunChildTask`、模型清单和选项名。MCP 工具没出现时，按 T3 注入的说明直接调用一次，或用 `acp-mcp-call` 兜底（语法见 `t3-code` 技能）输出重定向到文件。落盘后跑 `route.mjs audit --caps-file /tmp/t3-caps.json` 核对路由数据与目录一致。caps 文件没有 TTL：每次开工重新落盘，快照超 30 分钟脚本会把「不可派/无此模型」类判定标为可能过期——见到告警就重调覆盖，不凭旧快照拍板。
2. `node <技能目录>/scripts/t3-quota.mjs` 摸底各池额度并写穿快照供 `select` 复用（`--cached` 只读快照不触网）。
3. `node <技能目录>/scripts/quota-state.mjs status` 读共享失败状态；每次换路也读。用法与池边界见 [references/quota-state.md](references/quota-state.md)。
4. 指定实现、独立审查和最终验证三类职责。最终验证始终只有一个负责人（默认主代理，可明确交给一个验证子代理）；交接时先结束旧负责人的检查。

## 派活

`delegate_task` 参数：

- `target`：用 route.mjs 输出的 `providerInstanceId`、`model`、`options`，不自行增减选项。
- `role`：按任务填 `implementation`、`review`、`research`、`design`、`test` 之一。
- `mode`：`async`，靠完成事件唤醒。派完处理剩余独立工作，然后结束本轮等事件；不另起监视任务。追加修复和复审也新建 `delegate_task`，不用子线程的 `t3_thread_send` 代替委派。
- 保存每轮的 `taskId`（`task_status` / `task_cancel`）、`childThreadId`（只用于读原始证据）、`clientRequestId`（每轮不同，同轮工具重试沿用原值，换路增加尝试序号）。
- `runtimeMode`、`interactionMode` 一律继承：`approval-required` 的后台子代理每次工具调用都弹人工授权，没人批就永久挂起而 `task_status` 仍显示 running。「只读」这类意图写进任务「范围」，不靠权限模式实现。

规则：

- 同一工作树可同时跑多个写文件的子代理，须同时满足：各自「可以改」的范围互不重叠；都不碰共享文件（生成物、锁文件、全局配置、预算和基线清单）；都不提交，也不跑改写整个仓库的命令（生成器、全仓库格式化、依赖安装）；后一个任务不需要参照前一个任务的产出（例如 OHOS 要照着 desktop 的新代码对齐语义时，只能串行）。不满足就串行。共享文件和生成器由主代理在所有写任务验收后统一处理；只读调研和审查可并行。
- 任务要引用的名字来自共享生成物或词表（l10n key、FFI/接口签名、生成的绑定等）时，派活前先查证现有条目，把可用名单写进「背景」；缺的条目先作为前置任务串行产出。子代理只引用名单内的名字，需要新条目时在回报里提出，由主代理统一登记。
- 并行派写任务时，在每个子代理的「范围」里写明同一工作树还有哪些任务在改哪些目录，要求不碰、不回滚 `git status` 里的这些改动；「验收标准」只写本范围的定向检查（单个 crate 的 `cargo check`/`cargo test`、单个包的 lint）。并行 cargo 命令会争用同一个 target 目录，`Blocking waiting for file lock` 是正常等待，不是卡死。
- 实现、审查和需要执行命令的调研都走 `delegate_task`，失败原因可见、可换路。当前 harness 自带的子代理只用于不执行命令的只读探索（读文件、搜索）：它在后台运行时，需要审批的工具（shell、写文件）会被自动拒绝，只能交回没验证过的改动。
- 顾问任务只读：「范围」里写明不改任何文件、不执行写命令，「验收标准」只要结论、理由和被否决方案的依据；意见由主代理裁决后转述给实现代理，实现代理不与顾问直接对话。
- 只有用户明确要求新线程时，才用 `create_threads` 或 `t3_thread_launch`。
- 派端到端验证或截图任务时，把项目 AGENTS.md 的相关约束原文写进「约束」，注明场景首次开始时间、已消耗时间、重复崩溃计数和现有统一入口；时限、停止条件跨代理重试累计，以项目自身规则为准。截图前预检已有产物、harness 入口与上传条件，优先复用现有设施；环境事实只写查证过的；失败回报具体原因和替代证据；只释放本任务拥有的设备和进程。
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

按 [references/failures.md](references/failures.md) 分类错误原文、记录共享冷却、核实旧尝试进度后续跑。

换路即带上已试入口的 `--exclude` 重跑 `select`，用新的 `PICK`，不用先问用户，最后在汇报里说明。脚本报超过单任务 4 次上限（exit 1）就停下，向用户报告每次尝试的入口和失败原因。

## 验收与本地审查

1. 主代理亲自读实际 diff、原始日志和测试报告，核对证据对应的源码、脏改动、工具链及覆盖范围，不采信子代理自述。已有证据与最终源码一致且覆盖充分时复核采用；证据缺失、源码或工具链变化、有疑点时补跑相应检查。必要的独立行为核验仍执行。
2. 不达标时无论修复大小都新建一次 `delegate_task`，带原始意图、上轮发现、修复回应、未解决异议和完整续跑证据；保存新 taskId，async 等完成事件。方向错误或反复修不好按路由升档。4 次换路上限不能靠新建任务重置。
3. 按风险安排审查：小改动由主代理检查；需要独立审查的常规改动派 `route.mjs select --task advisor` 选出的审查者（实现者是用户点名的顾问模型时，审查改用 `ALTERNATIVES` 里第一个其他模型）；高风险改动用两模型 `$code-review-panel`（两位审查者都用 `--task advisor` 选，第二次 `--exclude` 第一次的入口）——并发（文件锁/互斥、跨进程共享状态、进程或 PID 生命周期与复用、看门狗/清理守护）、取消边界、播放、安全或公共接口，命中其一即 panel，不留裁量。合格 panel 就是该轮最终本地审查，不再重复审同一份 diff。
4. 后续轮只复核已修问题、修改范围与相关回归，仍完整传递原始意图、上轮发现及未解决异议；出现新风险则扩展相关审查范围。创建 PR 后交给云端审查与 `$pr-review-loop`，仅用户要求或风险实质扩大时重启本地 panel。
5. 所有写任务与生成步骤收敛后，唯一最终验证负责人完成最终完整验证；可按第 1 步条件复核采用已有检查证据，不降低整体覆盖。验收完成标准是最终源码、必要行为核验和所有有效审查问题都有可核查证据。

## 汇报

结束时简短说明：

- 每个子任务由哪个实例和模型完成，是否换过路、为什么换；
- 验收跑了什么、结果如何；
- 额度上的变化：哪个池报了用尽、什么时候重置。

## 更新模型与路由规则

用户要求更新模型与额度参考时，按 [references/models.md](references/models.md) 末尾的「更新来源与标准」执行：先列出改动建议，用户确认后再改。

改选择规则只改 `scripts/route-data.mjs`，改完跑 `node --test scripts/route.test.mjs`。
