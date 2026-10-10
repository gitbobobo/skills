#!/usr/bin/env node
// 等待当前 PR 的审查 bot 和 CI 在最新提交上全部回应，然后打印未读过的新意见。
//
// 用法：node pr-review-wait.mjs [--pr <number>] [--timeout <秒>] [--peek]
//   --timeout  最多等待多少秒，默认 1800（覆盖一个 30 分钟无响应窗口；超时退出码 2，再调一次）
//   --peek     只看不记，不把本次输出的意见标记为已读
//   --reset    丢弃已读记录，重新显示最新提交之后的所有意见（对话中断后恢复时用）
//
// 退出码：0 全部回应完毕（或 PR 已合并/关闭）；2 超时仍有审查者未回应，再调用一次；1 出错
//
// 已读记录存在 $(git rev-parse --git-common-dir)/pr-review-loop/ 下，各工作树共享。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const timeoutSec = Number(argValue("--timeout") ?? 1800);
const peek = args.includes("--peek");
const reset = args.includes("--reset");
const POLL_SEC = 90;
// 请求复审后超过这么久还没回应，视为无响应，不再等待
const STALE_MIN = 30;
const isStale = (iso) => Date.now() - Date.parse(iso) > STALE_MIN * 60 * 1000;

// 自己发的回复统一带此标记（HTML 注释，渲染不可见），用于把自己和别人区分开
const REPLY_MARK = "pr-review-loop:reply";

// trigger：请求复审的顶层评论；isArtifact：该审查者的回应
const REVIEWERS = [
  {
    name: "Codex",
    trigger: /^@codex review\s*$/i,
    isArtifact: (item) => item.author === "chatgpt-codex-connector[bot]",
  },
  {
    name: "Code Bot",
    trigger: /^@CodeBot review\s*$/i,
    // 结论借本账号 token 发布，和 agent 回复同作者；排除带标记的回复，防止引用了结论开头的回复被当成新结论
    isArtifact: (item) => item.kind === "comment" && item.body.startsWith("**Code Bot 审查结论") && !item.body.includes(REPLY_MARK),
  },
  {
    name: "Cursor",
    trigger: /^@cursor review\s*$/i,
    isArtifact: (item) => item.author === "cursor[bot]",
  },
  {
    name: "Copilot",
    trigger: /^@copilot review\s*$/i,
    isArtifact: (item) => /^copilot/i.test(item.author),
  },
];
const DEVIN_LOGIN = "devin-ai-integration[bot]";
const DEVIN_STATUS = "Devin Review";

