---
module: subagents
paths: [packages/core/src/kete/subagents.ts, packages/core/src/tool/plugin/subagent.ts, packages/core/src/session/subagent-job.ts, packages/core/src/config/plugin/command.ts, packages/core/src/job.ts, packages/schema/src/config/kete.ts]
verified-at: 460d1de894
---

## Quick answers
- Anything new for subagents? Only the `kete` config schema gained `offline` (`schema/src/config/kete.ts:72`); subagent behaviour is unchanged.
- Default subagent timeout: 60 minutes, 0 = no limit (`packages/core/src/kete/subagents.ts:36`, config key `kete.subagents.timeout`). This is the *per-subagent* timeout; an **unattended** run also has a *whole-family* time limit — see below and the `unattended` card.
- Default concurrency cap: 4 running subagents per parent session (`subagents.ts:36`, `kete.subagents.max_concurrent`).
- Who enforces the cap: `admit()` (`subagents.ts:137-166`), called only from the `subagent` tool (`packages/core/src/tool/plugin/subagent.ts:179`) — slash-command subtasks never call it.
- What happens when the user stops a session: its running subagents (foreground and background) are interrupted too, cascading to their own children (`subagents.ts:269-285`, `subagents.ts:347-365`).
- What a subagent worktree adds to the child's final answer: a `<worktree>` note appended by `bound()` (`subagents.ts:181-194`), produced by `kete/worktrees.ts` (see the worktrees-parallel card).
- Which event marks a run starting (for the unattended-run time-limit timer)? `SessionEvent.Execution.Started`, published at `packages/core/src/session/execution.ts:118` — `kete/unattended.ts`'s late plugin subscribes to it, not to anything in this module (see the `unattended` card).

## Purpose
Kete-owned controls layered on upstream's subagent tool: a per-job timeout, a per-parent concurrency ceiling, a stop cascade when the user interrupts a session, and (via `kete/worktrees.ts`) optional worktree isolation. Also home to `subtaskCheck`, reused so slash-command subtasks get the same nesting-depth and permission checks the subagent tool applies. Background subagents surviving a process restart are re-armed with a timeout by `watchRecovered` since they didn't go through `bound`.

## Entry points
- `subagent` tool call (`packages/core/src/tool/plugin/subagent.ts:110-306`) — the only caller of `admit`.
- Slash-command subtasks (`packages/core/src/config/plugin/command.ts:76-118`) — call `subtaskCheck` (`command.ts:41`, `:103`) but skip `admit`/`bound`; they still get depth and permission checks.
- `workflow` tool (`packages/core/src/kete/workflows.ts:284-316`) — drives the `subagent` tool via a tool-registry snapshot, so it inherits admission, timeout, worktrees and permission checks for free (see the workflows card).
- Recovered background jobs after a restart: `subagents.ts` `watchRecovered` (`:294-329`), wired into `Plugin.effect` (`:339-346`).

