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

规范的本地提交工作流。确保每次提交都可审计、相关且工作目录干净。

详见 [skills/godbobo/general/git-commit/SKILL.md](skills/godbobo/general/git-commit/SKILL.md)。

### git-sync

同步 git 远程并解决冲突，确保本地和远程保持一致。优先通过 rebase 保持线性历史，禁止直接丢弃提交内容，必须根据提交时间理解修改意图。

详见 [skills/godbobo/general/git-sync/SKILL.md](skills/godbobo/general/git-sync/SKILL.md)。

### plain-plan

生成用户向、简洁的实现计划：少术语、无代码库类名，用人话说明会做成什么样，便于不写代码的人通读与拍板。文字计划结束后主动询问是否需要网页版；用户同意后再生成有教育性的图文网页讲解（非文字计划的照搬），必要时通过 html-preview 发布预览链接。

详见 [skills/godbobo/general/plain-plan/SKILL.md](skills/godbobo/general/plain-plan/SKILL.md)。

### pr-review-loop

PR 推送并请求复审后，由 agent 自己等待审查 bot（Codex、Code Bot、Devin 等）和 CI 在最新提交上回应，处理新意见后再次请求复审，直到收敛。附带的等待脚本只打印未读意见，并识别长时间无响应的审查者。每条意见下面附有对应的回复命令（行内意见回复到所在线程，其余发新的顶层评论）。agent 只发新评论，不修改或删除任何已有评论：Code Bot 和 agent 共用同一个 GitHub 账号，改评论会覆盖审查结论。

使用方式：在项目 PR 模板的「审查意见处理」中加入下面这一行，agent 按模板完成待办时就会进入循环：

```markdown
- [ ] 请求复审后按 `$pr-review-loop` 自动等待并处理新意见，直到收敛（规则见该 skill，不需要用户转达）
```

对话中断后恢复时，发 `$pr-review-loop 继续（加 --reset）`。

详见 [skills/godbobo/general/pr-review-loop/SKILL.md](skills/godbobo/general/pr-review-loop/SKILL.md)。

### t3-orchestrator

