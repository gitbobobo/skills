# skills

个人开发工作流，保存常用技能。

## 技能列表

### git-commit

规范的本地提交工作流。确保每次提交都可审计、相关且工作目录干净。

详见 [skills/git-commit/SKILL.md](skills/git-commit/SKILL.md)。

### git-sync

同步 git 远程并解决冲突，确保本地和远程保持一致。禁止直接丢弃提交内容，必须根据提交时间理解修改意图。

详见 [skills/git-sync/SKILL.md](skills/git-sync/SKILL.md)。

### review-remediator

验证审计或代码审查结果的正确性，并自动修复已确认的问题。接收自由文本格式的审查报告，逐条交叉验证后应用修复，小问题自动处理，大改动需用户确认。

详见 [skills/review-remediator/SKILL.md](skills/review-remediator/SKILL.md)。

### code-review-mastery

对本地 git 变更（已暂存或未暂存）进行项目感知的代码审查。自动收集项目上下文（lint 规则、编码规范、框架模式），按安全性、正确性、性能、设计、可读性、约定的优先级分层分析，输出结构化的 `[MAJOR]` / `[MINOR]` 审查报告，支持交互式逐条修复。

触发关键词：`review my changes`、`review staged`、`review my diff`、`check my code`、`code review local changes`、`review unstaged`、`review before commit`。

详见 [skills/code-review-mastery/SKILL.md](skills/code-review-mastery/SKILL.md)。

### deslop

移除 AI 生成的代码冗余（slop），清理代码风格。检查当前分支相对于 main 的 diff，清理不必要的注释、过度的防御性检查、类型绕过、过深嵌套等与项目风格不一致的模式。

详见 [skills/deslop/SKILL.md](skills/deslop/SKILL.md)。
