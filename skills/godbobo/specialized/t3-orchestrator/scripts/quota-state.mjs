#!/usr/bin/env node
// User-level failure cache. No credentials, workspace state, or raw error messages.
import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MINUTE = 60_000;
const KINDS = new Set(['quota', 'rate_limit', 'overload', 'connection', 'configuration']);
export const defaultCache = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 't3-orchestrator');

export async function operate(dir, command, options = {}, now = Date.now()) {
  const id = (value) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:/\[\]-]{1,160}$/.test(value)) throw new Error('Expected a non-secret entry/pool ID (1..160 safe characters)');
    return value;
  };
  if (!['status', 'check', 'claim', 'fail', 'success'].includes(command)) throw new Error('Unknown command');
  const entryKey = command === 'status' ? null : `entry:${id(options.entry)}`;
  const poolKey = options.pool ? `pool:${id(options.pool)}` : null;
  if (poolKey && !options.confirmedPool) throw new Error('--pool requires --confirmed-pool; verify shared billing first');
  if (command === 'fail' && !KINDS.has(options.kind)) throw new Error('Expected --kind quota|rate_limit|overload|connection|configuration');
  const resetAt = options.resetAt === undefined ? null : Date.parse(options.resetAt);
  if (resetAt !== null && (!Number.isFinite(resetAt) || resetAt <= now)) throw new Error('--reset-at must be a future ISO timestamp');

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'state.lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw new Error(`Cache locked: ${lock}. Check owner.json and its PID; remove this lock only after confirming its owner has exited.`);
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  const file = join(dir, 'state.json');
  let temp;
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 1, records: {} }; }
    if (state.version !== 1 || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) throw new Error('Invalid quota cache; preserve it for diagnosis');
    for (const [key, record] of Object.entries(state.records)) {
      if (!/^(entry|pool):/.test(key) || !record || !KINDS.has(record.kind) || !Number.isFinite(record.retryAt) || (record.resetAt !== undefined && !Number.isFinite(record.resetAt)) || !Number.isInteger(record.failures) || record.failures < 1 || typeof record.generation !== 'string' || (record.probe && (typeof record.probe.token !== 'string' || !Number.isFinite(record.probe.until)))) throw new Error('Invalid quota record; preserve it for diagnosis');
    }
    const keys = [entryKey, poolKey].filter(Boolean);
    let result, changed = false;
    if (command === 'status') {
      result = state;
    } else if (command === 'fail') {
      // Pool is also the claim context; only actual quota exhaustion writes it.
      const key = options.kind === 'quota' && poolKey ? poolKey : entryKey;
      const previous = state.records[key];
      const liveProbe = Boolean(options.token) && keys.some((source) => state.records[source]?.probe?.token === options.token && state.records[source].probe.until > now);
      const newerDestination = previous && previous.probe?.token !== options.token;
      if (options.token !== undefined && (!options.token || !liveProbe || newerDestination)) {
        result = { recorded: false, reason: 'stale_probe' };
      } else {
        const failures = (previous?.failures || 0) + 1;
        const cooldown = Math.min(30 * MINUTE * 2 ** Math.min(failures - 1, 3), 4 * 60 * MINUTE);
        const confirmedReset = resetAt ?? (previous?.resetAt > now ? previous.resetAt : null);
        state.records[key] = { kind: options.kind, failures, retryAt: confirmedReset ?? now + cooldown, generation: randomUUID(), ...(confirmedReset === null ? {} : { resetAt: confirmedReset }) };
        if (options.token) {
          // A failure consumes the whole attempt, including a different source scope.
          for (const source of keys) {
            const record = state.records[source];
            if (record?.probe?.token !== options.token) continue;
            record.retryAt = Math.max(record.retryAt, record.probe.until);
            delete record.probe;
          }
        }
        changed = true;
        result = { recorded: true, key, ...state.records[key] };
      }
    } else if (command === 'success') {
      if (typeof options.token !== 'string' || !options.token) throw new Error('Recovery success requires the token returned by claim');
      const matching = keys.filter((key) => state.records[key]?.probe?.token === options.token);
      // A late success cannot clear a newer failure, or a different probe's lease.
      for (const key of matching) {
        if (state.records[key].probe.until <= now) continue;
        delete state.records[key]; changed = true;
      }
      result = { cleared: changed, keys: matching.filter((key) => !state.records[key]) };
    } else {
      const blocked = keys.filter((key) => {
        const r = state.records[key];
        return r && (r.retryAt > now || r.probe?.until > now);
      });
      if (blocked.length) {
        result = { allowed: false, blocked, retryAt: Math.max(...blocked.map((key) => Math.max(state.records[key].retryAt, state.records[key].probe?.until || 0))) };
      } else {
        const recovering = keys.filter((key) => state.records[key]);
        result = { allowed: true, recovery: recovering.length > 0 };
        if (command === 'claim' && recovering.length) {
          const token = randomUUID();
          for (const key of recovering) state.records[key].probe = { token, until: now + 10 * MINUTE };
          result = { ...result, token, leaseUntil: now + 10 * MINUTE, keys: recovering }; changed = true;
        }
      }
    }
    if (changed) {
      temp = join(dir, `state.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temp, file); temp = null;
    }
    return result;
  } finally {
    if (temp) await unlink(temp).catch(() => {});
    await unlink(join(lock, 'owner.json')).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const command = args.shift();
    if (!command || command === '--help') {
      console.log('quota-state.mjs status|check|claim|fail|success [--entry ID] [--pool ID --confirmed-pool] [--kind KIND] [--reset-at ISO] [--token TOKEN] [--cache-dir PATH]\nExit: 0 applied/allowed; 2 blocked or stale (no change); 1 invalid input/cache/lock error.');
    } else {
      const options = {};
      const flags = { '--entry': 'entry', '--pool': 'pool', '--kind': 'kind', '--reset-at': 'resetAt', '--token': 'token', '--cache-dir': 'cacheDir' };
      while (args.length) {
        const flag = args.shift();
        if (flag === '--confirmed-pool') options.confirmedPool = true;
        else if (flags[flag] && args[0] && !args[0].startsWith('--')) options[flags[flag]] = args.shift();
        else throw new Error(`Invalid or incomplete option: ${flag}`);
      }
      const result = await operate(options.cacheDir || defaultCache(), command, options);
      console.log(JSON.stringify(result, null, 2));
      if (result.allowed === false || result.recorded === false || result.cleared === false) process.exitCode = 2;
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
