// Where pull requests go. `githubHost` uses `gh` and `git push`; `dryRunHost` (dryrun.ts)
// writes everything to a local folder instead.
import { rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ReviewComment } from '../agent/prompt.ts';
import { firstLine, run, type Exec, type RunOptions } from '../exec.ts';
import type { PullRequest, Task } from '../types.ts';
import { resolveRepo, steeringCheck } from '../watchers/github.ts';

export interface OpenRequest {
  task: Task;
  branch: string;
  worktree: string;
  title: string;
  body: string;
  draft: boolean;
  /** The task's local folder for logs, proof and PR files. */
  runDir: string;
}

export interface PrHost {
  /** Puts proof files where the PR body can link to them. Returns file name -> link. */
  publishProof(taskId: string, files: string[]): Promise<Record<string, string>>;
  /** Opens the PR for a pushed branch, or returns the one already open for it (in any state). */
  open(req: OpenRequest): Promise<PullRequest>;
  /** Brings the worktree up to date with the remote branch before more work. */
  sync(pr: PullRequest): Promise<void>;
  push(pr: Pick<PullRequest, 'branch' | 'worktree'>): Promise<void>;
  /** Review comments from people who may steer the AI engineer, never its own. */
  comments(pr: PullRequest): Promise<ReviewComment[]>;
  reply(pr: PullRequest, comment: ReviewComment, body: string): Promise<void>;
  state(pr: PullRequest): Promise<'open' | 'merged' | 'closed'>;
}

/** Videos live on this branch, never in the fix diff. */
export const PROOF_BRANCH = 'gridbuild-proof';

const isBot = (login: string | undefined, type?: string) => type === 'Bot' || !!login?.endsWith('[bot]');

