# skills

个人开发工作流，保存常用技能与工具脚本。

## 目录结构

- `skills/godbobo/general/`：通用原创技能
- `skills/godbobo/specialized/`：专用原创技能
- `skills/forks/`：分叉技能（导入时注明来源，保持可独立安装）
- `docs/`：文档

技能的安装与更新步骤见 [docs/setup.md](docs/setup.md)（通过 `skills` CLI 安装到通用目录 + Claude Code，避免链接到所有 agent）。

## 给 Agent 的安装提示词

在新设备上，把下面代码块的内容直接发给任意 agent，即可按文档安装/更新本仓库全部技能：

```text
请阅读 https://raw.githubusercontent.com/gitbobobo/skills/main/docs/setup.md，按文档安装/更新该仓库的全部技能，不确定时先问我。
```

## 技能列表

### git-commit

规范的本地提交工作流。确保每次提交都可审计、相关且工作目录干净；当前源码、工具链和范围一致的最小检查证据可核验采用，变化或缺口才补跑，技能一致性检查同样适用。

详见 [skills/godbobo/general/git-commit/SKILL.md](skills/godbobo/general/git-commit/SKILL.md)。

### git-sync

同步 git 远程并解决冲突，确保本地和远程保持一致。优先通过 rebase 保持线性历史，禁止直接丢弃提交内容，必须根据提交时间理解修改意图。

详见 [skills/godbobo/general/git-sync/SKILL.md](skills/godbobo/general/git-sync/SKILL.md)。

### plain-plan

生成用户向、简洁的实现计划：少术语、无代码库类名，用人话说明会做成什么样，便于不写代码的人通读与拍板。文字计划结束后主动询问是否需要网页版；用户同意后再生成有教育性的图文网页讲解（非文字计划的照搬），必要时通过 html-preview 发布预览链接。仅限用户主动调用。

详见 [skills/godbobo/general/plain-plan/SKILL.md](skills/godbobo/general/plain-plan/SKILL.md)。

### pr-review-loop

PR 推送并请求复审后持续跟进 bot（Codex、Code Bot、Devin 等）和 CI。T3 原生 watcher 可用时，先读当前意见与最新 HEAD 检查、处理已有事项，再注册 watcher 并结束本轮等待事件；唤醒后结合账本续跑；未回应审查者用原生 scheduler 的一次临时期限提醒执行超时规则，提醒醒来先删除自身，不建额外 PR 轮询器。等待不代表完成，交回用户时清理提醒与 watcher。没有原生能力才用已有等待脚本，长等待后台执行并保存日志，不重复启动；单次约 4.5 分钟，退出码 2 表示还要继续。脚本附回复命令，原生路径按意见类型和线程 ID 回复。agent 只发新评论，不修改或删除已有评论：Code Bot 和 agent 共用 GitHub 账号，改评论会覆盖审查结论。
使用方式：在项目 PR 模板的「审查意见处理」中加入下面这一行，agent 按模板完成待办时就会进入循环：

```markdown
- [ ] 请求复审后按 `$pr-review-loop` 自动等待并处理新意见，直到收敛（规则见该 skill，不需要用户转达）
```

处理新意见按「收敛规则」一节执行：先把意见归并进 Act on / Consider / Noted / Dismissed 四桶再按桶回复（Consider 档补上了「对但本 PR 不做」的中间档）；云端 bot 的一致性要降权（各 bot 输入不同）；跨轮判断记在工作树外的 TSV 账本里；上一轮已 Dismissed 的意见被重复提出时引用旧驳回理由而不是重新辩论。

对话中断后恢复时，原生路径恢复账本与 watcher；回退脚本首次加 `--reset`。

详见 [skills/godbobo/general/pr-review-loop/SKILL.md](skills/godbobo/general/pr-review-loop/SKILL.md)。

### recall

重建工作上下文并产出四段简报（Capsule / Next move / Threads / Problems）：上次干到哪、需求整体进行到哪、下一步干什么。用于换设备接手或隔段时间续作。`scripts/recall.mjs` 在目标仓库里采集四个面——git/gh 实况、本机 T3 线程（statev2.sqlite，线程自述标记为「声称」需实况源核实）、Fast Ship 需求维度（`pull_requests[]` 跨仓库 PR 全集、共识、checklist），由 agent 综合成带可信度标注的简报。issue 引用按参数 > 分支名 > PR 正文自动解析。