T3 Code 多 harness 编排，仅限用户主动调用（在 T3 Code 线程里发 `$t3-orchestrator`）。调用后主代理按任务难度和各 harness 额度，通过 `t3-code` MCP 的 `delegate_task` 把活派给合适的子代理模型，再由主代理验收。审查交给 GPT-6.1 Sol 或 Grok 4.7。低难度任务优先用额度充足的 `glm-5.3-flash`、DeepSeek V4.1 Flash、GPT-6 Luna。子代理遇到限流、额度用尽或服务过载时，主代理按错误原文分类，先换同模型的其他入口，再换同档位或降档模型，读取旧子线程的进度和工作区 diff 后接着做，最后汇报换路情况。服务过载不在原入口重试；开始后 1 分钟内就失败、没调用过工具的，按配置问题处理。Factory Droid 在 [Factory-AI/factory#9](https://github.com/Factory-AI/factory/issues/9) 修复前暂停使用，路由表和备用入口里已移除。主代理自己中断仍由用户处理。派端到端验证或截图任务时，主代理要把项目 AGENTS.md 里的端到端约束原文转给子代理，不得猜测环境事实。

同一工作树可以并行跑多个写文件的子代理，条件是改动范围互不重叠、都不碰生成物和锁文件、都不提交，且彼此不依赖对方的产出；生成器、锁文件和全仓库测试由主代理在汇合后统一处理。需要执行命令的工作一律走 `delegate_task`，harness 自带的子代理只做不执行命令的只读探索，因为它在后台运行时 shell 和写文件会被自动拒绝。子代理被拒绝权限时要立即停下汇报，不得绕过或在无法验证的情况下继续改。

验收时，小问题用 `t3_thread_send` 发回原子线程，上下文还在。这样追加的 run 结束时不会触发完成通知，所以主代理发完必须在同一轮里用 `t3_thread_wait` 等它结束，不能结束本轮干等唤醒。修复量大的改为重新 `delegate_task` 一个 async 任务。

硬性规则：永远不用快速模式；GPT-6 Astra、Fable 5.1、Kimi K3 只在用户点名时使用；不主动调用 GLM 5.3 非 flash 版、Composer 2.5、Kimi Code、MiniMax，以及 opencode 上 `opencode-go/` 以外的模型。

- `references/models.md`：额度池、模型画像、任务路由表、同模型的备用入口，标有调研日期；末尾的「更新来源与标准」说明去哪里查新数据、按什么标准改，模型更新时只改这个文件
- `scripts/t3-quota.mjs`：读取 `~/.t3/caches` 中的 provider 额度快照，并直接查询 GLM（智谱/z.ai）和 Factory Droid 的额度（查询方法参考 [steipete/CodexBar](https://github.com/steipete/CodexBar)），不输出任何密钥

```bash
node ~/.agents/skills/t3-orchestrator/scripts/t3-quota.mjs
```

GLM 的 API Key 依次从环境变量（`BIGMODEL_API_KEY`、`ZHIPU_API_KEY`、`GLM_API_KEY`、`Z_AI_API_KEY`）、`~/.claude/settings.json`（base URL 指向智谱或 z.ai 时）和 CodexBar 配置中读取。Droid 需要 Factory API Key（在 [app.factory.ai/settings/api-keys](https://app.factory.ai/settings/api-keys) 创建），放在环境变量 `FACTORY_API_KEY` 或 `~/.factory/.env` 中（文件里写 `FACTORY_API_KEY=...` 或只写密钥本身都可以）。

详见 [skills/godbobo/general/t3-orchestrator/SKILL.md](skills/godbobo/general/t3-orchestrator/SKILL.md)。

### relay-audit

分析近期 T3 Code 线程里人的介入、agent 跑过的命令和各仓库新增的坏模式，按仓库找出人在充当传话员、agent 在走捷径或重复造轮子的地方，提出改进建议，并复盘已采纳改进的效果。仅限用户主动调用（发 `$relay-audit`）。思路来自 Poteto（Lauren Tan）的演讲《上个月我往生产环境合了 2500 个 PR》，以及她和 Matt Pocock 的访谈：给 agent 验证能力（验证 CLI 加特性地图），收紧环境让错误写法写不出来，把外部信息接进 agent 的工作循环；代码库是 agent 的记忆，坏模式会像病毒一样被照抄，需要有人当园丁。

问题分七类：搬运信息、验证缺口、约束缺口、无效停顿、重复粘贴的长提示词、坏模式扩散、agent 重复造轮子（临时脚本、手搓超时、长时间 sleep、手动起服务）。改法按演讲里的五层顺序从强到弱选：代码库和架构 > 静态分析 > 规则、审查 bot、技能 > 风格指南和人工审查，每条建议都要说明为什么做不到更强的一层。每轮最多提 5 条新建议，每条都附证据、具体改法和可统计的指标；下一轮先用指标复盘已完成的改进，没降下来的标为无效并重新诊断。

技能默认只提建议，不改任何仓库。用户采纳后，需要改仓库文件的建议按 Fast Ship、GitHub、本地 markdown 的优先级**三选一**建问题（命中即止，不在多处重复建）；用户要求直接实施的条目则跳过建问题直接改。多久跑一次由 T3 Code 的定时任务决定，技能本身不关心调度。

- `scripts/collect.mjs`：只读打开 `~/.t3/userdata/statev2.sqlite`，跨项目汇总人类消息（排除子代理线程、自动消息、定时任务提示词和审计自己的线程），聚类重复消息、打标签、附上每条消息前 agent 的最后一句话；统计 agent 命令里的临时脚本、等待、手动起服务、编码保险、重建工作目录、反复执行的命令，以及按原因聚类的失败命令；对每个仓库的默认分支做只读 `git diff`，统计新增的类型逃逸、lint 豁免、临时方案注释、跳过的测试和吞掉的错误；列出 AGENTS.md、PR 模板、CI、lint 配置、仓库内技能和特性地图；全部脱敏，并按消息、命令、代码库三种指标计算 ledger 中已采纳条目的变化。另有 `--count <正则>`、`--count-command <正则>` 统计频率，`--thread <ID 前缀>` 读单个线程。T3 数据库结构变化时直接报错退出
- `references/signals.md`：五层落点顺序，七类问题的识别特征、改法、指标和排序规则

几条度量口径容易踩坑，脚本里已经处理：

- **命令只能统计到 T3 的留存下界。** T3 切库时没有迁移 `command_execution`，更早的命令不可恢复。基线整段早于下界时报「不可用」而不是 0 次（报 0 会被读成"这个行为是新出现的"），速率的分母用与下界取交集后的实际区间。每轮在 `rollups/<时间>.json` 存一份聚合，让下一轮即便拿不到数据库基线也能做纵向对比。
- **坏模式用窗口两端的净 diff，并按每百提交归一化。** 逐提交累加会把同一行的反复修改重复计数、把加了又回滚的行也算进来；只看每天则会把"这期提交多"误读成"坏模式扩散"。诊断时先看每百提交那一列。`吞掉错误` 不含 Swift 的 `try?`（teardown、StoreKit 里是惯用法），它单列为参考项；采集器自身的源码不参与扫描，因为它按定义包含每一个 pattern 的字面量。
- **命令失败按 `status` 判定，不按 `exitCode`。** 只有约 5% 的记录带 `exitCode`，用它判定会漏掉近一半失败；同时搜索工具的 exit 1 是"没匹配到"而非失败，单独计数。摘要里有「失败命令」小节，按原因聚类并附报错行——超时、shell 引用写错、工作树约定不一致都在这里现形，是绕路最直接的证据。
- **聚类键先把 shell 外壳剥到不动为止。** 不剥的话 Windows 上的键全是 `powershell -NoProfile -Command` 和 `cd /d <工作树>`，真正执行了什么反而看不见。每个类别和每条反复命令都同时报次数和**线程数**：散布在很多线程才是系统性摩擦，集中在一个线程多半是那次任务的特殊情况。

运行状态（ledger、摘要、报告、聚合快照、本地问题）保存在 `~/.local/state/relay-audit/`（可用 `RELAY_AUDIT_HOME` 覆盖），不进任何仓库。`rollups/` 是命令类指标唯一的历史来源，不要删。需要 Node 22.5 以上（使用内置 `node:sqlite`）。

详见 [skills/godbobo/general/relay-audit/SKILL.md](skills/godbobo/general/relay-audit/SKILL.md)。

### html-preview

通过 HTML Preview REST API 上传、管理 HTML/ZIP 预览页：生成公开分享链接、更新元数据与有效期、替换内容、回收站与收藏管理。API Key 认证，配置持久化在 `~/.config/html-preview/config.yaml`。专用技能，配合同名服务使用。

来源：[gitbobobo/html-preview — skills/html-preview](https://github.com/gitbobobo/html-preview/tree/main/skills/html-preview)

详见 [skills/godbobo/specialized/html-preview/SKILL.md](skills/godbobo/specialized/html-preview/SKILL.md)。

### fast-ship

通过 Fast Ship REST API 创建、更新与查询 Issue：项目管理、打标、工作流状态推进、人机协作区（共识/总结）读写、推荐任务读写、发货后钩子只读与项目日志上传。API Key 认证，配置持久化在 `~/.config/fast-ship/config.yaml`；所有请求走 `scripts/fast-ship-api.mjs`，Key 不出现在命令行，请求体、参数与错误码以 `references/api.md` 为准。专用技能，配合同名服务使用。

来源：[gitbobobo/fast_ship — skills/fast-ship](https://github.com/gitbobobo/fast_ship/tree/main/skills/fast-ship)

详见 [skills/godbobo/specialized/fast-ship/SKILL.md](skills/godbobo/specialized/fast-ship/SKILL.md)。

### uiv

把截图、录屏等图片和视频上传到 UIV，拿到公开链接和可直接粘贴的 Markdown，用于在 PR 描述、评论、issue 中展示端到端验证成果；另附短演示按状态截图拼 GIF 的规则与自检方法。通过 `UIV_URL`（公网地址）与 `UIV_TOKEN` 环境变量配置，当前 shell 没有时从 `~/.agents/env/uiv.sh` 加载。专用技能，配合同名自托管服务使用。

来源：[gitbobobo/uiv — skills/uiv](https://github.com/gitbobobo/uiv/tree/main/skills/uiv)

详见 [skills/godbobo/specialized/uiv/SKILL.md](skills/godbobo/specialized/uiv/SKILL.md)。

## 分叉技能

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

### thermo-nuclear-code-quality-review

极严格的代码可维护性评审：不止挑局部清理点，主动找「code judo」式重构，让整段分支、辅助层、条件判断直接消失。硬性红线包括文件被推过 1k 行、在无关流程里插特判分支、薄封装与多余 cast、逻辑放错层等。另用 Fowler 的 12 条 smell 作为带名字的启发式（非自动 blocker）。行为正确不足以通过评审。仅限用户手动调用。

来源：[cursor/plugins — cursor-team-kit/skills/thermo-nuclear-code-quality-review](https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review)。Fowler smell 词表改编自 [mattpocock/skills — code-review](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review)。

详见 [skills/forks/thermo-nuclear-code-quality-review/SKILL.md](skills/forks/thermo-nuclear-code-quality-review/SKILL.md)。

## 工具脚本

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
