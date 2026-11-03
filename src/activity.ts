// Append-only activity log, one JSON event per line, with secrets redacted. The team dashboard reads this later.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redact } from './redact.ts';
import type { Activity, ActivityEvent } from './types.ts';

function redactAll(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactAll);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAll(v)]));
  return value;
}

export function fileActivity(stateDir: string, echo?: (line: string) => void): Activity {
  const file = join(stateDir, 'activity.jsonl');
  return {
    async log(type, data = {}) {
      const event = redactAll({ ts: new Date().toISOString(), type, ...data }) as ActivityEvent;
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(event) + '\n', { mode: 0o600 });
      echo?.(formatEvent(event));
    },
    async read() {
      const text = await readFile(file, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as ActivityEvent]; } catch { return []; }
      });
    },
  };
}

export function formatEvent(e: ActivityEvent): string {
  const { ts, type, task, ...rest } = e;
  const extras = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return [ts.slice(11, 19), type, task, extras].filter(Boolean).join('  ');
}
