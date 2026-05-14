# Claude Code 自定义命令机制调研

> 调研时间：2026-05-14
> 调研目标：梳理 Claude Code 支持的所有自定义命令与扩展机制

---

## 目录

1. [概述](#概述)
2. [Custom Slash Commands（自定义斜杠命令）](#custom-slash-commands自定义斜杠命令)
3. [Skills（技能系统）](#skills技能系统)
4. [Hooks（生命周期钩子）](#hooks生命周期钩子)
5. [MCP Servers（外部工具扩展）](#mcp-servers外部工具扩展)
6. [CLAUDE.md（项目上下文文件）](#claudemd项目上下文文件)
7. [Settings（配置层级）](#settings配置层级)
8. [方案对比与推荐](#方案对比与推荐)

---

## 概述

Claude Code 提供了多种扩展机制来实现自定义命令行为，按推荐程度从高到低排列：

| 机制 | 用途 | 推荐程度 |
|------|------|----------|
| Skills | 结构化、可发现的扩展能力 | Anthropic 官方推荐 |
| Custom Slash Commands | 简单的 Markdown 模板命令 | 保留兼容，建议迁移到 Skills |
| Hooks | 生命周期事件拦截与自动化 | 辅助增强 |
| MCP Servers | 集成外部工具与服务 | 辅助增强 |
| CLAUDE.md | 项目级上下文注入 | 基础配置 |
| Settings | 全局/项目配置管理 | 基础配置 |

---

## Custom Slash Commands（自定义斜杠命令）

### 基本原理

在 `.claude/commands/` 目录下放置 Markdown 文件，文件名即成为命令名。用户在 Claude Code 中输入 `/命令名` 即可触发。

### 目录结构

```
.claude/commands/           # 项目级命令（随项目共享）
  build.md
  test.md
  deploy/
    staging.md              # 命名空间：/deploy:staging
    production.md           # 命名空间：/deploy:production

~/.claude/commands/         # 用户级命令（个人专用）
  review.md
```

### YAML Frontmatter 配置

```markdown
---
description: 运行项目构建流程
allowed-tools: Bash, Read, Write
argument-hint: "<target>"
model: claude-sonnet-4-6
---

请构建 $1 目标，执行以下步骤...
```

支持的 frontmatter 字段：

| 字段 | 说明 |
|------|------|
| `description` | 命令描述，在命令列表中显示 |
| `allowed-tools` | 限制命令可使用的工具列表 |
| `argument-hint` | 参数提示信息 |
| `model` | 指定使用的模型 |

### 动态参数

使用 `$1`、`$2` 等占位符接收用户传入的参数：

```markdown
请分析 $1 目录下的代码质量问题，重点关注 $2。
```

调用方式：`/review src/api security`

### Bash 命令执行

使用反引号 + `!` 前缀执行 bash 命令并将结果注入提示词：

```markdown
当前 Git 状态：
`!git status`

最近的提交记录：
`!git log --oneline -5`
```

### 文件引用

使用 `@` 前缀引用文件内容：

```markdown
请参考以下配置：
@package.json
@tsconfig.json
```

### 子目录命名空间

通过子目录组织命令，使用 `:` 分隔：

```
.claude/commands/
  deploy/
    staging.md        # /deploy:staging
    production.md     # /deploy:production
```

---

## Skills（技能系统）

> Anthropic 官方推荐的自定义命令机制，用于替代 Custom Slash Commands。

### 基本原理

Skills 是以 `SKILL.md` 为核心的结构化目录，放置在 `.claude/skills/`（项目级）或 `~/.claude/skills/`（个人级）下。Claude 会自动发现并根据上下文按需加载。

### 目录结构

```
.claude/skills/
  code-review/
    SKILL.md              # 技能定义（必需）
    scripts/
      analyze.sh          # 配套脚本
    templates/
      review-template.md  # 配套模板
    examples/
      sample-output.md    # 参考示例

~/.claude/skills/
  my-skill/
    SKILL.md              # 个人级技能
```

### SKILL.md 格式

```markdown
---
name: code-review
description: 对代码变更进行全面审查，包括安全性、性能和可维护性分析
---

## 指令

你是一个代码审查专家。请按照以下步骤进行审查：

1. 分析变更的文件列表
2. 检查安全漏洞（OWASP Top 10）
3. 评估性能影响
4. 检查代码风格一致性
5. 输出结构化审查报告

## 输出格式

请使用以下格式输出审查结果：

### 安全性
- [发现列表]

### 性能
- [发现列表]

### 建议
- [改进建议]
```

### YAML Frontmatter 要求

| 字段 | 要求 | 约束 |
|------|------|------|
| `name` | **必需** | 最大 64 字符，仅限小写字母、数字和连字符 |
| `description` | **必需** | 最大 1024 字符 |

### 三级渐进加载机制

Skills 设计了高效的加载策略，优化 Token 消耗：

```
Level 1: 元数据（~100 tokens）
  ├── name + description
  └── 始终加载，用于 Claude 判断是否需要激活

Level 2: 指令（< 5k tokens）
  ├── SKILL.md 主体内容
  └── 当 Skill 被触发时加载

Level 3: 资源（无限制）
  ├── 脚本、模板、示例等附加文件
  └── 按需加载，仅在 Claude 需要时读取
```

### 技能目录可包含的内容

- `SKILL.md` — 核心定义文件（必需）
- 脚本文件（`.sh`、`.py` 等）
- 模板文件（`.md`、`.txt` 等）
- 示例文件
- 其他 Claude 可在需要时读取的参考资源

### 与 Slash Commands 的对比

| 特性 | Slash Commands | Skills |
|------|---------------|--------|
| 触发方式 | 手动输入 `/命令` | 自动发现 + 手动触发 |
| 结构 | 单个 Markdown 文件 | 结构化目录 |
| 资源捆绑 | 不支持 | 支持脚本、模板等 |
| 加载优化 | 全量加载 | 三级渐进加载 |
| 官方推荐 | 保留兼容 | **推荐** |
| 发现性 | 命令列表 | 自动语义匹配 |

---

## Hooks（生命周期钩子）

### 基本原理

Hooks 允许在 Claude Code 的生命周期事件中执行自定义 shell 命令、HTTP 请求或其他处理程序。配置在 `settings.json` 中。

### 支持的事件类型

| 事件 | 触发时机 |
|------|----------|
| `SessionStart` | 会话启动 |
| `PreToolUse` | 工具调用前 |
| `PostToolUse` | 工具调用后 |
| `Stop` | Claude 停止响应时 |
| `Notification` | 发送通知时 |
| `SubagentStop` | 子代理停止时 |

共支持 30+ 个生命周期事件。

### 处理程序类型

| 类型 | 说明 |
|------|------|
| `command` | 执行 shell 命令 |
| `http` | 发送 HTTP 请求 |
| `mcp_tool` | 调用 MCP 工具 |
| `prompt` | 注入提示词 |
| `agent` | 启动子代理 |

### 配置示例

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python scripts/validate-command.py"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "python scripts/post-write-check.py"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "notify-send 'Claude Code' '任务已完成'"
          }
        ]
      }
    ]
  }
}
```

### 输入输出协议

**输入**：通过 stdin 传递 JSON 数据，包含事件上下文信息。

**输出**：

| 退出码 | 含义 |
|--------|------|
| `0` | 成功，继续正常流程 |
| `2` | 阻止当前操作 |

stdout 可返回 JSON 结构进行决策控制：

```json
{
  "decision": "block",
  "reason": "不允许在此环境中执行该操作"
}
```

支持的 decision 值：`allow`（允许）、`deny`（拒绝）、`ask`（询问用户）、`defer`（推迟）、`block`（阻止）。

### Matcher 匹配器

Matcher 用于筛选特定工具或条件，支持精确匹配和模式匹配：

```json
{
  "matcher": "Bash",
  "matcher": "Edit|Write",
  "matcher": "mcp__github__*"
}
```

---

## MCP Servers（外部工具扩展）

### 基本原理

MCP（Model Context Protocol）Servers 允许 Claude Code 集成外部工具和服务，扩展 Claude 的能力边界。

### 配置方式

**项目级配置** `.mcp.json`：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "database": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

**用户级配置** 在 `settings.json` 中：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

### 工具命名规则

MCP 工具在 Claude Code 中以 `mcp__<server>__<tool>` 格式出现：

```
mcp__github__create_issue
mcp__github__list_prs
mcp__database__query
mcp__filesystem__read_file
```

### 常用 MCP Server 示例

| Server | 功能 |
|--------|------|
| `@modelcontextprotocol/server-github` | GitHub 操作（Issue、PR） |
| `@modelcontextprotocol/server-postgres` | PostgreSQL 数据库操作 |
| `@modelcontextprotocol/server-filesystem` | 文件系统操作 |
| `@modelcontextprotocol/server-brave-search` | Brave 搜索集成 |

---

## CLAUDE.md（项目上下文文件）

### 基本原理

`CLAUDE.md` 是项目级的上下文文件，其内容会附加到每次用户请求中，为 Claude 提供项目背景信息。

### 位置与层级

```
CLAUDE.md                          # 项目根目录
.claude/CLAUDE.md                  # .claude 目录下
sub-project/CLAUDE.md              # 子项目目录下
~/.claude/CLAUDE.md                # 用户全局
```

### 创建方式

使用 `/init` 命令自动生成：

```
> /init
```

Claude 会分析项目结构并自动生成合适的 `CLAUDE.md`。

### 典型内容

```markdown
# 项目说明

这是一个 TypeScript 全栈项目，使用以下技术栈：
- 前端：React + Next.js
- 后端：Express + Prisma
- 数据库：PostgreSQL

# 开发规范

- 使用 pnpm 作为包管理器
- 代码风格遵循 Airbnb 规范
- 提交信息遵循 Conventional Commits 规范

# 常用命令

- `pnpm dev` — 启动开发服务器
- `pnpm test` — 运行测试
- `pnpm build` — 构建项目
```

---

## Settings（配置层级）

### 配置文件层级（从低到高优先级）

```
1. 内置默认值
   ↓
2. ~/.claude/settings.json          # 用户全局配置
   ↓
3. .claude/settings.json            # 项目共享配置
   ↓
4. .claude/settings.local.json      # 项目本地配置（不入版本控制）
```

高优先级配置覆盖低优先级的同名设置。

### 关键配置项

```json
{
  "permissions": {
    "allow": ["Bash(git *)", "Read", "Write"],
    "deny": ["Bash(rm -rf *)"]
  },
  "hooks": {
    "PreToolUse": []
  },
  "mcpServers": {},
  "env": {
    "CUSTOM_VAR": "value"
  }
}
```

### `.claude/settings.json` vs `.claude/settings.local.json`

| 文件 | 版本控制 | 用途 |
|------|----------|------|
| `settings.json` | 提交到 Git | 团队共享的项目配置 |
| `settings.local.json` | 加入 `.gitignore` | 个人本地配置，覆盖共享配置 |

---

## 方案对比与推荐

### 按使用场景推荐

| 场景 | 推荐方案 | 理由 |
|------|----------|------|
| 创建结构化、可复用的命令 | **Skills** | 官方推荐，渐进加载，资源捆绑 |
| 快速创建简单命令 | **Slash Commands** | 简单直接，单个 Markdown 文件 |
| 在工具调用前后执行检查 | **Hooks** | 生命周期拦截，自动化流程 |
| 集成外部服务 | **MCP Servers** | 标准协议，丰富的生态 |
| 为所有请求注入项目上下文 | **CLAUDE.md** | 零配置，自动生效 |
| 管理权限与环境 | **Settings** | 分层配置，灵活控制 |

### 迁移建议

如果你正在使用 Custom Slash Commands，建议逐步迁移到 Skills：

1. 将 `commands/xxx.md` 移动到 `skills/xxx/SKILL.md`
2. 添加规范的 YAML frontmatter（`name` 和 `description`）
3. 将相关脚本和模板放入技能目录
4. 利用三级加载机制优化 Token 消耗

---

## 参考资料

- [Claude Code Slash Commands 官方文档](https://code.claude.com/docs/en/agent-sdk/slash-commands)
- [Claude Agent Skills 官方文档](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Claude Code Hooks 官方文档](https://code.claude.com/docs/en/hooks)
- [Model Context Protocol 规范](https://modelcontextprotocol.io/)
