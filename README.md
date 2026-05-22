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

详见 [skills/code-review-mastery/SKILL.md](skills/code-review-mastery/SKILL.md)。源仓库：[AbsolutelySkilled/AbsolutelySkilled](https://github.com/AbsolutelySkilled/AbsolutelySkilled)。

### deslop

移除 AI 生成的代码冗余（slop），清理代码风格。检查当前分支相对于 main 的 diff，清理不必要的注释、过度的防御性检查、类型绕过、过深嵌套等与项目风格不一致的模式。

详见 [skills/deslop/SKILL.md](skills/deslop/SKILL.md)。源仓库：[cursor/plugins](https://github.com/cursor/plugins)。

### grill-me

针对用户的计划或设计进行 relentless 追问，逐条遍历决策树的每个分支，逐步达成共识。每轮提问一个问题，同时给出推荐答案。如果问题可以通过探索代码库解决，则优先探索代码库。

详见 [skills/grill-me/SKILL.md](skills/grill-me/SKILL.md)。源仓库：[mattpocock/skills](https://github.com/mattpocock/skills)。

### complexity-optimizer

分析代码库的算法复杂度和性能热点，安全地提出或实施优化方案而不破坏现有行为。支持扫描嵌套循环、重复遍历、N+1 查询、不必要的 O(n^2) 操作等模式，并提供结构化的复杂度分析报告。内置启发式扫描器，支持 Python、JavaScript、TypeScript、Java、Go、C/C++、C#、Ruby、PHP、Swift 等语言。

详见 [skills/complexity-optimizer/SKILL.md](skills/complexity-optimizer/SKILL.md)。源仓库：[Kappaemme-git/codex-complexity-optimizer](https://github.com/Kappaemme-git/codex-complexity-optimizer)。

### improve-codebase-architecture

基于模块深度理论系统性改善代码库架构。识别浅层模块（接口复杂度≈实现复杂度），通过删除测试判断其价值，然后加深接口以提升杠杆率和局部性。支持依赖分类、缝隙分析、"设计两次"接口设计等方法。

详见 [skills/improve-codebase-architecture/SKILL.md](skills/improve-codebase-architecture/SKILL.md)。源仓库：[mattpocock/skills](https://github.com/mattpocock/skills)。

### thermo-nuclear-code-quality-review

极其严格的代码质量审查，聚焦抽象质量、巨型文件和面条式条件增长。主动寻找"代码柔道"手法：在保持行为不变的前提下，通过重构使实现大幅简化。禁止文件超过 1000 行、不允许面条式增长、要求直接可维护的代码风格。

触发关键词：`thermo-nuclear code quality review`、`thermonuclear review`、`deep code quality audit`、`harsh maintainability review`。

详见 [skills/thermo-nuclear-code-quality-review/SKILL.md](skills/thermo-nuclear-code-quality-review/SKILL.md)。源仓库：[cursor/plugins](https://github.com/cursor/plugins)。