## Key files
| File | Lines | Role |
|---|---|---|
| `packages/core/src/kete/subagents.ts` | 368 | `limits`, `admit`/`bound`/`worktree`, `subtaskCheck`, `stopChildren`, `watchRecovered`, the plugin |
| `packages/core/src/tool/plugin/subagent.ts` | 348 | Upstream tool (`opencode.tool.subagent`), patched at 5 `kete_change` sites |
| `packages/core/src/session/subagent-job.ts` | 74 | Wraps each subagent's `Job.run` in `KeteSubagents.bound`; delivers completion notices |
| `packages/core/src/config/plugin/command.ts` | 253 | Slash commands that run as subtasks; calls `subtaskCheck` |
| `packages/core/src/job.ts` | 482 | Upstream job registry (`start`/`wait`/`block`/`background`/`cancel`/`pendingBackground`); unmodified, no `kete_change` markers |
| `packages/schema/src/config/kete.ts` | 80 | `ConfigKete.Subagents` schema (`timeout`, `max_concurrent`, `worktree`), lines 29-41 (unrelated to the file's other growth: `Runtime`/ADR 0005 was added above it) |

## Data flow
1. Tool call arrives → depth check against `experimental.subagent_depth` (`subagent.ts:127-143`) → agent resolved, `mode !== "primary"` enforced (`:144-147`) → `subagent` permission asserted (`:148-161`).
2. `controls.admit(parentID, existing?.id)` (`:179`) takes the semaphore lock, counts running children via `Job.Service` (`subagents.ts:115-123`) plus in-flight tickets held in-process (`:71-84`), fails with a `ToolFailure` if `>= maxConcurrent` (`:144-150`).
3. Optionally `controls.worktree(...)` decides isolation (`:222-231`) → `KeteWorktrees.isolate` creates the child's location/metadata (see worktrees-parallel card) → child session created, `ticket.bind(child.id)` (`subagent.ts:235`) upgrades the ticket to a bound place.
4. `sessions.prompt` starts the child; `subagents.start(recovery)` (`subagent-job.ts:51-67`) registers the job, running the work under `controls.bound(childID, run)` — timeout via `Effect.timeoutOrElse`, then on timeout: fail the job first, interrupt the session after (`subagents.ts:176-216`, comment at `:18` explains the ordering).
5. On completion, `bound` appends/prepends the worktree note (`:181-194`) via `note()` → `worktrees.report`.
6. On session stop (`SessionEvent.Execution.Interrupted` with `reason: "user"`), `stopChildren` interrupts + cancels every running subagent job of that session, recursively (`:268-285`, `:347-365`).

## Data and APIs used
- `Config.Service` → `kete.subagents.{timeout,max_concurrent,worktree}` (`ConfigKete.Subagents`, `packages/schema/src/config/kete.ts:29-41`); `experimental.subagent_depth` for nesting.
- `Session.Service` (`list`, `get`, `interrupt`, `prompt`, `switchAgent`, `switchModel`), `Job.Service` (`get`, `wait`, `cancel`, `pendingBackground`), `Permission.Service` (`subagent`, `worktree` actions), `Agent.Service` (`resolve`), `Bus.Service` (`SessionEvent.Execution.Interrupted`), `Location.Service` (directory match in `watchRecovered`).

## Rules that must not break
- `admit`+bind must stay atomic per parent (`lock: Semaphore.make(1)`, `subagents.ts:110`) — parallel subagent calls in one turn must not both slip past the cap.
- Timeout must fail the job before interrupting the session (`subagents.ts:176-180`), or the run reads as user-cancelled rather than a limit.
- This module's per-subagent timeout is independent of, and doesn't replace, an unattended run's whole-family time limit (`unattended` card, `kete/unattended.ts` `watch`/`check`): a subagent can finish well inside its own `kete.subagents.timeout` and still have every further step in the family refused once the run's own `timeout` deadline (from the root session's `time.created`) passes.
- Stop cascade must filter on `reason === "user"` only (`:349-350`) — shutdown/supersede must leave background work for the next start.
- `subtaskCheck` is the only gate for slash-command subtasks; it must be called before session creation in `command.ts:103`, or subtasks bypass depth/permission checks the subagent tool enforces.
- A subagent's privilege is additionally capped by `KetePermissionCeiling` (not in this card's file set) so a child never exceeds any ancestor's agent — see `docs/upstream-patches.md` "Subagent security".

## Testing
- `bun run test ./test/kete/subagents.test.ts` inside `packages/core` (admission, timeout, stop cascade, `watchRecovered`).
- `bun run test ./test/tool-subagent.test.ts` inside `packages/core` (upstream tool behavior + Kete patches together).
- `bun run test ./test/config/command-subagent.test.ts` inside `packages/core` (`subtaskCheck` wiring for slash commands).
- `bun run test ./test/session-create.test.ts` inside `packages/core` (child `location` typing used by worktree subagents).

## Changes
- `docs/upstream-patches.md` sections "Subagent controls" and "Subagent security" enumerate every patched upstream file and line-level intent; don't duplicate here, read those before editing `subagent.ts` or `command.ts`.
- `kete_change` markers: `subagent.ts:10-11` (imports), `:50-55` (worktree input), `:82-83,178,180-201,227,235,246,294` (admission/worktree/scoped release); `subagent-job.ts:4,6,18-22,26,36,43` (Config dependency, `bound` wrap, `resume:false` on cancellation); `command.ts:17,41,103`.

## Gotchas
- `count()` (`subagents.ts:71-84`) dedupes a place already bound to a running child so continuing an existing child doesn't double-count; pass `exclude` when continuing.
- Only the `subagent` tool calls `admit` — recovered background subagents from `session/execution/restart.ts` and slash-command subtasks never go through it (header comment, `subagents.ts:15-18`).
- `watchRecovered` only arms subagents whose child session's `location.directory` matches the current `Location.Service` — a recovered subagent in a different worktree/directory is silently skipped (`:310`).
- `bound`'s `note()` never fails the outer effect; a worktree-report failure is logged and swallowed (`:170-174`), so a missing worktree note isn't necessarily a bug.
