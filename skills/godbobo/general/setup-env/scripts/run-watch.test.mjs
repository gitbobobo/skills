import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = process.env.RUN_WATCH_TEST_SCRIPT || join(dirname(fileURLToPath(import.meta.url)), "run-watch.mjs");
const posix = process.platform !== "win32";

function fixture(virtualClock = false) {
  const root = mkdtempSync(join(tmpdir(), "run-watch-test-"));
  const preload = join(root, "env.mjs");
  writeFileSync(preload, `import os from "node:os";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
os.tmpdir = () => process.env.RUN_WATCH_TEST_ROOT;
syncBuiltinESMExports();
${virtualClock ? `let elapsed = 0;
Date.now = () => elapsed;
Atomics.wait = (_buffer, _index, _value, ms) => { elapsed += ms; return "timed-out"; };
process.on("exit", () => writeFileSync(process.env.RUN_WATCH_TEST_ROOT + "/elapsed", String(elapsed)));
` : ""}`);
  const task = join(root, `run-watch-${process.getuid?.() ?? "u"}`, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "status"), "running");
  writeFileSync(join(task, "pid"), String(process.pid));
  writeFileSync(join(task, "log"), "task log\n");
  const run = (...args) => spawnSync(process.execPath, ["--import", preload, SCRIPT, ...args], {
    env: { ...process.env, RUN_WATCH_TEST_ROOT: root }, encoding: "utf8", timeout: 10000,
  });
  return { root, task, run };
}

test("默认 wait 有界返回 running，仍可跟踪原任务成功和失败", { skip: !posix }, () => {
  const f = fixture(true);
  const waiting = f.run("wait", "task");
  assert.equal(waiting.status, 2, waiting.stdout + waiting.stderr);
  assert.match(waiting.stdout, /task：running/);
  assert.equal(Number(readFileSync(join(f.root, "elapsed"), "utf8")), 30000);
  assert.equal(readFileSync(join(f.task, "status"), "utf8"), "running");
  assert.match(f.run("status", "task").stdout, /task log/);
  writeFileSync(join(f.task, "status"), "exit=0");
  assert.equal(f.run("wait", "task").status, 0);
  writeFileSync(join(f.task, "status"), "exit=7");
  assert.equal(f.run("wait", "task").status, 1);
});

test("显式时限不被 5 秒轮询步长放大，0 立即返回，非法值拒绝", { skip: !posix }, () => {
  const f = fixture();
  const start = performance.now();
  const waiting = f.run("wait", "task", "--timeout", "0.1");
  assert.equal(waiting.status, 2, waiting.stdout + waiting.stderr);
  assert.ok(performance.now() - start < 2000, "0.1 秒时限不应被放大到 5 秒");
  assert.equal(f.run("wait", "task", "--timeout", "0").status, 2);
  for (const args of [["--timeout"], ["--timeout", "NaN"], ["--timeout", "Infinity"], ["--timeout", "-1"]]) {
    const result = f.run("wait", "task", ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /非负有限秒数/);
  }
});

test("真实后台任务：wait 超时不终止任务，最终退出码和日志保留", { skip: !posix }, () => {
  const f = fixture();
  const worker = join(f.root, "worker.mjs");
  writeFileSync(worker, 'console.log("started"); setTimeout(() => { console.log("finished"); process.exitCode = 7; }, 500);');
  assert.equal(f.run("start", "worker", "--", process.execPath, worker).status, 0);
  const waiting = f.run("wait", "worker", "--timeout", "0.05");
  assert.equal(waiting.status, 2, waiting.stdout + waiting.stderr);
  assert.match(waiting.stdout, /worker：running/);
  const finished = f.run("wait", "worker", "--timeout", "2");
  assert.equal(finished.status, 1, finished.stdout + finished.stderr);
  assert.match(finished.stdout, /worker：exit=7/);
  assert.match(finished.stdout, /finished/);
});
