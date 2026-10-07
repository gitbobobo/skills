#!/usr/bin/env node
// recall.mjs — 为 recall 技能采集确定性事实（只读：不改库、不写远端、不调写接口）。
// 输出 markdown，由调用它的 agent 综合成简报。API Key 只用于请求头，永不出现在输出里。
//
// 用法：node recall.mjs [issue-ref] [--project <fast-ship-project-uuid>] [--threads N]
//   issue-ref: INT-58 / GH-12 / 纯数字（匹配 Fast Ship reference）
//   --threads N: 深入取尾部消息的线程数，默认 3

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const req = createRequire(import.meta.url);

const args = process.argv.slice(2);
let issueArg = null;
let fsProjectOverride = null;
let threadTailCount = 3;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project") fsProjectOverride = args[++i];
  else if (args[i] === "--threads") threadTailCount = parseInt(args[++i], 10) || 3;
  else if (!args[i].startsWith("--")) issueArg = args[i];
}

const out = [];
const sec = (t) => out.push(`\n## ${t}`);
const line = (s = "") => out.push(s);
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…[截断]" : s);
const warn = [];

function sh(cmd, argv, opts = {}) {
  try {
    return execFileSync(cmd, argv, {
      encoding: "utf8",
      timeout: opts.timeout ?? 15000,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    }).trim();
  } catch (e) {
    return null;
  }
}

// ---------- git ----------
sec("Git 实况");
const top = sh("git", ["rev-parse", "--show-toplevel"]);
const branch = sh("git", ["branch", "--show-current"]);
let ownerRepo = null;
if (!top) {
  line("当前目录不在 git 仓库里。git / gh / T3 线程关联均跳过。");
} else {
  const remote = sh("git", ["remote", "get-url", "origin"]) ?? "";
  const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  ownerRepo = m ? m[1] : null;
  const dirty = sh("git", ["status", "--porcelain"]);
  const upstream = sh("git", ["rev-parse", "--abbrev-ref", "@{u}"]);
  let aheadBehind = null;
  if (upstream) {
    const ab = sh("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (ab) {
      const [behind, ahead] = ab.split(/\s+/);
      aheadBehind = `ahead ${ahead} / behind ${behind}（相对 ${upstream}）`;
    }
  }
  const unpushed = upstream
    ? sh("git", ["log", "@{u}..HEAD", "--oneline"])
    : null;
  const recent = sh("git", ["log", "--oneline", "-8"]);
  line(`- 仓库根：${top}`);
  line(`- 分支：${branch ?? "(detached)"}${upstream ? `，上游 ${upstream}，${aheadBehind}` : "，无上游分支"}`);
  line(`- 未提交变更：${dirty ? dirty.split("\n").length + " 个文件" : "干净"}`);
  if (unpushed) line(`- 未推送提交：\n${unpushed.split("\n").map((l) => `  ${l}`).join("\n")}`);
  line(`- remote：${ownerRepo ?? remote ?? "无"}`);
  if (recent) line(`- 最近提交：\n${recent.split("\n").map((l) => `  ${l}`).join("\n")}`);
}

// ---------- gh ----------
sec("GitHub（gh 实测）");
let prJson = null;
if (top && branch) {
  const raw = sh("gh", [
    "pr", "view", "--json",
    "number,title,state,isDraft,mergedAt,url,headRefName,baseRefName,body,reviewDecision",
  ], { cwd: top });
  if (raw) {
    try { prJson = JSON.parse(raw); } catch {}
  }
}
if (prJson) {
  line(`- 当前分支 PR：#${prJson.number} ${prJson.title}`);
  line(`  ${prJson.url} · ${prJson.state}${prJson.isDraft ? " (draft)" : ""}${prJson.mergedAt ? ` · merged ${prJson.mergedAt}` : ""}${prJson.reviewDecision ? ` · review=${prJson.reviewDecision}` : ""}`);
  const refs = [...new Set((`${prJson.title}\n${prJson.body ?? ""}`).match(/\b(INT|GH)-\d+\b/gi) ?? [])];
  if (refs.length) line(`- PR 标题/正文里的 issue 引用：${refs.join("、")}`);
} else {
  line("当前分支没有关联 PR，或 gh 不可用。");
}

