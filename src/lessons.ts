// The lessons file: corrections from code review, saved in the target repo as rules
// every AI engineer follows on later tasks. It is committed on the PR branch, so a person
// reviews each lesson before it reaches the base branch.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Lessons } from './types.ts';

export const LESSONS_PATH = '.gridbuild/lessons.md';

const HEADER = `# Lessons

Rules from code review. Gridbuild adds one when a reviewer corrects its work, and every AI engineer follows them on later tasks. Edit or delete them like any other file.
`;

export function fileLessons(): Lessons {
  return {
    async read(repoDir) {
      return readFile(join(repoDir, LESSONS_PATH), 'utf8').catch(() => '');
    },
    async add(repoDir, rule, from) {
      const file = join(repoDir, LESSONS_PATH);
      const current = await readFile(file, 'utf8').catch(() => HEADER);
      const line = `- ${rule.trim().replace(/\s*\n\s*/g, ' ')} (from ${from}, ${new Date().toISOString().slice(0, 10)})`;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, current.replace(/\n*$/, '\n') + (current.includes('\n- ') ? '' : '\n') + line + '\n');
    },
  };
}
