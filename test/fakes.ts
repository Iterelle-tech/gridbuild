// Fakes for every outside tool, so tests never call GitHub, Jira, Firebase, Claude or a simulator.
// Local `git` runs for real, on temporary repos.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run, type Exec, type RunOptions, type RunResult } from '../src/exec.ts';
import type { Agent, AgentJob, AgentResult, DeviceProvider } from '../src/types.ts';

export interface Call {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

export type Handler = (cmd: string, args: string[], opts: RunOptions) => Partial<RunResult> | undefined | Promise<Partial<RunResult> | undefined>;

/** An Exec that answers from `handler` and records every call. Unhandled commands fail loudly. */
export function fakeExec(handler: Handler): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const exec = (async (cmd: string, args: string[], opts: RunOptions = {}) => {
    calls.push({ cmd, args, opts });
    const r = await handler(cmd, args, opts);
    if (!r) return { code: 99, stdout: '', stderr: `fake: no handler for ${cmd} ${args.join(' ')}`, timedOut: false };
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...r };
  }) as Exec & { calls: Call[] };
  exec.calls = calls;
  return exec;
}

/** Real git, fakes for everything else. */
export function gitAndFakes(handler: Handler = () => undefined): Exec & { calls: Call[] } {
  return fakeExec((cmd, args, opts) => (cmd === 'git' || cmd === '/bin/sh' ? run(cmd, args, opts) : handler(cmd, args, opts)));
}

export function tempDir(prefix = 'gridbuild-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run('git', args, { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A local git repo on branch main with one commit, isolated from the user's git config. */
export async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const dir = tempDir('gridbuild-repo-');
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.name', 'Gridbuild Test');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await git(dir, 'config', 'core.hooksPath', '/dev/null');
  writeFiles(dir, files);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'Initial commit');
  return dir;
}

export { git as gitIn };

/** An Agent that runs `act` instead of Claude Code and records every job. */
export function fakeAgent(act: (job: AgentJob) => Partial<AgentResult> | Promise<Partial<AgentResult>>): Agent & { jobs: AgentJob[] } {
  const jobs: AgentJob[] = [];
  return {
    name: 'fake',
    jobs,
    async run(job) {
      jobs.push(job);
      return { ok: true, text: '', costUsd: 0.01, durationMs: 5, turns: 1, ...(await act(job)) };
    },
  };
}

/** A device that "records" by writing a placeholder video file. */
export function fakeDevice(platform: 'ios' | 'android', problems: string[] = []): DeviceProvider & { opened: string[] } {
  const opened: string[] = [];
  return {
    platform,
    name: platform === 'ios' ? 'iOS Simulator' : 'Android Emulator',
    opened,
    async check() {
      return problems;
    },
    async prepare() {
      if (problems.length) throw new Error(problems.join(' '));
      return `${platform}-fake-device`;
    },
    async openUrl(_id, url) {
      opened.push(url);
    },
    async record(id, file) {
      return {
        async stop() {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `placeholder video from ${id}\n`);
        },
      };
    },
  };
}
