---
name: delegate-commit-sync
description: 委托子代理完成代码提交和同步远程任务，仅在用户提及时使用
---

委托子代理完成代码提交和远程同步任务，仅在用户提及时使用。

## 委托方式

用户可以选择子代理工具，未选择时按默认顺序检测工具是否可用，使用第一个可用工具。

```bash
# Opencode
opencode run "提示词" --dangerously-skip-permissions

# Kimi
kimi --prompt "提示词" --quiet --yolo

# Cursor Agent
agent -p "提示词" --yolo

# Claude Code
claude -p "提示词" --dangerously-skip-permissions
```

如果用户提供的代理名称不是以上四种，则检查用户环境变量配置文件，如果是已知编码代理的别名，就使用用户定义的别名。

## 提示词

固定发送`请检查可用技能，依次完成本地代码提交任务和同步远程任务，整个过程自主决策，不要询问用户。`
