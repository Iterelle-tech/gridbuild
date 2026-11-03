// GitHub watcher: open issues with the `bot` label, read with `gh issue list`. It only takes an
// issue when the label was added by someone with write access (or listed in review.allowedUsers).
import { firstLine, run, type Exec } from '../exec.ts';
import type { Task, Watcher } from '../types.ts';

const FIELDS = 'number,title,body,url,labels,createdAt';
/** Enough for any real backlog; `gh` pages through them. Known tasks are dropped before anything else. */
const LIST_LIMIT = '1000';
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  url?: string;
  labels?: { name: string }[];
  createdAt?: string;
}

export function issueToTask(issue: GhIssue): Task {
  const labels = (issue.labels ?? []).map((l) => l.name).filter((n) => n !== 'bot');
  const body = [issue.body?.trim() ?? '', labels.length ? `Labels: ${labels.join(', ')}` : ''].filter(Boolean).join('\n\n');
  return { id: `github-${issue.number}`, source: 'github', ref: String(issue.number), title: issue.title, body, url: issue.url };
}

/** Parses `gh issue list --json ...` output, oldest first. */
export function parseIssues(json: string): Task[] {
  const issues = JSON.parse(json) as GhIssue[];
  return issues
    .toSorted((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.number - b.number)
    .map(issueToTask);
}

/** "owner/name" from a GitHub remote URL (SSH or HTTPS). */
/** "owner/repo" from a GitHub remote, including SSH host aliases such as `git@github.com-work:owner/repo.git`. */
export function parseRemote(url: string): string | undefined {
  return /github\.com(?:-[\w.-]+)?[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/**
 * The GitHub repo to work on: the configured one, else the repo behind `origin`.
 * Always passed to gh explicitly, so a fork's PRs and issues never go to its upstream.
 */
export async function resolveRepo(exec: Exec, repoDir: string, configured?: string): Promise<string | undefined> {
  if (configured) return configured;
  const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, timeoutMs: 15_000 });
  return r.code === 0 ? parseRemote(r.stdout) : undefined;
}

/**
 * Whether someone may steer the AI engineer: write, maintain or admin permission on the repo,
 * or listed in `allowedUsers`. Answers are cached for the run; a failed check is asked again next time.
 */
export function steeringCheck(exec: Exec, repo: () => Promise<string>, allowedUsers: string[] = []): (login: string) => Promise<boolean> {
  const allowed = new Set(allowedUsers.map((u) => u.toLowerCase()));
  const cache = new Map<string, boolean>();
  return async (login) => {
    if (!login) return false;
    if (allowed.has(login.toLowerCase())) return true;
    const known = cache.get(login);
    if (known !== undefined) return known;
    const r = await exec('gh', ['api', `repos/${await repo()}/collaborators/${encodeURIComponent(login)}/permission`, '--jq', '[.permission // "", .role_name // ""] | join(" ")'], { timeoutMs: 30_000 });
    // 404 means not a collaborator; other failures are not cached, so the next poll asks again.
    if (r.code !== 0 && !/HTTP 404/.test(r.stderr)) return false;
    const ok = r.code === 0 && r.stdout.trim().split(/\s+/).some((role) => WRITE_ROLES.has(role));
    cache.set(login, ok);
    return ok;
  };
}

/** A problem when watchers.github.repo is not the repo behind `origin`: pushes go to origin, so the PRs must too. */
export async function repoMismatch(exec: Exec, repoDir: string, configured: string | undefined): Promise<string | undefined> {
  if (!configured) return undefined;
  const r = await exec('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, timeoutMs: 15_000 });
  const origin = r.code === 0 ? parseRemote(r.stdout) : undefined;
  if (origin?.toLowerCase() === configured.toLowerCase()) return undefined;
  const where = r.code === 0 ? (origin ? `github.com/${origin}` : r.stdout.trim()) : 'missing';
  return `"watchers.github.repo" is ${configured}, but origin is ${where}. Gridbuild pushes to origin, so the pull request must go there too (forks are not supported yet). Remove "repo" or point origin at ${configured}.`;
}

export function githubWatcher(opts: { repoDir: string; label: string; repo?: string; allowedUsers?: string[]; exec?: Exec }): Watcher {
  const exec = opts.exec ?? run;
  let repo: string | undefined;

  async function repoName(): Promise<string> {
    repo ??= await resolveRepo(exec, opts.repoDir, opts.repo);
    if (!repo) throw new Error('Cannot tell which GitHub repo to watch: `origin` is not a GitHub remote. Set "watchers.github.repo" in gridbuild.json.');
    return repo;
  }

  async function gh(args: string[]): Promise<string> {
    const r = await exec('gh', args, { cwd: opts.repoDir, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed${r.timedOut ? ' (timed out)' : ''}: ${firstLine(r.stderr || r.stdout)}`);
    return r.stdout;
  }

  const canSteer = steeringCheck(exec, repoName, opts.allowedUsers);

  /** Who last added the label, from the issue's events. */
  async function labelledBy(issue: string): Promise<string | undefined> {
    const lines = await gh(['api', `repos/${await repoName()}/issues/${issue}/events`, '--paginate', '--jq', '.[] | select(.event == "labeled") | {label: .label.name, login: .actor.login}']);
    const events = lines.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { label?: string; login?: string });
    return events.findLast((e) => e.label === opts.label)?.login;
  }

  return {
    name: 'github',
    async poll(known = new Set<string>()) {
      const listed = parseIssues(await gh(['issue', 'list', '--label', opts.label, '--state', 'open', '--json', FIELDS, '--limit', LIST_LIMIT, '--repo', await repoName()]));
      const tasks: Task[] = [];
      for (const task of listed.filter((t) => !known.has(t.id))) {
        const login = await labelledBy(task.ref);
        if (login && (await canSteer(login))) tasks.push(task);
      }
      return tasks;
    },
    // `gridbuild once <number>`: the person at this Mac chose the issue, so no label check.
    async get(ref) {
      return issueToTask(JSON.parse(await gh(['issue', 'view', ref, '--json', FIELDS, '--repo', await repoName()])));
    },
  };
}
