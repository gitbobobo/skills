#!/usr/bin/env node
// 后台长任务封装：命令输出落日志、结束写状态文件，agent 轮询一个文件即可，不用堆 sleep 链。
//
// 用法：
//   run-watch start <name> [--cwd <dir>] -- <cmd...>   后台启动；同名任务仍在跑则拒绝
//   run-watch status <name>                            打印状态（running/exit=N/dead）+ 日志尾部
//   run-watch tail <name> [行数]                       只打日志尾部（默认 30 行）
//   run-watch stop <name>                              终止任务（杀整个进程组）
//   run-watch list                                     列出全部任务
//
// 每个任务一个目录 $TMPDIR/run-watch-<uid>/<name>/，内含 status / log / pid / cmd。
// status 退出码：完成且命令成功=0，仍在运行=2，命令失败或进程消失=1，用法错误=1。
// 仅支持 POSIX（依赖 sh 与进程组）；Windows 请直接跑前台命令。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `run-watch-${process.getuid?.() ?? "u"}`);
const [action, name, ...rest] = process.argv.slice(2);

const die = (msg) => {
  console.error(msg);
  console.error("用法：run-watch start <name> [--cwd <dir>] -- <cmd...> | status <name> | tail <name> [n] | stop <name> | list");
  process.exit(1);
};

const dirOf = (n) => join(ROOT, n);
const fileOf = (n, f) => join(dirOf(n), f);
const read = (n, f) => (existsSync(fileOf(n, f)) ? readFileSync(fileOf(n, f), "utf8").trim() : "");
const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};
// status 文件：running | exit=N；进程消失但没写 exit 视为 dead
const statusOf = (n) => {
  const s = read(n, "status");
  if (!s) return "unknown";
  if (/^\d+$/.test(s)) return `exit=${s}`;
  if (s === "running" && !alive(read(n, "pid"))) return "dead";
  return s;
};
const validName = (n) => /^[\w][\w.-]*$/.test(n ?? "");
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function tail(n, lines = 30) {
  const log = fileOf(n, "log");
  if (!existsSync(log)) return console.log("（无日志）");
  const rows = readFileSync(log, "utf8").split("\n");
  process.stdout.write(rows.slice(-lines).join("\n"));
}

switch (action) {
  case "start": {
    if (!validName(name)) die("需要合法任务名（字母数字._-）");
    const sep = rest.indexOf("--");
    const cmd = sep === -1 ? rest : rest.slice(sep + 1);
    const cwdIdx = rest.indexOf("--cwd");
    const cwd = cwdIdx !== -1 ? rest[cwdIdx + 1] : process.cwd();
    if (cmd.length === 0) die("start 需要在 -- 后给出命令");
    if (statusOf(name) === "running") die(`任务 ${name} 仍在运行（${dirOf(name)}）`);
    mkdirSync(dirOf(name), { recursive: true });
    writeFileSync(fileOf(name, "status"), "running"); // 先写状态，避免快命令结束后被覆盖
    writeFileSync(fileOf(name, "cmd"), cmd.join(" "));
    const log = fileOf(name, "log");
    closeSync(openSync(log, "w"));
    const script = `${cmd.map(q).join(" ")} >${q(log)} 2>&1; echo "exit=$?" >${q(fileOf(name, "status"))}`;
    const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore", cwd });
    child.unref();
    writeFileSync(fileOf(name, "pid"), String(child.pid));
    console.log(`已启动 ${name}（进程组 ${child.pid}）\n日志：${log}\n轮询：run-watch status ${name}`);
    break;
  }
  case "status": {
    if (!validName(name)) die("需要任务名");
    const s = statusOf(name);
    const cmd = read(name, "cmd");
    console.log(`${name}：${s}${cmd ? `  cmd: ${cmd}` : ""}`);
    tail(name);
    if (s === "running") process.exit(2);
    process.exit(s === "exit=0" ? 0 : 1);
  }
  case "tail": {
    if (!validName(name)) die("需要任务名");
    tail(name, Number(rest[0]) || 30);
    break;
  }
  case "stop": {
    if (!validName(name)) die("需要任务名");
    const pid = read(name, "pid");
    if (statusOf(name) !== "running") die(`任务 ${name} 未在运行（${statusOf(name)}）`);
    try {
      process.kill(-Number(pid), "SIGTERM"); // detached 启动，pid 即进程组 id
    } catch {
      process.kill(Number(pid), "SIGTERM");
    }
    writeFileSync(fileOf(name, "status"), "stopped");
    console.log(`已终止 ${name}`);
    break;
  }
  case "list": {
    if (!existsSync(ROOT)) break;
    for (const n of readdirSync(ROOT)) console.log(`${n}\t${statusOf(n)}\t${read(n, "cmd")}`);
    break;
  }
  default:
    die(action ? `未知动作 ${action}` : "缺少动作");
}
