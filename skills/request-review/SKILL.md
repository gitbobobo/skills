---
name: request-review
description: 请求编码代理审查代码，核实审查结果并修复已确认的问题
---

# 请求审查

三阶段流程：获取审查结果 → 核实审查结果 → 修复已确认的问题。

## 第一阶段：获取审查结果

根据用户输入获取审查结果，有两种来源：

### 来源一：用户直接粘贴

用户直接提供审查文本。

### 来源二：指定编码代理

用户提供编码代理名称（`claude`、`cursor`、`kimi`、`opencode`），则通过 CLI 方式向该代理发送审查请求。

用户提供的代理名称如果不是以上四种，就先考虑别名，再考虑这是用户笔误，**不要盲目使用用户不想用的代理**。

严格按照示例命令发送（10 分钟超时），禁止修改提示词：

```bash
# Windows 平台必须通过 powershell 运行以下命令： powershell.exe -Command "<command>"

# Opencode
opencode run "使用 thermo-nuclear-code-quality-review 技能审查未提交更改（只读），输出审查报告（禁止使用 emoji）" --format json --dangerously-skip-permissions | grep '"type":"text"'

# Kimi
kimi --prompt "使用 thermo-nuclear-code-quality-review 技能审查未提交更改（只读），输出审查报告（禁止使用 emoji）" --quiet --yolo

# Cursor Agent
agent -p "使用 thermo-nuclear-code-quality-review 技能审查未提交更改（只读），输出审查报告（禁止使用 emoji）" --yolo

# Claude Code
claude -p "/thermo-nuclear-code-quality-review 审查未提交更改（只读），输出审查报告（禁止使用 emoji）" --dangerously-skip-permissions
```

> 若代理不支持 CLI 调用或命令执行失败，告知用户并请求手动粘贴审查结果。
> 若用户同时选择多个编码代理，则分别请求这些编码代理审查并汇总审查结果。

## 第二阶段：核实审查结果

对第一阶段获取的审查结果逐条核实：

- 对照实际代码验证问题是否成立；标记误报或过时的行号
- 汇总核实结果：哪些成立、哪些为误报，输出简短的核实摘要

## 第三阶段：修复已确认的问题

修复真实问题，最后输出修复报告

### 输出格式

#### 已修复

列出每个已成功解决的问题，每条必须包含：
- 序号（D1、D2等）
- 问题摘要
- 所做变更（一句话）

#### 未修复

列出每个未修复的问题，每条必须包含：
- 序号（T1、T2等）
- 问题摘要
- 未修复的理由

理由可能是误报、风险过高、超出范围、信息不足、设计冲突等，重要的是让用户能够判断该决定是否合理。

- 对于“风险过高/超出范围”的问题，评估改动量与收益，是否能提升代码库质量。
- 对于多个编码代理审查出的相同问题，在序号后面显示 `*`
