// The runner: poll watchers, work one task at a time (worktree, before video, fix, tests,
// after video, PR), and answer reviews. Every step goes to the activity log. Each task's
// progress is saved after every phase, so a restart resumes where it stopped.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FIX_SCHEMA, fixPrompt, readRepoRules, type FixSummary } from './agent/prompt.ts';
import type { Config } from './config.ts';
import { firstLine, type Exec } from './exec.ts';
import { prBody, prTitle } from './pr/body.ts';
import type { PrHost } from './pr/host.ts';
import { reviewOpenPrs } from './pr/review.ts';
import { agentEvent, recordPhase, runTests, type TestResult, type Video } from './proof/proof.ts';
import { redact, writePrivate } from './redact.ts';
import type { Activity, Agent, DeviceProvider, Lessons, PullRequest, Queue, QueueItem, Task, Watcher } from './types.ts';
import { baseCommit, commitCode, createDetachedWorktree, createWorktree, discardChanges, hasChanges, head, removeDetachedWorktree } from './worktree.ts';

export interface RunnerDeps {
  config: Config;
  exec: Exec;
  queue: Queue;
  activity: Activity;
  lessons: Lessons;
  agent: Agent;
  devices: DeviceProvider[];
  host: PrHost;
  watchers: Watcher[];
  dryRun: boolean;
  /** Aborted on Ctrl-C. Work stops without failing the task, and resumes on the next start. */
  signal?: AbortSignal;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function pollWatchers(d: RunnerDeps): Promise<number> {
  let total = 0;
  for (const w of d.watchers) {
    try {
      const known = new Set((await d.queue.list()).map((i) => i.task.id));
      const tasks = await w.poll(known);
      let added = 0;
      for (const task of tasks) {
        if (!(await d.queue.add(task))) continue;
        added++;
        await d.activity.log('task.queued', { task: task.id, source: w.name, title: task.title });
      }
      await d.activity.log('watcher.polled', { watcher: w.name, found: tasks.length, added });
      total += added;
    } catch (err) {
      await d.activity.log('watcher.failed', { watcher: w.name, error: message(err) });
    }
  }
  return total;
}

function asFixSummary(data: unknown, text: string): FixSummary {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    wrong: str(d.wrong),
    changed: str(d.changed) || text.trim().slice(0, 2000),
    tested: str(d.tested),
    notChecked: Array.isArray(d.notChecked) ? d.notChecked.filter((n): n is string => typeof n === 'string') : [],
  };
}

/** The phases of a task, in order. The last one finished is saved in the task's progress.json. */
const PHASES = ['started', 'filmed-before', 'fixed', 'tested', 'filmed-after', 'pushed', 'pr-opened'] as const;
type Phase = (typeof PHASES)[number];

interface Filmed {
  videos: Video[];
  notChecked: string[];
}

export interface Progress {
  phase: Phase;
  /** The commit the task branch starts from. */
  base: string;
  fix?: string;
  summary?: FixSummary;
  before?: Filmed;
  tests?: TestResult;
  after?: Filmed;
  links?: Record<string, string>;
  pr?: PullRequest;
}

class Stopped extends Error {}

/** Films the app before the fix from the base commit, in a throwaway worktree with no branch. */
async function filmBefore(d: RunnerDeps, task: Task, base: string, outDir: string): Promise<Filmed> {
  const wanted = d.devices.some((x) => d.config.proof[x.platform]);
  const path = join(d.config.stateDir, 'before', task.id);
  if (!wanted) return recordPhase(d, { task, worktree: path, outDir, phase: 'before' });
  await createDetachedWorktree(d.exec, { repoDir: d.config.repoDir, path, commit: base });
  try {
    return await recordPhase(d, { task, worktree: path, outDir, phase: 'before' });
  } finally {
    await removeDetachedWorktree(d.exec, d.config.repoDir, path);
  }
}

