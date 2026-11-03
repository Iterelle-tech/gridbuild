import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileActivity } from '../src/activity.ts';
import { DRIVE_SCHEMA, FIX_SCHEMA, REVIEW_SCHEMA } from '../src/agent/prompt.ts';
import { parseConfig } from '../src/config.ts';
import { fileLessons } from '../src/lessons.ts';
import type { PrHost } from '../src/pr/host.ts';
import { reviewOpenPrs } from '../src/pr/review.ts';
import { fileQueue } from '../src/queue.ts';
import { fileTask, pollWatchers, resolveTask, runOnce, type RunnerDeps } from '../src/runner.ts';
import type { Agent, Task, Watcher } from '../src/types.ts';
import { fakeAgent, fakeDevice, fixtureRepo, gitAndFakes, gitIn, tempDir, writeFiles } from './fakes.ts';

const task: Task = { id: 'github-3', source: 'github', ref: '3', title: 'Fix the typo', body: 'Helo should be Hello' };

function recordingHost(): PrHost & { opened: unknown[]; replies: string[]; state: () => Promise<'open' | 'merged' | 'closed'> } {
  const opened: unknown[] = [];
  const replies: string[] = [];
  let state: 'open' | 'merged' | 'closed' = 'open';
  return {
    opened,
    replies,
    async publishProof() { return {}; },
    async open(req) { opened.push(req); return { url: 'https://github.com/example/app/pull/1', number: 1, branch: req.branch, worktree: req.worktree }; },
    async sync() {},
    async push() {},
    async comments() { return [{ id: 'comment-1', kind: 'conversation', author: 'sam', body: 'Thanks!' }]; },
    async reply(_pr, _c, body) { replies.push(body); state = 'merged'; },
    state: async () => state,
  };
}

async function setup(agent: Agent, watchers: Watcher[] = []) {
  const repo = await fixtureRepo({ 'a.txt': 'Helo\n' });
  const state = tempDir();
  const config = parseConfig({ stateDir: state, proof: { ios: { run: 'true' } } }, repo);
  const host = recordingHost();
  const deps: RunnerDeps = {
    config, exec: gitAndFakes(), queue: fileQueue(state), activity: fileActivity(state), lessons: fileLessons(),
    agent, devices: [fakeDevice('ios', ['simctl hung']), fakeDevice('android')], host, watchers, dryRun: false,
  };
  return { deps, host, repo, state };
}

test('runner: a run with no changes fails the task and tells the source', async () => {
  const notes: string[] = [];
  const watcher: Watcher = { name: 'github', poll: async () => [task], get: async () => task, notify: async (_t, m) => { notes.push(m); } };
  const { deps, host } = await setup(fakeAgent(() => ({ text: 'I could not find the screen.' })), [watcher]);
  assert.equal(await runOnce(deps, '3'), undefined);
  const [item] = await deps.queue.list();
  assert.equal(item.state, 'failed');
  assert.match(item.error ?? '', /made no changes. It said: I could not find the screen/);
  assert.equal(host.opened.length, 0);
  assert.match(notes[0], /picked this up/);
  assert.match(notes[1], /could not finish this/);
});

test('runner: an agent error fails the task; a device problem only becomes a Not checked note', async () => {
  const { deps } = await setup(fakeAgent((job) => (job.schema ? { ok: false, error: 'Claude Code stopped: error_max_turns' } : {})));
  await deps.queue.add(task);
  assert.equal(await runOnce(deps, 'github-3'), undefined);
  assert.match((await deps.queue.list())[0].error ?? '', /error_max_turns/);
  const skipped = (await deps.activity.read()).find((e) => e.type === 'proof.skipped');
  assert.match(String(skipped?.reason), /simctl hung/);
});

