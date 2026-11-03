// The pull request title and body. Sections: What was wrong, What changed,
// How it was tested, Videos, Not checked.
import { basename } from 'node:path';
import type { FixSummary } from '../agent/prompt.ts';
import { testLine, type TestResult, type Video } from '../proof/proof.ts';
import type { Task } from '../types.ts';

export function prTitle(task: Task): string {
  const title = task.title.trim().replace(/\s+/g, ' ');
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

function sourceLine(task: Task): string {
  if (task.source === 'github') return `Fixes #${task.ref}`;
  if (task.source === 'jira') return `Jira: [${task.ref}](${task.url ?? task.ref})`;
  if (task.source === 'crashlytics') return `Crashlytics issue \`${task.ref}\``;
  return '';
}

const PLATFORMS = [
  ['ios', 'iOS Simulator'],
  ['android', 'Android Emulator'],
] as const;

export function prBody(o: {
  task: Task;
  summary?: FixSummary;
  tests?: TestResult;
  videos: Video[];
  links: Record<string, string>;
  notChecked: string[];
}): string {
  const s = o.summary;
  const cell = (platform: string, phase: string) => {
    const v = o.videos.find((x) => x.platform === platform && x.phase === phase);
    if (!v) return 'not recorded';
    const name = basename(v.file);
    return `[${name}](${o.links[name] ?? name})${v.attempt ? ' (attempt only, see Not checked)' : ''}`;
  };

  const tested = [s?.tested?.trim() || 'The AI engineer did not describe its own checks.', '', `Tests: ${testLine(o.tests)}`];
  if (o.tests?.tail) {
    tested.push('', `<details><summary>Test output (last lines)</summary>`, '', '```', o.tests.tail, '```', '', '</details>');
  }

  const notChecked = [...(s?.notChecked ?? []), ...o.notChecked].map((n) => n.trim()).filter(Boolean);
  if (o.tests && !o.tests.passed) notChecked.unshift('Tests fail on this branch; see How it was tested.');

  return [
    sourceLine(o.task),
    '## What was wrong',
    s?.wrong?.trim() || o.task.title,
    '## What changed',
    s?.changed?.trim() || 'See the diff. The AI engineer gave no summary.',
    '## How it was tested',
    tested.join('\n'),
    '## Videos',
    ['| | Before | After |', '|---|---|---|', ...PLATFORMS.map(([p, name]) => `| ${name} | ${cell(p, 'before')} | ${cell(p, 'after')} |`)].join('\n'),
    '## Not checked',
    notChecked.length ? notChecked.map((n) => `- ${n}`).join('\n') : '- Nothing the AI engineer knows of.',
    '---',
    `Opened by Gridbuild for task \`${o.task.id}\`. Leave review comments here: it answers them, re-tests and pushes, and saves corrections to \`.gridbuild/lessons.md\`.`,
  ].filter(Boolean).join('\n\n');
}
