import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { operate } from './quota-state.mjs';

const script = fileURLToPath(new URL('./quota-state.mjs', import.meta.url));
const start = Date.now();
const minute = 60_000;
const entry = 'codex/gpt-6.1-sol';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 't3-quota-state-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function cli(dir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args, '--cache-dir', dir]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, data: stdout ? JSON.parse(stdout) : null }));
  });
}

test('independent processes preserve all concurrent updates and the same-entry failure count', async (t) => {
  const dir = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => cli(dir, ['fail', '--entry', `provider/model-${i}`, '--kind', 'connection'])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(Object.keys((await operate(dir, 'status')).records).length, 20);
  const same = await Promise.all(Array.from({ length: 8 }, () => cli(dir, ['fail', '--entry', entry, '--kind', 'quota'])));
  for (const r of same) assert.equal(r.code, 0, r.stderr);
  assert.equal((await operate(dir, 'status')).records[`entry:${entry}`].failures, 8);
  assert.doesNotThrow(() => JSON.parse(results.at(-1).stdout));
});

test('expired cooldown permits one recovery probe across processes', async (t) => {
  const dir = await fixture(t);
  await operate(dir, 'fail', { entry, kind: 'quota' }, start - 31 * minute);
  const results = await Promise.all(Array.from({ length: 12 }, () => cli(dir, ['claim', '--entry', entry])));
  assert.equal(results.filter((r) => r.code === 0).length, 1);
  assert.equal(results.filter((r) => r.code === 2).length, 11);
  const winner = results.find((r) => r.code === 0).data;
  assert.equal(winner.recovery, true);
  assert.equal((await operate(dir, 'success', { entry, token: winner.token })).cleared, true);
  assert.deepEqual(await operate(dir, 'claim', { entry }), { allowed: true, recovery: false });
});

test('pool boundary is explicit and an endpoint connection failure leaves siblings available', async (t) => {
  const dir = await fixture(t);
  const pool = { pool: 'codex-pro', confirmedPool: true };
  await assert.rejects(operate(dir, 'fail', { entry, kind: 'quota', pool: pool.pool }), /confirmed-pool/);
  await operate(dir, 'fail', { entry, kind: 'connection', ...pool }, start);
  assert.equal((await operate(dir, 'status')).records['pool:codex-pro'], undefined);
  assert.equal((await operate(dir, 'claim', { entry: 'codex/gpt-6-luna', ...pool }, start)).allowed, true);
  await operate(dir, 'fail', { entry, kind: 'quota', ...pool }, start);
  assert.equal((await operate(dir, 'claim', { entry: 'codex/gpt-6-luna', ...pool }, start)).allowed, false);
  assert.equal((await operate(dir, 'claim', { entry: 'factory/gpt-6.1-sol', pool: 'factory-account', confirmedPool: true }, start)).allowed, true);
});

test('known reset wins, unknown failure backs off, and abandoned probes recover', async (t) => {
  const dir = await fixture(t);
  const resetAt = new Date(start + 2 * minute).toISOString();
  const first = await operate(dir, 'fail', { entry, kind: 'quota', resetAt }, start);
  assert.equal(first.retryAt, start + 2 * minute);
  const probe = await operate(dir, 'claim', { entry }, first.retryAt);
  assert.equal((await operate(dir, 'check', { entry }, probe.leaseUntil - 1)).allowed, false);
  const retry = await operate(dir, 'claim', { entry }, probe.leaseUntil);
  assert.notEqual(retry.token, probe.token);
  assert.equal((await operate(dir, 'success', { entry, token: probe.token }, probe.leaseUntil)).cleared, false);
  const failed = await operate(dir, 'fail', { entry, kind: 'quota' }, probe.leaseUntil + 1);
  assert.equal(failed.retryAt, probe.leaseUntil + 1 + 60 * minute);
  assert.equal((await operate(dir, 'success', { entry, token: retry.token }, probe.leaseUntil + 2)).cleared, false);
  for (let i = 0; i < 5; i++) await operate(dir, 'fail', { entry, kind: 'quota' }, start);
  assert.equal((await operate(dir, 'status')).records[`entry:${entry}`].retryAt, start + 240 * minute);
});

test('entry and pool are claimed together; check alone cannot acquire or clear a probe', async (t) => {
  const dir = await fixture(t);
  const pool = { pool: 'codex-pro', confirmedPool: true };
  await operate(dir, 'fail', { entry, kind: 'connection' }, start - 31 * minute);
  await operate(dir, 'fail', { entry, kind: 'quota', ...pool }, start - 31 * minute);
  assert.equal((await operate(dir, 'check', { entry, ...pool }, start)).recovery, true);
  assert.equal((await operate(dir, 'status')).records[`entry:${entry}`].probe, undefined);
  await assert.rejects(operate(dir, 'success', { entry, ...pool }, start), /token/);
  const probe = await operate(dir, 'claim', { entry, ...pool }, start);
  assert.equal(probe.keys.length, 2);
  assert.equal((await operate(dir, 'claim', { entry: 'codex/gpt-6-luna', ...pool }, start)).allowed, false);
  assert.equal((await operate(dir, 'success', { entry, ...pool, token: probe.token }, start + 1)).keys.length, 2);
});

test('corrupt state and invalid timestamps fail without discarding evidence', async (t) => {
  const dir = await fixture(t);
  await assert.rejects(operate(dir, 'fail', { entry, kind: 'quota', resetAt: 'invalid' }, start), /future ISO/);
  await assert.rejects(operate(dir, 'fail', { entry, kind: 'quota', resetAt: new Date(start).toISOString() }, start), /future ISO/);
  const file = join(dir, 'state.json');
  await writeFile(file, '{broken');
  await assert.rejects(operate(dir, 'claim', { entry }));
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, JSON.stringify({ version: 1, records: { 'entry:bad': { retryAt: null } } }));
  await assert.rejects(operate(dir, 'claim', { entry }), /Invalid quota record/);
});

