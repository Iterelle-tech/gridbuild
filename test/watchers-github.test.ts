import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { githubWatcher, parseIssues, parseRemote, repoMismatch } from '../src/watchers/github.ts';
import { fakeExec, type Handler } from './fakes.ts';

const ISSUES = readFileSync(new URL('./fixtures/gh-issue-list.json', import.meta.url), 'utf8');

/** gh answers: the issue list, who labelled each issue, and each person's permission. */
function github(labelledBy: Record<string, string>, roles: Record<string, string>): Handler {
  return (cmd, args) => {
    if (cmd !== 'gh') return undefined;
    if (args[1] === 'list') return { stdout: ISSUES };
    const events = /^repos\/example\/app\/issues\/(\d+)\/events$/.exec(args[1] ?? '');
    if (events) return { stdout: [JSON.stringify({ label: 'bot', login: 'someone-earlier' }), JSON.stringify({ label: 'bot', login: labelledBy[events[1]] })].join('\n') };
    const perm = /^repos\/example\/app\/collaborators\/(.+)\/permission$/.exec(args[1] ?? '');
    if (perm) return roles[perm[1]] ? { stdout: `${roles[perm[1]]}\n` } : { code: 1, stderr: 'gh: Not Found (HTTP 404)' };
    return undefined;
  };
}

test('github: parses gh issue list output into tasks, oldest first', () => {
  const tasks = parseIssues(ISSUES);
  assert.deepEqual(tasks.map((t) => t.id), ['github-9', 'github-14']);
  const crash = tasks[1];
  assert.equal(crash.source, 'github');
  assert.equal(crash.ref, '14');
  assert.equal(crash.url, 'https://github.com/example/app/issues/14');
  assert.match(crash.body, /Open Settings/);
  assert.match(crash.body, /Labels: crash$/);
});

test('github: polls with gh issue list --label and the configured repo', async () => {
  const exec = fakeExec(github({ 9: 'sam', 14: 'sam' }, { sam: 'write write' }));
  const w = githubWatcher({ repoDir: '/repo', label: 'bot', repo: 'example/app', exec });
  const tasks = await w.poll();
  assert.equal(tasks.length, 2);
  const [call] = exec.calls;
  assert.deepEqual(call.args.slice(0, 5), ['issue', 'list', '--label', 'bot', '--state']);
  assert.ok(call.args.includes('--json'));
  assert.deepEqual(call.args.slice(-2), ['--repo', 'example/app']);
  assert.equal(call.opts.cwd, '/repo');
  assert.ok(call.opts.timeoutMs, 'has a timeout');
});

test('github: only takes an issue when someone with write access added the label', async () => {
  const exec = fakeExec(github({ 9: 'outsider', 14: 'maintainer' }, { maintainer: 'write maintain', outsider: 'read triage' }));
  const w = githubWatcher({ repoDir: '/repo', label: 'bot', repo: 'example/app', exec });
  assert.deepEqual((await w.poll()).map((t) => t.id), ['github-14'], 'the label added last decides, and triage is not enough');
  await w.poll();
  assert.equal(exec.calls.filter((c) => c.args[1]?.includes('/collaborators/')).length, 2, 'permissions are cached for the run');
  const listed = githubWatcher({ repoDir: '/repo', label: 'bot', repo: 'example/app', allowedUsers: ['Outsider'], exec });
  assert.deepEqual((await listed.poll()).map((t) => t.id), ['github-9', 'github-14'], 'review.allowedUsers may also assign work');
  const stranger = githubWatcher({ repoDir: '/repo', label: 'bot', repo: 'example/app', exec: fakeExec(github({ 9: 'nobody', 14: 'nobody' }, {})) });
  assert.deepEqual(await stranger.poll(), [], 'not a collaborator');
});

test('github: known tasks are left out before any limit and before the label checks', async () => {
  const exec = fakeExec(github({ 9: 'sam', 14: 'sam' }, { sam: 'admin admin' }));
  const w = githubWatcher({ repoDir: '/repo', label: 'bot', repo: 'example/app', exec });
  assert.deepEqual((await w.poll(new Set(['github-9']))).map((t) => t.id), ['github-14']);
  const list = exec.calls[0].args;
  assert.ok(Number(list[list.indexOf('--limit') + 1]) >= 1000, 'lists the whole backlog, not the newest 50');
  assert.ok(!exec.calls.some((c) => c.args[1] === 'repos/example/app/issues/9/events'), 'no API calls for known tasks');
});

test('github: refuses a configured repo that is not origin, so pushes and PRs go to the same place', async () => {
  const origin = (url: string) => fakeExec((cmd) => (cmd === 'git' ? { stdout: `${url}\n` } : undefined));
  assert.equal(await repoMismatch(origin('git@github.com:me/app.git'), '/repo', undefined), undefined);
  assert.equal(await repoMismatch(origin('git@github.com:Me/App.git'), '/repo', 'me/app'), undefined);
  assert.match(await repoMismatch(origin('git@github.com:me/app.git'), '/repo', 'upstream/app') ?? '', /is upstream\/app, but origin is github\.com\/me\/app/);
  assert.match(await repoMismatch(origin('/tmp/local'), '/repo', 'me/app') ?? '', /origin is \/tmp\/local/);
});

test('github: gets one issue and reports gh failures clearly', async () => {
  const one = JSON.stringify(JSON.parse(ISSUES)[0]);
  const exec = fakeExec((_cmd, args) => (args[1] === 'view' ? { stdout: one } : { code: 1, stderr: 'HTTP 401: Bad credentials' }));
  const w = githubWatcher({ repoDir: '/repo', label: 'bot', repo: 'example/app', exec });
  assert.equal((await w.get('14'))?.id, 'github-14');
  await assert.rejects(w.poll(), /gh issue list failed: HTTP 401/);
});

test('github: works out owner/name from the origin remote, so a fork never talks to its upstream', async () => {
  assert.equal(parseRemote('git@github.com:me/social-app.git\n'), 'me/social-app');
  assert.equal(parseRemote('https://github.com/me/social-app'), 'me/social-app');
  assert.equal(parseRemote('git@github.com-oss:Me/social-app.git'), 'Me/social-app');
  assert.equal(parseRemote('/tmp/local-remote'), undefined);
  const exec = fakeExec((cmd) => (cmd === 'git' ? { stdout: 'https://github.com/me/social-app.git\n' } : { stdout: '[]' }));
  await githubWatcher({ repoDir: '/repo', label: 'bot', exec }).poll();
  assert.deepEqual(exec.calls[1].args.slice(-2), ['--repo', 'me/social-app']);
  await assert.rejects(githubWatcher({ repoDir: '/repo', label: 'bot', exec: fakeExec(() => ({ code: 2 })) }).poll(), /Set "watchers.github.repo"/);
});
