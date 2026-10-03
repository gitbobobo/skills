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

PR 推送并请求复审后，由 agent 自己等待审查 bot（Codex、Code Bot、Devin 等）和 CI 在最新提交上回应，处理新意见后再次请求复审，直到收敛。附带的等待脚本只打印未读意见，并识别长时间无响应的审查者。

使用方式：在项目 PR 模板的「审查意见处理」中加入下面这一行，agent 按模板完成待办时就会进入循环：

```markdown
- [ ] 请求复审后按 `$pr-review-loop` 自动等待并处理新意见，直到收敛（规则见该 skill，不需要用户转达）
```

对话中断后恢复时，发 `$pr-review-loop 继续（加 --reset）`。

详见 [skills/godbobo/general/pr-review-loop/SKILL.md](skills/godbobo/general/pr-review-loop/SKILL.md)。

### t3-orchestrator

T3 Code 多 harness 编排，仅限用户主动调用（在 T3 Code 线程里发 `$t3-orchestrator`）。调用后主代理按任务难度和各 harness 额度，通过 `t3-code` MCP 的 `delegate_task` 把活派给合适的子代理模型，再由主代理验收。审查交给 GPT-6.1 Sol 或 Grok 4.7。低难度任务优先用额度充足的 `glm-5.3-flash`、DeepSeek V4.1 Flash、GPT-6 Luna。子代理遇到限流、额度用尽或服务过载时，主代理按错误原文分类，先换同模型的其他入口，再换同档位或降档模型，读取旧子线程的进度和工作区 diff 后接着做，最后汇报换路情况。主代理自己中断仍由用户处理。

硬性规则：永远不用快速模式；GPT-6 Astra、Fable 5.1、Kimi K3 只在用户点名时使用；不主动调用 GLM 5.3 非 flash 版、Composer 2.5、Kimi Code、MiniMax，以及 opencode 上 `opencode-go/` 以外的模型。

- `references/models.md`：额度池、模型画像、任务路由表、同模型的备用入口，标有调研日期；末尾的「更新来源与标准」说明去哪里查新数据、按什么标准改，模型更新时只改这个文件
- `scripts/t3-quota.mjs`：读取 `~/.t3/caches` 中的 provider 额度快照，并直接查询 GLM（智谱/z.ai）和 Factory Droid 的额度（查询方法参考 [steipete/CodexBar](https://github.com/steipete/CodexBar)），不输出任何密钥

```bash
node ~/.agents/skills/t3-orchestrator/scripts/t3-quota.mjs
```

GLM 的 API Key 依次从环境变量（`BIGMODEL_API_KEY`、`ZHIPU_API_KEY`、`GLM_API_KEY`、`Z_AI_API_KEY`）、`~/.claude/settings.json`（base URL 指向智谱或 z.ai 时）和 CodexBar 配置中读取。Droid 需要 Factory API Key（在 [app.factory.ai/settings/api-keys](https://app.factory.ai/settings/api-keys) 创建），放在环境变量 `FACTORY_API_KEY` 或 `~/.factory/.env` 中（文件里写 `FACTORY_API_KEY=...` 或只写密钥本身都可以）。

详见 [skills/godbobo/general/t3-orchestrator/SKILL.md](skills/godbobo/general/t3-orchestrator/SKILL.md)。

### html-preview

通过 HTML Preview REST API 上传、管理 HTML/ZIP 预览页：生成公开分享链接、更新元数据与有效期、替换内容、回收站与收藏管理。API Key 认证，配置持久化在 `~/.config/html-preview/config.yaml`。专用技能，配合同名服务使用。

来源：[gitbobobo/html-preview — skills/html-preview](https://github.com/gitbobobo/html-preview/tree/main/skills/html-preview)

详见 [skills/godbobo/specialized/html-preview/SKILL.md](skills/godbobo/specialized/html-preview/SKILL.md)。

### fast-ship

通过 Fast Ship REST API 创建、更新与查询 Issue：项目管理、打标、工作流状态推进、人机协作区（共识/总结）读写、发货后钩子只读与项目日志上传。API Key 认证，配置持久化在 `~/.config/fast-ship/config.yaml`。专用技能，配合同名服务使用。

来源：[gitbobobo/fast_ship — skills/fast-ship](https://github.com/gitbobobo/fast_ship/tree/main/skills/fast-ship)

详见 [skills/godbobo/specialized/fast-ship/SKILL.md](skills/godbobo/specialized/fast-ship/SKILL.md)。

## 分叉技能

### frontend-design

前端界面设计指导：以小型工作室设计负责人的视角做 UI，先基于设计简报头脑风暴出一套设计 token（色板、字体、布局、签名元素）并用 ASCII 线框图比较方案，对照 AI 模板化的三种默认审美自审后再动手写代码。强调排版承载个性、结构编码信息、动效与文案保持克制，追求「不像模板」的独特视觉方向。

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

### unslop

去除文字中的 AI 写作痕迹并注入人味：按内容、语言、风格、沟通痕迹、废话、行话、平实表达七类共 31 条模式检测改写，改完自审「哪里一眼是 AI 写的」。

来源：[cursor/plugins — pstack/skills/unslop](https://github.com/cursor/plugins/tree/main/pstack/skills/unslop)

详见 [skills/forks/unslop/SKILL.md](skills/forks/unslop/SKILL.md)。

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