export function githubHost(opts: { repoDir: string; baseBranch: string; stateDir: string; repo?: string; allowedUsers?: string[]; exec?: Exec }): PrHost {
  const exec = opts.exec ?? run;
  let me: string | undefined;
  let repoUrl: string | undefined;
  let repoName: string | undefined;

  async function repo(): Promise<string> {
    repoName ??= await resolveRepo(exec, opts.repoDir, opts.repo);
    if (!repoName) throw new Error('Cannot tell which GitHub repo to use: `origin` is not a GitHub remote. Set "watchers.github.repo" in gridbuild.json.');
    return repoName;
  }

  async function cmd(command: string, args: string[], o: RunOptions = {}): Promise<string> {
    const r = await exec(command, args, { cwd: opts.repoDir, timeoutMs: 60_000, ...o });
    if (r.code !== 0) {
      throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed${r.timedOut ? ' (timed out)' : ''}: ${firstLine(r.stderr || r.stdout)}`);
    }
    return r.stdout.trim();
  }
  const gh = (args: string[], o?: RunOptions) => cmd('gh', args, o);
  const git = (args: string[], o?: RunOptions) => cmd('git', args, o);
  const number = (pr: PullRequest) => String(pr.number ?? pr.url.split('/').pop());
  const canSteer = steeringCheck(exec, repo, opts.allowedUsers);

  return {
    async publishProof(taskId, files) {
      if (!files.length) return {};
      repoUrl ??= await gh(['repo', 'view', await repo(), '--json', 'url', '--jq', '.url']);
      // Commit the files onto the proof branch with a private index, without touching any checkout.
      const localRef = 'refs/gridbuild/proof';
      const fetched = await exec('git', ['fetch', 'origin', `+refs/heads/${PROOF_BRANCH}:${localRef}`], { cwd: opts.repoDir, timeoutMs: 120_000 });
      const parent = fetched.code === 0 ? await git(['rev-parse', localRef]) : undefined;
      const index = join(opts.stateDir, `proof-index-${taskId}`);
      const env = { GIT_INDEX_FILE: index };
      try {
        await git(parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
        for (const file of files) {
          const sha = await git(['hash-object', '-w', file]);
          await git(['update-index', '--add', '--cacheinfo', `100644,${sha},${taskId}/${basename(file)}`], { env });
        }
        const tree = await git(['write-tree'], { env });
        const commit = await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Proof for ${taskId}`]);
        await git(['push', 'origin', `${commit}:refs/heads/${PROOF_BRANCH}`], { timeoutMs: 300_000 });
      } finally {
        await rm(index, { force: true });
      }
      return Object.fromEntries(files.map((f) => [basename(f), `${repoUrl}/blob/${PROOF_BRANCH}/${taskId}/${basename(f)}`]));
    },

    async open(req) {
      const target = await repo();
      const toPr = (url: string, n?: number) => ({ url, number: n ?? Number(url.split('/').pop()), branch: req.branch, worktree: req.worktree });
      // After a restart the PR may already exist; never open a second one for the branch.
      const existing = JSON.parse(await gh(['pr', 'list', '--repo', target, '--head', req.branch, '--state', 'all', '--json', 'url,number', '--limit', '1']) || '[]');
      const bodyFile = join(req.runDir, 'pr-body.md');
      await writeFile(bodyFile, req.body);
      if (existing[0]?.url) {
        // Refresh the description, so proof filmed after a resume shows up on the PR.
        await gh(['pr', 'edit', String(existing[0].number), '--repo', target, '--body-file', bodyFile]);
        return toPr(existing[0].url, existing[0].number);
      }
      const out = await gh(['pr', 'create', '--repo', target, '--base', opts.baseBranch, '--head', req.branch, '--title', req.title, '--body-file', bodyFile, ...(req.draft ? ['--draft'] : [])]);
      const url = out.split('\n').reverse().find((l) => l.startsWith('https://'));
      if (!url) throw new Error(`gh pr create gave no URL: ${firstLine(out)}`);
      return toPr(url);
    },

    async sync(pr) {
      await git(['pull', '--ff-only', '-q', 'origin', pr.branch], { cwd: pr.worktree, timeoutMs: 120_000 });
    },

    async push(pr) {
      await git(['push', '-u', 'origin', pr.branch], { cwd: pr.worktree, timeoutMs: 300_000 });
    },

    async comments(pr) {
      me ??= await gh(['api', 'user', '--jq', '.login']);
      const view = JSON.parse(await gh(['pr', 'view', number(pr), '--repo', await repo(), '--json', 'comments,reviews']));
      const inline = (await gh(['api', `repos/${await repo()}/pulls/${number(pr)}/comments`, '--paginate', '--jq', '.[] | {id, body, path, line, login: .user.login, type: .user.type}']))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const found: ReviewComment[] = [];
      for (const c of inline) {
        if (c.login !== me && !isBot(c.login, c.type) && c.body?.trim()) {
          found.push({ id: `inline-${c.id}`, kind: 'inline', author: c.login, body: c.body, path: c.path, line: c.line ?? undefined });
        }
      }
      for (const c of view.comments ?? []) {
        if (!c.viewerDidAuthor && c.author?.login && c.author.login !== me && !isBot(c.author.login) && c.body?.trim()) {
          found.push({ id: `comment-${c.id}`, kind: 'conversation', author: c.author.login, body: c.body });
        }
      }
      for (const r of view.reviews ?? []) {
        if (r.author?.login && r.author.login !== me && !isBot(r.author.login) && r.body?.trim()) {
          found.push({ id: `review-${r.id}`, kind: 'review', author: r.author.login, body: r.body });
        }
      }
      // Only people with write access (or in review.allowedUsers) can steer the AI engineer.
      const out: ReviewComment[] = [];
      for (const c of found) if (await canSteer(c.author)) out.push(c);
      return out;
    },

    async reply(pr, comment, body) {
      if (comment.kind === 'inline') {
        const id = comment.id.replace(/^inline-/, '');
        await gh(['api', '-X', 'POST', `repos/${await repo()}/pulls/${number(pr)}/comments/${id}/replies`, '-f', `body=${body}`]);
      } else {
        const quote = `> ${firstLine(comment.body)}\n\n@${comment.author} `;
        await gh(['pr', 'comment', number(pr), '--repo', await repo(), '--body-file', '-'], { input: quote + body });
      }
    },

    async state(pr) {
      const state = await gh(['pr', 'view', number(pr), '--repo', await repo(), '--json', 'state', '--jq', '.state']);
      return state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open';
    },
  };
}
