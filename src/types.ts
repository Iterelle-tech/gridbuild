// The six plug points: Watcher, Queue, DeviceProvider, Agent, Lessons, Activity.
// Other parts can plug in here (a shared queue can replace the local one, leased devices
// can replace the simulators, other tools can read the activity log), so keep them small
// and stable.

/** One unit of work from any watcher: an issue, a ticket or a crash. */
export interface Task {
  /** Unique and stable across restarts, safe for branch names: "github-42", "jira-APP-7". */
  id: string;
  /** The watcher it came from: "github", "jira", "crashlytics", or "file" for `once <file>`. */
  source: string;
  /** Its id in the source: issue number, ticket key, Crashlytics issue id or file path. */
  ref: string;
  title: string;
  /** Plain text or Markdown the AI engineer reads. */
  body: string;
  url?: string;
}

/** Watches one source of work and turns new items into tasks. */
export interface Watcher {
  name: string;
  /** Open work right now, leaving out task ids in `known` before any limit applies. */
  poll(known?: ReadonlySet<string>): Promise<Task[]>;
  /** One item by its id in the source, for `gridbuild once`. */
  get(ref: string): Promise<Task | undefined>;
  /** Post a short status note back to the source. */
  notify?(task: Task, message: string): Promise<void>;
}

/** `needs-attention`: stopped so a person can look, such as a fix interrupted with uncommitted changes. */
export type TaskState = 'queued' | 'claimed' | 'done' | 'failed' | 'needs-attention';

export interface PullRequest {
  url: string;
  number?: number;
  branch: string;
  worktree: string;
}

export interface QueueItem {
  task: Task;
  state: TaskState;
  addedAt: string;
  attempts: number;
  claimedAt?: string;
  finishedAt?: string;
  pid?: number;
  pr?: PullRequest;
  error?: string;
}

/** The task queue on one machine. */
export interface Queue {
  /** Returns false if the task was seen before, so no task is ever worked twice. */
  add(task: Task): Promise<boolean>;
  /** Claims the next queued task, or the given one. */
  claim(id?: string): Promise<QueueItem | undefined>;
  done(id: string, pr: PullRequest): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  /** Parks the task until a person runs it again with `gridbuild once`. */
  needsAttention(id: string, reason: string): Promise<void>;
  /** Gives a claim back unfinished, for a clean stop. The attempt does not count. */
  release(id: string): Promise<void>;
  list(): Promise<QueueItem[]>;
}

export interface Recording {
  stop(): Promise<void>;
}

/** A simulator or emulator the AI engineer can run the app on and film. */
export interface DeviceProvider {
  platform: 'ios' | 'android';
  name: string;
  /** Problems that stop this device from working; empty when ready. Must not hang. */
  check(): Promise<string[]>;
  /** Boots a device if none is running and returns its id. */
  prepare(): Promise<string>;
  openUrl(deviceId: string, url: string): Promise<void>;
  record(deviceId: string, file: string): Promise<Recording>;
}

export interface AgentJob {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** JSON Schema for a structured answer, returned as `data`. */
  schema?: object;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  data?: unknown;
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  error?: string;
}

/** The AI engineer: one coding agent working one task at a time. */
export interface Agent {
  name: string;
  run(job: AgentJob): Promise<AgentResult>;
}

/** Corrections from code review, kept in the target repo as rules for later tasks. */
export interface Lessons {
  read(repoDir: string): Promise<string>;
  add(repoDir: string, rule: string, from: string): Promise<void>;
}

export interface ActivityEvent {
  ts: string;
  type: string;
  task?: string;
  [key: string]: unknown;
}

/** Append-only log of everything the AI engineer does. */
export interface Activity {
  log(type: string, data?: Record<string, unknown>): Promise<void>;
  read(): Promise<ActivityEvent[]>;
}
