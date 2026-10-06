#!/usr/bin/env node
// 把本技能 rules/AGENTS.md 链接为各 agent harness 的全局规则文件。
//
// 用法：node setup-env.mjs [--check] [--copy]
//   --check  只报告各目标状态，不做任何改动
//   --copy   不建符号链接，改为复制文件（Windows 无开发者模式/权限时用）
//
// 退出码：0 全部就位；2 存在待处理项或部分失败；1 环境错误。
//
// 已有非空文件会先备份成 <path>.bak-<时间戳> 再替换；符号链接已指向真源则跳过。
// Cursor 目标写入派生的 .mdc（包裹 alwaysApply frontmatter），不走符号链接。

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const IS_WIN = platform() === "win32";
const APPDATA = process.env.APPDATA || join(HOME, "AppData", "Roaming");

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../rules/AGENTS.md");

// 各 harness 的全局规则文件路径。devin 文档同时会读 ~/.claude/CLAUDE.md，
// claudeAgent 也读它，一份文件覆盖两家。
const TARGETS = [
  {
    harness: "devin",
    path: IS_WIN ? join(APPDATA, "devin", "AGENTS.md") : join(HOME, ".config", "devin", "AGENTS.md"),
    cli: "devin",
  },
  {
    harness: "codex",
    path: join(HOME, ".codex", "AGENTS.md"),
    cli: "codex",
  },
  {
    harness: "claude / claudeAgent",
    path: join(HOME, ".claude", "CLAUDE.md"),
    cli: "claude",
  },
  {
    harness: "opencode",
    path: IS_WIN ? join(APPDATA, "opencode", "AGENTS.md") : join(HOME, ".config", "opencode", "AGENTS.md"),
    cli: "opencode",
  },
  {
    // cursor-agent 扫描 ~/.cursor/rules 下的 .mdc；alwaysApply 前置元数据让它始终生效。
    // 不能符号链接到 AGENTS.md——内容需要包裹 frontmatter，只能写派生文件。
    harness: "cursor",
    path: join(HOME, ".cursor", "rules", "global.mdc"),
    cli: "cursor-agent",
    transform: "mdc",
  },
  {
    // Factory Droid 的个人指令层：docs.factory.ai 确认 ~/.factory/AGENTS.md 跨项目生效。
    // （Droid 另会检查 ~/.agents/、~/.agent/ 个人目录，取 ~/.factory 为主。）
    harness: "factory droid",
    path: join(HOME, ".factory", "AGENTS.md"),
    cli: "droid",
  },
];

// 安装到 ~/.local/bin 的工具命令（仅 POSIX；Windows 跳过，直接用 node 调脚本）
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BINDIR = join(HOME, ".local", "bin");
const BINS = [{ name: "run-watch", src: join(SCRIPT_DIR, "run-watch.mjs") }];

const MDC_FRONT = "---\nalwaysApply: true\n---\n\n";
const expectedFor = (t) => (t.transform === "mdc" ? MDC_FRONT + sourceText : sourceText);

const checkOnly = process.argv.includes("--check");
const useCopy = process.argv.includes("--copy") || IS_WIN;
const sourceReal = realpathSync(SOURCE);
const sourceText = readFileSync(SOURCE, "utf8");
const stamp = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 12);

const which = (cmd) => {
  try {
    return execFileSync(IS_WIN ? "where" : "which", [cmd], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
};

// 返回 { state, detail }；state: linked | copy-current | copy-stale | foreign-empty | foreign | absent
function inspect(t) {
  const path = t.path;
  if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) return { state: "absent" };
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    const target = resolve(dirname(path), readlinkSync(path));
    try {
      return realpathSync(target) === sourceReal && !t.transform
        ? { state: "linked" }
        : { state: "foreign", detail: `符号链接指向 ${target}` };
    } catch {
      return { state: "foreign", detail: `悬空符号链接 → ${target}` };
    }
  }
  const content = readFileSync(path, "utf8");
  if (content === expectedFor(t)) return { state: "copy-current" };
  return content.trim() === ""
    ? { state: "foreign-empty" }
    : { state: "foreign", detail: `已有 ${content.length} 字符的不同内容` };
}