/** Works one claimed task end to end, resuming from its last finished phase. Returns the PR, or undefined. */
export async function workTask(d: RunnerDeps, item: QueueItem): Promise<PullRequest | undefined> {
  const { config, exec, activity } = d;
  const task = item.task;
  const runDir = join(config.stateDir, 'runs', task.id);
  const proofDir = join(runDir, 'proof');
  const progressFile = join(runDir, 'progress.json');
  await mkdir(runDir, { recursive: true });

  const notify = async (text: string) => {
    const watcher = d.watchers.find((w) => w.name === task.source);
    if (d.dryRun || !watcher?.notify) return;
    try {
      await watcher.notify(task, redact(text));
    } catch (err) {
      await activity.log('notify.failed', { task: task.id, error: message(err) });
    }
  };

  const saved = JSON.parse(await readFile(progressFile, 'utf8').catch(() => 'null')) as Progress | null;
  await activity.log('task.claimed', { task: task.id, title: task.title, attempt: item.attempts, resumeFrom: saved?.phase });
  if (!saved) await notify('Gridbuild picked this up. An AI engineer is working on it.');
  try {
    const p: Progress = saved ?? { phase: 'started', base: await baseCommit(exec, config.repoDir, config.baseBranch, !d.dryRun) };
    const finished = (phase: Phase) => PHASES.indexOf(p.phase) >= PHASES.indexOf(phase);
    const persist = () => writeFile(progressFile, JSON.stringify(p, null, 2) + '\n');
    const save = async (phase: Phase, update: Partial<Progress> = {}) => {
      // A phase cut short by Ctrl-C is never recorded as finished.
      if (d.signal?.aborted) throw new Stopped();
      Object.assign(p, update, { phase });
      await persist();
    };

    const wt = await createWorktree(exec, { repoDir: config.repoDir, stateDir: config.stateDir, taskId: task.id, baseRef: p.base });
    await activity.log('worktree.ready', { task: task.id, branch: wt.branch, path: wt.path, base: p.base });
    if (!saved) await save('started');

    if (!finished('filmed-before')) await save('filmed-before', { before: await filmBefore(d, task, p.base, proofDir) });

    if (!finished('fixed')) {
      // Never reset or clean a worktree with work in it: an interrupted fix waits for a person.
      if (await hasChanges(exec, wt.path)) {
        const reason = `An earlier fix was interrupted and left uncommitted changes in ${wt.path}. Gridbuild left them as they are. Look at them, commit or discard them, then run \`gridbuild once ${task.id}\` again.`;
        await d.queue.needsAttention(task.id, reason);
        await activity.log('task.needs-attention', { task: task.id, reason });
        return undefined;
      }
      let summary: FixSummary | undefined;
      if ((await head(exec, wt.path)) !== p.base) {
        await activity.log('fix.found', { task: task.id, note: 'the branch already has commits beyond the base; using them as the fix' });
      } else {
        const prompt = fixPrompt({
          task,
          rules: await readRepoRules(wt.path),
          lessons: await d.lessons.read(wt.path),
          test: config.test,
          branch: wt.branch,
        });
        await activity.log('agent.started', { task: task.id, step: 'fix', agent: d.agent.name });
        const result = await d.agent.run({ prompt, cwd: wt.path, timeoutMs: config.agent.minutes * 60_000, schema: FIX_SCHEMA });
        await writePrivate(join(runDir, 'agent.txt'), result.text || result.error || '');
        await activity.log('agent.finished', agentEvent(task.id, 'fix', result));
        if (d.signal?.aborted) throw new Stopped();
        if (!result.ok) throw new Error(result.error ?? 'The AI engineer stopped without finishing');

        const commitMessage = `${prTitle(task)}\n\nGridbuild task ${task.id}${task.url ? `\n${task.url}` : ''}`;
        if (!(await commitCode(exec, wt.path, commitMessage))) {
          throw new Error(`The AI engineer made no changes. It said: ${firstLine(result.text) || '(nothing)'}`);
        }
        summary = asFixSummary(result.data, result.text);
      }
      // The fix is committed, so only leftovers (such as edits to the lessons file) go.
      await discardChanges(exec, wt.path);
      await save('fixed', { fix: await head(exec, wt.path), summary });
      await activity.log('fix.committed', { task: task.id, branch: wt.branch, commit: p.fix });
    } else if (p.fix && (await exec('git', ['merge-base', '--is-ancestor', p.fix, 'HEAD'], { cwd: wt.path, timeoutMs: 30_000 })).code !== 0) {
      throw new Error(`The fix commit ${p.fix.slice(0, 12)} is no longer on ${wt.branch}. To start this task over, delete ${progressFile}.`);
    }

    if (!finished('tested')) {
      const tests = await runTests(d, { worktree: wt.path, outDir: proofDir });
      if (tests) await activity.log('tests.finished', { task: task.id, passed: tests.passed, code: tests.code });
      await save('tested', { tests });
    }

    if (!finished('filmed-after')) await save('filmed-after', { after: await recordPhase(d, { task, worktree: wt.path, outDir: proofDir, phase: 'after' }) });

    if (!finished('pushed')) {
      await d.host.push({ branch: wt.branch, worktree: wt.path });
      await save('pushed');
      await activity.log('branch.pushed', { task: task.id, branch: wt.branch, dryRun: d.dryRun || undefined });
    }

    if (!finished('pr-opened')) {
      const before = p.before ?? { videos: [], notChecked: [] };
      const after = p.after ?? { videos: [], notChecked: [] };
      const videos = [...before.videos, ...after.videos];
      if (!p.links) {
        p.links = await d.host.publishProof(task.id, videos.map((v) => v.file));
        await persist();
      }
      const body = redact(prBody({
        task,
        summary: p.summary,
        tests: p.tests,
        videos,
        links: p.links,
        notChecked: [...before.notChecked, ...after.notChecked],
      }));
      const tests = p.tests;
      const pr = await d.host.open({ task, branch: wt.branch, worktree: wt.path, title: prTitle(task), body, draft: !!tests && !tests.passed, runDir });
      await save('pr-opened', { pr });
      await activity.log('pr.opened', { task: task.id, url: pr.url, dryRun: d.dryRun || undefined });
    }

    const pr = p.pr!;
    await d.queue.done(task.id, pr);
    await activity.log('task.done', { task: task.id, pr: pr.url });
    await notify(`Gridbuild opened a pull request: ${pr.url}`);
    return pr;
  } catch (err) {
    // Ctrl-C: the claim is given back and the next start resumes from the last finished phase.
    if (err instanceof Stopped || d.signal?.aborted) return undefined;
    await d.queue.fail(task.id, message(err));
    await activity.log('task.failed', { task: task.id, error: message(err) });
    await notify(`Gridbuild could not finish this: ${message(err)}`);
    return undefined;
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'task';
}

/** A task from a Markdown file: the first line is the title, the rest is the description. */
export function fileTask(path: string): Task {
  const lines = readFileSync(path, 'utf8').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) throw new Error(`${path} is empty`);
  return {
    id: `file-${slug(basename(path, extname(path)))}`,
    source: 'file',
    ref: resolve(path),
    title: lines[first].replace(/^#+\s*/, '').trim(),
    body: lines.slice(first + 1).join('\n').trim(),
  };
}

/** Finds a task from what the user typed after `gridbuild once`. */
export async function resolveTask(d: RunnerDeps, ref: string): Promise<Task> {
  if (existsSync(ref) && statSync(ref).isFile()) return fileTask(ref);
  const known = (await d.queue.list()).find((i) => i.task.id === ref);
  if (known) return known.task;

  const watcher = (name: string) => {
    const w = d.watchers.find((x) => x.name === name);
    if (!w) throw new Error(`The ${name} watcher is not set up in gridbuild.json`);
    return w;
  };
  const found = async (name: string, id: string) => {
    const task = await watcher(name).get(id);
    if (!task) throw new Error(`No ${name} item ${id}`);
    return task;
  };
  let m: RegExpExecArray | null;
  if ((m = /^(?:github:|#)?(\d+)$/.exec(ref))) return found('github', m[1]);
  if ((m = /^(?:jira:)?([A-Z][A-Z0-9_]*-\d+)$/.exec(ref))) return found('jira', m[1]);
  if ((m = /^crashlytics:(.+)$/.exec(ref))) return found('crashlytics', m[1]);
  throw new Error(`Can't tell what "${ref}" is. Use a GitHub issue number (42), a Jira key (APP-7), crashlytics:<issue id>, or a path to a .md file.`);
}

/** `gridbuild once <task>`: work one task now. */
export async function runOnce(d: RunnerDeps, ref: string): Promise<PullRequest | undefined> {
  const task = await resolveTask(d, ref);
  const existing = (await d.queue.list()).find((i) => i.task.id === task.id);
  if (existing?.state === 'done') throw new Error(`Task ${task.id} is already done: ${existing.pr?.url}`);
  if (await d.queue.add(task)) await d.activity.log('task.queued', { task: task.id, source: task.source, title: task.title });
  const item = await d.queue.claim(task.id);
  if (!item) throw new Error(`Task ${task.id} is being worked on by another Gridbuild process`);
  return workTask(d, item);
}

/** `gridbuild run`: the loop, until the signal aborts. */
export async function runLoop(d: RunnerDeps, signal: AbortSignal): Promise<void> {
  await d.activity.log('runner.started', {
    dryRun: d.dryRun || undefined,
    watchers: d.watchers.map((w) => w.name),
    devices: d.devices.filter((x) => d.config.proof[x.platform]).map((x) => x.platform),
  });
  while (!signal.aborted) {
    await pollWatchers(d);
    if (signal.aborted) break;
    await reviewOpenPrs(d);
    const item = signal.aborted ? undefined : await d.queue.claim();
    if (item) {
      await workTask(d, item);
      continue;
    }
    await sleep(d.config.pollSeconds * 1000, undefined, { signal }).catch(() => {});
  }
  await d.activity.log('runner.stopped');
}
