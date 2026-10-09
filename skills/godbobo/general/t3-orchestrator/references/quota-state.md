# 跨线程失败状态

`scripts/quota-state.mjs` 记录本机实际失败，不代替 `t3-quota.mjs` 的实时额度查询。默认写入 `${XDG_CACHE_HOME:-~/.cache}/t3-orchestrator/`，不写工作树，不记录密钥或原始错误文本。`--cache-dir` 仅用于隔离测试/专门配置。

入口 ID 用 `<providerInstanceId>/<model>`；池 ID 从 `models.md` 的额度池与本机账号事实确认，跨线程保持一致。同模型的不同服务商通常不是同一个池；同一 provider 的不同模型也可能分池。池关系未确认时只记录入口。

每次选择/换路先 `status`，在实际派发前用 `claim` 原子检查入口及已确认的池。`check` 只供诊断，不能授权恢复探测。`claim` 返回 `recovery: false` 才能正式派实现；`recovery: true` 只授权一次轻量额度/连接查询，绝不以实现委派充当探测。先按结果 success/fail，成功清除后重新 claim，确认 recovery 为 false 再派活。下面的 `codex-pro` 只适用于已查证同账号的 Codex Pro 池：

```bash
node <技能目录>/scripts/quota-state.mjs status
node <技能目录>/scripts/quota-state.mjs claim --entry codex/gpt-6.1-sol --pool codex-pro --confirmed-pool
node <技能目录>/scripts/quota-state.mjs fail --entry codex/gpt-6.1-sol --kind quota --pool codex-pro --confirmed-pool --reset-at 2026-10-10T09:00:00Z
node <技能目录>/scripts/quota-state.mjs fail --entry cursor/grok-4.7 --kind connection
node <技能目录>/scripts/quota-state.mjs success --entry codex/gpt-6.1-sol --pool codex-pro --confirmed-pool --token <claim返回的token>
```

- 退出码 `0` 已应用/允许，`2` 冷却、别的线程持有探测或 token 已过期（未写入/未清除），`1` 参数、缓存或锁错误。错误先排查，不绕过共享状态重复派活。
- 明确额度耗尽用 `quota`；普通 429 用 `rate_limit`，连接/过载/配置分别用 `connection` / `overload` / `configuration`，这些只写入口作用域；`--pool` 可携带已认领的池上下文，但不会把入口故障记到池。原始错误保留在交接证据中，不传入缓存。
- 已知未来重置时间优先；后续无重置信息的失败保留已知时间，新查证的时间才覆盖。未知时省略 `--reset-at`：初始 30 分钟，连续失败逐次翻倍，最高 4 小时。到期不是永久解禁，只有一个 `claim` 能拿到恢复 token；入口和池同时到期时在同一锁内认领。
- 恢复探测先采用已有轻量额度/连接查询；不要把数小时实现当探测。10 分钟租约内成功带原 token 清除标记；恢复失败用 `fail --token <原token>`，与成功一样核对租约；过期或已被新探测替换的失败不落记录。恢复时错误类型可从入口故障变为池耗尽，或从池耗尽变为入口连接故障；继续携带 claim 的入口与池上下文，按实际类别记录。目标已有另一轮失败时保留它；失败消耗此次 token 的全部租约；原有其他 scope 的故障未经成功验证仍保留，retryAt 至少保留到原租约截止，再允许下一次探测。随后用旧 token 回报成功或失败均不能改动记录。调用方同时核对 JSON 中的 allowed/recovery/recorded/cleared 和退出码，不把未应用当成冷却已延长。普通任务的首次失败省略 token。确认旧尝试退出后再换路。超时或遗失 token 时保留标记，租约到期再允许一次探测。晚到的成功不能清除新失败。
- 原子 rename 保存 JSON，互斥目录锁串行更新。锁等待最多 5 秒；崩溃遗留锁会明确报错，检查 `state.lock/owner.json` 的 PID 和实际进程，确认退出后才移除这个锁目录。缓存损坏保留原文件并报错，不静默清空。
- 共享状态不改变路由、权限或每子任务最多 4 次尝试限制。新的轮次延续原计数和已有交接。

隔离行为测试：`node --test <技能目录>/scripts/quota-state.test.mjs`。
