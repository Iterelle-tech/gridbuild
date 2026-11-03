// Every outside command (git, gh, claude, xcrun, adb, build and test scripts) goes through here,
// always with a timeout. Commands run in their own process group so a hung grandchild
// (for example `simctl` under `xcrun`) is killed along with its parent.
import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Give the command only `env`, not this process's environment (see `agentEnv` in config.ts). */
  cleanEnv?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A long-running process, such as a screen recording. */
export interface Proc {
  output(): string;
  stop(signal?: NodeJS.Signals, graceMs?: number): Promise<RunResult>;
  done: Promise<RunResult>;
}

export type Exec = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
export type Start = (cmd: string, args: string[], opts?: RunOptions) => Proc;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 20 * 1024 * 1024;
const live = new Set<ChildProcess>();
let stopping = false;

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function launch(cmd: string, args: string[], opts: RunOptions, timeoutMs: number | undefined) {
  if (stopping) {
    const result = { code: 130, stdout: '', stderr: 'Gridbuild is stopping', timedOut: false };
    return { child: undefined, done: Promise.resolve(result), output: () => '' };
  }
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.cleanEnv ? { ...opts.env } : { ...process.env, ...opts.env },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.add(child);
  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      live.delete(child);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout?.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('error', (err: NodeJS.ErrnoException) => {
      stderr += err.code === 'ENOENT' ? `command not found: ${cmd}` : err.message;
      finish(err.code === 'ENOENT' ? 127 : 1);
    });
    child.on('close', (code) => finish(code ?? 1));
    // If an orphaned grandchild keeps the pipes open, 'close' never fires; don't wait for it.
    child.on('exit', (code) => { setTimeout(() => finish(code ?? 1), 1000).unref(); });
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        setTimeout(() => killGroup(child, 'SIGKILL'), 3000).unref();
        setTimeout(() => finish(124), 6000).unref();
      }, timeoutMs);
    }
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end(opts.input ?? '');
  return { child, done, output: () => stdout + stderr };
}

export const run: Exec = (cmd, args, opts = {}) =>
  launch(cmd, args, opts, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS).done;

export const start: Start = (cmd, args, opts = {}) => {
  const p = launch(cmd, args, opts, opts.timeoutMs);
  return {
    done: p.done,
    output: p.output,
    async stop(signal = 'SIGINT', graceMs = 20_000) {
      const child = p.child;
      if (!child) return p.done;
      killGroup(child, signal);
      const timer = setTimeout(() => killGroup(child, 'SIGKILL'), graceMs);
      const result = await p.done;
      clearTimeout(timer);
      return result;
    },
  };
};

/** Run a shell command line from gridbuild.json, such as the test or build command. */
export function shell(exec: Exec, command: string, opts: RunOptions): Promise<RunResult> {
  return exec('/bin/sh', ['-c', command], opts);
}

/**
 * For Ctrl-C: start no new commands, send SIGTERM to every running command's process group,
 * wait up to `graceMs` for the groups to exit, then SIGKILL whatever is left.
 */
export async function shutdown(graceMs = 10_000): Promise<void> {
  stopping = true;
  const groups = [...live].flatMap((c) => (c.pid === undefined ? [] : [c.pid]));
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + graceMs;
  while (groups.some(groupAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of groups.filter(groupAlive)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