test('runner: opens the PR, notes missing videos, answers a review once and stops when the PR is merged', async () => {
  const agent = fakeAgent((job) => {
    if (job.schema && 'wrong' in (job.schema as { properties: object }).properties) writeFiles(job.cwd, { 'a.txt': 'Hello\n' });
    return { data: job.schema ? { wrong: 'Typo', changed: 'Fixed', tested: 'Read it', notChecked: [], replies: [], lessons: [] } : undefined };
  });
  const { deps, host } = await setup(agent);
  await deps.queue.add(task);
  const pr = await runOnce(deps, 'github-3');
  assert.equal(pr?.url, 'https://github.com/example/app/pull/1');
  const body = (host.opened[0] as { body: string; draft: boolean }).body;
  assert.match(body, /^Fixes #3/);
  assert.match(body, /iOS Simulator before video: simctl hung/);
  assert.match(body, /Android Emulator: no `proof.android.run` command/);
  await assert.rejects(runOnce(deps, 'github-3'), /already done/);

  await reviewOpenPrs(deps);
  assert.equal(host.replies.length, 1);
  assert.match(host.replies[0], /no change needed/);
  await reviewOpenPrs(deps);
  assert.equal(host.replies.length, 1);
  const reviews = JSON.parse(readFileSync(join(deps.config.stateDir, 'reviews.json'), 'utf8'));
  assert.equal(reviews['github-3'].closed, true);
  assert.equal(reviews['github-3'].comments['comment-1'].status, 'replied');
});

function hostWith(o: { openFails?: number; pushes?: string[]; opened?: { body: string }[] } = {}): PrHost {
  let openFails = o.openFails ?? 0;
  return {
    async publishProof() { return {}; },
    async open(req) {
      if (openFails-- > 0) throw new Error('gh pr create failed: network is down');
      o.opened?.push(req);
      return { url: 'https://github.com/example/app/pull/2', number: 2, branch: req.branch, worktree: req.worktree };
    },
    async sync() {},
    async push(pr) { o.pushes?.push(pr.branch); },
    async comments() { return []; },
    async reply() {},
    async state() { return 'open'; },
  };
}

test('runner: films "before" from the base commit in its own worktree, saves each phase, and resumes without redoing work', async () => {
  const repo = await fixtureRepo({ 'a.txt': 'Helo\n' });
  const state = tempDir();
  const seen: Record<string, { text: string; cwd: string }> = {};
  const agent = fakeAgent((job) => {
    if (job.schema === FIX_SCHEMA) {
      writeFiles(job.cwd, { 'a.txt': 'Hello\n' });
      return { data: { wrong: 'A typo.', changed: `Fixed it. Debug token was ghp_${'x'.repeat(36)}`, tested: 'Read it.', notChecked: [] } };
    }
    const phase = job.prompt.includes('before the fix') ? 'before' : 'after';
    seen[phase] = { text: readFileSync(join(job.cwd, 'a.txt'), 'utf8'), cwd: job.cwd };
    assert.equal(job.schema, DRIVE_SCHEMA);
    return { data: phase === 'after' ? { shown: false, note: 'a sign-in screen got in the way' } : { shown: true, note: 'Shows Helo.' } };
  });
  const pushes: string[] = [];
  const opened: { body: string }[] = [];
  const deps: RunnerDeps = {
    config: parseConfig({ stateDir: state, proof: { android: { run: 'true' } } }, repo), exec: gitAndFakes(), queue: fileQueue(state),
    activity: fileActivity(state), lessons: fileLessons(), agent, devices: [fakeDevice('android')], host: hostWith({ openFails: 1, pushes, opened }), watchers: [], dryRun: false,
  };
  await deps.queue.add(task);
  assert.equal(await runOnce(deps, 'github-3'), undefined, 'opening the PR failed the first time');
  const progressFile = join(state, 'runs', 'github-3', 'progress.json');
  const saved = JSON.parse(readFileSync(progressFile, 'utf8'));
  assert.equal(saved.phase, 'pushed');
  assert.equal(saved.base, await gitIn(repo, 'rev-parse', 'main'));
  assert.equal(saved.fix, await gitIn(join(state, 'worktrees', 'github-3'), 'rev-parse', 'HEAD'));

  assert.equal(seen.before.text, 'Helo\n', 'before is filmed on the base commit');
  assert.equal(seen.after.text, 'Hello\n');
  assert.notEqual(seen.before.cwd, join(state, 'worktrees', 'github-3'));
  assert.ok(!existsSync(seen.before.cwd), 'the before worktree is removed after filming');

  const jobs = agent.jobs.length;
  const pr = await runOnce(deps, 'github-3');
  assert.equal(pr?.url, 'https://github.com/example/app/pull/2');
  assert.equal(agent.jobs.length, jobs, 'no new fix and no new filming on resume');
  assert.deepEqual(pushes, ['gridbuild/github-3'], 'pushed once');
  assert.equal(JSON.parse(readFileSync(progressFile, 'utf8')).phase, 'pr-opened');

  const body = opened[0].body;
  assert.ok(!body.includes('ghp_'), 'tokens never reach the PR body');
  assert.match(body, /Debug token was \[redacted\]/);
  assert.match(body, /\[android-after\.mp4\]\(android-after\.mp4\) \(attempt only, see Not checked\)/);
  assert.match(body, /- Android Emulator after video: the AI engineer could not show the fix \(a sign-in screen got in the way\)/);
  const tests = (await deps.activity.read()).filter((e) => e.type === 'proof.failed');
  assert.equal(tests.length, 1);
});

test('runner: a fix interrupted with uncommitted changes waits for a person, and its worktree is left alone', async () => {
  const stop = new AbortController();
  const agent = fakeAgent((job) => {
    if (job.schema !== FIX_SCHEMA) return {};
    writeFiles(job.cwd, { 'a.txt': 'Hel\n' });
    stop.abort(); // Ctrl-C while the AI engineer works
    return { ok: false, error: 'Claude Code gave no result: stopped' };
  });
  const { deps, state } = await setup(agent);
  deps.host = hostWith();
  await deps.queue.add(task);
  assert.equal(await runOnce({ ...deps, signal: stop.signal }, 'github-3'), undefined);
  assert.equal((await deps.queue.list())[0].state, 'claimed', 'stopping is not a failure');
  await deps.queue.release('github-3');

  assert.equal(await runOnce(deps, 'github-3'), undefined);
  const [item] = await deps.queue.list();
  assert.equal(item.state, 'needs-attention');
  assert.match(item.error ?? '', /interrupted and left uncommitted changes .*gridbuild once github-3/);
  const wt = join(state, 'worktrees', 'github-3');
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'Hel\n', 'the half-done work is untouched');
  assert.ok((await deps.activity.read()).some((e) => e.type === 'task.needs-attention'));
  assert.equal(await deps.queue.claim(), undefined, 'never picked up on its own');

  // A person finishes the work by hand and commits it; `once` carries on from there.
  writeFiles(wt, { 'a.txt': 'Hello\n' });
  await gitIn(wt, 'commit', '-qam', 'Finish the fix by hand');
  assert.ok(await runOnce(deps, 'github-3'));
  assert.equal(agent.jobs.filter((j) => j.schema === FIX_SCHEMA).length, 1, 'the AI engineer did not start over');
});

