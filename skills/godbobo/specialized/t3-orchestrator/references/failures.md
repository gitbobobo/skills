# 子代理失败处理

`delegate_task` 失败的 `summary` 开头是 provider 的错误原文，按原文分类：

| 类型 | 典型原文 | 处理 |
|---|---|---|
| 临时过载或连接失败 | `at capacity`、`server_is_overloaded`、`503`、`stream disconnected`、`Reconnecting... 5/5`、`runtime stream failed`、`Aborted` | 只记录该入口冷却，确认旧尝试退出后换路 |
| 额度或限流 | 明确的 `usage limit` / `quota` / `credits` 耗尽；`429`、`exceeded retry limit` 需看原文 | 已确认额度耗尽才记录 quota；仅 rate limit 按单入口记录。只有已确认共用额度的入口才共用池标记，不能仅因 429 封禁整个池 |
| 配置或环境 | `provider_unavailable`、`model_unavailable`、`Invalid value ... model`、`is not enabled`、`auth`、`Provider session failed to open`、`does not exist` | 不在原目标重试；重新调 `orchestrator_capabilities` 落盘，换入口 |
| 启动即失败 | 开始后 1 分钟内失败，期间没有任何工具调用，原文不属于上面几类（例如 `Provider turn failed`） | 按配置或环境处理 |
| 权限被拒 | `Permission denied for this tool`、`was denied because this agent is running in the background` | 不在原目标重试。harness 自带子代理改用 `delegate_task` 重派；已是 `delegate_task` 不能升级权限，停下向用户报告被拒的工具 |
| 任务没做好 | 状态是 completed，但结果不达标 | 不算 harness 故障，走验收流程 |
| 长时间无新消息 | activity 很久没有新内容 | `status=working` 不算活着——请求流挂死时状态停 working、零事件。查子线程 provider 日志文件 mtime/大小是否增长、实际编译进程、锁持有者和排队状态；仍在编译或合法排队就继续等待。确认无实际进展再取消，退出确认后才换路 |

## 记录共享冷却

把已查证的失败类别与重置时间写入共享状态；未知重置初始冷却 30 分钟。首次派活及每次换路都先 `status` 检查并用 `claim` 认领入口和已确认的池：`recovery: false` 才派正式实现；`recovery: true` 先做一次轻量额度/连接查询，以 token 回报后重新检查。恢复失败带原 token 延长冷却，成功带原 token 清除标记；失败消耗整个探测 token，旧结果不能再清除其他 scope 的故障。单入口故障不封禁模型家族。

命令语法、kind 取值、token 租约细节见 [quota-state.md](quota-state.md)；池 ID 见 [models.md](models.md)「额度池」。

## 续跑

换路前先弄清上一次尝试做到了哪一步：

1. `t3_thread_read` 读失败的子线程（`childThreadId`），用 activity 视图看它改了什么、卡在哪；
2. `task_status` 与原始日志/实际进程交叉核对。需要取消时调 `task_cancel`；取消请求本身不是退出确认。确认旧写者及其构建子进程已退出、锁已释放，才能启动下一尝试。投影与实际不一致时继续查证，不复制启动同一写任务；仅可结束本任务拥有的进程。
3. 在工作目录看 `git status` 和 `git diff`，核对已完成步骤、失败日志、后台任务及剩余验证。

新提示词沿用委派模板，在「背景」末尾加上：

```text
上一次尝试由 <实例/模型> 执行，因 <错误类型> 中断。
已完成：<步骤与已有检查证据>
工作区已有的改动：<文件列表和源码状态>
失败日志：<原始路径>
后台任务：<PID/任务ID、归属、已确认退出或仍运行>
剩余验证：<检查与唯一负责人>
截图边界：<首次开始时间、累计耗时与崩溃计数，续跑不重置>
先核对这些改动是否正确，在此基础上继续，不要从头开始，也不要回滚。
```
