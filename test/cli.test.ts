import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/exec.ts';
import { doctor, formatDoctor } from '../src/doctor.ts';
import { fixtureRepo, gitAndFakes, gitIn, tempDir } from './fakes.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cli = (args: string[], cwd?: string) => run(process.execPath, [CLI, ...args], { cwd, timeoutMs: 30_000 });

test('cli: --help, unknown commands and a missing config', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  for (const c of ['init', 'doctor', 'run', 'once <task>', 'status', '--dry-run']) assert.ok(help.stdout.includes(c), c);
  assert.equal((await cli(['launch'])).code, 2);
  const dir = tempDir();
  const once = await cli(['once', '42', '--repo', dir]);
  assert.equal(once.code, 1);
  assert.match(once.stderr, /No gridbuild\.json in .* Run `gridbuild init`/);
});

test('cli: init writes a starter config for an Expo app, then status reads an empty queue', async () => {
  const repo = await fixtureRepo({ 'package.json': JSON.stringify({ scripts: { test: 'jest' }, dependencies: { expo: '^54.0.0' } }) });
  const init = await cli(['init'], repo);
  assert.equal(init.code, 0, init.stderr);
  const config = JSON.parse(readFileSync(join(repo, 'gridbuild.json'), 'utf8'));
  assert.equal(config.baseBranch, 'main');
  assert.equal(config.test, 'npm test');
  assert.deepEqual(config.watchers, { github: { label: 'bot' } });
  assert.match(config.proof.ios.run, /expo run:ios .*--no-bundler/);
  assert.equal((await cli(['init'], repo)).code, 1, 'never overwrites');

  const state = tempDir();
  const withState = { ...config, stateDir: state };
  writeFileSync(join(repo, 'gridbuild.json'), JSON.stringify(withState));
  const status = await cli(['status', '--repo', repo]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /0 queued, 0 working, 0 done, 0 failed/);
  assert.match(status.stdout, /AI spend: \$0\.00 over 0/);
});

test('doctor: a hung simctl and a missing Android SDK are reported quickly and clearly', async () => {
  const repo = await fixtureRepo({ 'gridbuild.json': JSON.stringify({ watchers: { github: {}, jira: {} }, proof: { ios: { run: 'true' } } }) });
  const saved = { ...process.env };
  delete process.env.JIRA_BASE_URL; delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN;
  try {
    const exec = gitAndFakes((cmd, args) => {
      if (cmd === 'xcrun') return { code: 124, timedOut: true };
      if (cmd === 'gh' && args[0] === 'auth') return { code: 1, stderr: 'not logged in' };
      if (cmd === 'gh' || cmd === 'claude') return { stdout: `${cmd} 1.0.0\n` };
      return { code: 127, stderr: `command not found: ${cmd}` };
    });
    const began = Date.now();
    const results = await doctor({ repoDir: repo, exec });
    assert.ok(Date.now() - began < 5000);
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(by['iOS Simulator'].status, 'problem');
    assert.match(by['iOS Simulator'].detail, /did not answer within 15 seconds/);
    assert.equal(by['Android Emulator'].status, 'warn', 'Android is not set up in this config, so it is only a warning');
    assert.match(by['Android Emulator'].detail, /adb is not installed/);
    assert.match(by['GitHub CLI'].detail, /not signed in. Run `gh auth login`/);
    assert.match(by.Jira.detail, /set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);
    assert.equal(by['Claude Code'].status, 'ok');
    assert.equal(by.Repo.status, 'ok');
    assert.equal(by.Crashlytics.status, 'skip');
    assert.match(formatDoctor(results), /3 problems to fix\.$/);
    assert.ok(!exec.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'api'), 'doctor never calls the GitHub API');
  } finally {
    Object.assign(process.env, saved);
  }
});

test('cli: a second Gridbuild on the same repo stops with a clear message', async () => {
  const state = tempDir();
  const repo = await fixtureRepo({ 'gridbuild.json': JSON.stringify({ stateDir: state, watchers: {} }) });
  writeFileSync(join(state, 'gridbuild.lock'), `${process.pid}\n`); // this test process stands in for the first one
  writeFileSync(join(state, 'task.md'), '# Task\n');
  const r = await cli(['once', join(state, 'task.md'), '--repo', repo]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`Another Gridbuild process \\(PID ${process.pid}\\) is already working on this repo`));
});

test('cli and doctor: refuse a watchers.github.repo that is not origin', async () => {
  const state = tempDir();
  const repo = await fixtureRepo({ 'gridbuild.json': JSON.stringify({ stateDir: state, watchers: { github: { repo: 'upstream/app' } } }) });
  await gitIn(repo, 'remote', 'add', 'origin', 'git@github.com:me/app.git');
  const once = await cli(['once', '42', '--repo', repo]);
  assert.equal(once.code, 1);
  assert.match(once.stderr, /"watchers\.github\.repo" is upstream\/app, but origin is github\.com\/me\/app/);
  const results = await doctor({ repoDir: repo, exec: gitAndFakes(() => ({ code: 127 })), devices: [] });
  const check = results.find((r) => r.name === 'GitHub repo');
  assert.equal(check?.status, 'problem');
  assert.match(check?.detail ?? '', /forks are not supported yet/);
});

test('cli: once --dry-run runs the whole task through the Claude adapter, with a stand-in claude command', async () => {
  const state = tempDir();
  // Stands in for `claude -p --output-format json`: reads the prompt, fixes the file, prints a result.
  const fakeClaude = join(state, 'fake-claude.mjs');
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const prompt = readFileSync(0, 'utf8');
if (!process.argv.includes('-p') || !prompt.includes('Fix the task')) process.exit(3);
writeFileSync('src/greeting.js', readFileSync('src/greeting.js', 'utf8').replace('Helo', 'Hello'));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed the typo.', total_cost_usd: 0.12, duration_ms: 900, num_turns: 3,
  structured_output: { wrong: 'A typo.', changed: 'Fixed it.', tested: 'Ran the check.', notChecked: [] } }));
`, { mode: 0o755 });
  const repo = await fixtureRepo({
    'src/greeting.js': 'export const greeting = (name) => `Helo, ${name}!`;\n',
    'gridbuild.json': JSON.stringify({ stateDir: state, watchers: {}, test: 'grep -q Hello src/greeting.js', agent: { command: fakeClaude, args: [] } }),
  });
  writeFileSync(join(state, 'typo.md'), '# Greeting typo\n\nIt says Helo.\n');
  const r = await cli(['once', join(state, 'typo.md'), '--dry-run', '--repo', repo]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Dry run done/);
  assert.match(r.stderr, /agent\.finished\s+file-typo\s+step=fix ok=true costUsd=0\.12 durationMs=900 turns=3/);
  const body = readFileSync(join(state, 'runs', 'file-typo', 'pr.md'), 'utf8');
  assert.match(body, /## What was wrong\n\nA typo\./);
  assert.match(body, /`grep -q Hello src\/greeting\.js` passed/);
  assert.match(body, /iOS Simulator: no `proof\.ios\.run` command/);
  const status = await cli(['status', '--repo', repo]);
  assert.match(status.stdout, /1 done/);
  assert.match(status.stdout, /AI spend: \$0\.12 over 1 AI engineer runs/);
});
