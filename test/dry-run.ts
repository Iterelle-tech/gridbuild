// End-to-end dry run, with nothing outside this Mac: a local fixture git repo, a fake AI
// engineer that edits a file, and fake devices that write placeholder videos. It runs the
// real runner (worktree, commit, tests, proof, PR body, review loop, lessons) in --dry-run mode.
//
//   node test/dry-run.ts
//
// prints where the branch, PR body and proof folder are. test/e2e.test.ts checks the same run.
import { readdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileActivity } from '../src/activity.ts';
import { FIX_SCHEMA, REVIEW_SCHEMA } from '../src/agent/prompt.ts';
import { loadConfig } from '../src/config.ts';
import { run } from '../src/exec.ts';
import { fileLessons } from '../src/lessons.ts';
import { dryRunHost } from '../src/pr/dryrun.ts';
import { reviewOpenPrs } from '../src/pr/review.ts';
import { fileQueue } from '../src/queue.ts';
import { runOnce, type RunnerDeps } from '../src/runner.ts';
import { fakeAgent, fakeDevice, fixtureRepo, gitIn, tempDir } from './fakes.ts';

export async function dryRunDemo(opts: { echo?: (line: string) => void } = {}) {
  const state = tempDir('gridbuild-state-');
  const repo = await fixtureRepo({
    'package.json': '{ "type": "module" }\n',
    'src/greeting.js': 'export const greeting = (name) => `Helo, ${name}!`;\n',
    'check.js': [
      "import { greeting } from './src/greeting.js';",
      "const got = greeting('Sam');",
      "if (got !== 'Hello, Sam!') { console.error(`expected \"Hello, Sam!\", got \"${got}\"`); process.exit(1); }",
      "console.log('1 check passed');",
      '',
    ].join('\n'),
    'CONTRIBUTING.md': 'Keep changes small. Run `node check.js` before you push.\n',
    'gridbuild.json': JSON.stringify({
      baseBranch: 'main',
      test: 'node check.js',
      stateDir: state,
      proof: {
        seconds: 5,
        deepLink: 'demo://home',
        ios: { run: 'echo "built and launched on $GRIDBUILD_DEVICE_ID"' },
        android: { run: 'echo "built and launched on $GRIDBUILD_DEVICE_ID"' },
      },
    }, null, 2) + '\n',
  });
  const taskFile = join(state, 'fix-greeting.md');
  writeFileSync(taskFile, '# The home screen says "Helo"\n\nThe greeting on the home screen reads "Helo, Sam!". It should read "Hello, Sam!".\n');

  // The fake AI engineer: fixes the typo, answers the review, and drives nothing.
  const agent = fakeAgent(async (job) => {
    const file = join(job.cwd, 'src/greeting.js');
    if (job.schema === FIX_SCHEMA) {
      await writeFile(file, (await readFile(file, 'utf8')).replace('Helo', 'Hello'));
      return {
        text: 'Fixed the typo in the greeting.',
        data: {
          wrong: 'The greeting had a typo: "Helo" instead of "Hello".',
          changed: 'Fixed the spelling in src/greeting.js.',
          tested: 'Ran `node check.js`.',
          notChecked: ['Other languages: the app has no translations yet.'],
        },
      };
    }
    if (job.schema === REVIEW_SCHEMA) {
      await writeFile(file, "const WORD = 'Hello';\nexport const greeting = (name) => `${WORD}, ${name}!`;\n");
      return {
        text: 'Moved the word into a constant.',
        data: {
          replies: [{ id: '1', reply: 'Moved "Hello" into a named constant.' }],
          lessons: ['Keep words people see in named constants, not inline in template strings.'],
        },
      };
    }
    return { text: 'Showed the home screen greeting.' };
  });

  const config = await loadConfig(repo);
  const deps: RunnerDeps = {
    config,
    exec: run,
    queue: fileQueue(config.stateDir),
    activity: fileActivity(config.stateDir, opts.echo),
    lessons: fileLessons(),
    agent,
    devices: [fakeDevice('ios'), fakeDevice('android')],
    host: dryRunHost({ stateDir: config.stateDir, baseBranch: config.baseBranch }),
    watchers: [],
    dryRun: true,
  };

  const pr = await runOnce(deps, taskFile);
  if (!pr) throw new Error(`The dry run failed: ${(await deps.queue.list())[0]?.error}`);
  const runDir = join(state, 'runs', 'file-fix-greeting');

  // A reviewer leaves a comment; the review loop answers it and saves a lesson.
  writeFileSync(join(runDir, 'comments.json'), JSON.stringify([{ id: '1', author: 'sam', body: 'Please put "Hello" in a named constant.', path: 'src/greeting.js', line: 1 }]));
  await reviewOpenPrs(deps);

  return { repo, state, runDir, pr, agent, deps };
}

if (import.meta.main && !process.env.NODE_TEST_CONTEXT) {
  const r = await dryRunDemo();
  const commits = await gitIn(r.pr.worktree, 'log', '--format=%h %s', 'main..HEAD');
  console.log(`Dry run finished. Nothing left this Mac.

  Fixture repo   ${r.repo}
  Branch         ${r.pr.branch} (worktree ${r.pr.worktree})
${commits.split('\n').map((c) => `                 ${c}`).join('\n')}
  PR body        ${join(r.runDir, 'pr.md')}
  Proof folder   ${join(r.runDir, 'proof')}: ${readdirSync(join(r.runDir, 'proof')).join(', ')}
  Review reply   ${join(r.runDir, 'replies.md')}
  Activity log   ${join(r.state, 'activity.jsonl')}
`);
}
