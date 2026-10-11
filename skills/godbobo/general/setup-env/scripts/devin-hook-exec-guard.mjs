#!/usr/bin/env node
// Devin PreToolUse hook（exec）：阻断会长时间阻塞回合的前台 sleep。
//
// 全局约定禁止「sleep N && ...」轮询链——每条都是一次被完全阻塞的回合。
// 阈值：sleep ≥ 60 秒（sleep 5m / 1h 同样命中）；紧跟 & 的后台 sleep 放行。
//
// 契约：stdin 收 PreToolUse 事件 JSON；exit 2 + stderr 即阻断并把信息回给
// 代理；其余情况 exit 0。解析失败一律放行，绝不因 hook 自身故障误拦。

const BLOCK_SECONDS = 60;

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let command = "";
try {
  command = JSON.parse(raw)?.tool_input?.command ?? "";
} catch {
  process.exit(0);
}
if (typeof command !== "string" || command === "") process.exit(0);

const seconds = (num, unit) => {
  const n = Number.parseFloat(num);
  if (unit === "m") return n * 60;
  if (unit === "h") return n * 3600;
  if (unit === "d") return n * 86400;
  return n;
};

// heredoc 里的 sleep 是写文件内容不是执行，整串放行（宁可漏拦不误拦）。
if (!command.includes("<<")) {
  // sleep 必须处于命令位置（行首或在 ; & | && || $( ` 换行之后），
  // 命中 `echo sleep 300` 这类非执行语境的概率随之归零；
  // match 后紧跟单个 &（非 &&）视为后台任务放行。
  const SLEEP_RE = /(?:^|[;&|\n]|\$\(|`|&&|\|\|)\s*sleep\s+([0-9]+(?:\.[0-9]+)?)([smhd]?)/g;
  let hit = null;
  for (const m of command.matchAll(SLEEP_RE)) {
    if (seconds(m[1], m[2]) < BLOCK_SECONDS) continue;
    const rest = command.slice(m.index + m[0].length);
    if (/^\s*&(?!\s*&)/.test(rest)) continue;
    hit = m;
    break;
  }
  if (hit) {
    console.error(
      `已阻断：前台 \`${hit[0].trim()}\` 会阻塞本回合（约定禁止 sleep N && 轮询链）。\n` +
        `等待长任务请改用：exec 后台模式（timeout=0）+ get_output 轮询同一日志；` +
        `或 run-watch start <名> -- <命令>，run-watch status <名> 查状态。`,
    );
    process.exit(2);
  }
}
process.exit(0);