```bash
node ~/.agents/skills/recall/scripts/recall.mjs [INT-58] [--threads 5]
```

详见 [skills/godbobo/general/recall/SKILL.md](skills/godbobo/general/recall/SKILL.md)。

### setup-env

统一设置本机各 agent harness 的全局代理规则：把技能内置的 `rules/AGENTS.md`（唯一真源）链接到 devin、codex、claude、opencode、factory droid 的全局规则路径，cursor 则写入 `~/.cursor/rules/global.mdc`（包 `alwaysApply` frontmatter 的派生文件），让所有 CLI 代理在任何项目里加载同一套约定（命令输出截断保留退出码、重命令遵守机器调度、单一最终验证负责人、原生事件优先与后台等待回退、非 ASCII 请求体走文件、gh api 陷阱、工作树收尾：永不删除自己所在或被 T3 线程绑定的工作树、按固定顺序收尾并跑 t3-worktree-gc 回收、macOS 进程组与失效 cwd 不可恢复、Windows 删除目录与工作树约束等）。附带环境体检：报告各 harness CLI 安装情况与规则文件状态，已有非空文件先备份再替换，幂等可重跑。另把 `run-watch`（后台长任务封装：start 起任务写日志+状态文件，status 轮询返回退出码）链接到 `~/.local/bin`。仅限用户主动调用。

```bash
node ~/.agents/skills/setup-env/scripts/setup-env.mjs --check   # 只体检
node ~/.agents/skills/setup-env/scripts/setup-env.mjs           # 执行链接
node ~/.agents/skills/setup-env/scripts/setup-env.mjs --copy    # Windows/无符号链接权限
```

详见 [skills/godbobo/general/setup-env/SKILL.md](skills/godbobo/general/setup-env/SKILL.md)。

### t3-orchestrator

T3 Code 多 harness 编排，仅限用户主动调用（在线程里发 `$t3-orchestrator`）。真正的小任务可由主代理直接完成，复杂实现按既有路由与权限通过 `delegate_task` 委派；实现、独立审查、最终验证职责分开，始终只有一个最终验证负责人。实现者只做派定的最小检查；主代理亲自核对 diff、原始日志、源码状态、工具链和覆盖，符合最终源码的证据可复核采用，变化或缺口补跑。所有写入及生成步骤收敛后由唯一负责人完成最终完整验证。

按风险审查：小改动主代理检查，需要独立审查的常规改动用一个不同家族审查者，并发、取消、播放、安全或公共接口等高风险改动用两模型 panel。合格 panel 直接作为本轮最终本地审查；复审聚焦修复与相关回归并保留全部历史异议。PR 阶段由云端审查与 pr-review-loop 接续，用户要求或风险扩大才重开本地 panel。

同一工作树并行写入要求范围互斥、不碰生成物与锁文件、不提交且无产出依赖；共享改动及生成步骤汇合后处理。需要执行命令的委派走 `delegate_task`，自带子代理只做不执行命令的只读探索，被拒权限立即停下汇报。任务用 async 完成事件；追加修复和复审也新建 delegate_task，逐轮保存 taskId 与幂等请求 ID。

失败换路沿用原路由和每子任务最多 4 次限制；无新消息先检查实际编译、锁与队列，取消后确认旧写者及构建子进程退出才续跑。交接携带完成步骤、源码改动、失败日志、后台任务及剩余验证。共享缓存区分已确认池耗尽与单入口故障，冷却到期只允许一个恢复探测，不永久封禁。

E2E/截图委派原文携带项目约束、现有入口和首次开始时间；时限与崩溃计数跨代理、重试、构建策略和基线工作树累计。Musiver 使用自身 15 分钟/两次相同崩溃停止规则，其他项目按各自规则；只释放本任务拥有的设备与进程，失败给出原因和替代证据。机器资源限额读取设备配置。
硬性规则：永远不用快速模式；GPT-6 Astra、Fable 5.1、Kimi K3 只在用户点名时使用；不主动调用 GLM 5.3 非 flash 版、Composer 2.5、Kimi Code、MiniMax，以及 opencode 上 `opencode-go/` 以外的模型。

