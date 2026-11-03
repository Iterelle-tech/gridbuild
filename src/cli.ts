#!/usr/bin/env node
// The `gridbuild` command: init, doctor, run, once <task>, status.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileActivity, formatEvent } from './activity.ts';
import { claudeAgent } from './agent/claude.ts';
import { CONFIG_FILE, ConfigError, envSecrets, loadConfig, starterConfig, type Config } from './config.ts';
import { androidEmulator } from './devices/android.ts';
import { iosSimulator } from './devices/ios.ts';
import { doctor, formatDoctor } from './doctor.ts';
import { run, shutdown } from './exec.ts';
import { fileLessons } from './lessons.ts';
import { dryRunHost } from './pr/dryrun.ts';
import { githubHost } from './pr/host.ts';
import { fileQueue, LockError, lockStateDir } from './queue.ts';
import { runLoop, runOnce, type RunnerDeps } from './runner.ts';
import type { Watcher } from './types.ts';
import { crashlyticsWatcher } from './watchers/crashlytics.ts';
import { githubWatcher, repoMismatch } from './watchers/github.ts';
import { jiraWatcher } from './watchers/jira.ts';

const HELP = `Gridbuild: an AI engineer for your mobile app, on your own Mac.

Usage: gridbuild <command> [options]

Commands:
  init           Write a starter gridbuild.json in the repo
  doctor         Check git, gh, Claude Code, the iOS Simulator and the Android Emulator
  run            Watch for work and fix tasks one at a time, until you press Ctrl-C
  once <task>    Fix one task now: a GitHub issue number (42), a Jira key (APP-7),
                 crashlytics:<issue id>, or a Markdown file describing the task
  status         Show the queue, pull requests, AI spend and recent activity

Options:
  --repo <dir>   The app's repo (default: the current folder)
  --dry-run      Don't push, open pull requests or post comments. Write the branch
                 name, PR body and proof to a local folder instead
  -h, --help     Show this help

Secrets come from the environment, never gridbuild.json:
  JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN   for the Jira watcher
  GOOGLE_OAUTH_ACCESS_TOKEN (or a gcloud login) for the Crashlytics watcher
`;

const out = (text: string) => process.stdout.write(text + '\n');
const err = (text: string) => process.stderr.write(text + '\n');

/** Aborted on Ctrl-C. */
const stop = new AbortController();
/** Run on Ctrl-C once every child process has stopped: give back the claim, then the lock. */
const cleanups: (() => Promise<void> | void)[] = [];

function buildWatchers(config: Config): Watcher[] {
  const watchers: Watcher[] = [];
  const s = envSecrets();
  const { github, jira, crashlytics } = config.watchers;
  if (github) watchers.push(githubWatcher({ repoDir: config.repoDir, label: github.label, repo: github.repo, allowedUsers: config.review.allowedUsers }));
  if (jira) {
    if (!s.jiraBaseUrl || !s.jiraEmail || !s.jiraToken) {
      throw new ConfigError('The Jira watcher needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in the environment.');
    }
    watchers.push(jiraWatcher({ baseUrl: s.jiraBaseUrl, email: s.jiraEmail, token: s.jiraToken, jql: jira.jql }));
  }
  if (crashlytics) watchers.push(crashlyticsWatcher({ ...crashlytics, accessToken: s.googleToken }));
  return watchers;
}

function buildDeps(config: Config, dryRun: boolean): RunnerDeps {
  return {
    config,
    exec: run,
    queue: fileQueue(config.stateDir),
    activity: fileActivity(config.stateDir, (line) => err(line)),
    lessons: fileLessons(),
    agent: claudeAgent(config.agent),
    devices: [iosSimulator({ device: config.proof.ios?.device }), androidEmulator({ avd: config.proof.android?.device })],
    host: dryRun
      ? dryRunHost({ stateDir: config.stateDir, baseBranch: config.baseBranch })
      : githubHost({ repoDir: config.repoDir, baseBranch: config.baseBranch, stateDir: config.stateDir, repo: config.watchers.github?.repo, allowedUsers: config.review.allowedUsers }),
    watchers: buildWatchers(config),
    dryRun,
    signal: stop.signal,
  };
}

/** For `once` and `run`: checks where PRs go, takes the state folder's lock, and gives it back after. */
async function work<T>(config: Config, dryRun: boolean, fn: (deps: RunnerDeps) => Promise<T>): Promise<T> {
  const mismatch = await repoMismatch(run, config.repoDir, config.watchers.github?.repo);
  if (mismatch) throw new ConfigError(mismatch);
  const lock = lockStateDir(config.stateDir);
  try {
    const deps = buildDeps(config, dryRun);
    cleanups.push(async () => {
      for (const i of await deps.queue.list()) {
        if (i.state === 'claimed' && i.pid === process.pid) await deps.queue.release(i.task.id);
      }
    }, () => lock.release());
    return await fn(deps);
  } finally {
    lock.release();
  }
}

