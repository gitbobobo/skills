# skills

个人开发工作流，保存常用技能。

## 技能列表

### git-commit

规范的本地提交工作流。确保每次提交都可审计、相关且工作目录干净。默认主代理直接提交；用户指定子代理时，委托子代理完成（Kimi / Cursor / Claude Code 等）。

详见 [skills/git-commit/SKILL.md](skills/git-commit/SKILL.md)。

### git-sync

同步 git 远程并解决冲突，确保本地和远程保持一致。禁止直接丢弃提交内容，必须根据提交时间理解修改意图。默认主代理直接同步；用户指定子代理时，委托子代理完成（Kimi / Cursor / Claude Code 等）。

详见 [skills/git-sync/SKILL.md](skills/git-sync/SKILL.md)。

### request-review

验证审计或代码审查结果的正确性，并自动修复已确认的问题。接收自由文本格式的审查报告，逐条交叉验证后应用修复，小问题自动处理，大改动需用户确认。

详见 [skills/request-review/SKILL.md](skills/request-review/SKILL.md)。

### deslop

移除 AI 生成的代码冗余（slop），清理代码风格。检查当前分支相对于 main 的 diff，清理不必要的注释、过度的防御性检查、类型绕过、过深嵌套等与项目风格不一致的模式。

详见 [skills/deslop/SKILL.md](skills/deslop/SKILL.md)。源仓库：[cursor/plugins](https://github.com/cursor/plugins)。

### grill-me

针对用户的计划或设计进行 relentless 追问，逐条遍历决策树的每个分支，逐步达成共识。每轮提问一个问题，同时给出推荐答案。如果问题可以通过探索代码库解决，则优先探索代码库。

详见 [skills/grill-me/SKILL.md](skills/grill-me/SKILL.md)。源仓库：[mattpocock/skills](https://github.com/mattpocock/skills)。

### improve-codebase-architecture

基于模块深度理论系统性改善代码库架构。识别浅层模块（接口复杂度≈实现复杂度），通过删除测试判断其价值，然后加深接口以提升杠杆率和局部性。支持依赖分类、缝隙分析、"设计两次"接口设计等方法。

详见 [skills/improve-codebase-architecture/SKILL.md](skills/improve-codebase-architecture/SKILL.md)。源仓库：[mattpocock/skills](https://github.com/mattpocock/skills)。

### thermo-nuclear-code-quality-review

极其严格的代码质量审查，聚焦抽象质量、巨型文件和面条式条件增长。主动寻找"代码柔道"手法：在保持行为不变的前提下，通过重构使实现大幅简化。禁止文件超过 1000 行、不允许面条式增长、要求直接可维护的代码风格。

触发关键词：`thermo-nuclear code quality review`、`thermonuclear review`、`deep code quality audit`、`harsh maintainability review`。

详见 [skills/thermo-nuclear-code-quality-review/SKILL.md](skills/thermo-nuclear-code-quality-review/SKILL.md)。源仓库：[cursor/plugins](https://github.com/cursor/plugins)。

### plan-review

三阶段流程：创建计划 → 请求编码代理审查 → 修订计划。确保计划复用已有设施、长期可维护、无需实现时决策。支持向多个编码代理发送审查请求并汇总结果。

详见 [skills/plan-review/SKILL.md](skills/plan-review/SKILL.md)。
