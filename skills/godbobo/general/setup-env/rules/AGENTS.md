# 全局代理规则

适用于所有仓库；项目内的 AGENTS.md 优先于本文件。

## 执行命令

- 需要靠退出码判断成败的命令（构建、测试、部署、写请求），不要 `| tail` / `| head` 截断——管道返回的是末段命令的退出码，会掩盖真实失败。输出大就重定向到文件再截尾：

  ```bash
  cmd > /tmp/x.log 2>&1; s=$?; tail -30 /tmp/x.log; echo "exit=$s"
  ```

- 等待长任务（构建、e2e、后台服务）：后台跑、日志落文件，轮询同一份日志和进程状态；不要堆叠 `sleep N && ...` 链，也不要把长命令放前台同步等到超时再回头查日志。终端工具自带后台执行（exec 的后台模式加输出轮询）时优先用，其次 `run-watch`：`run-watch start <名> -- <命令>` 起后台任务，`run-watch status <名>` 查状态（退出码：还在跑=2、成功=0、失败=1）。仓库或技能自带 wait 类脚本时一律用脚本。
- 向外部服务发非 ASCII 内容（中文评论、JSON 体）：先写 UTF-8 无 BOM 文件再引用——`gh --body-file`、`gh api --input`、`curl --data-binary @file`；不内联、不经 stdin 管道。

## gh api 陷阱

- `-F` 把以 `@` 开头的值当文件路径（`-F body='@codex review'` 会去读文件）。字面量用 `-f`；较长的正文写文件后 `-F body=@file` 或 `--input file`。
- issue/PR comments 接口不支持 `direction=desc` 排序；取最新评论用 `?per_page=100` 后在结果尾部筛选。
- 发短评论优先 `gh pr comment <n> --body '...'` / `gh issue comment`，不手写 `gh api` 评论端点。

## macOS 环境

- 没有 `setsid`、`timeout`；命令超时会连同整个进程组被杀。需要脱离会话存活的进程用 `nohup cmd >log 2>&1 & disown` 或工具自带的 detached 选项。
- exec 报 "terminal failed to create" / 目录不存在：会话 cwd（典型是被删除的 git worktree）失效，先在命令里 `cd` 到存在的目录再重试。

## Windows 环境

### 删除目录和工作树

背景：曾有代理在 PowerShell 里执行 `cmd /c "rmdir /s /q \"$target\""`。PowerShell 不把 `\"` 当作转义，cmd 实际执行的是 `rmdir /s /q \ <路径>`，从 D 盘根目录开始递归删除，毁掉了多个工作树和开发环境。

- 删除目录只允许两种写法：`git worktree remove --force '<绝对路径>'`，或 PowerShell 的 `Remove-Item -LiteralPath '\\?\<盘符>:\<完整路径>' -Recurse -Force`。`\\?\` 前缀不能省，Windows PowerShell 5.1 不带它就删不掉超过 260 字符的深层路径。前缀后面只能用反斜杠，不能有 `..`。
- 路径必须是写死的完整绝对路径，不要用变量拼接。变量一旦为空，目标就会退化成当前目录或根目录。
- 禁止用 `cmd /c rmdir /s`、`rd /s`、`del /s`、`rm -rf` 删除 Windows 上的目录，从 WSL 访问的 `/mnt/<盘符>/` 路径同样适用。不要在 PowerShell 里嵌套 cmd，也不要用 `\"` 转义引号，PowerShell 的转义符是反引号。
- 删除失败（文件被占用、权限不足、路径过长）就停下，列出没删掉的内容交给用户处理。不要换更强硬的命令重试，也不要为了解锁去结束不是你启动的进程。
- 只删除属于当前任务的工作树。删除前用 `git worktree list` 和 `git -C '<工作树路径>' status -sb` 确认它检出的是当前任务的分支。发现其他代理或会话正在这个工作树里写文件，就停下来问用户，不要删除。
