# Gridbuild runner

The open-source runner for Gridbuild: it runs an AI engineer for a mobile app on your own Mac. It picks up work, fixes it with a coding agent, films the change on iOS and Android, and opens a pull request with the proof.

This repo is public. Keep every file fit for that: no secrets, private paths, customer names or internal notes.

## Scope

1. Watch for work: GitHub issues labelled `bot`, Jira tickets assigned to Gridbuild, and new Crashlytics crashes.
2. Run Claude Code on the Mac to fix the issue, following the repo's own rules (`CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`) and the lessons file.
3. Run the app in the iOS Simulator and the Android Emulator, and record before/after video.
4. Open a PR with the fix, both videos, the test results, a plain-words note on what was wrong and what changed, and what it couldn't check.
5. On review comments: answer, re-test, push, and save the correction to the lessons file.

Not built here: more than one machine, Sentry and store reviews, an audit log, a budget system, a model router, hosted Macs. Ask before adding any of these.

## Language and layout

TypeScript on Node 24, run directly (Node strips the types, so there's no build step; use only erasable syntax: no enums, namespaces or parameter properties, and `import type` for types). No runtime dependencies: shell out to `git`, `gh`, `claude`, `xcrun simctl`, `adb`/`emulator` and `gcloud` with `child_process`, always through `src/exec.ts` with a timeout; use the built-in `fetch` for Jira and BigQuery; test with `node --test`.

- `src/cli.ts`: the `gridbuild` command (`init`, `doctor`, `run` for the loop, `once <task>` for one task, `status`, `--dry-run`).
- `src/config.ts`: reads `gridbuild.json` in the target repo; secrets come from environment variables, never the file.
- `src/types.ts`: the six interfaces and the `Task` type.
- `src/exec.ts`: runs every outside command with a timeout, killing its whole process group.
- `src/doctor.ts`: `gridbuild doctor`, all checks in parallel, each with a timeout.
- `src/runner.ts`: the loop and one task end to end (worktree, before video, fix, tests, after video, PR).
- `src/worktree.ts`: one git worktree per task on `gridbuild/<task id>`, kept in the state folder, and the commits.
- `src/watchers/`: `github.ts`, `jira.ts`, `crashlytics.ts` (reads the Crashlytics BigQuery export), each implementing the `Watcher` interface.
- `src/queue.ts`: the local task queue on one machine.
- `src/agent/`: `claude.ts` behind the `Agent` interface; `prompt.ts` builds the fix, film and review prompts.
- `src/devices/`: `ios.ts` and `android.ts` behind the `DeviceProvider` interface.
- `src/proof/`: before/after recording and test results.
- `src/pr/`: PR body (`body.ts`), GitHub through `gh` with videos on the `gridbuild-proof` branch (`host.ts`), the `--dry-run` folder (`dryrun.ts`), and the review loop (`review.ts`).
- `src/lessons.ts`: the lessons file (`.gridbuild/lessons.md` in the target repo).
- `src/activity.ts`: an append-only activity log (JSON lines).
- `src/redact.ts`: removes secrets from everything published (PR body, replies, notes) and from the activity log.
- `test/`: `node --test`, with fakes for every outside tool, so tests never call GitHub, Jira, Firebase, Claude or a simulator. `node test/dry-run.ts` runs the end-to-end dry run.

The six interfaces (Watcher, Queue, DeviceProvider, Agent, Lessons, Activity) are the plug points: a shared queue can replace the local one, another device provider can replace the simulators, and other tools can read the activity log. Keep them small and stable. A `--dry-run` flag writes the branch, PR body and proof to a local folder instead of calling GitHub.

Rules that matter:

- The coding agent runs on the user's own account (`ANTHROPIC_BASE_URL` works for a gateway or OpenRouter). Never route code through an account of ours.
- Never claim that no code leaves the Mac: code goes to the AI provider the user already uses.
- The runner only connects out. Don't add open ports, tunnels or machine-to-machine networking.

## Terms

Use these words, with these meanings, in code, docs and the README.

| Term | Meaning |
|---|---|
| AI engineer | One coding agent working one task at a time on one machine, with its own simulator and emulator |
| Watcher | Watches one source of work and turns new items into tasks: GitHub issues labelled `bot`, Jira tickets assigned to Gridbuild, new Crashlytics crashes |
| Task | One unit of work from any watcher: an issue, a ticket or a crash |
| Runner | This program: it runs an AI engineer on a machine |
| Coding agent | The AI coding tool an AI engineer runs on. Claude Code today |
| Proof | What shows a fix works: before-and-after video from iOS and Android, checks against the ticket, and test results, posted on every PR |
| Lessons | Corrections from code review, saved in `.gridbuild/lessons.md` as rules the AI engineer follows on later tasks |

Say AI engineer, not agent on its own. Say bot only for the GitHub label or account name.

## Writing

Plain English, sentence case, second person in the README. Say what the user gets, not how it's built.
