---
name: recall
description: 重建工作上下文并产出四段简报（Capsule / Next move / Threads / Problems），回答「上次干到哪、这个需求整体进行到哪、下一步干什么」。用于换设备接手、隔段时间回来续作，或用户说「recall」「接着干」「到哪了」。在目标仓库目录里跑 scripts/recall.mjs 采集事实，再由你综合。
---

# recall

`scripts/recall.mjs` 采集事实，你写简报。**分工：脚本只产出可核实的事实和标注好的线索，判断和措辞由你做。** 不要把脚本输出原样贴给用户。

```bash
node <本技能目录>/scripts/recall.mjs [INT-58] [--project <fast-ship-项目-uuid>] [--threads 5]
```

在目标仓库目录里运行。issue 引用按序自动解析：命令行参数 > 分支名里的 `INT-N`/`GH-N` > 当前分支 PR 正文里的引用 > 列出该项目 in_progress 的 issue 让你挑。

## 脚本采集的四个面

- **Git 实况**：分支、上游、未提交/未推送提交、remote（owner/repo 同时是 Fast Ship 项目匹配的键）
- **GitHub**：当前分支 PR 的 `gh` 实测状态；Fast Ship 关联 PR 也逐条 `gh` 实测，与快照并列
- **T3 本机线程**：`~/.t3/userdata/statev2.sqlite`（只读）。`projection_projects.workspace_root` 映射项目，线程 payload 的 `worktreePath`/`branch`/`pullRequests` 标注【本工作树】【同分支】【子代理】，另带最近一条用户/助手消息尾部
- **Fast Ship 需求维度**：读 `~/.config/fast-ship/config.yaml`（Key 不出现在输出），issue 的 `pull_requests[]`、`collab` 共识/总结、checklist

任何一面拿不到（无 sqlite、无 fast-ship 配置、不在 git 仓库）都会在末尾「缺席的数据源」里列明，不让它静默缺席。

## 输出契约：四段简报

| 段 | 回答 | 主要来源 |
|---|---|---|
| **Capsule** | 这台机器上干到哪、结论是什么 | 本机线程尾部 + git/gh 核实 |
| **Next move** | 下一步干什么 | Fast Ship checklist/共识 ⊖ 已验证完成的部分 |
| **Threads** | 这个需求整体进行到哪、我是不是收尾那个 | Fast Ship `pull_requests[]`（跨仓库全集）+ `gh` 实测 |
| **Problems** | 有哪些已知坑、修过又回滚的事 | Fast Ship collab、线程里的失败记录 |

## 可信度标注（硬性规则）

线程自述是**主张**不是事实——「推上去了」「合了」可能是旧话。简报里每条结论标一档：

- ✅ **已验证**：git/gh/Fast Ship 当前数据能证实
- 🟡 **声称**：线程里这么说但实况源查不到（标注「线程称，未核实」）
- ⚪ **未知**：数据源缺席，明说不知道

`pull_requests[].state` 是 `synced_at` 时刻的快照。快照与 `gh` 实测不一致时以实测为准，并提示可调 `POST /api/issues/:iid/pull-requests/sync` 刷新（脚本只读，不替你调）。

## 深挖与边界

尾部消息不够还原现场时，用 `t3-code` 技能里的查询模板按 `thread_id` 继续挖 `turn_items`（脚本只给每条线程末尾一屏）。本机维度只覆盖 T3 线程——Devin、Claude Code 的会话历史不在 statev2 里，相关现场要在简报里标 ⚪。

## Next move 的推导口径

「PR 全合 ≠ 需求完成」。Next move 从 Fast Ship 的 checklist 未完成项和共识里推，不靠 PR 状态倒推；Fast Ship 缺席时退化为「本机未完成线索 + 当前分支 PR 状态」，并在简报里说明精度降级。
