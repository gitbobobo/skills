---
name: plan-review
description: 创建计划，请求审查，修订计划
---

三阶段流程：创建计划 → 请求审查 → 修订计划。

## 创建计划

一个好的计划应该满足以下标准：

- 不包含具体代码
- 复用已有设施，不重复造轮子
- 长期可维护性优先，选择最佳实现方案而非最小可行方案
- 实现者可根据计划直接实施，无需实现时决策

## 请求审查

用户提供编码代理名称（`claude`、`cursor`、`kimi`、`opencode`），则通过 CLI 方式向该代理发送审查请求。

如果用户提供的代理名称不是以上四种，则检查用户环境变量配置文件，如果是已知编码代理的别名，就使用用户定义的别名。

严格按照示例命令发送（10 分钟超时），提示词自由发挥，但必须包含计划内容。

```bash
# Windows 平台必须通过 powershell 运行以下命令： powershell.exe -Command "<command>"

# Opencode
opencode run "<提示词>" --format json --dangerously-skip-permissions | grep '"type":"text"'

# Kimi
kimi --prompt "<提示词>" --quiet --yolo

# Cursor Agent
agent -p "<提示词>" --yolo

# Claude Code
claude -p "<提示词>" --dangerously-skip-permissions
```

> 若用户同时选择多个编码代理，则分别请求这些编码代理审查并汇总审查结果。

## 修订计划

逐条核实审查结果，并修订计划，向用户展示最终版本，询问用户是否开始实现。
