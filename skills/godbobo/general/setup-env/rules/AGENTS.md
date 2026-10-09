# 全局代理规则

适用于所有仓库；项目内的 AGENTS.md 优先于本文件。

## 执行命令

- 重命令（构建、生成、全仓库检查、E2E）遵守本机配置的调度入口与资源限额，排队时检查日志、进程和锁持有者后再判断是否卡住。
- 同一功能任务始终只有一个最终验证负责人；已有检查证据须核对最终源码、工具链和覆盖，变化或缺口由该负责人补跑。

- 需要靠退出码判断成败的命令（构建、测试、部署、写请求），不要 `| tail` / `| head` 截断——管道返回的是末段命令的退出码，会掩盖真实失败。输出大就重定向到文件再截尾：

  ```bash
  cmd > /tmp/x.log 2>&1; s=$?; tail -30 /tmp/x.log; echo "exit=$s"
  ```

- 等待长任务（构建、e2e、后台服务）：后台跑、日志落文件，轮询同一份日志和进程状态；不要堆叠 `sleep N && ...` 链，也不要把长命令放前台同步等到超时再回头查日志。终端工具自带后台执行（exec 的后台模式加输出轮询）时优先用，其次 `run-watch`：`run-watch start <名> -- <命令>` 起后台任务，`run-watch status <名>` 查状态（退出码：还在跑=2、成功=0、失败=1）。有对应的原生完成通知或 watcher 时使用事件唤醒并结束当前轮等待；缺少原生能力时使用仓库或技能的 wait 脚本，长脚本后台执行。
- 向外部服务发非 ASCII 内容（中文评论、JSON 体）：先写 UTF-8 无 BOM 文件再引用——`gh --body-file`、`gh api --input`、`curl --data-binary @file`；不内联、不经 stdin 管道。

## gh api 陷阱

- `-F` 把以 `@` 开头的值当文件路径（`-F body='@codex review'` 会去读文件）。字面量用 `-f`；较长的正文写文件后 `-F body=@file` 或 `--input file`。
- issue/PR comments 接口不支持 `direction=desc` 排序；取最新评论用 `?per_page=100` 后在结果尾部筛选。
- 发短评论优先 `gh pr comment <n> --body '...'` / `gh issue comment`，不手写 `gh api` 评论端点。

## 工作树与收尾

- 永不删除自己所在的工作树，也不删除仍被 T3 线程绑定的工作树。shell 的 cwd 与线程绑定是两回事：删掉绑定目录后该线程的终端永久失效（spawn 在命令运行前失败，`cd` 救不回来）。
- 自己工作树的回收交给后续会话：收尾只清理其他已结束的工作树，统一跑 `node ~/.agents/skills/t3-code/scripts/t3-worktree-gc.mjs --apply`（内部已核对线程绑定、脏检查、本地提交、进程占用）。该脚本属于 t3-code 专用技能：非 T3 机器或脚本文件不存在（`test -f ~/.agents/skills/t3-code/scripts/t3-worktree-gc.mjs`）时跳过此步并在回复中说明，不要因报错改用手工删除兜底。
- 收尾顺序：更新 Fast Ship 状态 → 核验 PR 状态并 sync → 写接续记录 → 处理本地分支 → 运行 t3-worktree-gc --apply（脚本不存在则跳过）→ 输出最终回复。

## macOS 环境

- 没有 `setsid`、`timeout`；命令超时会连同整个进程组被杀。需要脱离会话存活的进程用 `nohup cmd >log 2>&1 & disown` 或工具自带的 detached 选项。
- exec 报 "terminal failed to create" / 目录不存在：会话 cwd（典型是被删除的 git worktree）失效后不可恢复——终端在命令运行前就失败，`cd` 救不回来。不要重试；结束本轮并向用户说明哪些收尾步骤没做（Fast Ship 状态、PR sync、分支清理、工作树回收），等用户在有效目录里开新会话接手。

## Windows 环境

### 删除目录和工作树

背景：曾有代理在 PowerShell 里执行 `cmd /c "rmdir /s /q \"$target\""`。PowerShell 不把 `\"` 当作转义，cmd 实际执行的是 `rmdir /s /q \ <路径>`，从 D 盘根目录开始递归删除，毁掉了多个工作树和开发环境。

- 删除目录只允许两种写法：`git worktree remove --force '<绝对路径>'`，或 PowerShell 的 `Remove-Item -LiteralPath '\\?\<盘符>:\<完整路径>' -Recurse -Force`。`\\?\` 前缀不能省，Windows PowerShell 5.1 不带它就删不掉超过 260 字符的深层路径。前缀后面只能用反斜杠，不能有 `..`。
- 路径必须是写死的完整绝对路径，不要用变量拼接。变量一旦为空，目标就会退化成当前目录或根目录。
- 禁止用 `cmd /c rmdir /s`、`rd /s`、`del /s`、`rm -rf` 删除 Windows 上的目录，从 WSL 访问的 `/mnt/<盘符>/` 路径同样适用。不要在 PowerShell 里嵌套 cmd，也不要用 `\"` 转义引号，PowerShell 的转义符是反引号。
- 删除失败（文件被占用、权限不足、路径过长）就停下，列出没删掉的内容交给用户处理。不要换更强硬的命令重试，也不要为了解锁去结束不是你启动的进程。
- 只删「其他已结束且确认无活动代理」的工作树。删除前用 `git worktree list` 核对注册与检出分支，并确认没有 T3 线程仍绑定该目录（T3 机器上优先跑 `t3-worktree-gc.mjs`，内部已做全套核对）。发现占用或其他代理/会话正在写文件，就停下来问用户，不要删除。
