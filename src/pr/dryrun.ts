// --dry-run: instead of calling GitHub, write the branch name, PR body and proof to the
// task's local folder (<stateDir>/runs/<task id>/). To try the review loop, put a
// comments.json there: [{ "id": "1", "author": "you", "body": "..." }].
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReviewComment } from '../agent/prompt.ts';
import { run, type Exec } from '../exec.ts';
import type { PullRequest } from '../types.ts';
import { git } from '../worktree.ts';
import type { PrHost } from './host.ts';

export function dryRunHost(opts: { stateDir: string; baseBranch: string; exec?: Exec }): PrHost {
  const exec = opts.exec ?? run;
  const runDir = (taskId: string) => join(opts.stateDir, 'runs', taskId);
  const taskOf = (pr: PullRequest) => basename(pr.worktree);

  async function writeBranch(pr: Pick<PullRequest, 'branch' | 'worktree'>): Promise<void> {
    const dir = runDir(taskOf(pr));
    const head = await git(exec, pr.worktree, ['rev-parse', 'HEAD']);
    const log = await git(exec, pr.worktree, ['log', '--format=%h %s', `${opts.baseBranch}..HEAD`]);
    await writeFile(
      join(dir, 'branch.txt'),
      `branch: ${pr.branch}\nbase: ${opts.baseBranch}\nhead: ${head}\nworktree: ${pr.worktree}\n\ncommits:\n${log}\n`,
    );
    await writeFile(join(dir, 'diff.patch'), (await git(exec, pr.worktree, ['diff', `${opts.baseBranch}...HEAD`])) + '\n');
  }

  return {
    async publishProof(taskId, files) {
      // The videos are already in the run folder; link to them relative to pr.md.
      return Object.fromEntries(files.map((f) => [basename(f), relative(runDir(taskId), f)]));
    },

    async open(req) {
      await writeFile(join(req.runDir, 'pr.md'), `# ${req.title}${req.draft ? ' (draft)' : ''}\n\n${req.body}\n`);
      const pr: PullRequest = { url: pathToFileURL(join(req.runDir, 'pr.md')).href, branch: req.branch, worktree: req.worktree };
      await writeBranch(pr);
      return pr;
    },

    async sync() {},

    async push(pr) {
      await writeBranch(pr);
    },

    async comments(pr) {
      const text = await readFile(join(runDir(taskOf(pr)), 'comments.json'), 'utf8').catch(() => '');
      if (!text) return [];
      return (JSON.parse(text) as Partial<ReviewComment>[]).map((c, i) => ({
        id: String(c.id ?? i + 1),
        kind: c.path ? 'inline' : 'conversation',
        author: c.author ?? 'reviewer',
        body: c.body ?? '',
        path: c.path,
        line: c.line,
      }));
    },

    async reply(pr, comment, body) {
      await appendFile(join(runDir(taskOf(pr)), 'replies.md'), `## Reply to comment ${comment.id} from ${comment.author}\n\n> ${comment.body.trim().replace(/\n/g, '\n> ')}\n\n${body}\n\n`);
    },

    async state() {
      return 'open';
    },
  };
}
