#!/usr/bin/env node
// t3-worktree-gc.test.mjs — t3-worktree-gc.mjs 的自包含夹具测试。
//
// 用法：node t3-worktree-gc.test.mjs（node:test 驱动，全部断言通过退出码 0）
//
// 在 fs.mkdtempSync 临时目录里构造：git 主仓库 + 假 origin（bare）、
// $T3CODE_HOME/worktrees/<组>/ 下若干 git worktree add 出的工作树、最小
// userdata/statev2.sqlite（node:sqlite 建，只含 threads/runs 两表）。
// 全程不碰真实 ~/.t3：注入 T3CODE_HOME 与 --root。

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const req = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL("./t3-worktree-gc.mjs", import.meta.url));
const isWindows = platform() === "win32";

const tmp = mkdtempSync(join(tmpdir(), "t3gc-test-"));
const t3home = join(tmp, "t3home");
const wtRoot = join(t3home, "worktrees");
const group = join(wtRoot, "group");
const dbDir = join(t3home, "userdata");
const dbPath = join(dbDir, "statev2.sqlite");
const mainRepo = join(tmp, "main");
const origin = join(tmp, "origin.git");
const bareRepo = join(tmp, "bare.git"); // bare 主仓库：验证 --git-dir 删除路径

const D = {}; // 用例名 → 工作树路径
let sleeper = null;

const git = (argv) =>
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...argv],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

// 跑 gc 脚本，返回 stdout。默认 cwd=tmp（位于任何工作树之外）。
function runGc(extra = [], { cwd = tmp, env = {} } = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...extra], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, T3CODE_HOME: t3home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const lineFor = (out, name) => out.split("\n").find((l) => l.includes(name)) ?? "";

