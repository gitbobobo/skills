#!/usr/bin/env node
// t3-worktree-gc.mjs — 回收 ~/.t3/worktrees/ 下「其他已终结线程」留下的孤儿工作树。
//
// 背景：T3 线程把工作区绑定到工作树后没有解绑接口；绑定中的目录被删会让该线程
// 的终端永久失效（spawn 在命令运行前失败，cd 救不回来）。所以本脚本只回收
// 「没有任何存活线程绑定」的工作树；调用者自己所在的工作树同样永不删除——
// 自己工作树的回收交给后续会话收尾时跑本脚本。
//
// 用法：
//   node t3-worktree-gc.mjs              # dry-run：逐目录打印结论，不删任何东西
//   node t3-worktree-gc.mjs --apply      # 真正执行 git worktree remove
//   node t3-worktree-gc.mjs --root <dir> # 单独指定扫描根
//
// 环境变量 T3CODE_HOME 覆盖 ~/.t3（worktrees=<home>/worktrees、
// 数据库=<home>/userdata/statev2.sqlite），主要给测试夹具用。
//
// 目录布局容忍两种：<root>/<工作树> 或 <root>/<分组名>/<工作树名>（分组名是
// 原仓库目录名，如 ~/.t3/worktrees/musiver/t3code-abc123）。
//
// 回收条件——全部满足才删，任一不满足则 skip 并注明原因：
//   a. 不是调用者自己所在的工作树（process.cwd() 的 realpath 不在其内）；
//   b. 是 git 链接工作树（rev-parse 成功且 --git-dir 与 --git-common-dir 解析后
//      不同；相同是独立 clone。非 git 目录/gitfile 失效标 not-a-worktree 只报告）；
//   c. DB 里 worktreePath 等于该路径的线程全部已终结（settledOverride='settled'、
//      archived 或 deleted 任一）；有未终结线程则区分主线程/委派线程报告。零绑定
//      允许回收，报告标 unbound；
//   d. 绑定线程没有 queued/preparing/starting/running/waiting 状态的 run；
//   e. 数据库文件不存在或打不开：此根下所有工作树全部 skip，「数据库缺席，不做删除」；
//   f. git status --porcelain 为空，且 --ignored 展开里没有命中「珍贵模式」的
//      条目（珍贵模式 = 凭据类文件类型：.env、密钥/证书/keystore、properties、
//      kubeconfig、凭据命名、本地数据库等，见 PRECIOUS_PATTERNS；node_modules、
//      构建产物不命中，照常可删，条目名列进报告、超 8 个截断）；
//   g. HEAD 可从某个 refs/remotes/origin/* 到达（merge-base --is-ancestor 任一为真；
//      本地孤立提交不能丢）；
//   h. 没有进程以它为 cwd（POSIX 用 lsof -d cwd -Fn；lsof 缺席时 Linux 退 /proc
//      读 cwd 链接。非 Windows 上检查不可用也是阻断原因——宁可错杀不可错放；
//      Windows 不做此检查，靠删除失败兜底）。
//
// 线程绑定/活跃 run/进程占用都可能在扫描期间变化：扫描阶段各取一份快照，
// --apply 真正删除前会对该目录重拍这三份快照复查一遍（收窄 TOCTOU 窗口）。
// 残余窗口——线程恰在复查后复活或新绑定该目录——只能靠 T3 提供解绑/互斥
// 接口才能彻底消除。
//
// 删除动作（仅 --apply）：重拍复查通过后先记分支名（symbolic-ref，detached
// 记空），git --git-dir <gitCommonDir> worktree remove <dir>，成功后
// git branch -d 兜底删本地分支（失败保留并注明）。--git-dir 直传公共 git
// 目录，兼容 bare / 独立 git-dir 布局，不推导主仓库路径。任何一步失败标
// failed 继续下一个；绝不结束进程、绝不换更强硬的命令重试。
//
// 数据库只读打开：优先 node:sqlite 的 DatabaseSync(path,{readOnly:true})，
// 退回 sqlite3 -readonly -json CLI，都不行视为数据库缺席。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const req = createRequire(import.meta.url);

