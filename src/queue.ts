// The local task queue: one JSON file, rewritten atomically, so claim and done state
// survive restarts. A claim held by a process that has died is picked up again.
// `lockStateDir` makes sure only one Gridbuild process works in a state folder.
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullRequest, Queue, QueueItem, Task } from './types.ts';

const MAX_ATTEMPTS = 3;

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class LockError extends Error {}

/**
 * Takes the state folder's lock: a file created atomically, holding this process's PID.
 * A lock left by a process that is no longer running is taken over.
 */
export function lockStateDir(stateDir: string): { release(): void } {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, 'gridbuild.lock');
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(tmp, file); // fails if the lock exists, and never leaves a half-written one
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
        const pid = Number(readFileSync(file, 'utf8').trim());
        if (alive(pid)) {
          throw new LockError(`Another Gridbuild process (PID ${pid}) is already working on this repo, with its state in ${stateDir}. Stop it first, or wait for it to finish.`);
        }
        unlinkSync(file);
      }
    }
  } finally {
    unlinkSync(tmp);
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      try {
        if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
      } catch { /* already gone */ }
    },
  };
}

export function fileQueue(stateDir: string): Queue {
  const file = join(stateDir, 'queue.json');

  async function load(): Promise<QueueItem[]> {
    const text = await readFile(file, 'utf8').catch(() => '');
    return text ? (JSON.parse(text).items as QueueItem[]) : [];
  }

  async function save(items: QueueItem[]): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ items }, null, 2) + '\n');
    await rename(tmp, file);
  }

  async function change(id: string, fn: (item: QueueItem) => void): Promise<void> {
    const items = await load();
    const item = items.find((i) => i.task.id === id);
    if (!item) throw new Error(`No task ${id} in the queue`);
    fn(item);
    await save(items);
  }

  async function claim(id?: string): Promise<QueueItem | undefined> {
    const items = await load();
    const stale = (i: QueueItem) => i.state === 'claimed' && !alive(i.pid);
    const item = id
      ? items.find((i) => i.task.id === id && (i.state !== 'claimed' || stale(i)))
      : items.find((i) => i.state === 'queued' || stale(i));
    if (!item) return undefined;
    if (!id && item.attempts >= MAX_ATTEMPTS) {
      Object.assign(item, { state: 'failed', error: `Stopped after ${MAX_ATTEMPTS} attempts`, finishedAt: new Date().toISOString() });
      await save(items);
      return claim();
    }
    Object.assign(item, { state: 'claimed', pid: process.pid, claimedAt: new Date().toISOString(), attempts: item.attempts + 1 });
    delete item.error;
    await save(items);
    return item;
  }

  return {
    claim,

    async add(task: Task) {
      const items = await load();
      if (items.some((i) => i.task.id === task.id)) return false;
      items.push({ task, state: 'queued', addedAt: new Date().toISOString(), attempts: 0 });
      await save(items);
      return true;
    },

    async done(id: string, pr: PullRequest) {
      await change(id, (i) => Object.assign(i, { state: 'done', pr, finishedAt: new Date().toISOString() }));
    },

    async fail(id: string, error: string) {
      await change(id, (i) => Object.assign(i, { state: 'failed', error, finishedAt: new Date().toISOString() }));
    },

    async needsAttention(id: string, reason: string) {
      await change(id, (i) => Object.assign(i, { state: 'needs-attention', error: reason, finishedAt: new Date().toISOString() }));
    },

    async release(id: string) {
      await change(id, (i) => {
        if (i.state !== 'claimed' || i.pid !== process.pid) return;
        Object.assign(i, { state: 'queued', attempts: Math.max(0, i.attempts - 1) });
        delete i.pid;
        delete i.claimedAt;
      });
    },

    list: load,
  };
}
