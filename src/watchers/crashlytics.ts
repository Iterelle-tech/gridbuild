// Crashlytics watcher. Firebase's supported way to read Crashlytics data programmatically is
// the BigQuery export (https://firebase.google.com/docs/crashlytics/bigquery-export), so this
// queries the exported tables with the BigQuery REST API. One task per new crash issue; the
// task id comes from the Crashlytics issue id, so the queue never opens the same crash twice.
import { firstLine, run, type Exec } from '../exec.ts';
import type { Task, Watcher } from '../types.ts';

const NAME = /^[A-Za-z0-9_]+$/;
const PROJECT = /^[a-z0-9.:-]+$/;

export function crashSql(o: { projectId: string; dataset: string; table: string; mode: 'new' | 'one' }): string {
  const from = `\`${o.projectId}.${o.dataset}.${o.table}\``;
  // Android tables hold `exceptions`, Apple tables hold `error`; both have `threads`.
  const detail = /_ANDROID(_REALTIME)?$/.test(o.table) ? 'exceptions' : 'error';
  const window = o.mode === 'new' ? 'INTERVAL @lookback_hours HOUR' : 'INTERVAL 30 DAY';
  return `WITH issues AS (
  SELECT
    issue_id,
    COUNT(*) AS events,
    COUNT(DISTINCT installation_uuid) AS users,
    MIN(event_timestamp) AS first_seen,
    MAX(event_timestamp) AS last_seen,
    ARRAY_AGG(DISTINCT application.display_version IGNORE NULLS LIMIT 10) AS app_versions,
    ARRAY_AGG(DISTINCT CONCAT(operating_system.name, ' ', operating_system.display_version) IGNORE NULLS LIMIT 10) AS os_versions,
    ARRAY_AGG(DISTINCT CONCAT(device.manufacturer, ' ', device.model) IGNORE NULLS LIMIT 10) AS devices
  FROM ${from}
  WHERE ${o.mode === 'new' ? "error_type = 'FATAL'\n    AND REGEXP_REPLACE(issue_id, r'[^A-Za-z0-9._-]', '-') NOT IN UNNEST(@known_ids)" : 'issue_id = @issue_id'}
    AND event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  GROUP BY issue_id${o.mode === 'new' ? '\n  HAVING MIN(event_timestamp) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookback_hours HOUR)' : ''}
),
samples AS (
  SELECT issue_id, ARRAY_AGG(STRUCT(error_type, blame_frame, ${detail}, threads) ORDER BY event_timestamp DESC LIMIT 1)[OFFSET(0)] AS sample
  FROM ${from}
  WHERE issue_id IN (SELECT issue_id FROM issues)
    AND event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), ${window})
  GROUP BY issue_id
)
SELECT TO_JSON_STRING(t) AS row FROM (
  SELECT issues.*, samples.sample FROM issues JOIN samples USING (issue_id)
  ORDER BY users DESC
  LIMIT 20
) AS t`;
}

interface Frame { symbol?: string; file?: string; line?: number; library?: string }
interface Crash {
  issue_id: string;
  events?: number;
  users?: number;
  first_seen?: string;
  last_seen?: string;
  app_versions?: string[];
  os_versions?: string[];
  devices?: string[];
  sample?: {
    error_type?: string;
    blame_frame?: Frame;
    exceptions?: { type?: string; exception_message?: string; nested?: boolean; title?: string; frames?: Frame[] }[];
    error?: { title?: string; subtitle?: string; frames?: Frame[] }[];
    threads?: { crashed?: boolean; title?: string; subtitle?: string; signal_name?: string; signal_code?: string; thread_name?: string; frames?: Frame[] }[];
  };
}

const at = (f: Frame) => `  at ${f.symbol || f.library || '?'}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`;
const frames = (list: Frame[] | undefined, max: number) => {
  const shown = (list ?? []).slice(0, max).map(at);
  if ((list?.length ?? 0) > max) shown.push(`  ... ${list!.length - max} more frames`);
  return shown;
};

const ID_PREFIX = 'crashlytics-';
const taskId = (issueId: string) => `${ID_PREFIX}${issueId.replace(/[^A-Za-z0-9._-]/g, '-')}`;

