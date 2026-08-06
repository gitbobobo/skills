---
name: create-plan-by
description: 委托多个子代理创建计划，对计划评分，并综合多个计划的优点创建修订版计划
---

委托多个子代理创建计划，对计划评分，并综合多个计划的优点创建修订版计划

## 创建计划

整理完整需求后，委托多个子代理创建计划，子代理需要将计划保存到系统临时目录。

子代理包含两种：

1. 内部子代理，必须包含
2. 外部子代理，用户指定的是外部子代理，需通过 CLI 方式调用

```bash
# Windows 平台必须通过 powershell 运行以下命令： powershell.exe -Command "<command>"

# Kimi
kimi --prompt "<提示词>"

# Cursor Agent
agent -p "<提示词>" --yolo

# Claude Code
claude -p "<提示词>" --dangerously-skip-permissions
```

- 用户提供的子代理名称如果不是以上3种，就在用户终端配置中找到对应的别名（不存在笔误），结合别名配置和示例命令选择对应的代理。

## 修订计划

对多个计划评分，评估利弊，创建修订版计划展示给用户。

如果用户安装了 `html-preview` 技能且已配置，则制作一个图文并茂的计划并上传，有效期设为 30d。
