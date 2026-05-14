# OpenCode 自定义命令机制调研

> 调研时间：2026-05-14
> 调研目标：梳理 OpenCode 支持的所有自定义命令与扩展机制

---

## 目录

1. [概述](#概述)
2. [自定义命令定义方式](#自定义命令定义方式)
3. [命令配置详解](#命令配置详解)
4. [提示词模板语法](#提示词模板语法)
5. [配置文件位置与优先级](#配置文件位置与优先级)
6. [代理（Agent）系统](#代理agent系统)
7. [插件（Plugin）系统](#插件plugin系统)
8. [MCP 服务器集成](#mcp-服务器集成)
9. [规则与指令（Rules & Instructions）](#规则与指令rules--instructions)
10. [方案对比与总结](#方案对比与总结)

---

## 概述

OpenCode 是一个开源 AI 编码代理，支持 TUI（终端用户界面）、桌面应用和 IDE 扩展。其自定义命令系统允许用户为重复性任务创建可复用的提示词模板，通过 `/command-name` 的方式在 TUI 中执行。

核心扩展机制：

| 机制 | 用途 | 复杂度 |
|------|------|--------|
| 自定义命令（Command） | 为重复任务定义提示词模板 | 低 |
| 代理（Agent） | 定义专用 AI 代理角色 | 中 |
| 插件（Plugin） | 扩展工具、钩子和集成 | 高 |
| MCP 服务器 | 集成外部工具与服务 | 高 |
| 规则/指令 | 项目级上下文和行为约束 | 低 |

---

## 自定义命令定义方式

OpenCode 提供两种方式定义自定义命令：

### 方式一：JSON 配置

在 `opencode.json` 或 `opencode.jsonc` 中使用 `command` 字段定义：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "command": {
    "test": {
      "template": "Run the full test suite with coverage report and show any failures.\nFocus on the failing tests and suggest fixes.",
      "description": "Run tests with coverage",
      "agent": "build",
      "model": "anthropic/claude-sonnet-4-5"
    },
    "component": {
      "template": "Create a new React component named $ARGUMENTS with TypeScript support.\nInclude proper typing and basic structure.",
      "description": "Create a new component"
    }
  }
}
```

JSON 配置中的 key 即为命令名（如 `test` → `/test`）。

### 方式二：Markdown 文件

在 `commands/` 目录下创建 `.md` 文件，文件名即为命令名。

创建 `.opencode/commands/test.md`：

```markdown
---
description: Run tests with coverage
agent: build
model: anthropic/claude-sonnet-4-5
---

Run the full test suite with coverage report and show any failures.

Focus on the failing tests and suggest fixes.
```

Markdown 文件结构：
- **Frontmatter**（YAML）：定义命令的元数据属性（description、agent、model 等）
- **Body**（正文）：命令的提示词模板内容

### 使用方式

在 TUI 中输入 `/` 后跟命令名称即可执行：

```
/test
/component Button
/create-file config.json src "{ \"key\": \"value\" }"
```

---

## 命令配置详解

每个自定义命令支持以下配置选项：

### Template（必需）

定义执行命令时发送给 LLM 的提示词内容。这是唯一必需的字段。

```json
{
  "command": {
    "test": {
      "template": "Run the full test suite with coverage report."
    }
  }
}
```

### Description（可选）

命令功能的简要描述，在 TUI 的命令列表中显示。

```json
{
  "command": {
    "test": {
      "description": "Run tests with coverage"
    }
  }
}
```

### Agent（可选）

指定执行此命令的代理。如果未指定，使用当前代理。

```json
{
  "command": {
    "review": {
      "agent": "plan"
    }
  }
}
```

如果是子代理，命令默认会触发子代理调用。可通过 `subtask: false` 禁用此行为。

### Subtask（可选）

布尔值，强制命令触发子代理调用。命令会作为子代理运行，不污染主上下文。

```json
{
  "command": {
    "analyze": {
      "subtask": true
    }
  }
}
```

### Model（可选）

覆盖此命令使用的默认模型。

```json
{
  "command": {
    "analyze": {
      "model": "anthropic/claude-haiku-4-5"
    }
  }
}
```

### 配置选项汇总

| 选项 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `template` | string | 是 | 发送给 LLM 的提示词 |
| `description` | string | 否 | TUI 中显示的命令描述 |
| `agent` | string | 否 | 执行命令的代理名称 |
| `subtask` | boolean | 否 | 是否强制作为子代理运行 |
| `model` | string | 否 | 覆盖使用的模型 |

---

## 提示词模板语法

自定义命令的提示词模板支持多种特殊占位符和语法。

### 参数占位符

**`$ARGUMENTS`** — 捕获所有参数：

```markdown
---
description: Create a new component
---
Create a new React component named $ARGUMENTS with TypeScript support.
```

使用：`/component Button` → `$ARGUMENTS` 替换为 `Button`

**位置参数** — 通过 `$1`、`$2`、`$3`... 访问各个参数：

```markdown
---
description: Create a new file with content
---
Create a file named $1 in the directory $2 with the following content: $3
```

使用：`/create-file config.json src "{ \"key\": \"value\" }"`

替换结果：
- `$1` → `config.json`
- `$2` → `src`
- `$3` → `{ "key": "value" }`

### Shell 输出注入

使用 `` !`command` `` 语法将 bash 命令输出注入到提示词中：

```markdown
---
description: Analyze test coverage
---
Here are the current test results:

!`npm test`

Based on these results, suggest improvements to increase coverage.
```

另一个示例：

```markdown
---
description: Review recent changes
---
Recent git commits:

!`git log --oneline -10`

Review these changes and suggest any improvements.
```

命令在项目根目录中运行，输出成为提示词的一部分。

### 文件引用

使用 `@` 后跟文件名引用文件内容：

```markdown
---
description: Review component
---
Review the component in @src/components/Button.tsx.
Check for performance issues and suggest improvements.
```

文件内容会自动包含在提示词中。

---

## 配置文件位置与优先级

OpenCode 配置支持多层级，后面的配置覆盖前面的（仅覆盖冲突的键，非冲突设置保留）。

### 优先级顺序（从低到高）

| 优先级 | 配置源 | 路径 | 说明 |
|--------|--------|------|------|
| 1 | 远程配置 | `.well-known/opencode` | 组织默认值 |
| 2 | 全局配置 | `~/.config/opencode/opencode.json` | 用户偏好 |
| 3 | 自定义配置 | `OPENCODE_CONFIG` 环境变量 | 自定义覆盖 |
| 4 | 项目配置 | 项目根目录 `opencode.json` | 项目特定设置 |
| 5 | `.opencode` 目录 | `.opencode/` | 代理、命令、插件 |
| 6 | 内联配置 | `OPENCODE_CONFIG_CONTENT` 环境变量 | 运行时覆盖 |

### Markdown 命令文件位置

自定义命令的 Markdown 文件可放置于：

- **全局**：`~/.config/opencode/commands/`
- **项目级**：`.opencode/commands/`

### 自定义配置目录

通过 `OPENCODE_CONFIG_DIR` 环境变量指定自定义配置目录，该目录遵循与 `.opencode` 相同的结构：

```bash
export OPENCODE_CONFIG_DIR=/path/to/my/config-directory
opencode run "Hello world"
```

### 配置合并规则

- 所有配置文件**合并**而非替换
- 仅在键冲突时，高优先级覆盖低优先级
- 例如：全局配置设置 `autoupdate: true`，项目配置设置 `model: "xxx"`，最终两者都保留

---

## 代理（Agent）系统

代理是 OpenCode 的核心扩展机制之一，允许为特定任务配置专用 AI 角色。

### JSON 配置方式

```jsonc
{
  "agent": {
    "code-reviewer": {
      "description": "Reviews code for best practices and potential issues",
      "model": "anthropic/claude-sonnet-4-5",
      "prompt": "You are a code reviewer. Focus on security, performance, and maintainability.",
      "tools": {
        "write": false,
        "edit": false
      }
    }
  }
}
```

### Markdown 文件方式

在 `~/.config/opencode/agents/` 或 `.opencode/agents/` 中创建 Markdown 文件定义代理。

### 默认代理

可通过 `default_agent` 选项设置默认代理：

```json
{
  "default_agent": "plan"
}
```

默认代理必须是主代理（不能是子代理），可以是内置代理（如 `"build"` 或 `"plan"`）或自定义代理。

---

## 插件（Plugin）系统

插件通过自定义工具、钩子和集成扩展 OpenCode。

### 加载方式

1. **本地插件**：将插件文件放置在 `.opencode/plugins/` 或 `~/.config/opencode/plugins/`
2. **npm 插件**：通过 `plugin` 选项从 npm 加载

```json
{
  "plugin": ["opencode-helicone-session", "@my-org/custom-plugin"]
}
```

---

## MCP 服务器集成

通过 `mcp` 选项配置 Model Context Protocol 服务器，集成外部工具与服务：

```json
{
  "mcp": {
    "jira": {
      "type": "remote",
      "url": "https://jira.example.com/mcp",
      "enabled": true
    }
  }
}
```

支持远程和本地 MCP 服务器。

---

## 规则与指令（Rules & Instructions）

### AGENTS.md

在项目根目录创建 `AGENTS.md` 文件提供自定义指令（类似 Cursor Rules），指令会包含在 LLM 上下文中。

### instructions 选项

通过 `instructions` 配置指定指令文件路径和 glob 模式：

```json
{
  "instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md"]
}
```

---

## 方案对比与总结

### 自定义命令 vs Claude Code Skills 对比

| 特性 | OpenCode 自定义命令 | Claude Code Skills |
|------|---------------------|-------------------|
| 定义方式 | JSON 配置 + Markdown 文件 | Markdown 文件 |
| 参数支持 | `$ARGUMENTS`、`$1`/`$2`/... | 通过 skill 系统参数化 |
| Shell 输出注入 | `` !`cmd` `` 语法 | 不支持（需 MCP） |
| 文件引用 | `@path` 语法 | 通过工具读取 |
| 代理绑定 | 支持（agent 选项） | 不适用 |
| 模型覆盖 | 支持（model 选项） | 不适用 |
| 子代理运行 | 支持（subtask 选项） | 不适用 |
| 全局/项目级 | 两者均支持 | 仅项目级 |
| 插件生态 | 有（npm 插件） | 有（Skills 生态） |

### 核心特点总结

1. **双定义方式**：JSON 配置适合简单命令，Markdown 文件适合复杂提示词模板
2. **强大的模板语法**：支持参数替换、Shell 输出注入、文件引用
3. **灵活的配置层级**：6 级优先级，支持远程/全局/项目级/运行时覆盖
4. **代理系统集成**：命令可绑定特定代理、模型，支持子代理隔离执行
5. **命令覆盖内置**：自定义命令同名时会覆盖内置命令
6. **活跃的生态**：[opencode.cafe](https://www.opencode.cafe) 社区共享命令，GitHub 上有丰富的配置仓库

---

## 参考资源

- [OpenCode 官方命令文档](https://opencode.ai/docs/commands/)
- [OpenCode 官方配置文档](https://opencode.ai/docs/config/)
- [GitHub: anomalyco/opencode](https://github.com/anomalyco/opencode) — 主仓库
- [GitHub Issue #299: custom slash commands](https://github.com/anomalyco/opencode/issues/299)
- [OpenCode Cafe](https://www.opencode.cafe/search?type=slash-command) — 社区命令共享
- [jjmartres/opencode](https://github.com/jjmartres/opencode) — 社区配置参考