test('review: a failed push or reply is retried on its own, without running the AI engineer again', async () => {
  const repo = await fixtureRepo({ 'a.txt': 'Helo\n' });
  const remote = tempDir('gridbuild-remote-');
  await gitIn(remote, 'init', '-q', '--bare', '-b', 'main');
  await gitIn(repo, 'remote', 'add', 'origin', remote);
  await gitIn(repo, 'push', '-q', 'origin', 'main');
  const state = tempDir();
  let failPush = 0;
  let failReply = 0;
  const replies: string[] = [];
  const host: PrHost = {
    ...hostWith(),
    async push(pr) {
      if (failPush-- > 0) throw new Error('git push failed: network is down');
      await gitIn(pr.worktree, 'push', '-q', 'origin', pr.branch);
    },
    async comments() {
      return [{ id: 'c1', kind: 'conversation', author: 'sam', body: 'Shout it.' }, { id: 'c2', kind: 'conversation', author: 'lee', body: 'Looks fine otherwise.' }];
    },
    async reply(_pr, c, body) {
      if (c.id === 'c2' && failReply-- > 0) throw new Error('gh: HTTP 502');
      replies.push(`${c.id}: ${body}`);
    },
  };
  const agent = fakeAgent((job) => {
    if (job.schema === FIX_SCHEMA) writeFiles(job.cwd, { 'a.txt': 'Hello\n' });
    if (job.schema === REVIEW_SCHEMA) writeFiles(job.cwd, { 'a.txt': 'HELLO\n' });
    return { data: job.schema === REVIEW_SCHEMA ? { replies: [{ id: 'c1', reply: 'Now in capitals.' }, { id: 'c2', reply: 'Thanks.' }], lessons: [] } : { wrong: 'w', changed: 'c', tested: 't', notChecked: [] } };
  });
  const deps: RunnerDeps = {
    config: parseConfig({ stateDir: state }, repo), exec: gitAndFakes(), queue: fileQueue(state), activity: fileActivity(state),
    lessons: fileLessons(), agent, devices: [], host, watchers: [], dryRun: false,
  };
  await deps.queue.add(task);
  const pr = await runOnce(deps, 'github-3');
  assert.ok(pr);

  failPush = 1;
  failReply = 1;
  await reviewOpenPrs(deps); // the review commit is made, but the push fails, so nothing is posted
  assert.deepEqual(replies, []);
  await reviewOpenPrs(deps); // the commit is pushed; c1 is answered, c2's reply fails
  assert.match(await gitIn(remote, 'log', '-1', '--format=%s', pr.branch), /Address review comments/);
  assert.deepEqual(replies.map((r) => r.split(':')[0]), ['c1']);
  assert.match(replies[0], /^c1: Now in capitals\.\n\nPushed a new commit\./);
  await reviewOpenPrs(deps); // only c2 is retried
  await reviewOpenPrs(deps);
  assert.deepEqual(replies.map((r) => r.split(':')[0]), ['c1', 'c2']);
  assert.equal(agent.jobs.filter((j) => j.schema === REVIEW_SCHEMA).length, 1, 'the AI engineer ran once');
  const reviews = JSON.parse(readFileSync(join(state, 'reviews.json'), 'utf8'));
  assert.deepEqual(Object.values(reviews['github-3'].comments).map((c) => (c as { status: string }).status), ['replied', 'replied']);
});

