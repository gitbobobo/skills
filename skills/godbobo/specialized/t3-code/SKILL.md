---
name: t3-code
description: 本机 T3 Code 运行状态的内部知识：状态数据库布局、会话记录查询方法、delegate_task 编排与 ACP 通道要点。分析 T3 会话、做复盘、排查编排或额度问题时使用；收尾回收孤儿工作树跑 scripts/t3-worktree-gc.mjs。
---

# t3-code 本机知识

T3 Code 的本地状态在 `~/.t3/` 下。会话、命令、消息等运行数据落 SQLite，复盘/排查时直接查库，比翻日志高效。

## 状态数据库

- 当前库：`~/.t3/userdata/statev2.sqlite`；`state.sqlite` 是旧库。
- v2 投影表（`orchestration_v2_projection_*`）2025-10-03 起为权威数据；v1 的 `projection_*` 表已停写，只在看更早历史时查。
- 关键表：
  - `orchestration_v2_projection_threads`：线程。列含 `thread_id`、`project_id`、`title`、`default_provider`、`runtime_mode`、`created_at`、`updated_at`、`archived_at`。
  - `orchestration_v2_projection_turn_items`：线程内事件流，分析主力表。列含 `thread_id`、`run_id`、`ordinal`、`type`、`status`、`updated_at`、`payload_json`。
  - `orchestration_v2_projection_subagents` / `runs` / `run_attempts` / `provider_sessions`：委派与运行明细。
  - `scheduled_tasks`、`projection_thread_pull_requests`：定时任务、线程关联的 PR。
- `turn_items.type` 常见值：`assistant_message`、`command_execution`、`reasoning`、`dynamic_tool`（MCP 调用）、`user_message`、`file_change`、`file_search`、`subagent`、`error`。
- `payload_json` 按 type 不同：`command_execution` 含 `input`/`output`/`exitCode`/`startedAt`/`completedAt`；`assistant_message`/`reasoning` 含正文文本。
- 留存限制：约 87% 的 `command_execution` 只在 `output` 里存「Exited with code N」一行，`exitCode` 字段经常缺省，完整 stdout/stderr 不落库——判成败主要靠 output 文本里的退出码。
- 委派任务的子代理是独立线程（命名形如 `thread:delegated-task:*`），查子代理活动按 `thread_id` 过滤即可。
- Windows 上没有 sqlite3 CLI，用 Python 自带的 sqlite3 模块查库；查询稍长就写临时 .py 文件再跑，cmd 里内联 `python -c` 的引号容易翻车（exec 是 cmd，`&&` 连接而不是 `;`）。

## 常用查询

```bash
DB=~/.t3/userdata/statev2.sqlite

# 最近活跃线程
sqlite3 $DB "SELECT thread_id, title, updated_at FROM orchestration_v2_projection_threads
  WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20;"

# 某线程的命令执行（含退出码）
sqlite3 $DB "SELECT json_extract(payload_json,'$.input'), json_extract(payload_json,'$.exitCode')
  FROM orchestration_v2_projection_turn_items
  WHERE thread_id='<id>' AND type='command_execution' ORDER BY ordinal;"

# 失败的命令（全库）
sqlite3 $DB "SELECT thread_id, json_extract(payload_json,'$.input')
  FROM orchestration_v2_projection_turn_items
  WHERE type='command_execution' AND payload_json LIKE '%Exited with code%'
    AND payload_json NOT LIKE '%Exited with code 0%';"

# 事件类型分布
sqlite3 $DB "SELECT type, COUNT(*) FROM orchestration_v2_projection_turn_items GROUP BY 1 ORDER BY 2 DESC;"
```

## 编排工具面（机制事实）

派活的策略与操作流程（选模型、写任务模板、换路、验收）是 `$t3-orchestrator` 技能的职责；这里只记工具层面的机制事实。

- `orchestrator_capabilities` 返回活的 provider/模型目录（含自定义模型）；harness 自带的模型清单不是全集。
- `delegate_task` 参数面：`task`、`target:{providerInstanceId, model}`、`mode`、`clientRequestId`。返回 `taskId`（配 `task_status`/`task_cancel` 管理）和 `childThreadId`（子代理存储线程，可 `t3_thread_read`）。
- 线程与工作区绑定只能在 `t3_thread_launch` 的 `workspaceStrategy` 里设（`worktree`/`existing_worktree`/`root`）；让 agent 自己跑 `git worktree add` 不改变绑定。
- ACP 通道兜底：T3 MCP 工具缺席且环境有 `T3_ACP_MCP_NODE` 时，走终端
  `ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" ${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call <tool> '<json>'`。
- `schedule_task` 的 `schedule` 传结构化对象（`{"type":"interval","everyMs":N}` / `{"type":"fixed_time","timeOfDay":"HH:MM","weekdays":[...]}`），不是 JSON 字符串。

## 工作树回收（t3-worktree-gc）