// ---------- T3 本机线程 ----------
sec("T3 本机线程（statev2.sqlite）");
const dbPath = join(homedir(), ".t3", "userdata", "statev2.sqlite");
let dbRows = null;
if (!existsSync(dbPath)) {
  warn.push(`未找到 ${dbPath}——不是 T3 机器或未初始化，本机线程维度缺席。`);
} else {
  dbRows = querySqlite(dbPath);
}
function querySqlite(db) {
  // 优先 node:sqlite（Node ≥22.5 内置），退回 sqlite3 CLI
  try {
    const { DatabaseSync } = req("node:sqlite");
    const d = new DatabaseSync(db, { readOnly: true });
    const q = (sql, ...p) => d.prepare(sql).all(...p);
    return collect(q);
  } catch {}
  const cliCheck = sh("sqlite3", ["--version"]);
  if (cliCheck) {
    const q = (sql) => {
      const r = sh("sqlite3", ["-readonly", "-json", db, sql]);
      return r ? JSON.parse(r) : [];
    };
    return collect(q);
  }
  warn.push("无法读取 statev2.sqlite（node:sqlite 与 sqlite3 CLI 都不可用）");
  return null;
}
function collect(q) {
  const r = { project: null, threads: [], tails: {} };
  try {
    const projects = q("SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL");
    r.project = projects.find((p) => top && (top === p.workspace_root || top.startsWith(p.workspace_root + "/"))) ?? null;
    const pid = r.project?.project_id;
    const threads = pid
      ? q(`SELECT thread_id, title, updated_at, payload_json FROM orchestration_v2_projection_threads
           WHERE project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 12`, pid)
      : q(`SELECT thread_id, title, updated_at, payload_json FROM orchestration_v2_projection_threads
           WHERE deleted_at IS NULL AND payload_json LIKE ? ORDER BY updated_at DESC LIMIT 12`, `%"worktreePath":"${top ?? "__none__"}"%`);
    r.threads = threads.map((t) => {
      let p = {};
      try { p = JSON.parse(t.payload_json); } catch {}
      const prs = [p.linkedPullRequest, p.branchPullRequest, ...(p.pullRequests ?? [])]
        .map((x) => (typeof x === "string" ? x : x?.url ?? (x?.number ? `#${x.number}` : null)))
        .filter(Boolean);
      return {
        id: t.thread_id,
        title: trunc(String(t.title ?? "").replace(/\s+/g, " "), 70),
        updated_at: t.updated_at,
        delegated: t.thread_id.startsWith("thread:delegated-task:"),
        branch: p.branch ?? null, worktree: p.worktreePath ?? null,
        prs: [...new Set(prs)],
      };
    });
    for (const t of r.threads.slice(0, threadTailCount)) {
      const items = q(`SELECT type, payload_json FROM orchestration_v2_projection_turn_items
                       WHERE thread_id=? AND type IN ('user_message','assistant_message')
                       ORDER BY ordinal DESC LIMIT 6`, t.id);
      const counts = q(`SELECT type, COUNT(*) c FROM orchestration_v2_projection_turn_items
                        WHERE thread_id=? GROUP BY type`, t.id);
      const extract = (pj) => {
        try {
          const d = JSON.parse(pj);
          return d.text ?? d.content ?? d.message ?? d.input ?? null;
        } catch { return null; }
      };
      r.tails[t.id] = {
        last_user: trunc(extract(items.find((i) => i.type === "user_message")?.payload_json), 400),
        last_assistant: trunc(extract(items.find((i) => i.type === "assistant_message")?.payload_json), 600),
        counts: Object.fromEntries(counts.map((c) => [c.type, c.c])),
      };
    }
  } catch (e) {
    warn.push(`读取 statev2 出错：${e.message}`);
  }
  return r;
}
if (dbRows) {
  line(dbRows.project
    ? `- T3 项目：${dbRows.project.title}（${dbRows.project.project_id}）`
    : `- 未找到 workspace_root 匹配当前仓库的 T3 项目（可能是 worktree，按 worktreePath 兜底匹配了线程）`);
  if (dbRows.threads.length === 0) line("- 本机没有关联此仓库的线程。");
  for (const t of dbRows.threads) {
    const here = t.worktree && top && t.worktree === top ? "【本工作树】" : "";
    const sameBr = t.branch && branch && t.branch === branch ? "【同分支】" : "";
    line(`- ${t.delegated ? "【子代理】" : ""}${t.title} ${here}${sameBr}`);
    line(`  ${t.id} · 更新于 ${t.updated_at}${t.branch ? ` · 分支 ${t.branch}` : ""}${t.prs.length ? ` · PR ${t.prs.join("、")}` : ""}`);
    const tail = dbRows.tails[t.id];
    if (tail) {
      if (tail.last_user) line(`  最近用户消息：${tail.last_user}`);
      if (tail.last_assistant) line(`  最近助手消息：${tail.last_assistant}`);
    }
  }
}

