#!/usr/bin/env node
// 仓库一致性检查：把「新增/修改技能必须同步更新 README」等约定机械化。
//
// 用法：node scripts/check.mjs
// 退出码：0 全部通过；1 存在不一致项。
//
// 检查项：
//   1. AGENTS.md 与 CLAUDE.md 正文一致（首行标题各自命名，忽略；两文件是同一份指令）
//   2. 每个 skills/**/SKILL.md 有 frontmatter，name 与目录名一致，description 非空
//   3. 每个技能在 README.md 中有对应小节（含指向该 SKILL.md 的链接）
//   4. skills/forks/ 下的技能，其 README 小节必须注明「来源」
//   5. scripts/ 下的 .mjs/.py 工具在 README 中有链接

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fails = [];
const fail = (msg) => fails.push(msg);

const readmePath = join(ROOT, "README.md");
const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
if (!readme) fail("README.md 缺失或为空");

// README 按 ### 切小节，便于做「该小节内」的断言
const sections = readme.split(/^### /m).slice(1);

// 1. AGENTS.md / CLAUDE.md 一致
const stripH1 = (t) => t?.replace(/^#[^\n]*\n/, "");
const agents = existsSync(join(ROOT, "AGENTS.md")) ? readFileSync(join(ROOT, "AGENTS.md"), "utf8") : null;
const claude = existsSync(join(ROOT, "CLAUDE.md")) ? readFileSync(join(ROOT, "CLAUDE.md"), "utf8") : null;
if (agents === null || claude === null) fail("AGENTS.md 或 CLAUDE.md 缺失");
else if (stripH1(agents) !== stripH1(claude)) fail("AGENTS.md 与 CLAUDE.md 正文不一致（首行标题各自命名，不计）");

// 2-4. 技能检查
function* walk(dir, depth = 0) {
  if (depth > 5) return;
  for (const e of readdirSync(dir)) {
    if (e.startsWith(".") || e === "node_modules") continue;
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "SKILL.md"))) yield p;
    else yield* walk(p, depth + 1);
  }
}

let skillCount = 0;
const skillsDir = join(ROOT, "skills");
for (const dir of walk(skillsDir)) {
  skillCount++;
  const rel = relative(ROOT, dir).split(sep).join("/");
  const name = dir.split(sep).at(-1);
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");

  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) {
    fail(`${rel}/SKILL.md：缺少 frontmatter`);
  } else {
    const fmName = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const fmDesc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!fmName) fail(`${rel}/SKILL.md：frontmatter 缺 name`);
    else if (fmName !== name) fail(`${rel}/SKILL.md：name "${fmName}" 与目录名 "${name}" 不一致`);
    if (!fmDesc) fail(`${rel}/SKILL.md：frontmatter 缺 description`);
  }

  const link = `(${rel}/SKILL.md)`;
  const section = sections.find((s) => s.includes(link));
  if (!section) {
    fail(`${rel}：README.md 没有指向 ${rel}/SKILL.md 的链接`);
  } else if (rel.startsWith("skills/forks/") && !/来源[:：]/.test(section)) {
    fail(`${rel}：分叉技能的 README 小节缺少「来源」标注`);
  }
}

// 5. 根 scripts/ 工具登记
const scriptsDir = join(ROOT, "scripts");
for (const f of readdirSync(scriptsDir)) {
  if (!/\.(mjs|py|sh)$/.test(f)) continue;
  const rel = `scripts/${f}`;
  if (!readme.includes(rel)) fail(`${rel}：README.md 的工具脚本小节没有登记`);
}

if (fails.length) {
  console.log(`检查未通过（${fails.length} 项）：`);
  for (const f of fails) console.log(`- ${f}`);
  process.exit(1);
}
console.log(`检查通过：${skillCount} 个技能、AGENTS/CLAUDE 一致、scripts 已登记。`);
