# Handoff: Extra working directories (A13)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-18 main session
Spec approved under the user's 2026-10-18 instruction to carry on through every remaining item without stopping.

Docs enough: no (scout, 2026-10-18). Missing:
- permissions card: where the workspace boundary is (FileAccess.resolve, external_directory, which tools call it) and how an "always allow" for it is saved (PermissionSaved, project-scoped).
- sandbox card: how writable roots are decided (resolve.ts ~397-401, settings.allowWrite) and whether a dir can be added.

## 2026-10-18 planner
Done: plan.md written (Large: upstream edits, new contracts `--add-dir`/`/add-dir`/`kete.dirs`/RPC `kete.add-dir`, security). Cards permissions, sandbox, cli, instructions: not stale.

Decisions:
- Grant = a Kete `evaluate` hook registered right after `KeteUnattended.PolicyPlugin` (loosening hooks must precede tightening ones); only `ask` → `allow` for `external_directory`, real-path containment, folders re-checked at use.
- Subagents: the ceiling gets the folders as allow rules via its `Lookup.policy`, otherwise it re-asks.
- Validation is enforced by guards in `Session.setMetadata` and `Session.create` (session hooks can't refuse). Because a server defect reaches clients as a generic error, clients pre-check through a plugin RPC `kete.add-dir` `check` (existing `/api/rpc` endpoint, no protocol change), which slightly extends the spec's "no new endpoint, metadata update only" (still no new HTTP endpoint).
- `/add-dir` is a server-side built-in command (like `/remember`), so the TUI needs no slash-command code and output goes through `ctx.session.synthetic`.
- An explicit config `ask` on external_directory is loosened by the grant too (deny still wins; org policy and `ConfigPolicyPlugin` run later). Flag for the security review.

Docs enough: no — missing:
- permissions card: FileAccess.resolve / `external_directory` resource shape (`<dir>/*`, forward slashes) and callers; `Permission.evaluateInput` order (`permission.ts:170-187`).
- sandbox card: how writable roots are built (`resolve.ts:397-401`) and how `KeteSandbox.make` is wired from `shell.ts:121-135`.
- no card says how a server-side defect from a session guard reaches clients (generic error, `server/src/handlers/session.ts:269-272`), nor that `ctx.session.update` has no metadata (`plugin/host.ts:537-542`).
- no card covers the plugin command API returning output without a model turn (`ctx.session.synthetic`, `plugin/plan.ts:69`).
- `memory-imports.ts:79` `SECRET_HOME_DIRS` (credential folder list) isn't on a card.

Open questions: whether session metadata is ever sent to the platform was not checked; the implementer should grep for session-metadata sync before closing.

## 2026-10-18 implementer
**No shell tool was available in this run: no check (typecheck, test, lint, upstream:check, generate) was run. Everything below is unverified.**

Done (code): core `kete/add-dir.ts` (validate, guard, dirs, rules, context), `kete/add-dir-plugin.ts` (grant on `evaluate`, `kete.add-dir` RPC `check`, `/add-dir`), `schema/src/kete/add-dir.ts`; wiring in `session/session.ts`, `session.ts`, `plugin/internal.ts` (pre, after `KeteUnattended.PolicyPlugin`, and `guarded`), `tool/plugin/shell.ts`; `kete/sandbox.ts` + `sandbox/resolve.ts` (`extraWrite`); `permission-ceiling.ts` policy; `memory-imports.ts` exports `SECRET_HOME_DIRS`; CLI `--add-dir` (commands.ts, both handlers, run.ts, `cli/src/kete/add-dir.ts`); TUI (`kete/add-dir.tsx`, args, prompt metadata merge, app.tsx). Tests: core `add-dir.test.ts`, cli `add-dir.test.ts`, tui `add-dir.test.tsx`. Docs: permissions.md, sandbox.md, README, CHANGELOG, upstream-patches.md.

Approval block, as applied:
- The grant turns `ask` into `allow` only when the matching rule for the resource (agent + session + saved rules, `Permission.evaluate`) is the default `external_directory * ask` (rule resource `"*"`). A path-specific `ask` (user, project, org, session) stands; tested (core test "an explicit external_directory ask ... still asks"). Limit: a user-written `external_directory: ask` with resource `*` is indistinguishable from the default and is loosened. The permission service decides `deny` before the hook; the hook also ignores `deny`.
- Session metadata and the platform: grepped `packages/core/src/kete` (sync, gateway, audit, hooks), `util/src/kete` (registration, telemetry, audit, usage, budget) for session metadata; found no path that sends it. Not exhaustively proven (no run); `kete.dirs` is a local path list and is not added to any request body by this change. Re-check if a session-sync feature is added.

Deviations from the plan:
- Split core module: `kete/add-dir.ts` (rules, no Session import) and `kete/add-dir-plugin.ts` (grant, RPC, command, imports Session and KetePermissionMode). Reason: `session/session.ts` imports the rules and `permission-mode.ts` imports Session (import cycle).
- `expand` copied from `FileAccess.resolvePath` instead of importing it (file-access.ts imports the permission service; same cycle risk).
- Metadata `guard` takes the context as an Effect, evaluated only when `kete.dirs` is present (no filesystem work on other metadata writes).
- `kete/add-dir.ts` has no node fs import, so `job-fs-sites.test.ts` needs no new entry (AC9 classification not needed).
- TUI: `createMetadata` sends the normalized paths; the runtime validates and stores real paths. The startup hook shows refusals; with a refused folder the session create fails (generic toast), after the reasons toast. Resumed sessions get the folders via GET-merge-PATCH once the check passes.
- `sandbox.ts` notice text now says "added folders"; check `sandbox.test.ts` for an exact-text assertion.
- Sandbox: `resolve.ts` drops an extra folder whose realpath differs from itself (swapped symlink).

Not done: sandbox write test in `sandbox-shell.test.ts` (AC6), AC7 "not loaded" test in `memory-files.test.ts` (by code reading, nested CLAUDE.md skips external reads: `memory-files.ts:370` returns when `externalDirectory` is set), `permission-ceiling.test.ts` (a pure ceiling case is in `add-dir.test.ts` instead), module card updates (librarian), `bun run generate` check (no protocol change expected: RPC and metadata only).

First things to run: `cd packages/core && bun run typecheck && bun run test ./test/kete/add-dir.test.ts`; then cli and tui typecheck/tests; `upstream:check`; `bun run lint`.

Risks to look at in review: the `evaluate` order (grant before `KetePermissionMode`); `Session.create` now requires `FSUtil.Service` in that layer (it is already provided: `FSUtil.node` at `session.ts:483`); `SessionSchema.Metadata` type vs `next[metadataKey]` indexing.
