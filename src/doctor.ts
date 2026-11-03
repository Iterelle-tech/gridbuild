// `gridbuild doctor`: checks everything the runner needs, in parallel, each with a timeout,
// and says plainly what to fix. It never calls GitHub, Jira, Firebase or the AI provider.
import { loadConfig, envSecrets, type Config } from './config.ts';
import { firstLine, run, type Exec } from './exec.ts';
import { androidEmulator } from './devices/android.ts';
import { iosSimulator } from './devices/ios.ts';
import type { DeviceProvider } from './types.ts';
import { repoMismatch } from './watchers/github.ts';

export type CheckStatus = 'ok' | 'problem' | 'warn' | 'skip';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const CHECK_LIMIT_MS = 45_000;

export async function doctor(o: { repoDir: string; exec?: Exec; devices?: DeviceProvider[] }): Promise<CheckResult[]> {
  const exec = o.exec ?? run;
  let config: Config | undefined;
  let configError = '';
  try {
    config = await loadConfig(o.repoDir, exec);
  } catch (err) {
    configError = (err as Error).message;
  }
  const devices = o.devices ?? [
    iosSimulator({ device: config?.proof.ios?.device, exec }),
    androidEmulator({ avd: config?.proof.android?.device, exec }),
  ];
  const version = async (cmd: string, args = ['--version']) => {
    const r = await exec(cmd, args, { timeoutMs: 15_000 });
    return r.code === 0 ? firstLine(r.stdout || r.stderr) : undefined;
  };

  const checks: Promise<CheckResult>[] = [
    (async () => {
      const major = Number(process.versions.node.split('.')[0]);
      return { name: 'Node.js', status: major >= 24 ? 'ok' : 'problem', detail: major >= 24 ? process.versions.node : `${process.versions.node}; Gridbuild needs Node 24 or newer` };
    })(),

    (async () => {
      const v = await version('git');
      return { name: 'git', status: v ? 'ok' : 'problem', detail: v ?? 'not found. Install the Xcode command line tools: `xcode-select --install`.' };
    })(),

    (async () => {
      const v = await version('gh');
      if (!v) return { name: 'GitHub CLI', status: 'problem', detail: 'not found. Install it from https://cli.github.com, then run `gh auth login`.' };
      // `gh auth token` reads the local keychain only; the token is never printed.
      const auth = await exec('gh', ['auth', 'token'], { timeoutMs: 15_000 });
      return auth.code === 0
        ? { name: 'GitHub CLI', status: 'ok', detail: `${v}, signed in` }
        : { name: 'GitHub CLI', status: 'problem', detail: `${v}, but not signed in. Run \`gh auth login\`.` };
    })(),

    (async () => {
      const cmd = config?.agent.command ?? 'claude';
      const v = await version(cmd);
      return v
        ? { name: 'Claude Code', status: 'ok', detail: v }
        : { name: 'Claude Code', status: 'problem', detail: `\`${cmd}\` not found. Install Claude Code (https://code.claude.com/docs) and sign in with your own account.` };
    })(),

    (async () => {
      if (!config) return { name: 'gridbuild.json', status: 'problem', detail: configError };
      const watchers = Object.keys(config.watchers).join(', ') || 'none';
      const proof = (['ios', 'android'] as const).filter((p) => config!.proof[p]).join(', ') || 'none';
      return { name: 'gridbuild.json', status: 'ok', detail: `watchers: ${watchers}; videos: ${proof}; state in ${config.stateDir}` };
    })(),

    (async () => {
      const top = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: o.repoDir, timeoutMs: 15_000 });
      if (top.code !== 0) return { name: 'Repo', status: 'problem', detail: `${o.repoDir} is not a git repository` };
      const notes: string[] = [];
      if (config) {
        const base = config.baseBranch;
        const local = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { cwd: o.repoDir, timeoutMs: 15_000 });
        const remote = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], { cwd: o.repoDir, timeoutMs: 15_000 });
        if (local.code !== 0 && remote.code !== 0) notes.push(`base branch "${base}" not found; set "baseBranch" in gridbuild.json`);
      }
      const email = await exec('git', ['config', 'user.email'], { cwd: o.repoDir, timeoutMs: 15_000 });
      if (!email.stdout.trim()) notes.push('no git identity for commits; run `git config user.name` and `git config user.email`');
      return notes.length ? { name: 'Repo', status: 'problem', detail: notes.join('; ') } : { name: 'Repo', status: 'ok', detail: top.stdout.trim() };
    })(),

    (async () => {
      const repo = config?.watchers.github?.repo;
      if (!repo) return { name: 'GitHub repo', status: 'skip', detail: 'pull requests go to the repo behind origin' };
      const problem = await repoMismatch(exec, o.repoDir, repo);
      return problem ? { name: 'GitHub repo', status: 'problem', detail: problem } : { name: 'GitHub repo', status: 'ok', detail: `${repo}, the same as origin` };
    })(),

    (async () => {
      if (!config?.watchers.jira) return { name: 'Jira', status: 'skip', detail: 'not set up in gridbuild.json' };
      const s = envSecrets();
      const missing = [['JIRA_BASE_URL', s.jiraBaseUrl], ['JIRA_EMAIL', s.jiraEmail], ['JIRA_API_TOKEN', s.jiraToken]].filter(([, v]) => !v).map(([k]) => k);
      return missing.length
        ? { name: 'Jira', status: 'problem', detail: `set ${missing.join(', ')} in the environment` }
        : { name: 'Jira', status: 'ok', detail: 'credentials set in the environment (not tested against Jira)' };
    })(),

    (async () => {
      if (!config?.watchers.crashlytics) return { name: 'Crashlytics', status: 'skip', detail: 'not set up in gridbuild.json' };
      if (envSecrets().googleToken) return { name: 'Crashlytics', status: 'ok', detail: 'GOOGLE_OAUTH_ACCESS_TOKEN is set (not tested against BigQuery)' };
      const v = await version('gcloud');
      return v
        ? { name: 'Crashlytics', status: 'ok', detail: 'will read BigQuery with your gcloud login (not tested)' }
        : { name: 'Crashlytics', status: 'problem', detail: 'needs the gcloud CLI (signed in) or GOOGLE_OAUTH_ACCESS_TOKEN to read the BigQuery export' };
    })(),

    ...devices.map(async (device): Promise<CheckResult> => {
      const problems = await device.check();
      const wanted = !config || !!config.proof[device.platform];
      if (!problems.length) return { name: device.name, status: wanted ? 'ok' : 'skip', detail: wanted ? 'ready' : `ready, but no proof.${device.platform} in gridbuild.json` };
      return { name: device.name, status: wanted ? 'problem' : 'warn', detail: problems.join(' ') };
    }),
  ];

  return Promise.all(checks.map((check, i) => Promise.race([
    check.catch((err): CheckResult => ({ name: `check ${i + 1}`, status: 'problem', detail: (err as Error).message })),
    new Promise<CheckResult>((r) => setTimeout(() => r({ name: `check ${i + 1}`, status: 'problem', detail: 'did not finish in time' }), CHECK_LIMIT_MS).unref()),
  ])));
}

const MARK: Record<CheckStatus, string> = { ok: '✓', problem: '✗', warn: '!', skip: '-' };

export function formatDoctor(results: CheckResult[]): string {
  const lines = results.map((r) => `  ${MARK[r.status]} ${r.name}: ${r.detail}`);
  const problems = results.filter((r) => r.status === 'problem').length;
  lines.push('', problems ? `${problems} problem${problems > 1 ? 's' : ''} to fix.` : 'Ready.');
  return lines.join('\n');
}
