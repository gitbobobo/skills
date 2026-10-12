---
name: setup-env
description: 统一设置本机各 agent harness 的全局代理规则并做环境体检。新设备初始化、全局约定变更后重同步时使用。仅限用户主动调用。
---

# setup-env

把 `rules/AGENTS.md`（本技能目录下，唯一真源）链接到各 harness 的全局规则路径，让所有 CLI 代理在任何项目里都加载同一套约定；通用规则涵盖重命令遵守机器调度、单一最终验证负责人和原生事件优先的等待入口，具体编排流程留在对应技能。同步后仍以项目规则优先。同时把 `scripts/run-watch.mjs` 链接为 `~/.local/bin/run-watch`（后台长任务封装，POSIX），并报告各 harness CLI 与本机工具（如 cargo-nextest）是否可用——工具只报告不安装。cargo-nextest 不在 PATH 时再探测 CARGO_HOME 和默认 Cargo bin，区分「未安装」与「已安装但 PATH 不可见」；后者在实际代理启动环境补路径，再从新代理执行 `cargo nextest --version` 验证。

另向 `~/.config/devin/hooks.v1.json`（Windows 为 `%APPDATA%\devin\hooks.v1.json`）合并写入一条 PreToolUse `exec` hook：`scripts/devin-hook-exec-guard.mjs` 阻断 ≥60 秒的前台 `sleep`（命令位出现、`&` 后台与 heredoc 内容放行），把「不用 sleep 轮询链」这条全局约定变成机械拦截。脚本核对 matcher、完整命令与超时，重跑会备份并替换旧路径，保留其他 hook；Node 使用 PATH 中的稳定链接路径，避免锁死 Homebrew 小版本目录。

## 步骤

1. 体检：`node <技能目录>/scripts/setup-env.mjs --check`，逐项看状态：已链接 / 副本一致 / 副本过期 / 有别的内容 / 缺失。
2. 执行：`node <技能目录>/scripts/setup-env.mjs`。Windows 或符号链接权限不足时用 `--copy`。
3. 核对备份：脚本对已有非空内容会先备份成 `<文件>.bak-<时间戳>` 再替换。出现备份就提醒用户检查旧内容是否需要合并。
4. 完成标准：脚本退出码为 0，且输出中每个 harness 显示「已链接」或「副本一致」。

`run-watch wait <名>` 默认最多等待 30 秒；`--timeout <秒>` 可显式调整，0 表示立即查状态。时限到而任务仍运行时返回 2，后台任务继续，后续查同一份 status/log。需要更长等待时使用终端支持的后台/让出机制。

## 覆盖的 harness

| harness | macOS / Linux | Windows |
|---|---|---|
| devin | `~/.config/devin/AGENTS.md` | `%APPDATA%\devin\AGENTS.md` |
| codex | `~/.codex/AGENTS.md` | `~/.codex/AGENTS.md` |
| claude / claudeAgent | `~/.claude/CLAUDE.md` | `~/.claude/CLAUDE.md` |
| opencode | `~/.config/opencode/AGENTS.md` | `%APPDATA%\opencode\AGENTS.md` |
| cursor | `~/.cursor/rules/global.mdc` | `~\.cursor\rules\global.mdc` |
| factory droid | `~/.factory/AGENTS.md` | `~\.factory\AGENTS.md` |

新增 harness 时改 `scripts/setup-env.mjs` 里的 `TARGETS`。

Factory Droid 备注：

- 官方文档确认 `~/.factory/AGENTS.md` 是跨项目的个人指令层；Droid 还会检查 `~/.agents/`、`~/.agent/` 个人目录，本脚本取 `~/.factory` 为主落点。
- 优先级语义：项目 `AGENTS.md` 优先于个人文件——个人层放与仓库无关的通用约定，不会覆盖项目规则。
- 逐次调用另可用 `droid --append-system-prompt-file <path>` 追加提示词（仅当次进程生效，不是持久配置）。

Cursor 备注：

- cursor-agent 扫描 `~/.cursor/rules/` 的 `.mdc` 文件；脚本写入带 `alwaysApply: true` frontmatter 的派生文件（不能符号链接，内容需要包裹），改了 `rules/AGENTS.md` 后所有机器都要重跑脚本。
- Cursor 设置 UI 里的 User Rules 存在账号上、由服务端下发（`getAllCursorRules`），是另一条官方路径，可跨设备同步但只能手动维护，和本文件制互不妨碍。
- 已知上游怪癖：Agents Window 的 Settings 界面可能不列出 `~/.cursor/rules` 下的文件级规则（[论坛确认 bug](https://forum.cursor.com/t/how-do-i-configure-a-global-rules-file-that-gets-picked-up-by-agent-mode/157335)），不影响 agent 运行时加载。

## 边界

- 全局规则是「会被加载」，不是「必定遵守」。跨 harness 委派（`delegate_task`）时的硬性约束仍要原文写进任务 prompt 转述。
- 仓库级规则仍放各仓库的 AGENTS.md；本文件只放与仓库无关的通用约定。
- 改约定只改 `rules/AGENTS.md`。符号链接立即生效；`--copy` 部署过的机器要重跑本脚本。
- 本技能只管全局规则，不装 CLI、不改项目。技能本身的安装走 `docs/setup.md` 的 `npx skills` 流程。
