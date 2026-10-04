---
module: worktrees-parallel
paths: [packages/core/src/kete/worktrees.ts, packages/core/src/kete/worktree-lease.ts, packages/core/src/kete/worktree-name.ts, packages/core/src/kete/git.ts, packages/core/src/kete/session-move.ts, packages/core/src/kete/stale-write.ts, packages/core/src/worktree.ts, packages/core/src/worktree/strategies.ts, packages/core/src/session/move.ts, packages/core/src/session.ts, packages/core/src/tool.ts]
verified-at: d5cd08f36b
---

## Quick answers
- Branch naming: `kete/agent-<slug>`, `worktrees.ts:44` (`branchPrefix`), slug from `worktrees.ts:223`.
- Branch base: the parent session's last commit on its repository directory (`worktrees.ts:210-217`), not the parent's uncommitted changes.
- What keeps two sessions out of the same agent worktree: `KeteWorktreeLease.leasedTo` (`worktree-lease.ts:32-44`), enforced by the model-facing `session_move` tool hook (`session-move.ts:73-77`) and by the HTTP/UI move path (`session/move.ts:120-123`) — both, not just the tool.
- What stops a whole-file `write` from clobbering a parallel agent's edit: `kete/stale-write.ts` SHA-256 fingerprints per session per file, checked only on `write` (edit/patch already fail on stale context by design — header comment `stale-write.ts:1-11`).
- Who guards deleting a worktree with unmerged commits: `KeteWorktrees.guard` (`worktrees.ts:349-381`) wraps the `git` `WorktreeStrategies.Strategy.remove`.
- Does `POST /api/worktree` create a branch? No — it makes a **detached** worktree (upstream
  `git worktree add --detach`, `core/src/git.ts:657`); its `CreateInput.branch` names a ref to
  check out, not a new branch to create, and no endpoint creates one. That's why `kete job run`
  doesn't use this endpoint at all — see the next line.
