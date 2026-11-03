// One git worktree per task, on branch gridbuild/<task id>, kept outside the repo so the
// app's own tools (Metro, Jest, Xcode) never see it. Gridbuild never resets or cleans a task
// worktree before the fix is committed, so an interrupted fix is never thrown away.
import { existsSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { firstLine, type Exec } from './exec.ts';
import { LESSONS_PATH } from './lessons.ts';

export interface Worktree {
  path: string;
  branch: string;
}

export function branchFor(taskId: string): string {
  return `gridbuild/${taskId}`;
}

export async function git(exec: Exec, cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const r = await exec('git', args, { cwd, timeoutMs });
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed${r.timedOut ? ' (timed out)' : ''}: ${firstLine(r.stderr || r.stdout)}`);
  }
  return r.stdout.trim();
}

async function succeeds(exec: Exec, cwd: string, args: string[]): Promise<boolean> {
  return (await exec('git', args, { cwd, timeoutMs: 30_000 })).code === 0;
}

async function commonDir(exec: Exec, dir: string): Promise<string> {
  return realpathSync(await git(exec, dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

/** Creates the task's worktree, or reuses it after a restart if it belongs to this repo and branch. */
export async function createWorktree(exec: Exec, opts: { repoDir: string; stateDir: string; taskId: string; baseRef: string }): Promise<Worktree> {
  const branch = branchFor(opts.taskId);
  const path = join(opts.stateDir, 'worktrees', opts.taskId);
  if (existsSync(join(path, '.git'))) {
    if ((await commonDir(exec, path)) !== (await commonDir(exec, opts.repoDir))) {
      throw new Error(`${path} is a worktree of a different repo. Move it away, or set "stateDir" in gridbuild.json.`);
    }
    const current = await git(exec, path, ['branch', '--show-current']);
    if (current !== branch) throw new Error(`${path} is on ${current ? `branch ${current}` : 'a detached HEAD'}, not ${branch}. Check it out there, or move the folder away.`);
    return { path, branch };
  }
  await git(exec, opts.repoDir, ['worktree', 'prune']);
  const branchExists = await succeeds(exec, opts.repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const args = branchExists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, opts.baseRef];
  await git(exec, opts.repoDir, args, 120_000);
  return { path, branch };
}

/** The commit to branch from: origin/<base> after a fetch when there is a remote, else the local branch. */
export async function baseCommit(exec: Exec, repoDir: string, baseBranch: string, useRemote: boolean): Promise<string> {
  let ref = baseBranch;
  if (useRemote && (await succeeds(exec, repoDir, ['remote', 'get-url', 'origin']))) {
    await git(exec, repoDir, ['fetch', 'origin', baseBranch], 120_000);
    ref = `origin/${baseBranch}`;
  }
  return git(exec, repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/** A throwaway worktree at `commit` with no branch, for filming the app before the fix. */
export async function createDetachedWorktree(exec: Exec, opts: { repoDir: string; path: string; commit: string }): Promise<void> {
  await removeDetachedWorktree(exec, opts.repoDir, opts.path);
  await git(exec, opts.repoDir, ['worktree', 'add', '--detach', opts.path, opts.commit], 120_000);
}

export async function removeDetachedWorktree(exec: Exec, repoDir: string, path: string): Promise<void> {
  if (existsSync(path)) {
    await exec('git', ['worktree', 'remove', '--force', path], { cwd: repoDir, timeoutMs: 60_000 });
    await rm(path, { recursive: true, force: true });
  }
  await git(exec, repoDir, ['worktree', 'prune']);
}

export async function hasChanges(exec: Exec, dir: string): Promise<boolean> {
  return (await git(exec, dir, ['status', '--porcelain'])) !== '';
}

export async function head(exec: Exec, dir: string): Promise<string> {
  return git(exec, dir, ['rev-parse', 'HEAD']);
}

/** True when the branch has commits its remote-tracking branch does not. False when it was never pushed. */
export async function aheadOfRemote(exec: Exec, dir: string, branch: string): Promise<boolean> {
  const r = await exec('git', ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`], { cwd: dir, timeoutMs: 30_000 });
  return r.code === 0 && Number(r.stdout.trim()) > 0;
}

/** Commits the code changes. The lessons file is left for its own commit. */
export async function commitCode(exec: Exec, dir: string, message: string): Promise<boolean> {
  await git(exec, dir, ['add', '-A', '--', '.', `:!${LESSONS_PATH}`]);
  if (await succeeds(exec, dir, ['diff', '--cached', '--quiet'])) return false;
  await git(exec, dir, ['commit', '-q', '-m', message]);
  return true;
}

export async function commitLessons(exec: Exec, dir: string, message: string): Promise<boolean> {
  await git(exec, dir, ['add', '--', LESSONS_PATH]);
  if (await succeeds(exec, dir, ['diff', '--cached', '--quiet'])) return false;
  await git(exec, dir, ['commit', '-q', '-m', message, '--', LESSONS_PATH]);
  return true;
}

/**
 * Throws away anything not committed, such as files touched while building, filming or testing.
 * Only call it on a throwaway worktree, or on a task worktree right after its work was committed.
 */
export async function discardChanges(exec: Exec, dir: string): Promise<void> {
  await git(exec, dir, ['reset', '--hard', '-q']);
  await git(exec, dir, ['clean', '-fdq']);
}