async function init(repoDir: string): Promise<number> {
  const file = join(repoDir, CONFIG_FILE);
  if (existsSync(file)) {
    err(`${file} already exists.`);
    return 1;
  }
  const git = async (args: string[]) => {
    const r = await run('git', args, { cwd: repoDir, timeoutMs: 15_000 });
    return r.code === 0 ? r.stdout.trim() : '';
  };
  if (!(await git(['rev-parse', '--show-toplevel']))) {
    err(`${repoDir} is not a git repository. Run init in your app's repo.`);
    return 1;
  }
  const baseBranch = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '') || (await git(['branch', '--show-current'])) || 'main';
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')); } catch { /* not a JS project */ }
  const config = starterConfig({ baseBranch, hasTestScript: !!pkg.scripts?.test, expo: !!pkg.dependencies?.expo });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  out(`Wrote ${file}.

Next:
  1. Check "test" and the proof.ios / proof.android "run" commands. Each run command
     builds, installs and opens the app on the device, then exits. $GRIDBUILD_DEVICE_ID
     holds the simulator or emulator id. Set "deepLink" to open the right screen.
  2. Run \`gridbuild doctor\`.
  3. Try one task without touching GitHub: \`gridbuild once <issue number> --dry-run\`.`);
  return 0;
}

async function status(config: Config): Promise<number> {
  const items = await fileQueue(config.stateDir).list();
  const events = await fileActivity(config.stateDir).read();
  const count = (state: string) => items.filter((i) => i.state === state).length;
  out(`Queue (${join(config.stateDir, 'queue.json')}): ${count('queued')} queued, ${count('claimed')} working, ${count('done')} done, ${count('failed')} failed, ${count('needs-attention')} need attention`);
  for (const i of items.slice(-20)) {
    const detail = i.pr?.url ?? i.error ?? '';
    out(`  ${i.state.padEnd(15)} ${i.task.id.padEnd(24)} ${i.task.title.slice(0, 50)}${detail ? `  ${detail.slice(0, 120)}` : ''}`);
  }
  const runs = events.filter((e) => e.type === 'agent.finished');
  const spend = runs.reduce((sum, e) => sum + (typeof e.costUsd === 'number' ? e.costUsd : 0), 0);
  out(`\nAI spend: $${spend.toFixed(2)} over ${runs.length} AI engineer runs`);
  out(`\nRecent activity (${join(config.stateDir, 'activity.jsonl')}):`);
  for (const e of events.slice(-15)) out(`  ${formatEvent(e).slice(0, 200)}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { 'dry-run': { type: 'boolean' }, repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command || command === 'help') {
    out(HELP);
    return 0;
  }
  const repoDir = resolve(values.repo ?? process.cwd());
  const dryRun = !!values['dry-run'];

  try {
    switch (command) {
      case 'init':
        return await init(repoDir);
      case 'doctor': {
        out(`Gridbuild doctor (${repoDir})\n`);
        const results = await doctor({ repoDir });
        out(formatDoctor(results));
        return results.some((r) => r.status === 'problem') ? 1 : 0;
      }
      case 'status':
        return await status(await loadConfig(repoDir));
      case 'once': {
        if (!rest[0]) {
          err('Which task? For example: gridbuild once 42');
          return 2;
        }
        return await work(await loadConfig(repoDir), dryRun, async (deps) => {
          const pr = await runOnce(deps, rest[0]);
          if (stop.signal.aborted) return 130;
          if (!pr) {
            err(`\nThe task did not finish. See \`gridbuild status\` and ${join(deps.config.stateDir, 'runs')}.`);
            return 1;
          }
          out(dryRun ? `\nDry run done. PR body, branch and proof: ${join(deps.config.stateDir, 'runs')}` : `\nPull request: ${pr.url}`);
          return 0;
        });
      }
      case 'run':
        return await work(await loadConfig(repoDir), dryRun, async (deps) => {
          err(`Gridbuild is watching for work${dryRun ? ' (dry run)' : ''}. Press Ctrl-C to stop.`);
          await runLoop(deps, stop.signal);
          return stop.signal.aborted ? 130 : 0;
        });
      default:
        err(`Unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    err(e instanceof ConfigError || e instanceof LockError ? e.message : `Error: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  // Ctrl-C: stop every running command (SIGTERM, then SIGKILL after 10 seconds), give back the
  // claim and the lock, then exit. The task in progress resumes on the next start.
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      err('\nStopping (this can take up to 10 seconds). The task in progress resumes on the next start.');
      stop.abort();
      await shutdown();
      for (const cleanup of cleanups) {
        try { await cleanup(); } catch (e) { err(`Cleanup failed: ${(e as Error).message}`); }
      }
      process.exit(130);
    });
  }
  process.exitCode = await main(process.argv.slice(2));
}