- `references/models.md`：额度池、模型画像、任务路由表、同模型的备用入口，标有调研日期；末尾的「更新来源与标准」说明去哪里查新数据、按什么标准改，模型更新时只改这个文件
- [scripts/quota-state.mjs](skills/godbobo/general/t3-orchestrator/scripts/quota-state.mjs)：用户级跨线程失败缓存，互斥与原子写入；已确认额度池才联动，入口故障不误封同族，已知重置优先、未知初始 30 分钟，到期仅授权一次轻量恢复探测，正式派活须 recovery 为 false；探测 token 在失败时整体收回，过期结果不会误清未验证故障，退出码区分未应用
- [scripts/quota-state.test.mjs](skills/godbobo/general/t3-orchestrator/scripts/quota-state.test.mjs)：临时目录内多进程并发更新、唯一探测、过期恢复、池隔离、已知重置保留、延迟成功/失败、失败后 token 整体失效、CLI 未应用退出码与损坏缓存测试
- [references/quota-state.md](skills/godbobo/general/t3-orchestrator/references/quota-state.md)：缓存命令、池确认、恢复租约与锁故障处理
- `scripts/t3-quota.mjs`：用本机凭证直查各 harness 额度，覆盖 Codex（ChatGPT OAuth）、Cursor（Cursor.app 登录态：总额/API/Grok 周）、Devin（CLI credentials：日/周）、opencode go、GLM（智谱/z.ai）和 Factory Droid（查询方法参考 [steipete/CodexBar](https://github.com/steipete/CodexBar)），不依赖 T3 缓存，不输出任何密钥

```bash
node ~/.agents/skills/t3-orchestrator/scripts/t3-quota.mjs
```

GLM 的 API Key 依次从环境变量（`BIGMODEL_API_KEY`、`ZHIPU_API_KEY`、`GLM_API_KEY`、`Z_AI_API_KEY`）、`~/.claude/settings.json`（base URL 指向智谱或 z.ai 时）和 CodexBar 配置中读取。Droid 需要 Factory API Key（在 [app.factory.ai/settings/api-keys](https://app.factory.ai/settings/api-keys) 创建），放在环境变量 `FACTORY_API_KEY` 或 `~/.factory/.env` 中（文件里写 `FACTORY_API_KEY=...` 或只写密钥本身都可以）。

详见 [skills/godbobo/general/t3-orchestrator/SKILL.md](skills/godbobo/general/t3-orchestrator/SKILL.md)。

### t3-code

本机 T3 Code 运行状态的内部参考：`~/.t3/userdata/statev2.sqlite` 的表布局（v2 投影表为权威、v1 已停写）、`turn_items` 各类型 payload 结构与输出留存限制、常用会话分析查询，以及编排工具的机制事实（ACP 兜底语法、schedule_task 格式）与已观察到的平台坑。分析 T3 会话、复盘、排查编排问题时加载；派活的策略与操作流程是 t3-orchestrator 的职责。专用技能。

- `scripts/t3-worktree-gc.mjs`：回收 `~/.t3/worktrees/` 下「其他已终结线程」留下的工作树——核对 T3 线程绑定（settled/archived/deleted；委派子线程按 subagents 表关联行终态判定）、活跃 run（只统计未终结线程，已终结线程的 running 行按投影滞留放行）、工作树脏（`-uall` 抗 untracked 配置）、ignored 珍贵文件（凭据类逐文件检出，`*.properties` 命中再过内容豁免——整文件键都在 `sdk.dir`/`flutter.*` 等工具链白名单即放行；嵌套 git 仓库与子模块这类不可评估目录一律不动，产物/依赖目录良性段内的除外）、索引标记（assume-unchanged/skip-worktree）、HEAD 改动已在远端（祖先 / `git cherry` 逐提交 patch 等价 / 整支 diff patch-id 对上游提交——覆盖 squash 合并；先 `fetch --prune` 刷新跟踪引用，dry-run 同样执行、需联网且更新本地 refs/remotes，禁交互凭据提示；远端不可达不删）、进程占用（绑定线程全终结时占用判为残留进程降级放行；零绑定目录的占用仍阻断）后才允许删除，删除前再复查一遍全部条件；整树只占位文件的残留目录（`.keep`/`.DS_Store` 等）同样过检查后删除。删除走 rmSync + `worktree prune`（无 spawn 超时），成功后 `git branch -d`（改动已验证在远端的分支拒删时改 `-D`）兜底删本地分支，删空的分组目录一并 rmdir；有删除失败时退出码非 0。默认 dry-run，`--apply` 才真删；`--root` 与 `T3CODE_HOME` 可换扫描根与数据库；汇总行附「在用工作树」计数
- `scripts/t3-worktree-gc.test.mjs`：自包含夹具测试，临时目录造 git 仓库、假 origin 与最小 statev2.sqlite，覆盖每条 skip 原因，不碰真实 `~/.t3`

```bash
node ~/.agents/skills/t3-code/scripts/t3-worktree-gc.mjs            # dry-run
node ~/.agents/skills/t3-code/scripts/t3-worktree-gc.mjs --apply    # 真正删除
node ~/.agents/skills/t3-code/scripts/t3-worktree-gc.test.mjs       # 跑夹具测试
```

详见 [skills/godbobo/specialized/t3-code/SKILL.md](skills/godbobo/specialized/t3-code/SKILL.md)。

### html-preview

通过 HTML Preview REST API 上传、管理 HTML/ZIP 预览页：生成公开分享链接、更新元数据与有效期、替换内容、回收站与收藏管理。API Key 认证，配置持久化在 `~/.config/html-preview/config.yaml`。专用技能，配合同名服务使用。

来源：[gitbobobo/html-preview — skills/html-preview](https://github.com/gitbobobo/html-preview/tree/main/skills/html-preview)

详见 [skills/godbobo/specialized/html-preview/SKILL.md](skills/godbobo/specialized/html-preview/SKILL.md)。

### fast-ship

通过 Fast Ship REST API 创建、更新与查询 Issue：项目管理（含项目级独立 PR 访问 Token）、打标、工作流状态推进、Issue 关联 PR 的 attach/sync/detach、人机协作区（共识/总结）读写、推荐任务读写、项目截图库（按界面聚合、版本全量保留）、发货后钩子只读与项目日志上传。API Key 认证，配置持久化在 `~/.config/fast-ship/config.yaml`；所有请求走 `scripts/fast-ship-api.mjs`，Key 不出现在命令行，请求体、参数与错误码以 `references/api.md` 为准。专用技能，配合同名服务使用。

来源：[gitbobobo/fast_ship — skills/fast-ship](https://github.com/gitbobobo/fast_ship/tree/main/skills/fast-ship)

详见 [skills/godbobo/specialized/fast-ship/SKILL.md](skills/godbobo/specialized/fast-ship/SKILL.md)。

### uiv

把截图、录屏等图片和视频上传到 UIV，拿到公开链接和可直接粘贴的 Markdown，用于在 PR 描述、评论、issue 中展示端到端验证成果；另附短演示按状态截图拼 GIF 的规则与自检方法。通过 `UIV_URL`（公网地址）与 `UIV_TOKEN` 环境变量配置，当前 shell 没有时从 `~/.agents/env/uiv.sh` 加载。专用技能，配合同名自托管服务使用。

来源：[gitbobobo/uiv — skills/uiv](https://github.com/gitbobobo/uiv/tree/main/skills/uiv)

详见 [skills/godbobo/specialized/uiv/SKILL.md](skills/godbobo/specialized/uiv/SKILL.md)。

## 分叉技能

### blast-radius

在改动发布前找出它会在别处破坏什么：列出调用方不是目标，目标是 grep 看不到的破坏。先找出「这个改动安全所依赖的那一个事实」，按 0-5 级证据阶梯（从「我说了算」到「在运行中的应用里复现」）把它推到尽可能高，再用真实代码验证。大改动可派多个不同模型的只读子代理并行提问再合并答案（见 code-review-panel）。

来源：[cursor/plugins — pstack/skills/blast-radius](https://github.com/cursor/plugins/tree/main/pstack/skills/blast-radius)（MIT）。已改造：原文对 `how`/`why`/`arena`/`unslop` 四个技能的引用全部内联化，可独立安装。

详见 [skills/forks/blast-radius/SKILL.md](skills/forks/blast-radius/SKILL.md)。

### code-review-panel

高风险改动用两个不同家族的只读审查者检查同一份 diff、prompt 与 rubric；小改动主代理检查，需独立审查的常规改动用单个不同家族审查者。主代理按 Act on / Consider / Noted / Dismissed 归并裁决。panel 即该轮最终本地审查，审查者默认读已有证据，重检查交给唯一验证负责人安排；新一轮聚焦修复、变更范围与相关回归，完整携带历史异议。PR 后走云端跟进，仅用户要求或风险实质扩大才重开本地 panel。

来源：[cursor/plugins — pstack/skills/interrogate](https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate)（MIT），改名改造而来：审查者模型来源从 Cursor 的 `pstack-models.mdc` 配置换成 `t3-orchestrator` 的路由表（高风险用两个不同家族），派发走 `delegate_task` 或 harness 自带只读子代理，换路沿用 t3-orchestrator 的规则；并新增与 `pr-review-loop` 的分工一节（本技能只管推送之前，PR 阶段的云端 bot 意见走 pr-review-loop）。

详见 [skills/forks/code-review-panel/SKILL.md](skills/forks/code-review-panel/SKILL.md)。

### create-verification-skill

生成一个项目本地的验证技能：通过访谈仓库（而非用户）弄清应用的表面、启动、驱动方式与可采集证据，产出带 Launch/Doctor/Drive/Evidence/Cleanup 五段规格的 SKILL.md 和一份 feature map（每个用户可见功能一个文件，固定四个 H2）。生成后必须按自己的说明完整跑一遍才交付——没跑过的叫草稿。仅限用户主动调用。

来源：[cursor/plugins — pstack/skills/create-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/create-verification-skill)（MIT）。已改造：生成物落点从硬编码 `.cursor/skills/` 改为跟随目标仓库自己的 agent 技能目录约定（本机 `.agents/skills/`）。fast_ship 实战检验后补强：启动命令要求记录的 PID 拥有端口（绕过 `go run`/`make dev` 包装层）、dev 命令不可隔离时自建隔离变体、截图等渲染完成而非仅等导航、Drive 段落建议技能自带薄驱动 CLI。

详见 [skills/forks/create-verification-skill/SKILL.md](skills/forks/create-verification-skill/SKILL.md)。

### diagnosing-bugs

疑难 bug 与性能回退的诊断纪律，六个阶段：先建一条能对「这个 bug」变红的紧反馈回路（这是技能本体，其余都是机械步骤），再复现最小化、列出 3-5 个可证伪假设、按假设逐个插桩、在对的缝上先写回归测试再修，最后清理。附带 HITL 回路脚本模板。已补一节：仓库级的放弃规则只管端到端截图采集，不管 Phase 1 的回路构建。

来源：[mattpocock/skills — skills/engineering/diagnosing-bugs](https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs)

详见 [skills/forks/diagnosing-bugs/SKILL.md](skills/forks/diagnosing-bugs/SKILL.md)。

### frontend-design

前端界面设计指导：以设计工作室负责人的视角做 UI，先基于设计简报头脑风暴出一套设计 token（色板、字体、布局、原则）并用 ASCII 线框图比较方案，对照 AI 模板化的五类默认审美自审后再动手写代码。强调排版承载个性、结构编码信息、非用户触发的动效与文案保持克制，追求「不像模板」的独特视觉方向。

来源：[anthropics/skills — skills/frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design)（Apache-2.0，含 LICENSE.txt）

详见 [skills/forks/frontend-design/SKILL.md](skills/forks/frontend-design/SKILL.md)。

### grilling

就一个计划、决策或想法对用户连环追问，直到达成共同理解。把决策组织成设计树，按轮次推进：每轮只问前置问题已就绪的「前沿」问题，编号并附上推荐答案，等用户回答后再计算下一轮。事实自己查（派子代理），决策交给用户。

来源：[mattpocock/skills — skills/productivity/grilling](https://github.com/mattpocock/skills/tree/main/skills/productivity/grilling)

详见 [skills/forks/grilling/SKILL.md](skills/forks/grilling/SKILL.md)。

### handoff

把当前会话压缩成交接文档，保存到系统临时目录，供新会话接着干。不重复引用已有产物（规格、计划、ADR、issue、提交、diff），敏感信息先脱敏；可传入参数说明下一会话的用途，据此裁剪内容。仅限用户手动调用。

来源：[mattpocock/skills — skills/productivity/handoff](https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff)

详见 [skills/forks/handoff/SKILL.md](skills/forks/handoff/SKILL.md)。

### maintain-verification-skill

create-verification-skill 生成的验证技能的维护回路：每个 feature 文件派一个只读子代理从源码核查，再由主代理一次长会话把每个功能实际驱动一遍，全程持三条不变量（驱动前先 doctor、已采证据不被清理吃掉、驱动不留残余）。结局只有 clean / changed / blocked 三种，changed 产出一个 PR 的已验证修正。仅限用户主动调用。

来源：[cursor/plugins — pstack/skills/maintain-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/maintain-verification-skill)（MIT）。已改造：定位路径从 `.cursor/skills/verify-*/` 改为跟随目标仓库的技能目录约定。

详见 [skills/forks/maintain-verification-skill/SKILL.md](skills/forks/maintain-verification-skill/SKILL.md)。

### retro

复盘一次编码会话，向 agent 的工作环境提改进建议：只提议不落地，用户采纳后才改。读指定会话的原始记录（默认当前会话，可查本机会话日志），按七类问题找候选并按严重度排序——导航指引、自动化检查（机械性错误优先落成 lint/pre-commit/CI 等确定性检查，而不是写规则；仓库缺少守卫本身也算发现）、编码标准（判断力层面的规则进 `CODING_STANDARDS.md` 供评审环节读）、臃肿的 AGENTS.md 精简外移、工具调用成本、steering 文件中的无效指令、信息获取缺口。仅限用户主动调用。

依赖同仓库的 writing-for-agents（已一并导入；单独安装本技能时需一并安装它）。`CODING_STANDARDS.md` 规则需要有复审流程读取才能生效，否则需人工接手。

另吸收了 [cursor/plugins — pstack/skills/correct](https://github.com/cursor/plugins/tree/main/pstack/skills/correct) 的两条主张（不单独导入 correct，触发词与 retro 相近）：修复层级阶梯（架构 > 类型 > 报错能指名替代物的 lint/CI > 行为测试 > 文档和 agent 规则垫底），以及「新检查必须在一条真实历史错误上证明会变红」加规则↔强制者表（规则无人强制时再犯要在同次改动里提到更高层级，错误不可能再发生就删规则）。

来源：[mattpocock/skills — skills/engineering/retro](https://github.com/mattpocock/skills/tree/main/skills/engineering/retro)

详见 [skills/forks/retro/SKILL.md](skills/forks/retro/SKILL.md)。

### writing-for-agents

给 agent 写文档的通用参考，适用于技能、`AGENTS.md`/`CLAUDE.md` 以及被指针引用的 docs：context pointer 的措辞（leading word 前置、一个分支一个触发词）、context load 与 cognitive load 两种开销、信息层级（文内步骤 / 文内参考 / 披露式参考）、完成标准的清晰度与强度、按序列或调用方式拆分、leading words 与删减原则。写技能时另读同目录 `SKILL-MECHANICS.md`（frontmatter、模型调用 vs 用户调用、router 技能）。

来源：[mattpocock/skills — skills/productivity/writing-for-agents](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents)

详见 [skills/forks/writing-for-agents/SKILL.md](skills/forks/writing-for-agents/SKILL.md)。

## 工具脚本

### check

仓库一致性检查：AGENTS.md 与 CLAUDE.md 正文一致、每个 SKILL.md 有合法 frontmatter（name 与目录名一致）且 README 有对应小节、分叉技能注明来源、`scripts/` 工具已登记、带 `disable-model-invocation` 的技能在 README 写明「仅限用户主动调用」。改动技能或 README 后运行。

```bash
node scripts/check.mjs
```

详见 [scripts/check.mjs](scripts/check.mjs)。

### patch-cursor-cli-acp-retry

为 Cursor CLI 的 ACP 模式开启 `enableAgentRetries`。交互式 CLI 会对瞬时网络错误自动重试，但 ACP 路径默认未传入该开关；本脚本在确认结构匹配后向 ACP 的 run options 插入该开关，结构变化或不适用时拒绝机械替换并给出明确原因。支持 Windows 与 Unix，写入成功后默认清理 Node compile cache 使补丁立即生效。

```bash
./scripts/patch-cursor-cli-acp-retry.py           # 补丁当前激活版本
./scripts/patch-cursor-cli-acp-retry.py --status  # 仅检查
./scripts/patch-cursor-cli-acp-retry.py --dry-run
./scripts/patch-cursor-cli-acp-retry.py --all
./scripts/patch-cursor-cli-acp-retry.py --version 2026.07.23-e383d2b
```

详见 [scripts/patch-cursor-cli-acp-retry.py](scripts/patch-cursor-cli-acp-retry.py)。
