// Proof: before-and-after video from each device, and test results.
// To reach the right screen, the AI engineer drives the device while it records,
// within a time limit. An optional deep link opens the app on the right screen first.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DRIVE_SCHEMA, drivePrompt } from '../agent/prompt.ts';
import { agentEnv, type Config } from '../config.ts';
import { firstLine, shell, type Exec } from '../exec.ts';
import { writePrivate } from '../redact.ts';
import type { Activity, Agent, DeviceProvider, Lessons, Task } from '../types.ts';
import { discardChanges } from '../worktree.ts';

export interface Video {
  platform: 'ios' | 'android';
  phase: 'before' | 'after';
  file: string;
  /** The AI engineer could not show the change, so this video is only an attempt, not proof. */
  attempt?: boolean;
}

export interface TestResult {
  command: string;
  passed: boolean;
  code: number;
  timedOut: boolean;
  tail: string;
  file: string;
}

export interface ProofContext {
  config: Config;
  exec: Exec;
  agent: Agent;
  devices: DeviceProvider[];
  activity: Activity;
  /** The repo's lessons, so the AI engineer driving the app knows the team's device tips too. */
  lessons?: Lessons;
}

export function videoName(platform: string, phase: string, label?: string): string {
  return `${platform}-${phase}${label ? `-${label}` : ''}.mp4`;
}

/** Builds and tests run code the AI engineer wrote, so they get its environment too. */
function commandEnv(config: Config, extra: Record<string, string> = {}) {
  return { env: { ...agentEnv(config.agent.env), ...extra }, cleanEnv: true };
}

/**
 * Records one phase (before or after the fix) on every device. Problems become "not checked" notes.
 * Discards uncommitted changes in `worktree` afterwards: pass a throwaway worktree, or one whose work is committed.
 * `label` keeps later recordings, such as after a review, from replacing the first ones.
 */
export async function recordPhase(
  ctx: ProofContext,
  o: { task: Task; worktree: string; outDir: string; phase: 'before' | 'after'; label?: string },
): Promise<{ videos: Video[]; notChecked: string[] }> {
  const videos: Video[] = [];
  const notChecked: string[] = [];
  await mkdir(o.outDir, { recursive: true });

  for (const device of ctx.devices) {
    const setup = ctx.config.proof[device.platform];
    if (!setup) {
      if (o.phase === 'before') notChecked.push(`${device.name}: no \`proof.${device.platform}.run\` command in gridbuild.json, so no video.`);
      continue;
    }
    const step = `${device.platform}-${o.phase}${o.label ? `-${o.label}` : ''}`;
    try {
      const deviceId = await device.prepare();
      const build = await shell(ctx.exec, setup.run, {
        cwd: o.worktree,
        timeoutMs: ctx.config.proof.buildMinutes * 60_000,
        ...commandEnv(ctx.config, { GRIDBUILD_DEVICE_ID: deviceId }),
      });
      await writePrivate(join(o.outDir, `build-${step}.log`), build.stdout + build.stderr);
      if (build.code !== 0) {
        throw new Error(`the app did not build and launch${build.timedOut ? ` within ${ctx.config.proof.buildMinutes} minutes` : ` (exit code ${build.code})`}; see build-${step}.log`);
      }

      const file = join(o.outDir, videoName(device.platform, o.phase, o.label));
      const recording = await device.record(deviceId, file);
      let shown: { ok: boolean; why?: string };
      try {
        if (ctx.config.proof.deepLink) await device.openUrl(deviceId, ctx.config.proof.deepLink);
        const prompt = drivePrompt({
          task: o.task,
          deviceName: device.name,
          platform: device.platform,
          deviceId,
          phase: o.phase,
          seconds: ctx.config.proof.seconds,
          deepLink: ctx.config.proof.deepLink,
          lessons: await ctx.lessons?.read(o.worktree),
        });
        const result = await ctx.agent.run({ prompt, cwd: o.worktree, timeoutMs: ctx.config.proof.seconds * 1000, schema: DRIVE_SCHEMA });
        await ctx.activity.log('agent.finished', agentEvent(o.task.id, `drive-${step}`, result));
        const answer = (result.data && typeof result.data === 'object' ? result.data : {}) as { shown?: unknown; note?: unknown };
        const note = typeof answer.note === 'string' && answer.note.trim() ? answer.note.trim() : undefined;
        shown = !result.ok ? { ok: false, why: result.error ?? 'the AI engineer stopped' } : answer.shown === false ? { ok: false, why: note ?? 'it could not reach the screen' } : { ok: true };
      } finally {
        await recording.stop();
      }
      if (shown.ok) {
        videos.push({ platform: device.platform, phase: o.phase, file });
        await ctx.activity.log('proof.recorded', { task: o.task.id, step, file });
      } else {
        // Kept so a reviewer can see what happened, but it proves nothing.
        videos.push({ platform: device.platform, phase: o.phase, file, attempt: true });
        notChecked.push(`${device.name} ${o.phase} video: the AI engineer could not show ${o.phase === 'before' ? 'the problem' : 'the fix'} (${shown.why}). The video is only an attempt.`);
        await ctx.activity.log('proof.failed', { task: o.task.id, step, file, reason: shown.why });
      }
    } catch (err) {
      const why = (err as Error).message;
      notChecked.push(`${device.name} ${o.phase} video: ${why}`);
      await ctx.activity.log('proof.skipped', { task: o.task.id, step, reason: why });
    }
    // Building and filming must never change the fix.
    await discardChanges(ctx.exec, o.worktree);
  }
  return { videos, notChecked };
}

/** Runs the repo's test command and keeps the full output next to the videos. */
export async function runTests(ctx: ProofContext, o: { worktree: string; outDir: string; name?: string }): Promise<TestResult | undefined> {
  const command = ctx.config.test;
  if (!command) return undefined;
  const r = await shell(ctx.exec, command, { cwd: o.worktree, timeoutMs: ctx.config.testMinutes * 60_000, ...commandEnv(ctx.config) });
  const output = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trimEnd();
  const file = join(o.outDir, o.name ?? 'tests.txt');
  await mkdir(o.outDir, { recursive: true });
  await writePrivate(file, `$ ${command}\n${output}\n\nexit code ${r.code}${r.timedOut ? ' (timed out)' : ''}\n`);
  // Files the tests leave behind (snapshots, reports) must not end up in a later commit.
  await discardChanges(ctx.exec, o.worktree);
  return { command, passed: r.code === 0, code: r.code, timedOut: r.timedOut, tail: output.split('\n').slice(-40).join('\n'), file };
}

export function testLine(t: TestResult | undefined): string {
  if (!t) return 'No test command is set in gridbuild.json, so no tests were run.';
  if (t.passed) return `\`${t.command}\` passed.`;
  return `\`${t.command}\` failed${t.timedOut ? ' (timed out)' : ` with exit code ${t.code}`}: ${firstLine(t.tail.split('\n').slice(-1)[0] ?? '')}`;
}

export function agentEvent(task: string, step: string, r: { ok: boolean; costUsd?: number; durationMs?: number; turns?: number; error?: string }) {
  return { task, step, ok: r.ok, costUsd: r.costUsd, durationMs: r.durationMs, turns: r.turns, error: r.error };
}
