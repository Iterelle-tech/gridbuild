import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LESSONS_PATH } from '../src/lessons.ts';
import { dryRunDemo } from './dry-run.ts';
import { gitIn } from './fakes.ts';

test('dry run: worktree branch, PR body, proof folder, review reply and a separate lesson commit', async () => {
  const r = await dryRunDemo();
  const wt = r.pr.worktree;

  // The fix is on its own branch in its own worktree; the main checkout is untouched.
  assert.equal(r.pr.branch, 'gridbuild/file-fix-greeting');
  assert.equal(await gitIn(wt, 'branch', '--show-current'), r.pr.branch);
  assert.match(readFileSync(join(r.repo, 'src/greeting.js'), 'utf8'), /Helo/);
  assert.equal(await gitIn(r.repo, 'status', '--porcelain'), '');

  // Commits: the fix, the review change, then the lesson alone.
  const commits = (await gitIn(wt, 'log', '--format=%s', 'main..HEAD')).split('\n');
  assert.deepEqual(commits, ['Add lesson from review', 'Address review comments', 'The home screen says "Helo"']);
  assert.equal(await gitIn(wt, 'show', '--name-only', '--format=', 'HEAD'), LESSONS_PATH);
  assert.match(readFileSync(join(wt, LESSONS_PATH), 'utf8'), /- Keep words people see in named constants.*\(from review of file-fix-greeting, /);

  // No videos in the fix diff.
  const changed = await gitIn(wt, 'diff', '--name-only', 'main...HEAD');
  assert.deepEqual(changed.split('\n').sort(), [LESSONS_PATH, 'src/greeting.js']);

  // The PR body and proof folder.
  const body = readFileSync(join(r.runDir, 'pr.md'), 'utf8');
  assert.match(body, /^# The home screen says "Helo"\n/);
  for (const h of ['What was wrong', 'What changed', 'How it was tested', 'Videos', 'Not checked']) assert.match(body, new RegExp(`^## ${h}$`, 'm'));
  assert.match(body, /`node check\.js` passed/);
  assert.match(body, /\[ios-before\.mp4\]\(proof\/ios-before\.mp4\)/);
  const proof = readdirSync(join(r.runDir, 'proof'));
  for (const f of ['ios-before.mp4', 'ios-after.mp4', 'android-before.mp4', 'android-after.mp4', 'tests.txt']) assert.ok(proof.includes(f), f);
  assert.match(readFileSync(join(r.runDir, 'branch.txt'), 'utf8'), /^branch: gridbuild\/file-fix-greeting\nbase: main\n/);
  assert.match(readFileSync(join(r.runDir, 'diff.patch'), 'utf8'), /-export const greeting = \(name\) => `Helo/);
  const replies = readFileSync(join(r.runDir, 'replies.md'), 'utf8');
  assert.match(replies, /Moved "Hello" into a named constant\.\n\nPushed a new commit\. Saved a lesson/);
  // After the review change, the app is filmed again and the reply links the new videos.
  assert.match(replies, /New video after this change: \[ios-after-review-1\.mp4\]\(proof\/ios-after-review-1\.mp4\), \[android-after-review-1\.mp4\]/);
  for (const f of ['ios-after-review-1.mp4', 'android-after-review-1.mp4']) assert.ok(proof.includes(f) || readdirSync(join(r.runDir, 'proof')).includes(f), f);

  // The AI engineer drove each device once per phase, got the repo rules, and the deep link opened.
  const steps = (await r.deps.activity.read()).filter((e) => e.type === 'agent.finished').map((e) => e.step);
  assert.deepEqual(steps, ['drive-ios-before', 'drive-android-before', 'fix', 'drive-ios-after', 'drive-android-after', 'review', 'drive-ios-after-review-1', 'drive-android-after-review-1']);
  assert.match(r.agent.jobs.find((j) => j.prompt.includes('Fix the task'))?.prompt ?? '', /Keep changes small/);

  // The queue remembers the task as done, and a second review pass does nothing new.
  const [item] = await r.deps.queue.list();
  assert.equal(item.state, 'done');
  const jobs = r.agent.jobs.length;
  const { reviewOpenPrs } = await import('../src/pr/review.ts');
  await reviewOpenPrs(r.deps);
  assert.equal(r.agent.jobs.length, jobs, 'each comment is answered once');
});
