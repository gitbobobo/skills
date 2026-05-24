---
name: delegate-claude-agent
description: 将计划委派给子代理执行，必须由用户主动调用
---

# Delegate Claude Agent

编写计划后，由 Claude Code agent 完成计划，必须由用户主动调用。

计划中需要包含明确的验收标准。

给 Claude Code agent 的首个提示词中需要包含计划文件路径，以及“这是一个长程任务，在达到验收标准之前不得以任何理由停下来”的提示，以确保子代理不会选择性跳过部分任务。

关键原则：Claude Code agent 只负责实现计划，验收标准需要由你来把关，不通过则告诉子代理哪些地方还要修改，修改方向是什么。

## 前置条件

确保已安装 tmux 和 Claude Code，未安装时需要先询问用户是否需要安装：

```bash
# tmux
sudo apt install -y tmux    # Ubuntu/Debian
brew install tmux            # macOS

# Claude Code
npm install -g @anthropic-ai/claude-code
```

## 核心流程

### 编写计划

编写计划并保存到文档目录

### 启动后台 agent 并委派任务

```bash
tmux new -d -s <agent名>
tmux send-keys -t <agent名> 'claude --dangerously-skip-permissions'
sleep 3
tmux send-keys -t <agent名> '<任务描述>'
sleep 1
tmux send-keys -t <agent名> Enter
```

子代理开始执行任务后，告诉用户该通过什么命令查看子代理会话。

### 任务进度报告

每3分钟执行一次 `tmux capture-pane -t <name> -p | tail -80`，并向用户报告子代理当前的工作内容，即使当前没有进展。

在此期间不要询问用户意见，不要停下来，直至子代理声称任务完成。

### 验收

验收任务完成情况，验收通过则关闭创建的 tmux 会话，不达标则继续循环。

## 常用命令速查

```bash
# 启动
tmux new -d -s <name>                                           # 创建后台会话
tmux send-keys -t <name> 'claude --dangerously-skip-permissions'  # 启动 claude

# 输入提示词并提交
tmux send-keys -t <name> '<任务>'
sleep 1
tmux send-keys -t <name> Enter # 这一步很重要，不做提示词就一直在输入框中不会发送

# 监控
tmux ls                                      # 列出所有 agent
tmux attach -t <name>                        # 连接查看（Ctrl+b d 分离）
tmux capture-pane -t <name> -p | tail -80    # 获取最新输出

# 追加指令
tmux send-keys -t <name> '<指令>'      # 向 agent 追加指令

# 清理
tmux kill-session -t <name>                  # 终止指定会话
tmux kill-session -a                         # 终止所有会话
```

更多命令可直接查看 cli 的帮助命令。

## 常见问题

- 子代理上下文窗口达到限制时，发送 `/compact` 命令压缩上下文后，让子代理继续工作
- 子代理额度达到上限时，如果报错信息提示了恢复时间，则等待直到额度恢复。在子代理可用时发送“继续”让子代理继续工作