const gh = (...ghArgs) => execFileSync("gh", ghArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const ghJson = (...ghArgs) => JSON.parse(gh(...ghArgs));
// gh <2.66 无 --slurp：用 --jq '.[]' 逐页打平，按行解析等价于合并数组。
const ghPaged = (path) =>
  gh("api", "--paginate", "--jq", ".[]", path)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

function loadPr() {
  const prArg = argValue("--pr");
  return ghJson("pr", "view", ...(prArg ? [prArg] : []), "--json", "number,url,state,headRefOid,headRepository,headRepositoryOwner");
}

function collect(repo, pr, head) {
  const items = [];
  for (const c of ghPaged(`repos/${repo}/issues/${pr.number}/comments`)) {
    items.push({ id: `c${c.id}`, kind: "comment", author: c.user.login, at: c.created_at, body: c.body ?? "", url: c.html_url });
  }
  for (const r of ghPaged(`repos/${repo}/pulls/${pr.number}/reviews`)) {
    if (!r.submitted_at) continue;
    items.push({ id: `r${r.id}`, kind: "review", author: r.user.login, at: r.submitted_at, body: r.body ?? "", url: r.html_url, commit: r.commit_id });
  }
  for (const c of ghPaged(`repos/${repo}/pulls/${pr.number}/comments`)) {
    items.push({
      id: `i${c.id}`, kind: "inline", author: c.user.login, at: c.created_at, body: c.body ?? "", url: c.html_url,
      path: c.path, line: c.line ?? c.original_line, replyTo: c.in_reply_to_id,
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));

  const reviewers = [];
  for (const rv of REVIEWERS) {
    const lastTrigger = items.filter((i) => i.kind === "comment" && rv.trigger.test(i.body.trim())).at(-1);
    const lastArtifact = items.filter(rv.isArtifact).at(-1);
    if (!lastTrigger && !lastArtifact) continue;
    // 「已回应」必须同时晚于最近一次触发和当前 HEAD 提交——推送新提交后，上一轮的意见不算数
    const baseline = [lastTrigger?.at, head.date].filter(Boolean).sort().at(-1);
    const waiting = !lastArtifact || lastArtifact.at < baseline;
    reviewers.push({ name: rv.name, pending: waiting && !isStale(baseline), stale: waiting && isStale(baseline) });
  }

  // Devin 每次推送自动审查，用 HEAD 上的 commit status 判断是否完成
  const statuses = ghJson("api", `repos/${repo}/commits/${head.sha}/status`).statuses;
  const devin = statuses.find((s) => s.context === DEVIN_STATUS);
  const devinSeen = devin || items.some((i) => i.author === DEVIN_LOGIN);
  if (devinSeen) {
    const waiting = !devin || devin.state === "pending";
    const since = devin?.updated_at ?? head.date;
    reviewers.push({ name: "Devin", pending: waiting && !isStale(since), stale: waiting && isStale(since) });
  }

  const checkRuns = ghJson("api", `repos/${repo}/commits/${head.sha}/check-runs?per_page=100`).check_runs;
  const ci = [
    ...checkRuns.map((c) => ({ name: c.name, done: c.status === "completed", ok: ["success", "neutral", "skipped"].includes(c.conclusion) })),
    ...statuses.filter((s) => s.context !== DEVIN_STATUS).map((s) => ({ name: s.context, done: s.state !== "pending", ok: s.state === "success" })),
  ];
  return { items, reviewers, ci };
}

// 意见识别不看作者：Code Bot 结论等借本账号 token 发布，按作者过滤会漏掉它们。
// 排除项：复审触发评论；带 REPLY_MARK 的自己的回复；本账号发的行内回复（历史上无标记，基本是 agent 旧回复）。
// 本账号的其余评论（旧回复、用户手动评论、新格式 bot 结论）宁可显示一次也不漏。
function isFeedback(item, prAuthor) {
  if (REVIEWERS.some((rv) => rv.trigger.test(item.body.trim()))) return false;
  if (item.body.includes(REPLY_MARK)) return false;
  if (item.author === prAuthor && item.kind === "inline" && item.replyTo) return false;
  return item.body.trim().length > 0;
}

function statePath(repo, number) {
  const dir = join(resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()), "pr-review-loop");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${repo.replace("/", "-")}-${number}.json`);
}

function truncate(text, max = 4000) {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，完整内容见链接）` : text;
}

function stripNoise(body) {
  return body.replace(/<!--[\s\S]*?-->/g, "").replace(/<picture>[\s\S]*?<\/picture>/g, "").replace(/<a [^>]*>\s*<\/a>/g, "").trim();
}

// 回复一律发新评论。Code Bot 和 agent 共用账号，改已有评论会覆盖审查结论，所以不给 PATCH/DELETE 的写法。
// 行内意见只能回复到线程的第一条评论，回复的回复也挂到 replyTo 上。
// 命令里自动在正文末尾附上 REPLY_MARK 标记；Windows 不支持 $(cat …)，把标记写进回复文件末尾后用 -F body=@<回复文件>。
function replyCommand(repo, number, item) {
  const body = `-f body="$(cat '<回复文件>'; printf '\\n\\n<!-- ${REPLY_MARK} -->')"`;
  if (item.kind === "inline") {
    const root = item.replyTo ?? item.id.slice(1);
    return `gh api repos/${repo}/pulls/${number}/comments -X POST -F in_reply_to=${root} ${body}`;
  }
  return `gh api repos/${repo}/issues/${number}/comments -X POST ${body}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pr = loadPr();
const repo = `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`;
const prAuthor = ghJson("api", `repos/${repo}/pulls/${pr.number}`).user.login;
console.log(`PR #${pr.number} ${pr.url}`);
console.log(`HEAD ${pr.headRefOid.slice(0, 9)}  状态 ${pr.state}`);
if (pr.state !== "OPEN") process.exit(0);

// 等待期间可能推送新提交，每轮重新取 HEAD；变了就按新提交重算审查基线
function currentHead() {
  const sha = ghJson("pr", "view", String(pr.number), "--json", "headRefOid").headRefOid;
  const date = ghJson("api", `repos/${repo}/commits/${sha}`).commit.committer.date;
  return { sha, date };
}

const deadline = Date.now() + timeoutSec * 1000;
let head = currentHead();
let snapshot = collect(repo, pr, head);
while ((snapshot.reviewers.some((r) => r.pending) || snapshot.ci.some((c) => !c.done)) && Date.now() + POLL_SEC * 1000 < deadline) {
  await sleep(POLL_SEC * 1000);
  const now = currentHead();
  if (now.sha !== head.sha) {
    head = now;
    console.log(`检测到新提交 ${head.sha.slice(0, 9)}，按新 HEAD 重新计算审查与 CI 状态`);
  }
  snapshot = collect(repo, pr, head);
}

const { items, reviewers, ci } = snapshot;
console.log("\n## 审查者");
if (reviewers.length === 0) console.log("- 还没有请求任何审查");
for (const r of reviewers) console.log(`- ${r.name}：${r.pending ? "等待中" : r.stale ? `无响应（超过 ${STALE_MIN} 分钟）` : "已回应"}`);

console.log("\n## CI");
if (ci.length === 0) console.log("- 无");
for (const c of ci) console.log(`- ${c.name}：${!c.done ? "运行中" : c.ok ? "通过" : "失败"}`);

const file = statePath(repo, pr.number);
// 第一次调用时，HEAD 提交之前的意见视为上一轮已处理
const seen = new Set(existsSync(file) && !reset ? JSON.parse(readFileSync(file, "utf8")) : items.filter((i) => i.at < head.date).map((i) => i.id));
const fresh = items.filter((i) => !seen.has(i.id) && isFeedback(i, prAuthor));

console.log(`\n## 新意见（${fresh.length} 条未读）`);
for (const i of fresh) {
  const where = i.kind === "inline" ? ` ${i.path}:${i.line ?? "?"}${i.replyTo ? "（回复）" : ""}` : "";
  console.log(`\n### [${i.kind}] ${i.author} ${i.at}${where}\n${i.url}\n回复：${replyCommand(repo, pr.number, i)}\n\n${truncate(stripNoise(i.body))}`);
}

if (!peek) writeFileSync(file, JSON.stringify([...seen, ...fresh.map((i) => i.id)]));

const stale = reviewers.filter((r) => r.stale).map((r) => r.name);
if (stale.length > 0) console.log(`\n注意：${stale.join("、")} 无响应。可以重新请求一次；仍无响应就停下来告诉用户。`);

const pending = reviewers.some((r) => r.pending) || ci.some((c) => !c.done);
console.log(pending ? "\n结果：仍有审查者或 CI 未完成，处理完上面的新意见后再调用一次。" : "\n结果：所有审查者和 CI 已在最新提交上回应。");
process.exit(pending ? 2 : 0);
