import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, start } from '../src/exec.ts';
import { agentEnv, ConfigError, loadConfig, normalizeRemote, parseConfig } from '../src/config.ts';
import { fileQueue, LockError, lockStateDir } from '../src/queue.ts';
import { fileActivity } from '../src/activity.ts';
import { fileLessons, LESSONS_PATH } from '../src/lessons.ts';
import { redact, writePrivate } from '../src/redact.ts';
import { fixtureRepo, gitIn, tempDir, writeFiles } from './fakes.ts';

const task = (id: string) => ({ id, source: 'github', ref: id, title: `Task ${id}`, body: '' });

test('exec: kills a hung command and its children at the timeout', async () => {
  const began = Date.now();
  const r = await run('/bin/sh', ['-c', '(sleep 30) & sleep 30'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - began < 8000, 'returned soon after the timeout');
});

const gone = async (pid: number) => {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test('exec: at the timeout, both the command and the child it started are gone', async () => {
  const r = await run('/bin/sh', ['-c', 'echo $$; sleep 30 & echo $!; wait'], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  const [child, grandchild] = r.stdout.trim().split('\n').map(Number);
  assert.ok(child > 0 && grandchild > 0 && child !== grandchild, r.stdout);
  assert.ok(await gone(child), `child ${child} still running`);
  assert.ok(await gone(grandchild), `grandchild ${grandchild} still running`);
});

test('exec: a missing command returns 127 instead of throwing', async () => {
  const r = await run('gridbuild-no-such-command', [], { timeoutMs: 5000 });
  assert.equal(r.code, 127);
  assert.match(r.stderr, /command not found/);
});

test('exec: passes input on stdin and captures output', async () => {
  const r = await run('/bin/cat', [], { input: 'hello', timeoutMs: 5000 });
  assert.deepEqual([r.code, r.stdout], [0, 'hello']);
});

test('exec: start/stop sends a signal to a long-running process', async () => {
  const p = start('/bin/sh', ['-c', 'trap "echo stopped; exit 0" INT; echo started; while true; do sleep 0.1; done']);
  await new Promise((r) => setTimeout(r, 300));
  const r = await p.stop('SIGINT', 3000);
  assert.match(r.stdout, /started/);
});

test('config: defaults to the GitHub watcher with the bot label', () => {
  const c = parseConfig({}, '/repo');
  assert.deepEqual(c.watchers, { github: { label: 'bot', repo: undefined } });
  assert.equal(c.baseBranch, 'main');
  assert.equal(c.agent.command, 'claude');
  assert.equal(c.proof.ios, undefined);
  assert.match(c.stateDir, /\.gridbuild\/repo-[0-9a-f]{8}$/);
  assert.deepEqual([c.agent.env, c.review.allowedUsers], [[], []]);
});

test('config: the state folder follows the repo identity, not the folder name', async () => {
  for (const url of ['git@github.com:Me/App.git', 'https://github.com/me/app', 'ssh://git@github.com/me/app.git/']) assert.equal(normalizeRemote(url), 'github.com/me/app');
  const mine = await fixtureRepo({ 'gridbuild.json': '{}' });
  const theirs = await fixtureRepo({ 'gridbuild.json': '{}' });
  const clone = await fixtureRepo({ 'gridbuild.json': '{}' });
  await gitIn(mine, 'remote', 'add', 'origin', 'git@github.com:me/app.git');
  await gitIn(theirs, 'remote', 'add', 'origin', 'git@github.com:someone-else/app.git');
  await gitIn(clone, 'remote', 'add', 'origin', 'https://github.com/me/app');
  const [a, b, c] = await Promise.all([mine, theirs, clone].map((dir) => loadConfig(dir)));
  assert.match(a.stateDir, /\.gridbuild\/app-[0-9a-f]{8}$/);
  assert.notEqual(a.stateDir, b.stateDir, 'two repos named "app" never share state');
  assert.equal(a.stateDir, c.stateDir, 'a second clone of the same repo finds the same queue');
  const local = await loadConfig(await fixtureRepo({ 'gridbuild.json': '{}' }));
  assert.match(local.stateDir, /\.gridbuild\/gridbuild-repo-\w+-[0-9a-f]{8}$/, 'no origin: keyed by the real path');
});

test('config: the AI engineer gets an allowlisted environment, never Gridbuild credentials', () => {
  const env = { PATH: '/bin', HOME: '/h', LC_ALL: 'C', GH_TOKEN: 'g', GITHUB_TOKEN: 'g', JIRA_API_TOKEN: 'j', GOOGLE_OAUTH_ACCESS_TOKEN: 'o', AWS_SECRET_ACCESS_KEY: 'a', OPENAI_API_KEY: 'x', SENTRY_DSN: 's', EXTRA: 'e' };
  assert.deepEqual(Object.keys(agentEnv([], env)).sort(), ['HOME', 'LC_ALL', 'PATH']);
  assert.deepEqual(Object.keys(agentEnv(['EXTRA', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY'], env)).sort(), ['EXTRA', 'HOME', 'LC_ALL', 'PATH']);
  assert.throws(() => parseConfig({ agent: { env: ['GH_TOKEN', 'JIRA_EMAIL'] } }, '/repo'), /must not list GH_TOKEN, JIRA_EMAIL/);
  assert.deepEqual(parseConfig({ agent: { env: ['ANTHROPIC_API_KEY'] }, review: { allowedUsers: ['sam'] } }, '/repo').review.allowedUsers, ['sam']);
});

test('config: refuses secrets in the file', () => {
  assert.throws(() => parseConfig({ watchers: { jira: { apiToken: 'abc' } } }, '/repo'), ConfigError);
  assert.throws(() => parseConfig({ password: 'x' }, '/repo'), /environment variables/);
});

test('config: checks the Crashlytics and proof settings', () => {
  assert.throws(() => parseConfig({ watchers: { crashlytics: { projectId: 'p' } } }, '/repo'), /tables/);
  assert.throws(() => parseConfig({ proof: { ios: {} } }, '/repo'), /proof\.ios\.run/);
  const c = parseConfig({ stateDir: 'state', watchers: { crashlytics: { projectId: 'p', tables: ['com_x_IOS'] } } }, '/repo');
  assert.equal(c.stateDir, '/repo/state');
  assert.equal(c.watchers.crashlytics?.dataset, 'firebase_crashlytics');
  assert.equal(c.watchers.github, undefined);
});

test('queue: never adds the same task twice, claims in order, and survives a restart', async () => {
  const dir = tempDir();
  const q = fileQueue(dir);
  assert.equal(await q.add(task('a')), true);
  assert.equal(await q.add(task('b')), true);
  assert.equal(await q.add(task('a')), false);
  const first = await q.claim();
  assert.equal(first?.task.id, 'a');
  await q.done('a', { url: 'u', branch: 'gridbuild/a', worktree: '/w' });

  const restarted = fileQueue(dir);
  assert.equal(await restarted.add(task('a')), false, 'done tasks are remembered');
  assert.equal((await restarted.claim())?.task.id, 'b');
  await restarted.fail('b', 'broke');
  assert.equal(await restarted.claim(), undefined);
  const items = await restarted.list();
  assert.deepEqual(items.map((i) => [i.task.id, i.state]), [['a', 'done'], ['b', 'failed']]);
  assert.equal(items[1].error, 'broke');
});

test('queue: picks up a claim left by a process that died, up to three attempts', async () => {
  const dir = tempDir();
  const q = fileQueue(dir);
  await q.add(task('a'));
  await q.claim();
  const file = join(dir, 'queue.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.items[0].pid = 999_999; // not running
  writeFileSync(file, JSON.stringify(data));
  const again = await q.claim();
  assert.equal(again?.task.id, 'a');
  assert.equal(again?.attempts, 2);

  data.items[0].attempts = 3;
  writeFileSync(file, JSON.stringify(data));
  assert.equal(await q.claim(), undefined);
  assert.equal((await q.list())[0].state, 'failed');
});

test('queue: a stopped task goes back to the queue without using an attempt; one can wait for a person', async () => {
  const q = fileQueue(tempDir());
  await q.add(task('a'));
  await q.add(task('b'));
  await q.claim('a');
  await q.release('a');
  const [a] = await q.list();
  assert.deepEqual([a.state, a.attempts, a.pid], ['queued', 0, undefined]);
  await q.claim('b');
  await q.needsAttention('b', 'look at the worktree');
  assert.equal((await q.claim())?.task.id, 'a');
  assert.equal(await q.claim(), undefined, 'a task that needs attention is never picked up on its own');
  assert.equal((await q.claim('b'))?.task.id, 'b', 'but `once` can run it again');
});

test('lock: one Gridbuild per state folder; a lock left by a dead process is taken over', () => {
  const dir = tempDir();
  const lock = lockStateDir(dir);
  assert.throws(() => lockStateDir(dir), (e: Error) => e instanceof LockError && e.message.includes(`PID ${process.pid}`) && e.message.includes('already working'));
  lock.release();
  assert.ok(!existsSync(join(dir, 'gridbuild.lock')));
  writeFileSync(join(dir, 'gridbuild.lock'), '999999\n');
  const again = lockStateDir(dir);
  assert.equal(readFileSync(join(dir, 'gridbuild.lock'), 'utf8').trim(), String(process.pid));
  again.release();
});

test('redact: hides secret env values and known token formats', async () => {
  const env = { MY_API_KEY: 'k3y-value-123', SHORT_TOKEN: 'abc', DB_PASSWORD: 'hunter2hunter2', PATH: '/usr/bin:/bin' };
  const text = [
    'key k3y-value-123 and hunter2hunter2, short abc, path /usr/bin:/bin',
    `gh ghp_${'a'.repeat(36)} pat github_pat_${'B'.repeat(40)} slack xoxb-1234567890-abc aws AKIAABCDEFGHIJKLMNOP`,
    'Authorization: Bearer abc.def-ghi_jkl',
    'clone https://sam:s3cret@github.com/me/app.git',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redact(text, env);
  for (const secret of ['k3y-value-123', 'hunter2hunter2', 'ghp_', 'github_pat_', 'xoxb-', 'AKIA', 'abc.def', 's3cret', 'MIIEow']) assert.ok(!out.includes(secret), secret);
  assert.match(out, /short abc, path \/usr\/bin:\/bin/, 'short values and other variables stay');
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /https:\/\/\[redacted\]@github\.com\/me\/app\.git/);

  const dir = tempDir();
  const saved = process.env.GRIDBUILD_TEST_TOKEN;
  process.env.GRIDBUILD_TEST_TOKEN = 'tok-0123456789';
  try {
    await fileActivity(dir).log('task.failed', { task: 'a', error: 'push failed for https://x:tok-0123456789@github.com', nested: ['tok-0123456789'] });
  } finally {
    if (saved === undefined) delete process.env.GRIDBUILD_TEST_TOKEN; else process.env.GRIDBUILD_TEST_TOKEN = saved;
  }
  const log = readFileSync(join(dir, 'activity.jsonl'), 'utf8');
  assert.ok(!log.includes('tok-0123456789'), 'the activity log never holds the secret');
  assert.equal(statSync(join(dir, 'activity.jsonl')).mode & 0o777, 0o600);
  await writePrivate(join(dir, 'tests.txt'), 'full output');
  assert.equal(statSync(join(dir, 'tests.txt')).mode & 0o777, 0o600);
});

test('activity: appends JSON lines and reads them back', async () => {
  const dir = tempDir();
  const lines: string[] = [];
  const a = fileActivity(dir, (l) => lines.push(l));
  await a.log('task.claimed', { task: 'github-1' });
  await a.log('agent.finished', { task: 'github-1', costUsd: 0.5 });
  const events = await a.read();
  assert.deepEqual(events.map((e) => e.type), ['task.claimed', 'agent.finished']);
  assert.equal(events[1].costUsd, 0.5);
  assert.match(lines[1], /agent\.finished\s+github-1\s+costUsd=0\.5/);
  assert.equal(readFileSync(join(dir, 'activity.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('lessons: creates the file with a header, then appends rules', async () => {
  const dir = tempDir();
  const l = fileLessons();
  assert.equal(await l.read(dir), '');
  await l.add(dir, 'Use the theme colors,\n never hex values.', 'review of PR 7');
  await l.add(dir, 'Keep strings in the i18n files.', 'review of PR 8');
  const text = await l.read(dir);
  assert.ok(existsSync(join(dir, LESSONS_PATH)));
  assert.match(text, /^# Lessons\n/);
  assert.match(text, /\n\n- Use the theme colors, never hex values\. \(from review of PR 7, \d{4}-\d\d-\d\d\)\n- Keep strings/);
});

test('cli: SIGTERM stops the AI engineer and its children, gives back the claim and the lock, then exits', async () => {
  const state = tempDir();
  const pids = join(state, 'pids.txt');
  // Stands in for `claude`: starts a grandchild, writes both PIDs, then hangs.
  const fakeClaude = join(state, 'fake-claude.mjs');
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn('sleep', ['60'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid);
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const repo = await fixtureRepo({ 'gridbuild.json': JSON.stringify({ stateDir: state, watchers: {}, agent: { command: fakeClaude, args: [] } }) });
  writeFiles(state, { 'task.md': '# Fix the greeting\n' });

  const cli = start(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'once', join(state, 'task.md'), '--repo', repo], { timeoutMs: 60_000 });
  for (let i = 0; i < 200 && !existsSync(pids); i++) await new Promise((r) => setTimeout(r, 100));
  const [agentPid, grandchildPid] = readFileSync(pids, 'utf8').split(' ').map(Number);
  assert.ok(existsSync(join(state, 'gridbuild.lock')), 'the lock is held while working');

  const r = await cli.stop('SIGTERM', 15_000);
  assert.equal(r.code, 130, r.stderr);
  assert.match(r.stderr, /Stopping/);
  assert.ok(await gone(agentPid), 'the AI engineer is gone');
  assert.ok(await gone(grandchildPid), 'its child is gone');
  const [item] = await fileQueue(state).list();
  assert.deepEqual([item.state, item.attempts], ['queued', 0], 'the claim is given back');
  assert.ok(!existsSync(join(state, 'gridbuild.lock')), 'the lock is given back');
  const events = (await fileActivity(state).read()).map((e) => e.type);
  assert.ok(!events.includes('task.failed'), 'stopping is not a failure');
});
