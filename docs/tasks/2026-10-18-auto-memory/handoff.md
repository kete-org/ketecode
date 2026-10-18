# Handoff: Quick remember and auto memory (A2b)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-18 main session
Spec approved under the user's 2026-10-18 instruction to carry on through every remaining item without stopping. A2a (#49) merged first.

## 2026-10-18 planner
Done: plan.md written (Large: upstream registration edit in `core/src/plugin/internal.ts`, config schema `kete.memory.auto`, new contracts, security-sensitive). Needs the user's approval of plan.md before building.

Cards: `instructions`, `config-kete`, `permissions`, `roles-skills`, `audit-log`, `todo` fresh. `cli` is stale (only `cli/src/kete/skill-flow.ts`) and `job-mode` is stale (only orchestration files); the plan uses neither stale part (built-in command pattern is in `core/src/kete/git-commands.ts`, job-mode check is `KeteJobMode.enabled`), so planning went ahead. The librarian must refresh both cards at close (or before build, if the main session prefers the strict rule).

Docs enough: no — missing: how a built-in command reports an error to the person (found: `core/src/command.ts:80-88` maps a failing `execute` to `ExecutionError` with its message).
Docs enough: no — missing: which seam removes a tool per request (found: `delete event.tools[name]` in `context`/`compaction`/`generate` hooks, `core/src/kete/offline.ts:149-156`).
Docs enough: no — missing: a cross-process file lock for Kete state (found: `EffectFlock.Service.withLock`, `util/src/effect-flock.ts:82-90`).
Docs enough: no — missing: the id of a project without a stable id (found: `ProjectID.global` = "global", `schema/src/project-id.ts:6`).

Decisions: one plugin `core/src/kete/auto-memory.ts` registered in `post` after `KeteMemoryFiles`; `memory` added to Plan mode's `planAllowed` (writes only Kete's state folder, like `todowrite`); index loaded at plugin start and after the tool changes it, no watcher; loaded text is redacted again on load.
## 2026-10-18 implementer
Done: schema `kete.memory.auto`; `core/src/kete/auto-memory.ts` (plugin); registration in `plugin/internal.ts` (marked); `memory` in `planAllowed`; `core/test/kete/auto-memory.test.ts`; README, CHANGELOG, `docs/upstream-patches.md`, `docs/permissions.md`.

NOT RUN: this session had no shell tool, so no check ran (no typecheck, no tests, no `bun run generate` in `packages/protocol` and `packages/client`, no `upstream:check`, no `job-fs-sites.test.ts`). The generated `openapi.json` and client files are NOT regenerated and must be before merge. The code and tests are unverified and may have type errors (notably: effect-v4 API use in the tool, `Tool.Error` instanceof, test harness layers).

Deviation from the plan (needed by the approval block): unattended is a property of a session (`kete.unattended` metadata, resolved through `KeteUnattendedPolicy.resolve` as `kete/hooks.ts` does, fail closed), but InstructionDiscovery is shared by all sessions of a process, so it cannot hide notes from one unattended session. The notes are therefore added to the system prompt per session in the `context` hook (not through `discovery.transform`), and the same per-session check hides the tool (`context`/`compaction`/`generate`), refuses `execute` and refuses `/remember` and `/memory`. `discovery.project`/`global` are still honoured. Consequence: `/memory` cannot list the notes via instructions, it uses the tool; cards `instructions` should not say auto memory is in discovery. Job mode (`KeteJobMode.enabled`) still returns before anything registers. Tests: "off" block covers `kete.memory.auto: false`, an unattended session and job mode.
Other small deviations: lock key is `kete-memory-<folder>` (sanitised) with no `dir` argument; write/append/delete are atomic via temp file + rename; `memory.md` (lowercase) is refused as a name because it collides with `MEMORY.md` on case-insensitive disks.

Open questions for review: is allowing `memory` in Plan mode acceptable to the security review? Does a local `kete job run` (unattended, not job mode) need auto memory off too? The spec only names job mode; the unattended policy's fail-closed rules should deny `memory` unless a policy allows it, and the implementer should confirm this in a test or report it.