test('runner: polling adds each task once and keeps going when a watcher fails', async () => {
  const good: Watcher = { name: 'github', poll: async () => [task], get: async () => undefined };
  const bad: Watcher = { name: 'jira', poll: async () => { throw new Error('Jira returned 401'); }, get: async () => undefined };
  const { deps } = await setup(fakeAgent(() => ({})), [bad, good]);
  assert.equal(await pollWatchers(deps), 1);
  assert.equal(await pollWatchers(deps), 0);
  const failed = (await deps.activity.read()).find((e) => e.type === 'watcher.failed');
  assert.equal(failed?.error, 'Jira returned 401');
});

test('runner: once understands issue numbers, Jira keys, crash ids and task files', async () => {
  const seen: string[] = [];
  const w = (name: string): Watcher => ({ name, poll: async () => [], get: async (ref) => { seen.push(`${name}:${ref}`); return { ...task, id: `${name}-${ref}` }; } });
  const { deps, state } = await setup(fakeAgent(() => ({})), [w('github'), w('jira'), w('crashlytics')]);
  for (const ref of ['42', '#43', 'github:44', 'APP-7', 'jira:APP-8', 'crashlytics:abc123']) await resolveTask(deps, ref);
  assert.deepEqual(seen, ['github:42', 'github:43', 'github:44', 'jira:APP-7', 'jira:APP-8', 'crashlytics:abc123']);
  await assert.rejects(resolveTask(deps, 'what?'), /Can't tell what/);
  writeFiles(state, { 'My Task.md': '\n# Fix the login button\n\nIt does nothing.\n' });
  assert.deepEqual(fileTask(join(state, 'My Task.md')), { id: 'file-my-task', source: 'file', ref: join(state, 'My Task.md'), title: 'Fix the login button', body: 'It does nothing.' });
});