test('a concurrent failure without reset information retains a confirmed future reset', async (t) => {
  const dir = await fixture(t);
  const pool = { pool: 'codex-pro', confirmedPool: true };
  const resetAt = new Date(start + 24 * 60 * minute).toISOString();
  await operate(dir, 'fail', { entry, kind: 'quota', resetAt, ...pool }, start);
  const later = await operate(dir, 'fail', { entry: 'codex/gpt-6-luna', kind: 'quota', ...pool }, start + 1);
  assert.equal(later.retryAt, Date.parse(resetAt));
});

test('a delayed recovery failure cannot overwrite or recreate a newer recovery result', async (t) => {
  const dir = await fixture(t);
  await operate(dir, 'fail', { entry, kind: 'quota' }, start - 31 * minute);
  const old = await operate(dir, 'claim', { entry }, start);
  const current = await operate(dir, 'claim', { entry }, old.leaseUntil);
  const stale = await operate(dir, 'fail', { entry, kind: 'quota', token: old.token }, old.leaseUntil + 1);
  assert.equal(stale.recorded, false);
  assert.equal((await operate(dir, 'status')).records[`entry:${entry}`].probe.token, current.token);
  await operate(dir, 'success', { entry, token: current.token }, old.leaseUntil + 2);
  const late = await operate(dir, 'fail', { entry, kind: 'quota', token: old.token }, old.leaseUntil + 3);
  assert.equal(late.recorded, false);
  assert.equal((await operate(dir, 'claim', { entry }, old.leaseUntil + 4)).recovery, false);
  await operate(dir, 'fail', { entry, kind: 'quota' }, start - 31 * minute);
  const active = await operate(dir, 'claim', { entry }, start);
  const failure = await operate(dir, 'fail', { entry, kind: 'quota', token: active.token }, start + 1);
  assert.equal(failure.recorded, true);
  assert.equal(failure.retryAt, start + 1 + 60 * minute);
});

test('recovery can change failure scope while preserving a newer destination failure', async (t) => {
  const dir = await fixture(t);
  const pool = { pool: 'codex-pro', confirmedPool: true };
  await operate(dir, 'fail', { entry, kind: 'connection' }, start - 31 * minute);
  const probe = await operate(dir, 'claim', { entry, ...pool }, start);
  const quota = await operate(dir, 'fail', { entry, ...pool, kind: 'quota', token: probe.token }, start + 1);
  assert.equal(quota.recorded, true);
  assert.equal(quota.key, 'pool:codex-pro');
  assert.equal((await operate(dir, 'claim', { entry: 'codex/gpt-6-luna', ...pool }, start + 2)).allowed, false);

  const other = await fixture(t);
  await operate(other, 'fail', { entry, ...pool, kind: 'quota' }, start - 31 * minute);
  const poolProbe = await operate(other, 'claim', { entry, ...pool }, start);
  const connection = await operate(other, 'fail', { entry, ...pool, kind: 'connection', token: poolProbe.token }, start + 1);
  assert.equal(connection.recorded, true);
  assert.equal(connection.key, `entry:${entry}`);
  assert.equal((await operate(other, 'status')).records['pool:codex-pro'].kind, 'quota');
  assert.equal((await operate(other, 'status')).records['pool:codex-pro'].failures, 1);

  const conflict = await fixture(t);
  await operate(conflict, 'fail', { entry, kind: 'connection' }, start - 31 * minute);
  const older = await operate(conflict, 'claim', { entry, ...pool }, start);
  const newer = await operate(conflict, 'fail', { entry: 'codex/gpt-6-luna', ...pool, kind: 'quota' }, start + 1);
  const stale = await operate(conflict, 'fail', { entry, ...pool, kind: 'quota', token: older.token }, start + 2);
  assert.equal(stale.recorded, false);
  assert.equal((await operate(conflict, 'status')).records['pool:codex-pro'].generation, newer.generation);
});

test('a scoped recovery failure consumes the entire token and preserves unverified failures', async (t) => {
  for (const from of ['connection', 'quota']) {
    const dir = await fixture(t);
    const pool = { pool: 'codex-pro', confirmedPool: true };
    const sourceKey = from === 'quota' ? 'pool:codex-pro' : `entry:${entry}`;
    await operate(dir, 'fail', { entry, ...pool, kind: from }, start - 31 * minute);
    const probe = await operate(dir, 'claim', { entry, ...pool }, start);
    const result = await operate(dir, 'fail', { entry, ...pool, kind: from === 'quota' ? 'connection' : 'quota', token: probe.token }, start + 1);
    assert.equal(result.recorded, true);
    assert.equal((await operate(dir, 'success', { entry, ...pool, token: probe.token }, start + 2)).cleared, false);
    const source = (await operate(dir, 'status')).records[sourceKey];
    assert.equal(source.kind, from);
    assert.equal(source.probe, undefined);
    assert.equal(source.retryAt, probe.leaseUntil);
    assert.equal((await operate(dir, 'claim', { entry, ...pool }, start + 3)).allowed, false);
    const stale = await cli(dir, ['fail', '--entry', entry, '--pool', pool.pool, '--confirmed-pool', '--kind', 'quota', '--token', probe.token]);
    assert.equal(stale.data.recorded, false);
    assert.equal(stale.code, 2);
    const lateSuccess = await cli(dir, ['success', '--entry', entry, '--pool', pool.pool, '--confirmed-pool', '--token', probe.token]);
    assert.equal(lateSuccess.data.cleared, false);
    assert.equal(lateSuccess.code, 2);
  }
});