// ---------- Fast Ship ----------
sec("Fast Ship 需求维度");
const cfgPath = join(homedir(), ".config", "fast-ship", "config.yaml");
async function fsGet(path) {
  const cfg = readFileSync(cfgPath, "utf8");
  const base = cfg.match(/^\s*base_url:\s*["']?(.+?)["']?\s*$/m)?.[1];
  const key = cfg.match(/^\s*api_key:\s*["']?(.+?)["']?\s*$/m)?.[1];
  if (!base || !key) throw new Error("config.yaml 缺 base_url/api_key");
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`${path} → code ${j.code}: ${j.message}`);
  return j.data;
}
if (!existsSync(cfgPath)) {
  warn.push(`未找到 ${cfgPath}（fast-ship 技能未配置），需求维度缺席。`);
} else {
  try {
    let fsProjectId = fsProjectOverride;
    if (!fsProjectId && ownerRepo) {
      const pl = await fsGet("/api/projects?page_size=100");
      const items = pl.items ?? [];
      const key = (p) => `${p.github_owner}/${p.github_repo}`;
      let hit = items.find((p) => key(p) === ownerRepo);
      let via = null;
      if (!hit) {
        // 本机 remote 是 fork 时，试上游 owner/repo
        const parentRaw = sh("gh", ["repo", "view", "--json", "parent", "--jq", ".parent.nameWithOwner"], { cwd: top ?? undefined });
        if (parentRaw) {
          hit = items.find((p) => key(p) === parentRaw);
          if (hit) via = `上游 ${parentRaw}`;
        }
      }
      if (!hit) {
        const repoName = ownerRepo.split("/")[1];
        const named = items.filter((p) => p.github_repo === repoName);
        if (named.length === 1) { hit = named[0]; via = `仅按仓库名匹配（${key(hit)}）`; }
        else if (named.length > 1) warn.push(`仓库名 ${repoName} 命中多个 Fast Ship 项目，需传 --project 指定`);
      }
      fsProjectId = hit?.id ?? null;
      if (hit) line(`- Fast Ship 项目：${hit.name}（${hit.id}）${via ? ` · 经${via}` : ""}`);
    }
    if (!fsProjectId) {
      warn.push(`没有匹配 ${ownerRepo ?? "当前仓库"} 的 Fast Ship 项目，也未传 --project。`);
    } else {
      // 解析 issue：显式参数 > 分支名 > PR 正文引用
      let ref = issueArg;
      if (!ref && branch) {
        const b = branch.match(/\b((?:INT|GH)-\d+)\b/i);
        if (b) ref = b[1].toUpperCase();
      }
      if (!ref && prJson) {
        const b = `${prJson.title}\n${prJson.body ?? ""}`.match(/\b((?:INT|GH)-\d+)\b/i);
        if (b) ref = b[1].toUpperCase();
      }
      let issue = null;
      if (ref) {
        const res = await fsGet(`/api/projects/${fsProjectId}/issues?q=${encodeURIComponent(ref)}`);
        const item = (res.items ?? []).find(
          (i) => i.reference?.toUpperCase() === String(ref).toUpperCase() ||
                 String(i.sequence_number) === String(ref).replace(/^(INT|GH)-/i, "")
        );
        if (item) issue = await fsGet(`/api/issues/${item.id}`);
        else warn.push(`Fast Ship 里没找到 ${ref}`);
      }
      if (!issue) {
        const res = await fsGet(`/api/projects/${fsProjectId}/issues?page_size=100`);
        const doing = (res.items ?? []).filter((i) => i.internal_meta?.workflow_status === "in_progress");
        line("- 未定位到具体 issue（可传 issue-ref 参数）。");
        if (doing.length) {
          line("  该项目进行中的 issue 候选：");
          for (const i of doing) line(`  - ${i.reference} ${i.title}`);
        }
      } else {
        const im = issue.internal_meta ?? {};
        line(`- Issue：${issue.reference} ${issue.title}`);
        line(`  状态 ${issue.state} / workflow ${im.workflow_status} / checklist ${im.checklist_done ?? 0}/${im.checklist_total ?? 0}`);
        const prs = issue.pull_requests ?? [];
        if (prs.length) {
          line(`- 关联 PR（${prs.length}，含 synced_at 快照时间，注意可能滞后）：`);
          for (const p of prs) {
            const fresh = sh("gh", ["pr", "view", p.html_url, "--json", "state,mergedAt"], { cwd: top ?? undefined });
            let freshStr = "";
            if (fresh) {
              try {
                const f = JSON.parse(fresh);
                freshStr = `【实测 ${f.state}${f.mergedAt ? `/${f.mergedAt.slice(0, 10)}` : ""}】`;
              } catch {}
            }
            line(`  - ${p.repo_full_name}#${p.number} ${p.state}${p.is_draft ? "(draft)" : ""} ${freshStr} [${p.link_origin}] ${p.title ?? ""}`);
            line(`    ${p.html_url} · synced ${p.synced_at ?? "?"}`);
          }
        } else line("- 无关联 PR。");
        if (issue.collab?.consensus) line(`- 共识：${trunc(issue.collab.consensus.body ?? issue.collab.consensus, 800)}`);
        if (issue.collab?.summary) line(`- 完成总结：${trunc(issue.collab.summary.body ?? issue.collab.summary, 800)}`);
      }
    }
  } catch (e) {
    warn.push(`Fast Ship 查询失败：${e.message}`);
  }
}

if (warn.length) {
  sec("缺席的数据源");
  for (const w of warn) line(`- ${w}`);
}
console.log(out.join("\n"));
