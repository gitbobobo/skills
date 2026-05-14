# OpenAI Codex CLI 自定义命令调研

> 调研日期：2026-05-14
> 目标：了解 OpenAI Codex CLI 如何添加自定义命令，并与 Claude Code 进行对比

---

## 概述

Codex CLI 提供了 **三种扩展机制**来实现自定义命令，其中一种已废弃：

| 机制 | 状态 | 调用方式 |
|------|------|---------|
| **Skills（技能）** | 当前推荐 | `$skill-name` 或隐式匹配 |
| **Custom Prompts（自定义提示）** | 已废弃 | `/prompts:<name>` |
| **Built-in Slash Commands** | 不可扩展 | `/command` |

**关键点：Codex CLI 不允许用户自定义 `/slash-commands`**，斜杠命令菜单仅限内置命令。自定义工作流通过 Skills 系统实现。

---

## 1. Skills（技能系统）— 推荐方式

### 1.1 目录结构

```
my-skill/
├── SKILL.md              # 必须：指令 + YAML frontmatter 元数据
├── scripts/              # 可选：可执行脚本
├── references/           # 可选：参考文档
├── assets/               # 可选：模板、资源文件
└── agents/
    └── openai.yaml       # 可选：UI 元数据、策略、工具依赖声明
```

### 1.2 SKILL.md 格式

```markdown
---
name: commit
description: Stage and commit changes in semantic groups. Use when the user wants to commit, organize commits, or clean up a branch before pushing.
---

1. Do not run `git add .`. Stage files in logical groups by purpose.
2. Group into separate commits: feat -> test -> docs -> refactor -> chore.
3. Write concise commit messages that match the change scope.
4. Keep each commit focused and reviewable.
```

- **frontmatter**：`name`（技能名称）和 `description`（描述，用于自动匹配）
- **正文**：具体的执行指令，作为系统提示注入

### 1.3 agents/openai.yaml（可选元数据）

```yaml
interface:
  display_name: "Commit Organizer"
  short_description: "Smart commit workflow"
  icon_small: "./assets/small-logo.svg"
  icon_large: "./assets/large-logo.png"
  brand_color: "#3B82F6"
  default_prompt: "Optional surrounding prompt"

policy:
  allow_implicit_invocation: false  # 是否允许自动匹配触发

dependencies:
  tools:
    - type: "mcp"
      value: "openaiDeveloperDocs"
      description: "OpenAI Docs MCP server"
      transport: "streamable_http"
      url: "https://developers.openai.com/mcp"
```

**核心能力：**
- 声明 MCP 工具依赖（Codex 自动安装）
- 控制是否允许隐式调用
- 定义 UI 展示信息（名称、图标、颜色）

### 1.4 Skills 存放位置（扫描优先级）

| 范围 | 路径 | 用途 |
|------|------|------|
| 项目目录 | `$CWD/.agents/skills` | 当前目录级别的技能 |
| 仓库根目录 | `$REPO_ROOT/.agents/skills` | 团队共享的仓库级技能 |
| 用户目录 | `$HOME/.agents/skills` | 个人全局技能 |
| 管理员目录 | `/etc/codex/skills` | 机器级共享技能 |
| 系统内置 | Codex 内部 | OpenAI 官方内置技能 |

### 1.5 Skills 配置与禁用

在 `~/.codex/config.toml` 中：

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

### 1.6 调用方式

- **显式调用**：在对话中输入 `$skill-name`
- **隐式调用**：当用户任务匹配技能描述时，Codex 自动选择并加载
- **渐进式加载**：初始仅加载 name + description，选中后才加载完整 SKILL.md

---

## 2. Custom Prompts（已废弃）

### 2.1 原始机制

在 `~/.codex/prompts/` 目录下放置 Markdown 文件：

```markdown
---
description: Prep a branch, commit, and open a draft PR
argument-hint: [FILES=<paths>] [PR_TITLE="<title>"]
---

Create a branch named `dev/<feature_name>` for this work.
If files are specified, stage them first: $FILES.
Commit the staged changes with a clear message.
Open a draft PR on the same branch.
```

### 2.2 支持的占位符

| 占位符 | 含义 |
|--------|------|
| `$1` ~ `$9` | 位置参数 |
| `$ARGUMENTS` | 所有参数 |
| `$FILE`, `$TICKET_ID` | 命名参数 |
| `$$` | 转义的 `$` 字符 |

### 2.3 调用方式

```
/prompts:draftpr FILES="src/main.ts" PR_TITLE="Add feature"
```

### 2.4 废弃状态

官方文档明确标注 "Deprecated. Use skills for reusable prompts."。GitHub Issues 中有多个用户反馈自定义提示不再出现（#15941）。

---

## 3. 与 Claude Code 的对比

| 特性 | OpenAI Codex CLI | Claude Code |
|------|-----------------|-------------|
| **自定义命令机制** | Skills（`.agents/skills/`） | Skills（`.claude/skills/`） |
| **调用语法** | `$skill-name` 或隐式 | `/skill-name` |
| **用户自定义斜杠命令** | 不支持（`/` 菜单仅限内置） | 支持（自定义命令出现在 `/` 菜单） |
| **项目指令文件** | `AGENTS.md` | `CLAUDE.md` |
| **配置格式** | TOML（`~/.codex/config.toml`） | JSON（`~/.claude/settings.json`） |
| **技能中的脚本支持** | 有（`scripts/` 目录） | 有限（主要基于提示） |
| **技能分发机制** | Plugin 系统（`/plugins` 市场） | 无正式分发机制 |
| **MCP 支持** | 有 | 有 |
| **生命周期 Hooks** | 有（`hooks.json` 或 `config.toml`） | 有（`settings.json`） |
| **子代理系统** | 有（`/agent`, `/fork`, `/side`） | 无原生子代理 |
| **管理员策略** | 有（`requirements.toml`） | 无正式管理配置层 |
| **内置斜杠命令数量** | ~30+ | ~10 |

### 核心架构差异

1. **调用模型不同**：Codex 用 `$` 前缀触发技能，Claude Code 用 `/` 前缀
2. **Skills 结构化程度**：Codex 的 Skills 更结构化（YAML frontmatter + 脚本目录 + 依赖声明），Claude Code 的 Skills 更轻量
3. **Plugin 生态**：Codex 有正式的插件市场和分发机制，Claude Code 目前没有
4. **配置复杂度**：Codex 的 TOML 配置有 200+ 键，Claude Code 的 JSON 配置更简洁
5. **隐式调用**：Codex 支持基于任务描述自动匹配技能，Claude Code 需要显式调用

---

## 4. 参考链接

- [Codex CLI GitHub 仓库](https://github.com/openai/codex)
- [官方文档 - Slash Commands](https://developers.openai.com/codex/cli/slash-commands)
- [官方文档 - Agent Skills](https://developers.openai.com/codex/skills)
- [官方文档 - Custom Prompts（已废弃）](https://developers.openai.com/codex/custom-prompts)
- [官方文档 - Configuration Reference](https://developers.openai.com/codex/config-reference)
- [GitHub Issue #913 - Add ability to add custom commands](https://github.com/openai/codex/issues/913)
- [GitHub Issue #7480 - Support for custom commands](https://github.com/openai/codex/issues/7480)
- [GitHub Issue #13893 - Add custom slash commands from SKILL.md](https://github.com/openai/codex/issues/13893)
- [社区配置集合 feiskyer/codex-settings](https://github.com/feiskyer/codex-settings)