// ---------- 夹具 ----------
function insThread(db, { id, title = id, wt, settled = false, archived = null, deleted = null }) {
  const payload = { worktreePath: wt };
  if (settled) payload.settledOverride = "settled";
  db.prepare(
    `INSERT INTO orchestration_v2_projection_threads
     (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, deleted_at, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, "p1", title, "devin", "code", "default", "2026-01-01", "2026-01-01", archived, deleted, JSON.stringify(payload));
}
function insRun(db, { id, thread, status }) {
  db.prepare(
    `INSERT INTO orchestration_v2_projection_runs
     (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, thread, 1, "devin", status, "2026-01-01", "{}");
}

before(() => {
  mkdirSync(group, { recursive: true });
  mkdirSync(dbDir, { recursive: true });

  // 主仓库 + 假 origin：push 后 fetch，让 refs/remotes/origin/* 存在
  git(["init", "--bare", origin]);
  git(["init", "-b", "main", mainRepo]);
  writeFileSync(join(mainRepo, "f.txt"), "x\n");
  // 根 .gitignore 进初始提交：夹具 ignored 文件不用额外提交，也不显脏
  writeFileSync(join(mainRepo, ".gitignore"), ".env\n*.db\n*.properties\n*.keystore\n*.log\nnode_modules/\ndist/\nbuild/\nlocal/\nsigning/\n.kube/\n.docker/\n*.tfstate*\nlocal.settings.json\n");
  git(["-C", mainRepo, "add", "."]);
  git(["-C", mainRepo, "commit", "-m", "init"]);
  git(["-C", mainRepo, "remote", "add", "origin", origin]);
  git(["-C", mainRepo, "push", "-u", "origin", "main"]);
  git(["-C", mainRepo, "fetch", "origin"]);

  const addWt = (name) => {
    const dir = join(group, name);
    git(["-C", mainRepo, "worktree", "add", "-b", `br-${name}`, dir]);
    return dir;
  };

  D.clean = addWt("wt-clean"); // 全条件满足 → 可删
  D.unbound = addWt("wt-unbound"); // 零绑定线程 → 可删（unbound）
  D.self = addWt("wt-self"); // self 用例：子进程 cwd 进去跑 → skip
  D.unsettled = addWt("wt-unsettled"); // 主线程未结算 → skip
  D.delegated = addWt("wt-delegated"); // 委派线程未结算 → skip
  D.activerun = addWt("wt-activerun"); // 线程已结算但有 running run → skip
  D.dirty = addWt("wt-dirty"); // 未跟踪文件 → skip
  writeFileSync(join(D.dirty, "untracked.txt"), "x\n");
  D.unpushed = addWt("wt-unpushed"); // 本地孤立提交 → skip
  writeFileSync(join(D.unpushed, "wip.txt"), "x\n");
  git(["-C", D.unpushed, "add", "."]);
  git(["-C", D.unpushed, "commit", "-m", "wip"]);
  D.occupied = addWt("wt-occupied"); // 进程占用 → skip
  D.alias = addWt("wt-alias"); // 双路径拼写绑定，未终结别名线程须让它 skip
  D.precious = addWt("wt-precious"); // ignored 珍贵文件 → skip 并列出命中
  writeFileSync(join(D.precious, ".env"), "TOKEN=x\n");
  writeFileSync(join(D.precious, ".local.db"), "x\n");
  D.keystore = addWt("wt-keystore"); // local.properties/release.keystore 式凭据文件 → skip
  writeFileSync(join(D.keystore, "local.properties"), "release.storePassword=x\n");
  writeFileSync(join(D.keystore, "release.keystore"), "x\n");
  D.artifacts = addWt("wt-artifacts"); // 只有 ignored 产物 → 可删（列名截断进报告）
  mkdirSync(join(D.artifacts, "node_modules"));
  writeFileSync(join(D.artifacts, "node_modules", "x.js"), "x\n");
  mkdirSync(join(D.artifacts, "dist"));
  writeFileSync(join(D.artifacts, "dist", "bundle.js"), "x\n");
  for (let i = 1; i <= 7; i++) writeFileSync(join(D.artifacts, `f${i}.log`), "x\n"); // 凑够 >8 项触发截断
  D.hiddendir = addWt("wt-hiddendir"); // ignored 目录里藏凭据：折叠视图看不到，须 ls-files 检出
  mkdirSync(join(D.hiddendir, "local"));
  writeFileSync(join(D.hiddendir, "local", ".env"), "TOKEN=x\n");
  mkdirSync(join(D.hiddendir, "signing"));
  writeFileSync(join(D.hiddendir, "signing", "app.keystore"), "x\n");
  D.classfiles = addWt("wt-classfiles"); // build/ 下的 *Credentials*.class：良性目录段过滤，不误拦
  mkdirSync(join(D.classfiles, "build", "intermediates"), { recursive: true });
  writeFileSync(join(D.classfiles, "build", "intermediates", "UpstreamBootstrapCredentials.class"), "x\n");
  D.clouddir = addWt("wt-clouddir"); // 标准云凭据位置：.kube/.docker/tfstate/azure → skip
  mkdirSync(join(D.clouddir, ".kube"));
  writeFileSync(join(D.clouddir, ".kube", "config"), "x\n");
  mkdirSync(join(D.clouddir, ".docker"));
  writeFileSync(join(D.clouddir, ".docker", "config.json"), "x\n");
  writeFileSync(join(D.clouddir, "terraform.tfstate"), "x\n");
  writeFileSync(join(D.clouddir, "local.settings.json"), "x\n");
  mkdirSync(join(group, "plain-dir")); // 非 git 目录 → not-a-worktree
  git(["clone", mainRepo, join(group, "wt-clone")]); // 独立 clone → skip
  // gitfile 失效残留：.git 文件指向不存在的 admin 路径 → not-a-worktree
  D.stalegit = join(group, "wt-stalegit");
  mkdirSync(D.stalegit);
  writeFileSync(join(D.stalegit, ".git"), `gitdir: ${join(tmp, "gone-admin", "wt-stalegit")}\n`);

  // root 直接子目录本身是工作树（无分组层）的布局
  git(["-C", mainRepo, "worktree", "add", "-b", "br-wt-toplevel", join(wtRoot, "wt-toplevel")]);
  D.toplevel = join(wtRoot, "wt-toplevel");

  // bare 主仓库的工作树：--git-dir <gitCommon> 才能正确定位（dirname 推导会错）
  git(["init", "--bare", "-b", "main", bareRepo]);
  git(["-C", mainRepo, "push", bareRepo, "main"]);
  git(["--git-dir", bareRepo, "remote", "add", "origin", bareRepo]); // 自身做远端
  git(["--git-dir", bareRepo, "fetch", "origin"]); // 造出 refs/remotes/origin/*
  git(["--git-dir", bareRepo, "worktree", "add", "-b", "br-wt-bare", join(group, "wt-bare")]);
  D.bare = join(group, "wt-bare");

  // 最小 statev2.sqlite：只建 threads / runs 两表
  const { DatabaseSync } = req("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
    active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT)`);
  db.exec(`CREATE TABLE orchestration_v2_projection_runs (
    run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    provider TEXT NOT NULL, provider_thread_id TEXT, status TEXT NOT NULL,
    requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT)`);
  insThread(db, { id: "t-clean-1", wt: D.clean, settled: true });
  insThread(db, { id: "t-clean-2", wt: D.clean, archived: "2026-01-02" }); // archived 同样算终结
  insRun(db, { id: "r0", thread: "t-clean-1", status: "completed" }); // 已结束 run 不阻挡
  insThread(db, { id: "t-unsettled", title: "主线程未结算", wt: D.unsettled });
  insThread(db, { id: "thread:delegated-task:test%3Ad1", title: "委派线程未结算", wt: D.delegated });
  insThread(db, { id: "t-activerun", title: "有活跃run", wt: D.activerun, settled: true });
  insRun(db, { id: "r1", thread: "t-activerun", status: "running" });
  for (const [k, wt] of Object.entries({ self: D.self, dirty: D.dirty, unpushed: D.unpushed, occupied: D.occupied, toplevel: D.toplevel, bare: D.bare, precious: D.precious, keystore: D.keystore, artifacts: D.artifacts, hiddendir: D.hiddendir, classfiles: D.classfiles, clouddir: D.clouddir }))
    insThread(db, { id: `t-${k}`, wt, settled: true });
  // 同一工作树的两种路径拼写：realpath 别名下的未终结线程必须命中（别名合并回归）
  insThread(db, { id: "t-alias-1", wt: D.alias, settled: true });
  insThread(db, { id: "t-alias-2", title: "别名路径未终结线程", wt: realpathSync(D.alias) });
  db.close();

  // 进程占用夹具：sleep 的 cwd 落在 wt-occupied 里（POSIX）
  if (!isWindows) sleeper = spawn("sleep", ["60"], { cwd: D.occupied, stdio: "ignore" });
});

after(() => {
  sleeper?.kill();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

// ---------- 用例 ----------
test("dry-run：逐目录判定，不删任何东西", () => {
  const out = runGc();
  assert.match(lineFor(out, "wt-clean"), /^delete\s/);
  assert.match(lineFor(out, "wt-unbound"), /^delete\s.*unbound/);
  assert.match(lineFor(out, "wt-toplevel"), /^delete\s/); // 无分组层布局也能识别
  assert.match(lineFor(out, "wt-self"), /^delete\s/); // 正常 cwd 下 self 树也可删
  assert.match(lineFor(out, "wt-bare"), /^delete\s/); // bare 主仓库的工作树也是链接工作树
  const preciousLine = lineFor(out, "wt-precious");
  assert.match(preciousLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(preciousLine, /\.env/);
  assert.match(preciousLine, /\.local\.db/);
  const keystoreLine = lineFor(out, "wt-keystore");
  assert.match(keystoreLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(keystoreLine, /local\.properties/);
  assert.match(keystoreLine, /release\.keystore/);
  const artifactsLine = lineFor(out, "wt-artifacts");
  assert.match(artifactsLine, /^delete\s.*忽略文件 9 项（/); // 产物不珍贵，列名进报告
  assert.match(artifactsLine, /、…/); // 超 8 项截断出省略号
  const hiddendirLine = lineFor(out, "wt-hiddendir");
  assert.match(hiddendirLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(hiddendirLine, /local\/\.env/); // 折叠进 local/ 的凭据被逐文件检出
  assert.match(hiddendirLine, /signing\/app\.keystore/);
  assert.match(lineFor(out, "wt-classfiles"), /^delete\s.*忽略文件 1 项（build\/）/); // Credentials.class 经 build/ 段过滤
  const cloudLine = lineFor(out, "wt-clouddir"); // 标准云凭据位置全部被珍贵模式拦住
  assert.match(cloudLine, /^skip\s.*含珍贵忽略文件/);
  assert.match(cloudLine, /\.kube\/config/);
  assert.match(cloudLine, /\.docker\/config\.json/);
  assert.match(cloudLine, /terraform\.tfstate/);
  assert.match(cloudLine, /local\.settings\.json/);
  assert.match(lineFor(out, "wt-unsettled"), /^skip\s.*主线程 1 个未终结.*主线程未结算/);
  assert.match(lineFor(out, "wt-delegated"), /^skip\s.*委派线程 1 个未终结.*委派线程未结算/);
  assert.match(lineFor(out, "wt-activerun"), /^skip\s.*run.*有活跃run/);
  assert.match(lineFor(out, "wt-dirty"), /^skip\s.*1 个未提交文件/);
  assert.match(lineFor(out, "wt-unpushed"), /^skip\s.*未推送/);
  assert.match(lineFor(out, "wt-alias"), /^skip\s.*未终结.*别名路径未终结线程/);
  if (!isWindows) assert.match(lineFor(out, "wt-occupied"), /^skip\s.*进程占用：pid \d+/);
  assert.match(lineFor(out, "wt-clone"), /^skip\s.*独立 clone/);
  assert.match(lineFor(out, "plain-dir"), /^not-a-worktree/);
  assert.match(lineFor(out, "wt-stalegit"), /^not-a-worktree/);
  assert.match(out, /--apply 执行删除/);
  for (const d of Object.values(D)) assert.ok(existsSync(d), `dry-run 不应删除 ${d}`);
});

test("数据库缺席：根下所有工作树全部 skip", () => {
  const empty = mkdtempSync(join(tmpdir(), "t3gc-nodb-"));
  const out = runGc(["--root", wtRoot], { env: { T3CODE_HOME: empty } });
  for (const name of ["wt-clean", "wt-unbound", "wt-self", "wt-toplevel", "wt-bare", "wt-unsettled", "wt-dirty", "wt-unpushed", "wt-occupied", "wt-alias", "wt-precious", "wt-keystore", "wt-artifacts", "wt-hiddendir", "wt-classfiles", "wt-clouddir"])
    assert.match(lineFor(out, name), /^skip\s.*数据库缺席/, name);
  assert.equal(out.split("\n").filter((l) => l.startsWith("delete ")).length, 0, "DB 缺席时不得出现可删项");
  rmSync(empty, { recursive: true, force: true });
});

test("self：调用者 cwd 在工作树内时该树被跳过", { skip: isWindows && "POSIX 限定" }, () => {
  const out = runGc([], { cwd: D.self });
  assert.match(lineFor(out, "wt-self"), /^skip\s.*(self|位于此工作树内)/);
});

test("--root 缺值：报错退出而非静默回退 ~/.t3", () => {
  for (const argv of [["--root"], ["--apply", "--root"], ["--root", "--apply"], ["--root", ""], ["--root", "   "]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
      encoding: "utf8",
      cwd: tmp,
      env: { ...process.env, T3CODE_HOME: t3home },
    });
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, /--root 需要目录参数/);
  }
});

test("--apply：只删可删工作树并清理本地分支", () => {
  const out = runGc(["--apply"]);
  const deletable = ["wt-clean", "wt-unbound", "wt-self", "wt-toplevel", "wt-artifacts", "wt-classfiles"];
  if (isWindows) deletable.push("wt-occupied"); // Windows 不做占用检查，会被删
  for (const name of deletable) {
    assert.match(lineFor(out, name), /^deleted\s/, name);
    assert.ok(!existsSync(D[name.slice(3)]), `${name} 目录应已消失`);
    assert.equal(git(["-C", mainRepo, "branch", "--list", `br-${name}`]), "", `br-${name} 应已删除`);
  }
  // bare 主仓库的工作树同样可删（验证 --git-dir 路径），且 br-wt-bare 被清理
  assert.match(lineFor(out, "wt-bare"), /^deleted\s/);
  assert.ok(!existsSync(D.bare));
  assert.equal(git(["--git-dir", bareRepo, "branch", "--list", "br-wt-bare"]), "", "br-wt-bare 应已删除");
  assert.ok(!git(["--git-dir", bareRepo, "worktree", "list", "--porcelain"]).includes(D.bare));
  // git worktree 注册同步移除
  const list = git(["-C", mainRepo, "worktree", "list", "--porcelain"]);
  for (const d of [D.clean, D.unbound, D.self, D.toplevel, D.artifacts, D.classfiles]) assert.ok(!list.includes(d), `${d} 不应再注册`);
  const kept = [D.unsettled, D.delegated, D.activerun, D.dirty, D.unpushed, D.alias, D.precious, D.keystore, D.hiddendir, D.clouddir];
  if (!isWindows) kept.push(D.occupied); // Windows 不查占用，该树会被删
  for (const d of kept) assert.ok(list.includes(d), `${d} 应仍在注册表`);
  // skip 的工作树全部保留
  for (const d of kept) assert.ok(existsSync(d), `${d} 应保留`);
  assert.ok(existsSync(join(group, "plain-dir")));
  assert.ok(existsSync(join(group, "wt-clone")));
  assert.ok(existsSync(D.stalegit));
  assert.ok(!/^failed/m.test(out), "不应有 failed");
});