T3 线程绑定的工作树（`~/.t3/worktrees/<项目分组>/<名>`）在线程结束后不会自动清理。收尾时用 `scripts/t3-worktree-gc.mjs` 只回收「其他已终结线程」的工作树——自己所在的树留给后续会话，绑定中的树永远不碰（删掉绑定目录会让该线程终端永久失效）。

```bash
node <技能目录>/scripts/t3-worktree-gc.mjs               # dry-run：逐目录打印结论
node <技能目录>/scripts/t3-worktree-gc.mjs --apply       # 真正执行 git worktree remove
node <技能目录>/scripts/t3-worktree-gc.mjs --root <dir>  # 单独指定扫描根
```

全部满足才删，任一不满足则 skip 并注明原因：

- 调用者 cwd 不在该工作树内（self 永不删）；
- 是 git 链接工作树（独立 clone skip；非 git/gitfile 失效标 not-a-worktree 只报告）；
- 绑定的线程全部已终结（settled / archived / deleted 任一；零绑定标 unbound 可删），且没有 queued/preparing/starting/running/waiting 状态的 run；
- `git status --porcelain -uall` 为空（`-uall` 覆盖 `status.showUntrackedFiles` 配置）；ignored 逐文件展开里没有命中「珍贵模式」的条目——珍贵模式 = 凭据类文件类型（`.env`、密钥/证书/keystore、`*.properties`、kubeconfig、`.kube`/`.docker`/`.azure` 等云凭据目录、`.config/gh`/`gcloud`（项目本地 `GH_CONFIG_DIR` 等 CLI 凭据区）、`*.tfstate*`/`local.settings.json`、`hosts.yml`、`.git-crypt`、凭据命名、本地数据库等，全集见脚本里 `PRECIOUS_PATTERNS`/`PRECIOUS_SUBSTRINGS`）；命中列出文件，其余 ignored 条目收敛到顶层名进报告、超 8 个截断；
- 没有 ls-files 下探不了的目录（嵌套 git 仓库等尾斜杠条目）、没有 git 子模块（`submodule status` 为空）、没有 assume-unchanged/skip-worktree 标记文件（`ls-files -v` 小写或 `S` 标签）——这些路径的内部状态对所有检查不可见，一律不删；
- HEAD 能从某个 `refs/remotes/origin/*` 到达（判定前先对该仓库跑一次 `fetch origin --prune` 刷新本地跟踪引用——远端删过分支后残留的 tracking ref 不代表已推送；远端不可达即 skip；本地孤立提交不丢）。注意 dry-run 也会执行这一步：fetch 需要联网、会更新本地 `refs/remotes/origin/*`（已禁交互凭据提示，缺凭据直接判不可达不卡终端）；
- 没有进程以它为 cwd（POSIX 用 lsof，缺席时 Linux 退 /proc；Windows 不查，靠删除失败兜底）。

`--apply` 在 `git worktree remove` 前对该目录重拍线程绑定/活跃 run/进程占用快照并重查 git 侧全部条件，收窄扫描与执行之间的并发窗口。

数据库 `userdata/statev2.sqlite` 只读打开（node:sqlite 优先，退回 sqlite3 CLI）；缺席或打不开时此根下全部 skip，不做删除。`--apply` 下 `git worktree remove` 成功后用 `git branch -d` 兜底删本地分支（失败保留并注明）；任一步失败标 failed 继续下一个，退出码置非 0；绝不结束进程、不换更强硬的命令重试。

测试：`node <技能目录>/scripts/t3-worktree-gc.test.mjs`——在临时目录造夹具（git 仓库 + 假 origin + 最小 statev2.sqlite），覆盖每条 skip 原因；不碰真实 `~/.t3`。

外部依赖：T3 目前不能解除线程与工作树的绑定、也没有「退回 root」的接口（`t3_worktree_handoff` 只能转入新工作树）；绑定中的工作树只能等线程终结后由 gc 回收，解绑能力依赖 T3 产品改动。

## 已观察到的坑

- 少数 ACP 代理收了 MCP 注入但不暴露工具——先用上面的 `acp-mcp-call` 兜底验证一次再下结论。
- delegated 子代理偶发静默丢失，主代理要做好降级自审。
- `subagents`/`runs` 投影偶发停在 `running`：子线程实际已完工，`task_status` 却一直返回 running。别只信状态轮询，用 `t3_thread_read` 读 `childThreadId` 尾部判断真实进度。
- `mcp__t3-code__*` 偶发报 "Failed to connect to MCP server 't3-code'"，重试即恢复；不行再走 ACP 兜底。
- `mcp_list_tools` 每次会话都重查完整目录，token 开销不小。
- `command_execution` 输出留存不全（见上节），分析失败命令时 stderr 多半拿不到，只能看退出码。

额度查询用 t3-orchestrator 技能的 `scripts/t3-quota.mjs`。