export function crashToTask(c: Crash, table: string): Task {
  const s = c.sample ?? {};
  const top = s.exceptions?.find((e) => !e.nested) ?? s.exceptions?.[0];
  const crashed = s.threads?.find((t) => t.crashed);
  const headline =
    (top && [top.type, top.exception_message].filter(Boolean).join(': ')) ||
    s.error?.[0]?.title ||
    (crashed && ([crashed.title, crashed.subtitle].filter(Boolean).join(' ') || [crashed.signal_name, crashed.signal_code].filter(Boolean).join(' '))) ||
    s.blame_frame?.symbol ||
    `issue ${c.issue_id}`;

  const stack: string[] = [];
  for (const e of s.exceptions ?? []) {
    stack.push(`${e.nested ? 'Caused by: ' : ''}${[e.type, e.exception_message].filter(Boolean).join(': ') || e.title || 'Exception'}`, ...frames(e.frames, 30));
  }
  if (!s.exceptions?.length && crashed) {
    stack.push(`Crashed: ${crashed.thread_name || crashed.title || 'thread'}${crashed.signal_name ? ` (${crashed.signal_name} ${crashed.signal_code ?? ''})`.trimEnd() : ''}`, ...frames(crashed.frames, 40));
  }
  for (const e of s.error ?? []) stack.push(e.title || 'Error', ...frames(e.frames, 30));

  const b = s.blame_frame;
  const facts = [
    `- Users affected: ${c.users ?? '?'} (${c.events ?? '?'} crashes) in the last 30 days`,
    `- First seen: ${c.first_seen ?? '?'}; last seen: ${c.last_seen ?? '?'}`,
    c.app_versions?.length && `- App versions: ${c.app_versions.join(', ')}`,
    c.os_versions?.length && `- OS versions: ${c.os_versions.join(', ')}`,
    c.devices?.length && `- Devices: ${c.devices.join(', ')}`,
    b?.symbol && `- Blamed frame: ${at(b).replace(/^ {2}at /, '')}`,
  ].filter(Boolean);

  const body = [
    `A new crash in ${table.replace(/_(IOS|ANDROID)(_REALTIME)?$/, '').replace(/_/g, '.')} on ${/_ANDROID/.test(table) ? 'Android' : 'iOS'} (Crashlytics issue ${c.issue_id}).`,
    facts.join('\n'),
    stack.length ? `Stack trace:\n\n\`\`\`\n${stack.join('\n')}\n\`\`\`` : 'No stack trace in the export.',
    'Find and fix the cause. If you cannot reproduce it, explain what you found and make the code safe against it.',
  ].join('\n\n');

  const title = `Crash: ${headline}`.replace(/\s+/g, ' ');
  return {
    id: taskId(c.issue_id),
    source: 'crashlytics',
    ref: c.issue_id,
    title: title.length > 120 ? `${title.slice(0, 117)}...` : title,
    body,
  };
}

/** Rows from a BigQuery jobs.query response whose single column is TO_JSON_STRING(...). */
export function parseQueryRows(data: { jobComplete?: boolean; rows?: { f: { v: string }[] }[] }): Crash[] {
  if (data.jobComplete === false) throw new Error('BigQuery did not finish the query in time; trying again on the next poll');
  return (data.rows ?? []).map((r) => JSON.parse(r.f[0].v));
}

export function crashlyticsWatcher(opts: {
  projectId: string;
  dataset: string;
  tables: string[];
  lookbackHours: number;
  /** Minimum time between BigQuery queries. */
  pollMinutes?: number;
  accessToken?: string;
  fetch?: typeof fetch;
  exec?: Exec;
}): Watcher {
  const doFetch = opts.fetch ?? fetch;
  const exec = opts.exec ?? run;
  if (!PROJECT.test(opts.projectId)) throw new Error(`"${opts.projectId}" is not a Google Cloud project id`);
  for (const name of [opts.dataset, ...opts.tables]) {
    if (!NAME.test(name)) throw new Error(`"${name}" is not a BigQuery dataset or table name`);
  }

  async function token(): Promise<string> {
    if (opts.accessToken) return opts.accessToken;
    // gcloud refreshes the token, so ask each time instead of keeping one.
    const r = await exec('gcloud', ['auth', 'print-access-token'], { timeoutMs: 30_000 });
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new Error(`No Google access token: run \`gcloud auth login\` or set GOOGLE_OAUTH_ACCESS_TOKEN (${firstLine(r.stderr) || `exit code ${r.code}`})`);
    }
    return r.stdout.trim();
  }

  async function query(table: string, mode: 'new' | 'one', o: { issueId?: string; known?: ReadonlySet<string> } = {}): Promise<Task[]> {
    // Crashes already in the queue are left out inside the query, before its LIMIT.
    const knownIds = [...(o.known ?? [])].filter((id) => id.startsWith(ID_PREFIX)).map((id) => ({ value: id.slice(ID_PREFIX.length) }));
    const queryParameters = mode === 'new'
      ? [
          { name: 'lookback_hours', parameterType: { type: 'INT64' }, parameterValue: { value: String(opts.lookbackHours) } },
          { name: 'known_ids', parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: knownIds } },
        ]
      : [{ name: 'issue_id', parameterType: { type: 'STRING' }, parameterValue: { value: o.issueId } }];
    const res = await doFetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${opts.projectId}/queries`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: crashSql({ projectId: opts.projectId, dataset: opts.dataset, table, mode }),
        useLegacySql: false,
        parameterMode: 'NAMED',
        queryParameters,
        timeoutMs: 60_000,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`BigQuery returned ${res.status} for ${table}${text ? `: ${text}` : ''}`);
    }
    return parseQueryRows(await res.json()).map((c) => crashToTask(c, table));
  }

  let lastPoll = 0;
  return {
    name: 'crashlytics',
    async poll(known) {
      if (Date.now() - lastPoll < (opts.pollMinutes ?? 0) * 60_000) return [];
      const tasks: Task[] = [];
      for (const table of opts.tables) tasks.push(...(await query(table, 'new', { known })));
      lastPoll = Date.now();
      return tasks;
    },
    async get(issueId) {
      for (const table of opts.tables) {
        const [task] = await query(table, 'one', { issueId });
        if (task) return task;
      }
      return undefined;
    },
  };
}
