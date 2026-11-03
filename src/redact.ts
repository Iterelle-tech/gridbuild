// Removes secrets from anything Gridbuild publishes (PR bodies, review replies, status notes)
// or keeps in its activity log: the values of secret-looking environment variables, and
// well-known token formats.
import { chmod, writeFile } from 'node:fs/promises';

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|KEY/i;
const MIN_SECRET_LENGTH = 8;
const HIDDEN = '[redacted]';

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, HIDDEN],
  [/\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, HIDDEN],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, HIDDEN],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${HIDDEN}`],
  // user:password@ in URLs
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"]+:[^\s/@"]+@/gi, `$1${HIDDEN}@`],
];

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value && value.length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(HIDDEN);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Writes a local log only the user can read (mode 600). Logs keep full output, unredacted. */
export async function writePrivate(file: string, text: string): Promise<void> {
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
}