function apply(t, state) {
  const path = t.path;
  mkdirSync(dirname(path), { recursive: true });
  let note = "";
  if (state === "foreign" || state === "foreign-empty") {
    const bak = `${path}.bak-${stamp}`;
    renameSync(path, bak);
    note = `备份到 ${bak}，`;
  }
  if (t.transform || useCopy) {
    writeFileSync(path, expectedFor(t));
    return `${note}已写入`;
  }
  symlinkSync(SOURCE, path);
  return `${note}已链接`;
}

let pending = 0;
console.log(`真源：${SOURCE}`);
console.log(`模式：${checkOnly ? "check（只读）" : useCopy ? "copy" : "symlink"}\n`);

for (const t of TARGETS) {
  const cliPath = which(t.cli);
  const { state, detail } = inspect(t);
  const cliInfo = cliPath ? `cli: ${cliPath}` : `cli: 未安装（${t.cli}）`;
  let action = "";
  if (!checkOnly && state !== "linked" && state !== "copy-current") {
    try {
      action = ` → ${apply(t, state)}`;
    } catch (e) {
      action = ` → 失败：${e.message}`;
      pending++;
    }
    // 应用后复查
    if (!action.includes("失败")) {
      const post = inspect(t).state;
      if (!(t.transform || useCopy ? post === "copy-current" : post === "linked")) {
        action += "（复查未生效）";
        pending++;
      }
    }
  } else if (state !== "linked" && state !== "copy-current") {
    pending++;
  }
  const label = { linked: "已链接", "copy-current": "副本一致", "copy-stale": "副本过期", absent: "缺失", foreign: "有别的内容", "foreign-empty": "空文件" }[state];
  console.log(`${label.padEnd(6)} ${t.harness.padEnd(20)} ${t.path}   ${cliInfo}${detail ? `（${detail}）` : ""}${action}`);
}

// ---- 工具命令：链接到 ~/.local/bin ----
if (IS_WIN) {
  console.log("\n跳过     tools              Windows 不安装 bin 链接，用 node 直接调用 scripts/ 下脚本");
} else {
  for (const b of BINS) {
    const dest = join(BINDIR, b.name);
    const srcReal = realpathSync(b.src);
    const ok = () => {
      try {
        return lstatSync(dest).isSymbolicLink()
          ? realpathSync(dest) === srcReal
          : existsSync(dest) && readFileSync(dest, "utf8") === readFileSync(b.src, "utf8");
      } catch {
        return false;
      }
    };
    let state = existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false }) ? (ok() ? "linked" : "foreign") : "absent";
    let action = "";
    if (!checkOnly && state !== "linked") {
      try {
        mkdirSync(BINDIR, { recursive: true });
        let note = "";
        if (state === "foreign") {
          const bak = `${dest}.bak-${stamp}`;
          renameSync(dest, bak);
          note = `备份到 ${bak}，`;
        }
        chmodSync(b.src, 0o755);
        if (useCopy) {
          writeFileSync(dest, readFileSync(b.src, "utf8"));
          chmodSync(dest, 0o755);
        } else {
          symlinkSync(b.src, dest);
        }
        action = ` → ${note}${useCopy ? "已复制" : "已链接"}`;
        state = ok() ? "linked" : "foreign";
      } catch (e) {
        action = ` → 失败：${e.message}`;
      }
    }
    if (state !== "linked") pending++;
    const label = { linked: "已链接", foreign: "有别的内容", absent: "缺失" }[state];
    console.log(`${label.padEnd(6)} tool:${b.name.padEnd(14)} ${dest}${action}`);
  }
}

console.log(
  pending === 0
    ? "\n全部就位。"
    : checkOnly
      ? `\n${pending} 个目标待处理；去掉 --check 执行。`
      : `\n${pending} 个目标处理失败，见上方输出。`,
);
process.exit(pending === 0 ? 0 : 2);
