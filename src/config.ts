// Reads gridbuild.json from the target repo. Secrets never go in that file:
// they come from environment variables (see `envSecrets`).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { run, type Exec } from './exec.ts';

export const CONFIG_FILE = 'gridbuild.json';

export interface PlatformProof {
  /** Shell command that builds, installs and launches the app, then exits. */
  run: string;
  /** Simulator name or UDID (iOS), or AVD name (Android). */
  device?: string;
}

export interface Config {
  repoDir: string;
  /** Queue, activity log, worktrees and run folders. Defaults to ~/.gridbuild/<repo name>-<hash of the origin URL or path>. */
  stateDir: string;
  baseBranch: string;
  pollSeconds: number;
  test?: string;
  testMinutes: number;
  watchers: {
    github?: { label: string; repo?: string };
    jira?: { jql: string };
    crashlytics?: { projectId: string; dataset: string; tables: string[]; lookbackHours: number; pollMinutes: number };
  };
  agent: {
    command: string;
    args: string[];
    model?: string;
    minutes: number;
    /** Extra environment variable names the AI engineer, builds and tests may see. */
    env: string[];
  };
  review: {
    /** People who may steer the AI engineer with review comments, besides those with write access. */
    allowedUsers: string[];
  };
  proof: {
    seconds: number;
    buildMinutes: number;
    deepLink?: string;
    ios?: PlatformProof;
    android?: PlatformProof;
  };
}

export class ConfigError extends Error {}

const SECRET_KEY = /token|secret|password|api[_-]?key/i;

function findSecrets(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => {
    const here = [...path, key];
    if (SECRET_KEY.test(key) && typeof v === 'string' && v) return [here.join('.')];
    return findSecrets(v, here);
  });
}

function obj(value: unknown, name: string): Record<string, any> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(`"${name}" must be an object`);
  return value as Record<string, any>;
}

function strings(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ConfigError(`"${name}" must be a list of strings`);
  return value;
}

/** What the AI engineer's environment always holds. Everything else is left out unless listed in `agent.env`. */
const AGENT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'DEVELOPER_DIR', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME'];
/** Credentials Gridbuild itself uses. The AI engineer never gets these, even when listed. */
const NEVER_AGENT_ENV = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|JIRA_.*|GOOGLE_.*|AWS_.*)$/;

/** The environment for the AI engineer and the build and test commands it can change. */
export function agentEnv(extra: string[], env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = (name: string) => !NEVER_AGENT_ENV.test(name) && (AGENT_ENV.includes(name) || name.startsWith('LC_') || extra.includes(name));
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && keep(e[0])));
}

/** "github.com/owner/repo" from any form of remote URL (SSH, HTTPS, with or without .git). */
export function normalizeRemote(url: string, repoDir?: string): string {
  const u = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  let id: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const parsed = new URL(u);
    id = parsed.protocol === 'file:' ? parsed.pathname : `${parsed.hostname}${parsed.pathname}`;
  } else if (scp && !u.startsWith('/')) {
    id = `${scp[1]}/${scp[2]}`;
  } else {
    id = repoDir ? resolve(repoDir, u) : u;
  }
  return id.replace(/\.git\/?$/, '').replace(/\/+$/, '').toLowerCase();
}

/** What identifies the repo across moves and re-clones: its origin URL, else its real path. */
export async function repoIdentity(repoDir: string, exec: Exec = run): Promise<string> {
  const r = await exec('git', ['config', '--get', 'remote.origin.url'], { cwd: repoDir, timeoutMs: 15_000 });
  if (r.code === 0 && r.stdout.trim()) return normalizeRemote(r.stdout, repoDir);
  try { return realpathSync(repoDir); } catch { return resolve(repoDir); }
}

export function defaultStateDir(identity: string): string {
  const name = (basename(identity) || 'repo').replace(/[^A-Za-z0-9._-]+/g, '-');
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  return join(homedir(), '.gridbuild', `${name}-${hash}`);
}

function platform(value: unknown, name: string): PlatformProof | undefined {
  if (value === undefined || value === null) return undefined;
  const p = obj(value, name);
  if (typeof p.run !== 'string' || !p.run) throw new ConfigError(`"${name}.run" must be a shell command`);
  return { run: p.run, device: p.device };
}

