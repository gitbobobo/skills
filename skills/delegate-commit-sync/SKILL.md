---
name: delegate-commit-sync
description: 委托子代理完成代码提交和同步远程任务，仅在用户提及时使用
---

委托子代理完成代码提交和远程同步任务，仅在用户提及时使用。

## 委托方式

用户可以选择子代理工具，未选择时按默认顺序检测工具是否可用，使用第一个可用工具。

```bash
# Kimi
kimi --prompt "<提示词>"

# Cursor Agent
agent -p "<提示词>" --yolo

# Claude Code
claude -p "<提示词>" --dangerously-skip-permissions
```

用户提供的代理名称如果不是以上3种，就先考虑别名，再考虑这是用户笔误。

如果在用户的终端配置中找到对应的别名，就结合别名的配置和示例命令选择对应的代理。

提示词自由发挥，但任务需满足以下要求：

- 按可审计粒度提交，提交信息清晰，且只提交应入库文件
- 提交内容满足 Conventional Commits 规范
- 运行相关测试，如果失败需要修复并提交
