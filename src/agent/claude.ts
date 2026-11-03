// The Claude Code adapter: runs `claude -p` headless in the task's worktree, prompt on stdin,
// and reads cost, duration and the structured answer from its JSON output. It gets only the
// allowlisted environment (`agentEnv`), never Gridbuild's GitHub, Jira or Google credentials.
import { agentEnv } from '../config.ts';
import { firstLine, run, type Exec } from '../exec.ts';
import type { Agent, AgentResult } from '../types.ts';

export interface ClaudeOptions {
  command: string;
  args: string[];
  model?: string;
  /** Extra environment variable names to pass through (`agent.env`). */
  env?: string[];
}

/** Finds Claude Code's final `result` object in its output. */
export function parseClaudeOutput(stdout: string): Record<string, any> | undefined {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value) && value.type === 'result') return value;
    } catch { /* not JSON */ }
  }
  try {
    const value = JSON.parse(stdout);
    if (Array.isArray(value)) return value.findLast((v) => v?.type === 'result');
  } catch { /* not JSON */ }
  return undefined;
}

/** The last ```json block in a reply, for answers given as text instead of structured output. */
export function lastJsonBlock(text: string): unknown {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  if (!last) return undefined;
  try { return JSON.parse(last[1]); } catch { return undefined; }
}

export function claudeAgent(opts: ClaudeOptions, exec: Exec = run): Agent {
  return {
    name: 'claude',
    async run(job): Promise<AgentResult> {
      const args = ['-p', '--output-format', 'json'];
      if (opts.model) args.push('--model', opts.model);
      if (job.schema) args.push('--json-schema', JSON.stringify(job.schema));
      args.push(...opts.args);
      const r = await exec(opts.command, args, { cwd: job.cwd, input: job.prompt, timeoutMs: job.timeoutMs, env: agentEnv(opts.env ?? []), cleanEnv: true });
      const out = parseClaudeOutput(r.stdout);
      if (!out) {
        const why = r.timedOut ? `timed out after ${Math.round(job.timeoutMs / 1000)}s` : firstLine(r.stderr || r.stdout) || `exit code ${r.code}`;
        return { ok: false, text: '', error: `Claude Code gave no result: ${why}` };
      }
      const text = typeof out.result === 'string' ? out.result : '';
      const failed = r.code !== 0 || out.is_error === true || (typeof out.subtype === 'string' && out.subtype !== 'success');
      return {
        ok: !failed,
        text,
        data: out.structured_output ?? lastJsonBlock(text),
        costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : undefined,
        durationMs: typeof out.duration_ms === 'number' ? out.duration_ms : undefined,
        turns: typeof out.num_turns === 'number' ? out.num_turns : undefined,
        error: failed ? `Claude Code stopped: ${out.subtype ?? 'error'}${r.timedOut ? ' (timed out)' : ''}${text ? ` (${firstLine(text)})` : ''}` : undefined,
      };
    },
  };
}