/** `identity` comes from `repoIdentity`; without it the repo path stands in. */
export function parseConfig(raw: unknown, repoDir: string, identity = repoDir): Config {
  const c = obj(raw, CONFIG_FILE);
  const secrets = findSecrets(c);
  if (secrets.length) {
    throw new ConfigError(`${CONFIG_FILE} must not hold secrets (${secrets.join(', ')}). Set them as environment variables instead.`);
  }

  const w = c.watchers === undefined ? { github: {} } : obj(c.watchers, 'watchers');
  const watchers: Config['watchers'] = {};
  if (w.github) watchers.github = { label: obj(w.github, 'watchers.github').label ?? 'bot', repo: w.github.repo };
  if (w.jira) {
    watchers.jira = { jql: obj(w.jira, 'watchers.jira').jql ?? 'assignee = currentUser() AND statusCategory != Done ORDER BY created ASC' };
  }
  if (w.crashlytics) {
    const cr = obj(w.crashlytics, 'watchers.crashlytics');
    if (typeof cr.projectId !== 'string') throw new ConfigError('"watchers.crashlytics.projectId" is required');
    if (!Array.isArray(cr.tables) || !cr.tables.length) {
      throw new ConfigError('"watchers.crashlytics.tables" must list your Crashlytics BigQuery tables, like "com_example_app_IOS"');
    }
    watchers.crashlytics = {
      projectId: cr.projectId,
      dataset: cr.dataset ?? 'firebase_crashlytics',
      tables: cr.tables,
      lookbackHours: cr.lookbackHours ?? 24,
      // Each poll is a BigQuery query you pay for, and the daily export changes slowly.
      pollMinutes: cr.pollMinutes ?? 60,
    };
  }

  const a = obj(c.agent, 'agent');
  const p = obj(c.proof, 'proof');
  const stateDir = c.stateDir ? resolve(repoDir, c.stateDir) : defaultStateDir(identity);
  const env = strings(a.env, 'agent.env');
  const forbidden = env.filter((name) => NEVER_AGENT_ENV.test(name));
  if (forbidden.length) throw new ConfigError(`"agent.env" must not list ${forbidden.join(', ')}: the AI engineer never gets GitHub, Jira, Google or AWS credentials.`);

  return {
    repoDir,
    stateDir,
    baseBranch: c.baseBranch ?? 'main',
    pollSeconds: c.pollSeconds ?? 300,
    test: c.test || undefined,
    testMinutes: c.testMinutes ?? 20,
    watchers,
    agent: {
      command: a.command ?? 'claude',
      // Headless runs can't answer permission prompts. The AI engineer works in its own worktree.
      args: a.args ?? ['--permission-mode', 'bypassPermissions'],
      model: a.model,
      minutes: a.minutes ?? 45,
      env,
    },
    review: { allowedUsers: strings(obj(c.review, 'review').allowedUsers, 'review.allowedUsers') },
    proof: {
      seconds: p.seconds ?? 90,
      buildMinutes: p.buildMinutes ?? 20,
      deepLink: p.deepLink || undefined,
      ios: platform(p.ios, 'proof.ios'),
      android: platform(p.android, 'proof.android'),
    },
  };
}

export async function loadConfig(repoDir: string, exec: Exec = run): Promise<Config> {
  const dir = isAbsolute(repoDir) ? repoDir : resolve(repoDir);
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) throw new ConfigError(`No ${CONFIG_FILE} in ${dir}. Run \`gridbuild init\` there first.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw, dir, await repoIdentity(dir, exec));
}

export function envSecrets(env: NodeJS.ProcessEnv = process.env) {
  return {
    jiraBaseUrl: env.JIRA_BASE_URL?.replace(/\/+$/, ''),
    jiraEmail: env.JIRA_EMAIL,
    jiraToken: env.JIRA_API_TOKEN,
    googleToken: env.GOOGLE_OAUTH_ACCESS_TOKEN,
  };
}

/** The starter gridbuild.json written by `gridbuild init`. */
export function starterConfig(opts: { baseBranch: string; hasTestScript: boolean; expo: boolean }): object {
  const config: Record<string, unknown> = {
    baseBranch: opts.baseBranch,
    test: opts.hasTestScript ? 'npm test' : '',
    watchers: { github: { label: 'bot' } },
    proof: {
      seconds: 90,
      deepLink: '',
      ...(opts.expo
        ? {
            ios: { run: 'npx expo run:ios --configuration Release --no-bundler --device "$GRIDBUILD_DEVICE_ID"' },
            android: { run: 'npx expo run:android --variant release --no-bundler' },
          }
        : {}),
    },
  };
  return config;
}
