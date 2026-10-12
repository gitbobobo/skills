import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = process.env.SETUP_ENV_TEST_SCRIPT || join(dirname(fileURLToPath(import.meta.url)), "setup-env.mjs");
const posix = process.platform !== "win32";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "setup-env-test-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const preload = join(root, "home.mjs");
  writeFileSync(preload, `import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.homedir = () => process.env.SETUP_ENV_TEST_HOME;
syncBuiltinESMExports();
`);
  const env = { ...process.env, SETUP_ENV_TEST_HOME: home, CARGO_HOME: join(root, "cargo"), PATH: `${bin}:/usr/bin:/bin` };
  const run = (...args) => spawnSync(process.execPath, ["--import", preload, SCRIPT, ...args], {
    env, encoding: "utf8", timeout: 10000,
  });
  return { root, home, bin, env, run, hooks: join(home, ".config", "devin", "hooks.v1.json") };
}

test("hook 迁移：旧命令报过期，替换后保留无关配置且重跑无变化", { skip: !posix }, () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const sibling = { type: "command", command: "echo unrelated", timeout: 8 };
  const other = { matcher: "write", hooks: [{ type: "command", command: "echo elsewhere" }], extra: "preserve" };
  const oldHook = { type: "command", command: '"/missing/node" "/old/deployment/devin-hook-exec-guard.mjs"', timeout: 5 };
  const old = { PreToolUse: [{ matcher: "exec", hooks: [oldHook, sibling] }, other], PostToolUse: [{ matcher: "*", hooks: [] }] };
  writeFileSync(f.hooks, JSON.stringify(old));
  const check = f.run("--check");
  assert.equal(check.status, 2, check.stdout + check.stderr);
  assert.match(check.stdout, /配置过期\s+devin:hooks/);
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, "utf8")), old, "check 不写配置");
  const apply = f.run();
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  const current = readFileSync(f.hooks, "utf8");
  const cfg = JSON.parse(current);
  assert.deepEqual(cfg.PostToolUse, old.PostToolUse);
  assert.deepEqual(cfg.PreToolUse.slice(0, 2), [{ matcher: "exec", hooks: [sibling] }, other]);
  assert.match(cfg.PreToolUse[2].hooks[0].command, new RegExp(f.bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/node"));
  const backups = readdirSync(dirname(f.hooks)).filter((n) => n.startsWith("hooks.v1.json.bak-"));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(f.hooks), backups[0]), "utf8")), old);
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(f.hooks, "utf8"), current);
  assert.equal(readdirSync(dirname(f.hooks)).filter((n) => n.startsWith("hooks.v1.json.bak-")).length, 1);
  assert.equal(f.run("--check").status, 0);
});

test("hook 配置：错误 matcher、类型、超时和重复条目均收敛为一个 exec hook", { skip: !posix }, () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const good = JSON.parse(readFileSync(f.hooks, "utf8")).PreToolUse[0];
  for (const broken of [
    { ...good, matcher: "write" },
    { ...good, hooks: [{ ...good.hooks[0], type: "other" }] },
    { ...good, hooks: [{ ...good.hooks[0], timeout: 100 }] },
  ]) {
    writeFileSync(f.hooks, JSON.stringify({ PreToolUse: [broken] }));
    assert.equal(f.run("--check").status, 2);
    assert.equal(f.run().status, 0);
    assert.deepEqual(JSON.parse(readFileSync(f.hooks, "utf8")).PreToolUse, [good]);
  }
  writeFileSync(f.hooks, JSON.stringify({ PreToolUse: [good, good] }));
  assert.equal(f.run("--check").status, 2);
  assert.equal(f.run().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.hooks, "utf8")).PreToolUse, [good]);
});

test("cargo-nextest 发现：迁移目录/默认目录已有工具，PATH 不可见时不提示重装", { skip: !posix }, () => {
  const f = fixture();
  const cargoBin = join(f.env.CARGO_HOME, "bin");
  mkdirSync(cargoBin, { recursive: true });
  writeFileSync(join(cargoBin, "cargo-nextest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  let r = f.run("--check");
  assert.match(r.stdout, /PATH不可见\s+tool:cargo-nextest/);
  assert.ok(r.stdout.includes(cargoBin));
  assert.doesNotMatch(r.stdout, /未安装\s+tool:cargo-nextest/);
  f.env.PATH = `${cargoBin}:${f.env.PATH}`;
  assert.match(f.run("--check").stdout, /已安装\s+tool:cargo-nextest/);

  const fallback = fixture();
  const defaultBin = join(fallback.home, ".cargo", "bin");
  mkdirSync(defaultBin, { recursive: true });
  writeFileSync(join(defaultBin, "cargo-nextest"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.match(fallback.run("--check").stdout, /PATH不可见\s+tool:cargo-nextest/);
  const absent = fixture();
  assert.match(absent.run("--check").stdout, /未安装\s+tool:cargo-nextest.*cargo install/);
  const notExecutable = join(absent.home, ".cargo", "bin");
  mkdirSync(notExecutable, { recursive: true });
  writeFileSync(join(notExecutable, "cargo-nextest"), "not executable", { mode: 0o644 });
  assert.match(absent.run("--check").stdout, /未安装\s+tool:cargo-nextest/);
});