// ---------- 参数 ----------
const args = process.argv.slice(2);
let apply = false;
let rootOverride = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") apply = true;
  else if (args[i] === "--root") {
    const v = args[++i];
    // 缺值或以 -- 开头：拒绝静默回退真实 ~/.t3（--apply --root 会误删真实工作树）
    if (v === undefined || v.startsWith("--")) {
      console.error(`--root 需要目录参数\n用法：node t3-worktree-gc.mjs [--apply] [--root <dir>]`);
      process.exit(2);
    }
    rootOverride = v;
  } else {
    console.error(`未知参数：${args[i]}\n用法：node t3-worktree-gc.mjs [--apply] [--root <dir>]`);
    process.exit(2);
  }
}

const t3Home = process.env.T3CODE_HOME || join(homedir(), ".t3");
const scanRoot = resolve(rootOverride ?? join(t3Home, "worktrees"));
const dbPath = join(t3Home, "userdata", "statev2.sqlite");
const isWindows = platform() === "win32";

// ---------- 工具 ----------
// 数组传参，禁止拼 shell 字符串；失败不抛异常，由调用处按保守策略处理。
function shErr(cmd, argv, opts = {}) {
  try {
    const out = execFileSync(cmd, argv, {
      encoding: "utf8",
      timeout: opts.timeout ?? 15000,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    return { ok: false, out: "", err: String(e.stderr?.toString() || e.message).trim() };
  }
}
const sh = (cmd, argv, opts = {}) => {
  const r = shErr(cmd, argv, opts);
  return r.ok ? r.out : null;
};

// 忽略文件里的「珍贵模式」：凭据类文件类型，命中任何路径段即阻断删除
//（大小写不敏感）。node_modules / 构建产物这类 ignored 不命中，照常可删、
// 条目名截断列进报告。
const PRECIOUS_PATTERNS = [
  // 环境变量与常藏凭据的配置
  ".env*",
  "*.properties",
  "*.tfvars",
  "secrets.*",
  "*.token",
  // 密钥 / 证书 / 钥匙串
  "*.pem",
  "*.key",
  "*.crt",
  "*.cer",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.keytab",
  "*.ppk",
  "*.mobileprovision",
  "*.ovpn",
  "id_*",
  // 凭据命名、口令库与各平台账号目录/文件
  "*credential*",
  "*secret*",
  ".htpasswd",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".ssh",
  ".gnupg",
  ".aws",
  ".pypirc",
  ".npmrc",
  ".gitconfig",
  ".dockercfg",
  "kubeconfig*",
  "*.serviceaccount*",
  // 本地数据库
  "*.sqlite*",
  "*.db",
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PRECIOUS_RE = PRECIOUS_PATTERNS.map(
  (p) => new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`, "i")
);
const isPrecious = (p) =>
  p.split("/").some((seg) => seg && PRECIOUS_RE.some((re) => re.test(seg)));

const norm = (p) => resolve(p).replace(/[\\/]+$/, "");
const tryReal = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

// ---------- 数据库（只读） ----------
// 返回 { all(sql) } 或 null（文件缺席/两种后端都打不开）。查询一律无参数，
// worktreePath 匹配放到 JS 侧做，CLI 兜底也能复用同一组 SQL。
function openDb() {
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = req("node:sqlite");
    const d = new DatabaseSync(dbPath, { readOnly: true });
    return { all: (sql) => d.prepare(sql).all() };
  } catch {}
  if (sh("sqlite3", ["--version"]) !== null) {
    return {
      all: (sql) => {
        const r = shErr("sqlite3", ["-readonly", "-json", dbPath, sql]);
        if (!r.ok) throw new Error(`sqlite3 查询失败：${r.err}`);
        try {
          return JSON.parse(r.out || "[]");
        } catch {
          return [];
        }
      },
    };
  }
  return null;
}

// 线程终结判定：settledOverride='settled' / archived / deleted 任一。
// archived_at、deleted_at 是列；payload_json 里同义字段 archivedAt/deletedAt 兜底。
function threadSettled(t) {
  let p = {};
  try {
    p = JSON.parse(t.payload_json);
  } catch {}
  return (
    p.settledOverride === "settled" ||
    t.archived_at != null ||
    p.archivedAt != null ||
    t.deleted_at != null ||
    p.deletedAt != null
  );
}

// worktreePath → 绑定线程列表；另建 realpath 别名键，容忍符号链接路径差异。
function loadState(db) {
  const rows = db.all(
    `SELECT thread_id, title, payload_json, archived_at, deleted_at
     FROM orchestration_v2_projection_threads
     WHERE json_extract(payload_json,'$.worktreePath') IS NOT NULL`
  );
  const byWt = new Map();
  const add = (key, t) => {
    const arr = byWt.get(key) ?? [];
    arr.push(t);
    byWt.set(key, arr);
  };
  for (const t of rows) {
    let p = {};
    try {
      p = JSON.parse(t.payload_json);
    } catch {}
    const wp = typeof p.worktreePath === "string" ? norm(p.worktreePath) : null;
    if (!wp) continue;
    const rec = {
      id: t.thread_id,
      title: String(t.title ?? "").replace(/\s+/g, " ").slice(0, 60),
      delegated: t.thread_id.startsWith("thread:delegated-task:"),
      settled: threadSettled(t),
    };
    add(wp, rec);
    const rp = tryReal(wp);
    if (rp && rp !== wp) add(rp, rec);
  }
  const activeRuns = new Set(
    db
      .all(
        `SELECT DISTINCT thread_id FROM orchestration_v2_projection_runs
         WHERE status IN ('queued','preparing','starting','running','waiting')`
      )
      .map((r) => r.thread_id)
  );
  return { byWt, activeRuns };
}

// ---------- 候选目录收集 ----------
// <root>/<工作树> 或 <root>/<分组>/<工作树> 两种布局。分组只下一层。
function isGitDir(d) {
  try {
    return statSync(d).isDirectory() && sh("git", ["-C", d, "rev-parse", "--git-dir"]) !== null;
  } catch {
    return false;
  }
}
function subdirs(d) {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(d, e.name))
      .sort();
  } catch {
    return [];
  }
}
function candidates(root) {
  const out = [];
  for (const d of subdirs(root)) {
    if (isGitDir(d)) {
      out.push(d);
      continue;
    }
    // 有 .git 条目但 rev-parse 失败：gitfile 失效的工作树残留，自身报 not-a-worktree
    const subs = existsSync(join(d, ".git")) ? [] : subdirs(d);
    if (subs.length === 0) out.push(d);
    else out.push(...subs); // 分组目录：其下才是工作树
  }
  return out;
}

// ---------- 进程占用（POSIX） ----------
// 返回 Map<cwd路径, pid[]>（空 Map = 枚举成功、无占用），null = 检查不可用。
// Windows 恒 null（不查，靠删除失败兜底）；非 Windows 上 null 会算阻断原因。
function computeOccupants() {
  if (isWindows) return null;
  const map = new Map();
  const push = (p, pid) => {
    const a = map.get(p) ?? [];
    a.push(pid);
    map.set(p, a);
  };
  const out = sh("lsof", ["-d", "cwd", "-Fn"], { timeout: 60000 });
  if (out !== null) {
    let pid = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = line.slice(1);
      else if (line.startsWith("n") && pid) push(line.slice(1), pid);
    }
    return map;
  }
  if (platform() !== "linux") return null; // 无 lsof 又非 Linux：检查缺席
  // /proc 兜底：整目录枚举失败才算不可用；单个进程 cwd 读不到只跳过它
  try {
    for (const e of readdirSync("/proc")) {
      if (!/^\d+$/.test(e)) continue;
      try {
        push(readlinkSync(`/proc/${e}/cwd`), e);
      } catch {}
    }
    return map;
  } catch {
    return null;
  }
}

// ---------- 外部状态快照 ----------
// DB 与进程占用都是易变状态：扫描阶段各取一份；--apply 删除前重拍复查。
function snapshotDb() {
  const db = openDb();
  if (!db) return { state: null, note: null };
  try {
    return { state: loadState(db), note: null };
  } catch (e) {
    return { state: null, note: `数据库查询失败，按缺席处理：${e.message}` };
  }
}

// DB 里同一工作树可能有多种路径拼写（如 /tmp 与 /private/tmp）：原路径与
// realpath 两个键下的绑定列表合并，按 thread_id 去重。
function boundThreads(byWt, dir, wtReal) {
  const m = new Map();
  for (const key of new Set([norm(dir), wtReal].filter(Boolean))) {
    for (const t of byWt.get(key) ?? []) m.set(t.id, t);
  }
  return [...m.values()];
}

// 依赖快照的判定：c. 线程全终结、d. 无活跃 run、h. 无进程占用。
// 返回阻断原因列表；unbound 顺带写进 notes（可删报告用）。
function snapshotReasons(dir, wtReal, snap, occ, notes) {
  const reasons = [];
  if (!snap.state) {
    reasons.push(snap.note ?? "数据库缺席，不做删除");
  } else {
    const bound = boundThreads(snap.state.byWt, dir, wtReal);
    if (bound.length === 0) notes.push("unbound");
    const unsettled = bound.filter((t) => !t.settled);
    if (unsettled.length) {
      const mains = unsettled.filter((t) => !t.delegated);
      const dels = unsettled.filter((t) => t.delegated);
      const fmt = (list, label) =>
        `${label} ${list.length} 个未终结（${list.map((t) => t.title).join("；")}）`;
      const parts = [];
      if (mains.length) parts.push(fmt(mains, "主线程"));
      if (dels.length) parts.push(fmt(dels, "委派线程"));
      reasons.push(parts.join("、"));
    }
    const running = bound.filter((t) => snap.state.activeRuns.has(t.id));
    if (running.length) {
      reasons.push(`${running.length} 个绑定线程有进行中的 run（${running.map((t) => t.title).join("；")}）`);
    }
  }
  if (occ === null) {
    // Windows 不查占用；POSIX 查不到时保守 skip
    if (!isWindows) reasons.push("进程占用检查不可用（lsof 缺席且非 Linux /proc）");
  } else {
    const pids = [];
    for (const [p, ids] of occ) {
      const pr = tryReal(p) ?? norm(p);
      if (inside(pr, wtReal) || inside(norm(p), norm(dir))) pids.push(...ids);
    }
    if (pids.length) reasons.push(`进程占用：pid ${[...new Set(pids)].join(", ")}`);
  }
  return reasons;
}

// ---------- 主流程 ----------
const rows = []; // { verdict, rel, branch, detail }
const counts = { delete: 0, deleted: 0, skip: 0, "not-a-worktree": 0, failed: 0 };
const report = (verdict, rel, detail, branch) => {
  rows.push({ verdict, rel, detail, branch });
  counts[verdict]++;
};

if (!existsSync(scanRoot)) {
  console.log(`扫描根目录不存在：${scanRoot}`);
  process.exit(0);
}

const dbSnap = snapshotDb();
const occSnap = computeOccupants();
const cwdReal = tryReal(process.cwd()) ?? norm(process.cwd());

for (const dir of candidates(scanRoot)) {
  const rel = relative(scanRoot, dir) || dir;
  const reasons = [];
  const notes = [];

  // b. git 链接工作树判定（not-a-worktree 只报告，后续检查无意义）
  const gitDirOut = sh("git", ["-C", dir, "rev-parse", "--git-dir"]);
  if (gitDirOut === null) {
    report("not-a-worktree", rel, "非 git 目录或 gitfile 失效的残留", null);
    continue;
  }
  const branch = sh("git", ["-C", dir, "symbolic-ref", "-q", "--short", "HEAD"]);
  const commonOut = sh("git", ["-C", dir, "rev-parse", "--git-common-dir"]) ?? gitDirOut;
  const gitDir = tryReal(resolve(dir, gitDirOut)) ?? resolve(dir, gitDirOut);
  const gitCommon = tryReal(resolve(dir, commonOut)) ?? resolve(dir, commonOut);
  const wtReal = tryReal(dir) ?? norm(dir);

  // a. 自己所在的工作树永不删
  if (inside(cwdReal, wtReal)) reasons.push("调用者 cwd 位于此工作树内（self）");

  // b. 独立 clone（git-dir == git-common-dir）直接 skip
  if (gitDir === gitCommon) {
    reasons.push("独立 clone，非链接工作树");
    report("skip", rel, [...reasons, ...notes].join("；"), branch);
    continue;
  }

  // c/d/h. 依赖快照的判定（线程绑定、活跃 run、进程占用）
  reasons.push(...snapshotReasons(dir, wtReal, dbSnap, occSnap, notes));

  // f. 未提交变更 + 忽略文件里的珍贵内容
  // --porcelain 不含 ignored 条目；--ignored 展开的 !! 行过珍贵模式检查
  const st = sh("git", ["-C", dir, "status", "--porcelain", "--ignored"]);
  if (st === null) reasons.push("git status 执行失败");
  else {
    const dirty = [];
    const ignored = [];
    for (const l of st.split("\n").filter(Boolean)) {
      if (l.startsWith("!!")) ignored.push(l.slice(2).trim());
      else dirty.push(l);
    }
    if (dirty.length) reasons.push(`${dirty.length} 个未提交文件`);
    const precious = ignored.filter(isPrecious);
    if (precious.length) reasons.push(`含珍贵忽略文件：${precious.join("、")}`);
    else if (ignored.length) {
      // 列条目名供 dry-run 审查，超 8 个截断
      notes.push(`忽略文件 ${ignored.length} 项（${ignored.slice(0, 8).join("、")}${ignored.length > 8 ? "、…" : ""}）`);
    }
  }

  // g. HEAD 须可从某个 refs/remotes/origin/* 到达
  const refs = (sh("git", ["-C", dir, "for-each-ref", "--format=%(refname)", "refs/remotes/origin"]) ?? "")
    .split("\n")
    .filter(Boolean);
  if (refs.length === 0) reasons.push("无 refs/remotes/origin/* 远端引用");
  else if (!refs.some((ref) => shErr("git", ["-C", dir, "merge-base", "--is-ancestor", "HEAD", ref]).ok))
    reasons.push("HEAD 不在任何 origin 分支上（本地提交未推送）");

  if (reasons.length) {
    report("skip", rel, [...reasons, ...notes].join("；"), branch);
    continue;
  }

  // ---- 全部条件满足 ----
  notes.push("干净", "HEAD 已推送");
  if (!apply) {
    report("delete", rel, notes.join("；"), branch);
    continue;
  }

  // 删除前重拍快照复查（收窄 TOCTOU）：线程绑定/活跃 run/进程占用可能已变
  const reReasons = snapshotReasons(dir, wtReal, snapshotDb(), computeOccupants(), []);
  if (reReasons.length) {
    report("skip", rel, `删除前复查发现阻断：${reReasons.join("；")}`, branch);
    continue;
  }

  // --git-dir 直传公共 git 目录：bare / 独立 git-dir 布局下推导主仓库路径会错
  const rm = shErr("git", ["--git-dir", gitCommon, "worktree", "remove", dir]);
  if (!rm.ok || existsSync(dir)) {
    report("failed", rel, `worktree remove 失败：${rm.err || "目录仍存在"}`, branch);
    continue;
  }
  if (branch) {
    const bd = shErr("git", ["--git-dir", gitCommon, "branch", "-d", branch]);
    if (bd.ok) notes.push(`分支 ${branch} 已删`);
    else notes.push(`分支 ${branch} 保留（${bd.err || "branch -d 失败"}）`);
  }
  report("deleted", rel, notes.join("；"), branch);
}

// ---------- 输出 ----------
console.log(`扫描根：${scanRoot}${apply ? "（--apply）" : "（dry-run）"}`);
for (const r of rows) {
  console.log(`${r.verdict.padEnd(14)} ${r.rel}${r.branch ? `  branch=${r.branch}` : ""}${r.detail ? `  ${r.detail}` : ""}`);
}
const total = rows.length;
console.log(
  `汇总：共 ${total} 个目录 — 可删 ${counts.delete} / 已删 ${counts.deleted} / skip ${counts.skip} / not-a-worktree ${counts["not-a-worktree"]} / failed ${counts.failed}`
);
if (!apply && counts.delete > 0) console.log("（dry-run：加 --apply 执行删除）");