- Does `kete job run` use `POST /api/worktree`/this module at all? No (D1, `kete job run` task,
  2026-09-28) — the CLI (`cli/src/kete/job-git.ts`, `job-run.ts`) runs `git worktree add -b`
  itself, under upstream's own worktree-parent convention (`<Global.Path.data>/worktree/<project
  id, first 6 chars>/`, the same parent `WorktreeStrategies` uses, `strategies.ts:51`) but with a
  `job-<id8>` name, never `kete/agent-<slug>`. A job's worktree is therefore **not** in this
  module's KV-backed lease index (`worktree-lease.ts`), doesn't go through `KeteWorktrees.guard`,
  and `sweep()` never touches it (only `kete.worktree/` lease records it owns) — nothing here
  manages a job's worktree lifecycle; the job itself creates it once and never removes it once the
  prompt is submitted (`cli` card, `docs/jobs.md`). The reason: `POST /api/worktree` would run the
  project's `commands.start` setup script outside the job's own policy and audit.

## Purpose
Lets subagents (and, by extension, workflow steps) work in parallel without stepping on each other's files or the parent's: each isolated subagent gets its own git worktree and branch through the upstream `Worktree` service, a KV-backed index tracks which session owns which worktree so other sessions can't move into it, and a fingerprint check on `write` catches the case where an agent's plan was based on a file another agent or the user has since changed. Also fixes a path-traversal gap in upstream worktree naming.

## Entry points
- `subagent` tool with `worktree: true`, or `kete.subagents.worktree: "background"` for background+editing subagents (`packages/core/src/tool/plugin/subagent.ts:183-201`, decided by `KeteSubagents.worktree`, see subagents card).
- `workflow` tool step with `worktree: true` (`packages/core/src/kete/workflows.ts:48-49` schema, `:297` passthrough) — same worktree machinery, one layer up.
- Model's `session_move` tool, gated by `kete/session-move.ts` (`isSessionMove`, `:27`, hooked at `execute.before`, `:54-100`).
- Any `write` tool call, gated by `kete/stale-write.ts` (`execute.before`/`execute.after` hooks, `:94-129`).
- `kete.worktrees.Plugin` startup: wraps the `git` `WorktreeStrategies.Strategy` and sweeps orphaned worktrees (`worktrees.ts:383-400`).

## Key files
| File | Lines | Role |
|---|---|---|
| `packages/core/src/kete/worktrees.ts` | 400 | `isolate`/`check`/`report`/`sweep`/`release`, the `guard` wrapper, the plugin |
| `packages/core/src/kete/worktree-lease.ts` | 44 | `Record` schema + `leasedTo` lookup; deliberately session-import-free so `session/move.ts` can use it without a cycle |
| `packages/core/src/kete/worktree-name.ts` | 19 | `valid()` — one path segment, no traversal, cross-platform reserved-name checks |
| `packages/core/src/kete/git.ts` | 54 | Timeout-bounded `git` runner (`run`/`text`) for commands the upstream Git service doesn't expose |
| `packages/core/src/kete/session-move.ts` | 102 | Model-facing `session_move` tool checks (own-subtree only, `external_directory` permission, lease refusal) |
| `packages/core/src/kete/stale-write.ts` | 131 | Per-session file fingerprints; refuses stale `write` |
| `packages/core/src/worktree.ts` | 367 | Upstream worktree service; patched at `:214-217` (name validation) and `:252-255` (Kete env var names alongside `OPENCODE_*`) |
| `packages/core/src/worktree/strategies.ts` | 74 | Upstream strategy registry (`Strategy`, `Editor`, `Service`) — unmodified, the seam `guard()` wraps |
| `packages/core/src/session/move.ts` | 182 | Upstream session-move implementation; patched at `:69` (KV dep), `:120-123` (lease refusal for every caller, not just the tool) |
| `packages/core/src/session.ts` | 483 | Upstream session service; patched at `:91` (child may carry its own `location`) and `:256` (explicit location wins over parent's) |
| `packages/core/src/tool.ts` | 332 | Upstream tool hook dispatch (`execute.before`/`execute.after`, `:104-149`); unmodified — the seam `session-move.ts` and `stale-write.ts` hook into |

## Data flow
1. `isolate(parent, childID, invocation)` (`worktrees.ts:180-255`): refuses non-local sessions (`:185-186`); if the project has a `commands.start` setup script, asks the `shell` permission naming it (`:190-209`) before running it; resolves `HEAD` of the parent's repo dir (`projectDirectory`, `:57-62`) as `base`; prunes stale worktrees (`sweep`, then `git worktree prune`, `:218-221`); creates the worktree via upstream `Worktree.Service.create` (`:222-228`, this is also where `worktree.ts`'s name-validation patch applies); creates+switches a new branch `kete/agent-<slug>` (`:229-238`); records a `Record` in KV under `kete.worktree/<childID>` (`worktree-lease.ts:13`, `worktrees.ts:247`); returns `{ record, location, metadata: { ...parent.metadata, [worktreeKey]: record } }` for `Session.create` (`:253`) — the child's metadata **spreads the parent's**, so session-metadata keys like `kete.permissionMode` and `kete.unattended` (permissions/`unattended` cards) survive a worktree subagent even though it supplies its own `metadata` at creation, unlike a plain child which inherits by omitting `metadata` entirely.
2. `session.ts:256` lets that explicit `location` win over the inherited parent location when creating the child (`sessions.create({ ..., location: isolated.location, metadata: isolated.metadata })`, `subagent.ts:227`).
3. While running, other sessions are kept out: `session-move.ts` refuses model-driven moves into the lease (`:73-77`), and `session/move.ts:120-123` refuses it unconditionally for UI/HTTP/tool moves alike.
4. On finish, `KeteSubagents.bound` calls `worktrees.report(childID, { release })` (subagents card, `subagents.ts:169-174`): if the worktree has 0 commits and 0 uncommitted changes, `release()` removes the worktree (and the branch, if it holds nothing beyond `base`) and moves the child session back to the parent's directory (`worktrees.ts:283-298`); otherwise `describe()` returns review/merge instructions (`:76-91`).
5. Independently of subagents, `stale-write.ts` fingerprints every file a session reads/writes/edits/patches (`execute.after`, `:106-129`) and refuses a `write` whose current on-disk fingerprint doesn't match what that session last saw (`refusal()`, `:55-60`, checked in `execute.before`, `:94-104`).

## Data and APIs used
- Upstream `Worktree.Service` (`create`, `remove`) and `WorktreeStrategies.Service` (`get`, `transform`) — `worktrees.ts` never talks to git directly for creation, only for branch/status/prune via `KeteGit`.
- `KV.Service` for the worktree-lease index (`kete.worktree/` prefix) — outlives the session, cleaned by `sweep`/`release`.
- `Permission.Service`: `shell` (setup script), `worktree` (isolation itself, asserted in `subagent.ts`), `external_directory` (session move outside the repo).
- `FSUtil.Service`, `AppProcess.Service`, `Project.Service` — all optional-injected (`worktrees.ts:317-343`, `optional`) so worktree subagents degrade gracefully (e.g. in focused tests) rather than hard-failing.
- `Environment.Service` (`files.stat`/`files.read`) and `FileAccess.Service` (`resolve`) for fingerprinting in `stale-write.ts`.

## Rules that must not break
- A worktree name must be one path segment (`worktree-name.ts:7-19`) — `worktree.ts:214-217` refuses anything else; this is the fix for a path-traversal gap where a plugin/HTTP-supplied name like `../../x` escaped the worktree directory.
- `leasedTo` must be checked by every move path, not just the model tool — `session/move.ts:120-123` is the one true gate; `session-move.ts`'s tool hook exists only to give the model an actionable message before that gate fires.
- `release()` must never remove a worktree with uncommitted changes or unmerged commits (`worktrees.ts:122-138`); `guard()` separately refuses removing any detached worktree whose HEAD commits aren't reachable from a branch/tag/remote unless `force` (`:349-381`).
- `stale-write` only gates `write`; `edit`/`patch` are deliberately left unchecked because they already fail on mismatched surrounding text (design note, `stale-write.ts:6-8`) — don't add a fingerprint check there without re-reading that rationale.
- Files over 5 MiB are `"untracked"` and unprotected by `stale-write` (`:22,26,77`) — a large-file race is a known, accepted gap, not a bug to silently "fix" by fingerprinting big files (would blow the in-memory 5000-entry budget, `:23`).

## Testing
- `bun run test ./test/kete/worktrees.test.ts` inside `packages/core` — covers `worktrees.ts` isolate/release/sweep/guard **and** `KeteStaleWrite` rules (a `describe("KeteStaleWrite rules")` block lives in this same file, line ~321) and the worktree-lease index.
- `bun run test ./test/session-move.test.ts` inside `packages/core` — lease refusal for every move path.
- `bun run test ./test/worktree.test.ts` inside `packages/core` (upstream) — name validation, `KETE_WORKTREE_*` setup-script env vars (per `docs/upstream-patches.md`, "Upstream test edits").
- `bun run test ./test/plugin/worktree.test.ts` inside `packages/core` — strategy-wrapping plugin behavior.
- `bun run test ./test/session-create.test.ts` inside `packages/core` — child session with its own `location` typechecks.
- No dedicated `stale-write.test.ts` exists — its only coverage is the block inside `worktrees.test.ts`; if you touch `stale-write.ts` in isolation, that's still the file to run.

## Changes
- `docs/upstream-patches.md` sections "Subagent worktrees" and "Subagent security" and "Parallel safety" are the authoritative per-file patch list; `docs/architecture.md` §50 (Git Worktrees) and §105 (Concurrency) are the direction docs this implements.
- `kete_change` markers: `worktree.ts:214-217,252-255`; `session.ts:91,256`; `session/move.ts:69,120-123,180`. `worktree/strategies.ts` and `tool.ts` carry none — they're unmodified upstream seams. `session.ts` also has a fourth marked line (`create`'s `metadata:` field, ~`:276`) owned by the `unattended` module (`docs/upstream-patches.md` "Unattended runs"), not this one — don't conflate it with the worktree-location patch at `:256` when reading the diff.

## Gotchas
- `projectDirectory()` (`worktrees.ts:57-62`) walks *up* by the session's `subpath` to find the repo root — a session opened in a subdirectory still isolates the whole repo, not just the subpath.
- A continued (not new) subagent still gets `worktrees.check()` (`subagent.ts:181`) — continuing a child whose worktree was already released (because it changed nothing) is refused with a message telling the model to start a new subagent instead.
- `release()`'s branch deletion only fires when the branch tip still equals `base` (`worktrees.ts:133-135`) — a branch with any commit, even one later reverted to match base's tree, keeps the branch (compares OIDs, not trees).
- `sweep()` only removes *clean* worktrees of sessions that no longer exist (`:140-174`); a deleted session's dirty worktree is kept forever and only logged as a warning — there's no automatic escape hatch, by design (would risk losing work).
