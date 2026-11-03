// The review loop: for each open Gridbuild PR, answer new review comments, re-test, re-film,
// push, and save corrections to the lessons file as a separate commit on the same PR.
// Each comment's progress is saved on its own, so a failed push or reply is retried alone,
// without running the AI engineer again.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readRepoRules, REVIEW_SCHEMA, reviewPrompt, type ReviewAnswer, type ReviewComment } from '../agent/prompt.ts';
import { agentEvent, recordPhase, runTests, testLine } from '../proof/proof.ts';
import { redact } from '../redact.ts';
import type { RunnerDeps } from '../runner.ts';
import type { QueueItem } from '../types.ts';
import { aheadOfRemote, commitCode, commitLessons, createWorktree, discardChanges } from '../worktree.ts';

/** `answered`: the reply is written but not yet posted. */
interface CommentRecord {
  status: 'answered' | 'replied';
  reply: string;
}
interface ReviewRecord {
  comments: Record<string, CommentRecord>;
  rounds?: number;
  closed?: boolean;
}
type ReviewState = Record<string, ReviewRecord>;

function asReviewAnswer(data: unknown): ReviewAnswer {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const replies = Array.isArray(d.replies)
    ? d.replies.filter((r) => r && typeof r.id === 'string' && typeof r.reply === 'string')
    : [];
  const lessons = Array.isArray(d.lessons) ? d.lessons.filter((l): l is string => typeof l === 'string' && !!l.trim()) : [];
  return { replies, lessons };
}

export async function reviewOpenPrs(d: RunnerDeps): Promise<void> {
  const file = join(d.config.stateDir, 'reviews.json');
  const state: ReviewState = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
  const save = async () => {
    await mkdir(d.config.stateDir, { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2) + '\n');
  };

  for (const item of await d.queue.list()) {
    if (item.state !== 'done' || !item.pr) continue;
    const pr = item.pr;
    const record = (state[item.task.id] ??= { comments: {} });
    if (record.closed) continue;
    try {
      const prState = await d.host.state(pr);
      if (prState !== 'open') {
        record.closed = true;
        await save();
        await d.activity.log('review.closed', { task: item.task.id, state: prState });
        continue;
      }
      // Commits that never reached the PR, such as after a failed push.
      if (existsSync(join(pr.worktree, '.git')) && (await aheadOfRemote(d.exec, pr.worktree, pr.branch))) {
        await d.host.push(pr);
        await d.activity.log('pr.pushed', { task: item.task.id, pr: pr.url });
      }
      const comments = await d.host.comments(pr);
      for (const c of comments) {
        const r = record.comments[c.id];
        if (r?.status !== 'answered') continue;
        await d.host.reply(pr, c, r.reply);
        r.status = 'replied';
        await save();
      }
      const fresh = comments.filter((c) => !record.comments[c.id]);
      if (fresh.length) await answerComments(d, item, fresh, record, save);
    } catch (err) {
      await d.activity.log('review.failed', { task: item.task.id, error: (err as Error).message });
    }
  }
}

async function answerComments(d: RunnerDeps, item: QueueItem, comments: ReviewComment[], record: ReviewRecord, save: () => Promise<void>): Promise<void> {
  const pr = item.pr!;
  const task = item.task;
  const { exec, config } = d;
  await d.activity.log('review.comments', { task: task.id, pr: pr.url, count: comments.length });

  await createWorktree(exec, { repoDir: config.repoDir, stateDir: config.stateDir, taskId: task.id, baseRef: pr.branch });
  await d.host.sync(pr);

  const prompt = reviewPrompt({
    task,
    prUrl: pr.url,
    comments,
    rules: await readRepoRules(pr.worktree),
    lessons: await d.lessons.read(pr.worktree),
    test: config.test,
  });
  await d.activity.log('agent.started', { task: task.id, step: 'review', agent: d.agent.name });
  const result = await d.agent.run({ prompt, cwd: pr.worktree, timeoutMs: config.agent.minutes * 60_000, schema: REVIEW_SCHEMA });
  await d.activity.log('agent.finished', agentEvent(task.id, 'review', result));
  if (d.signal?.aborted) return;

  const answer = result.ok ? asReviewAnswer(result.data) : { replies: [], lessons: [] };
  let changed = false;
  if (result.ok) changed = await commitCode(exec, pr.worktree, `Address review comments\n\nGridbuild task ${task.id}`);
  await discardChanges(exec, pr.worktree);

  const outDir = join(config.stateDir, 'runs', task.id, 'proof');
  const tests = await runTests(d, { worktree: pr.worktree, outDir, name: `tests-review-${Date.now()}.txt` });
  if (tests) await d.activity.log('tests.finished', { task: task.id, step: 'review', passed: tests.passed, code: tests.code });

  const from = `review of ${pr.url.startsWith('https://') ? pr.url : task.id}`;
  for (const rule of answer.lessons) await d.lessons.add(pr.worktree, rule, from);
  const lessonSaved = answer.lessons.length > 0 && (await commitLessons(exec, pr.worktree, `Add lesson from review\n\nGridbuild task ${task.id}`));
  if (lessonSaved) await d.activity.log('lesson.saved', { task: task.id, rules: answer.lessons });

  // The code changed, so film the app again and link the new videos in the reply.
  let videos = '';
  if (changed) {
    record.rounds = (record.rounds ?? 0) + 1;
    const filmed = await recordPhase(d, { task, worktree: pr.worktree, outDir, phase: 'after', label: `review-${record.rounds}` });
    const links = filmed.videos.length ? await d.host.publishProof(task.id, filmed.videos.map((v) => v.file)) : {};
    const shown = filmed.videos.map((v) => `[${basename(v.file)}](${links[basename(v.file)] ?? basename(v.file)})${v.attempt ? ' (attempt only)' : ''}`);
    videos = [shown.length ? `New video after this change: ${shown.join(', ')}.` : '', ...filmed.notChecked].filter(Boolean).join(' ');
  }
  if (d.signal?.aborted) return;

  const notes = [changed ? 'Pushed a new commit.' : '', lessonSaved ? 'Saved a lesson in `.gridbuild/lessons.md` (separate commit).' : '', videos, `Tests: ${testLine(tests)}`];
  for (const comment of comments) {
    const reply = answer.replies.find((r) => r.id === comment.id)?.reply
      ?? (result.ok ? (changed ? 'Addressed in the new commit.' : 'Read this; no change needed.') : `I could not work on this automatically (${result.error ?? 'the AI engineer failed'}). A person needs to look.`);
    record.comments[comment.id] = { status: 'answered', reply: redact(`${reply}\n\n${notes.filter(Boolean).join(' ')}`) };
  }
  // Saved before pushing and replying: if either fails, the next pass retries just that step.
  await save();

  if (changed || lessonSaved || (await aheadOfRemote(exec, pr.worktree, pr.branch))) {
    await d.host.push(pr);
    await d.activity.log('pr.pushed', { task: task.id, pr: pr.url });
  }
  for (const comment of comments) {
    const r = record.comments[comment.id];
    await d.host.reply(pr, comment, r.reply);
    r.status = 'replied';
    await save();
  }
  await d.activity.log('review.replied', { task: task.id, pr: pr.url, count: comments.length, changed, lessons: answer.lessons.length });
}
