> **Approved 2026-10-18** by the main session under the user's no-stop instruction (handoff.md), with one change: **the grant turns `ask` into `allow` only when that `ask` came from the default rules**, not from an explicit user, project or org rule on `external_directory` (the more restrictive setting wins, CLAUDE.md §5). Tell the two apart the way `kete/permission-mode.ts` does (`Permission.evaluate` against the agent's and session's rules; a rule the person or org wrote is explicit), and add a test: an explicit `external_directory: ask` for the added folder still asks. Also confirm (and record in handoff.md) whether session metadata is ever sent to the platform; `kete.dirs` must not be.

# Plan: Extra working directories (A13)

> **Large task — needs the user's approval of this plan before building.** It edits upstream files
> (listed under "Upstream edits"), adds contracts (`--add-dir`, `/add-dir`, session metadata
> `kete.dirs`, plugin RPC `kete.add-dir`) and is a security change (it widens the workspace
> boundary). A security review runs before merge (spec, Risks).

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

## Cards read
- docs/context/modules/permissions.md (verified-at 3c3e792370, stale: no)
- docs/context/modules/sandbox.md (verified-at a6f140247e, stale: no)
- docs/context/modules/cli.md (verified-at 52ddc2f9ef, stale: no)
- docs/context/modules/instructions.md (stale: no)
- docs/context/pitfalls.md ("Permissions and sessions"), docs/context/commands.md

## Design in one paragraph
One Kete module, `core/src/kete/add-dir.ts` (`KeteAddDir`), owns the rules: `validate` (one path →
real path or a refusal reason), `guard` (called directly from the session service on create and on
metadata update, because session hooks can't refuse — pitfalls), `dirs` (the **root-most** session's
`kete.dirs`, like `KetePermissionMode.resolveMode`), and a `Plugin` (`kete.add-dir`, guarded) that
(1) on the permission `evaluate` hook turns `ask` into `allow` for `external_directory` when **every**
resource's real path is inside an added folder, (2) serves the `kete.add-dir` RPC `check` so clients
get clear reasons before they write metadata, (3) adds the `/add-dir` built-in command (server-side,
so the TUI and every other client that lists commands get it; output via `ctx.session.synthetic`).
The plugin sits right after `KeteUnattended.PolicyPlugin` in `pre`, before `KetePermissionMode`
(a loosening hook must run before the tightening ones — pitfalls). A `deny` never reaches the hook
(config/agent deny wins, `permission.ts:174-178`); org policy (`kete/sync/plugin.ts`) and
`ConfigPolicyPlugin` run later and can tighten again; Plan/Ask modes don't touch `external_directory`
but still deny/ask the `edit` that follows. The subagent ceiling gets the same folders as allowances
(like its `Lookup.policy`), or a subagent would be asked again. The sandbox adds the folders to its
writable roots; its masks are computed after and still apply.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/core/src/kete/add-dir.ts` | **new** | `metadataKey = "kete.dirs"`, `MAX = 10`, `validate`, `guard`, `dirs`, `granted`, `rules`, `Plugin` (steps 1-4) |
| `packages/schema/src/kete/add-dir.ts` | **new** | `KeteAddDirRpc.Definition` (`check`), result schema; pattern: `schema/src/kete/sandbox.ts` |
| `packages/schema/src/kete/sandbox.ts` | read | RPC definition pattern to copy |
| `packages/schema/package.json` | read / change if needed | export path for `./kete/add-dir` if `kete/*` isn't already a wildcard export |
| `packages/core/src/kete/sandbox.ts` | read + change | `Deps.session` lookup; pass the session's folders to `resolve`; `notice` text mentions added folders; plugin RPC registration pattern (`:296-330`) |
| `packages/core/src/kete/sandbox/resolve.ts` | change | `Input.extraWrite?: readonly string[]`, real-pathed and joined into `writable` (`:401`) before `denyWrite`/kete/credential masks |
| `packages/core/src/kete/permission-mode.ts` | read | `resolveMode` (`:255`) root-walk to copy; `realTarget` (`:378`) to reuse for request real paths; `Lookup.protectedRoots` |
| `packages/core/src/kete/permission-ceiling.ts` | change | Plugin's `Lookup.policy` (`:100-125`): append `KeteAddDir.rules(...)` for the session's folders |
| `packages/core/src/kete/memory-imports.ts` | change | export `SECRET_HOME_DIRS` (`:79`) so the credential-folder list has one source |
| `packages/core/src/kete/auto-memory.ts` | read | `ctx.command.transform` + `Effect.fail(new Error(...))` refusal pattern (`:339-360`) |
| `packages/core/src/plugin/plan.ts` | read | `ctx.session.synthetic({ sessionID, text, resume: false })` (`:69`) |
| `packages/core/src/kete/unattended-policy.ts` | read | `guardMetadata` (`:175-187`) shape to copy |
| `packages/core/src/file-access.ts` | read | `resolvePath` (`~`, Windows paths) to reuse; external resource shape `<dir>/*`, forward slashes (`:113-127`) |
| `packages/core/src/util/wildcard.ts` | read | `*` matches `/`; case-insensitive on Windows (ceiling rules) |
| `packages/util/src/fs-util.ts` | read | `FSUtil.contains` (`:271`), `resolve` = realpath (`:102`) |
| `packages/core/src/session/session.ts` | **upstream**, change | `setMetadata` (`:76-83`): `const metadata = yield* KeteAddDir.guard(...)`, publish `metadata` (marked) |
| `packages/core/src/session.ts` | **upstream**, change | `create` (`:251-276`): guard `input.metadata` before publish; feed it into the existing marked `inheritMetadata` line |
| `packages/core/src/plugin/internal.ts` | **upstream**, change | import; register `KeteAddDir.Plugin` after `KeteUnattended.PolicyPlugin` (`:294`); add its id to `guarded` (`:362-370`) — all marked |
| `packages/core/src/tool/plugin/shell.ts` | **upstream**, change | inside the existing marked block (`:121-135`): pass `session` lookup to `KeteSandbox.make` |
| `packages/core/test/kete/add-dir.test.ts` | **new** | AC1, AC3, AC4, AC5 (through the real `Permission.Service`, like `permission-mode-service.test.ts`), AC8 core side |
| `packages/core/test/kete/permission-mode-service.test.ts` | read | harness to copy for real-service permission tests |
| `packages/core/test/kete/permission-ceiling.test.ts` | change | a subagent of a session with an added folder isn't asked again; deny still wins |
| `packages/core/test/kete/sandbox-shell.test.ts` | change | AC6: write inside an added folder succeeds, write beside it fails (real sandbox) |
| `packages/core/test/kete/memory-files.test.ts` | read + change | AC7: an added folder's CLAUDE.md is not loaded after a read there |
| `packages/core/test/kete/job-fs-sites.test.ts` | change | classify `kete/add-dir.ts` (AC9) |
| `packages/cli/src/kete/add-dir.ts` | **new** | `--add-dir` client side: normalize (`~`, relative to cwd → absolute), refuse in job mode, call RPC `check`, GET-merge-PATCH + read back (pattern: `cli/src/kete/permission-mode.ts` `apply`) |
| `packages/cli/src/kete/permission-mode.ts` | read | `apply` pattern |
| `packages/cli/src/commands/commands.ts` | **upstream**, change | `addDir: Flag.string("add-dir").pipe(Flag.withDescription(...), Flag.atLeast(0))` in `PermissionParams` (`:29-55`), marked (pattern `:544-547`) |
| `packages/cli/src/commands/handlers/default.ts` | **upstream**, change | job-mode refusal; pass `addDirs` into TUI `args` (`:86-92`), marked |
| `packages/cli/src/commands/handlers/run.ts` | **upstream**, change | pass `addDirs` to `run` (`:40-43`), marked |
| `packages/cli/src/run/run.ts` | **upstream**, change | in the marked block at `:132-144`: apply folders before the first prompt; refusal → `reportRunError` |
| `packages/cli/test/kete/add-dir.test.ts` | **new** | normalization, job-mode refusal, refusal reasons, GET-merge-PATCH keeps other keys |
| `packages/tui/src/kete/add-dir.tsx` | **new** | `useKeteAddDir()`: on start, if `args.addDirs`, RPC `check` once (refusals → toast with reasons); `createMetadata()`; apply to a resumed session (`--continue`/`--session`), as `permission-mode.tsx:94-101` does |
| `packages/tui/src/kete/permission-mode.tsx` | read | pattern (args, `createMetadata`, resumed apply, toast) |
| `packages/tui/src/kete/sandbox-status.tsx` | read | `client.rpc.call` + decode pattern (`:14-25`) |
| `packages/tui/src/context/args.tsx` | **upstream**, change | `addDirs?: string[]` (marked) |
| `packages/tui/src/component/prompt/index.tsx` | **upstream**, change | existing marked line `:1256`: merge `keteMode.createMetadata()` and the add-dir metadata |
| `packages/tui/src/app.tsx` | **upstream**, change | one marked line next to `:499` calling the add-dir startup hook |
| `packages/tui/test/kete/add-dir.test.tsx` | **new** | `createMetadata` merge; refusal toast; resumed apply |
| `docs/permissions.md`, `docs/sandbox.md`, `.github/README.md`, `CHANGELOG.md`, `docs/upstream-patches.md` | change | user docs; new section "Extra working directories (feature/add-dir)" listing every upstream edit |

## Upstream edits (and why no seam works)
1. `core/src/session/session.ts` `setMetadata` — refusing a metadata write must be a plain guard
   called from the service; session hooks can't fail (pitfalls; `KeteUnattendedPolicy.guardMetadata`
   precedent on the same lines).
2. `core/src/session.ts` `create` — same reason; `session.create` metadata bypasses `setMetadata`.
3. `core/src/plugin/internal.ts` — the only place built-in plugins are registered and guarded.
4. `core/src/tool/plugin/shell.ts` — extends the existing marked sandbox block by one property; the
   sandbox has no other way to learn the session.
5. `cli/src/commands/commands.ts`, `handlers/default.ts`, `handlers/run.ts`, `run/run.ts` — upstream's
   flag spec and handlers; same pattern and blocks as `--permission-mode`.
6. `tui/src/context/args.tsx`, `component/prompt/index.tsx`, `app.tsx` — the TUI's args, the
   new-session `metadata` (atomic, in force before the first tool call) and the hook call site;
   same lines `--permission-mode` already uses.
No protocol or config-schema change: session metadata is free-form and the RPC uses the existing
`POST /api/rpc/:rpcID/:method` (as `kete.sandbox` does). Confirm `bun run generate` in
`packages/protocol` leaves `openapi.json` unchanged.

## Steps
1. **`KeteAddDir.validate(fs, input, ctx)`** in `core/src/kete/add-dir.ts`. `ctx = { base, home,
   workspace: string[] (location dir + project dir), kete: string[] (Global config, data, state,
   cache — real paths), existing: string[] }`. Expand with `FileAccess.resolvePath(base, input, home)`;
   `fs.existsSafe` → else "doesn't exist"; real path via `fs.resolve`; must be a directory; refuse,
   each with its own reason: a file-system root (`path.dirname(real) === real`); home or above
   (`FSUtil.contains(real, home)`); overlap either way with a credential folder (`SECRET_HOME_DIRS`
   under home) or a Kete folder (so `~/.config` is refused because it holds `~/.config/gh` and
   `~/.config/kete`); inside the workspace (`FSUtil.contains(workspaceRoot, real)` for each); more
   than `MAX = 10` after dedupe. Already present → accepted, unchanged. Returns
   `{ ok: true, real } | { ok: false, reason }`. Job mode (`KeteJobMode.enabled()`): always refused.
2. **`KeteAddDir.guard(fs, ctx, before, next)`** → the metadata to store. Reads `next[metadataKey]`;
   absent → `next`. Must be an array of strings (else die). Entries equal to ones in `before` pass;
   each new entry goes through `validate` with `existing` = the earlier accepted entries; any refusal
   → `Effect.die(new RefusedError(reason))` (as `LockedError`); stores real paths. Wire it:
   `session/session.ts` `setMetadata` (before = `session.metadata`, ctx from `session.location` and
   `Project.root(fs, dir)` like `file-access.ts:125`) and `session.ts` `create` (before =
   `parent?.metadata`), both marked one-liners. Global paths: `Global.Path`.
3. **Grant on `evaluate`** (`KeteAddDir.granted`, pure over a lookup, unit-testable): skip unless
   `event.action === "external_directory"` and `event.effect === "ask"`. Folders = `dirs(lookup,
   sessionID)` (root-most session, parent chain capped at 32 like `resolveMode`; none → return). Each
   folder is re-checked now: `fs.resolve(folder) === folder` and still passes the root/home/credential/
   Kete checks (a folder swapped for a symlink since it was added grants nothing). For each resource:
   it must end in `/*` and be absolute; strip `/*`; real path via `KetePermissionMode.realTarget(fs,
   base, dir)`; `undefined`/`UNRESOLVED` → not granted; granted iff `FSUtil.contains(folder, real)` for
   some folder. All resources granted → `event.effect = "allow"`. Never touch `deny`, never other actions.
4. **Plugin** `kete.add-dir`: the evaluate hook (step 3); `ctx.rpc.register(KeteAddDirRpc.Definition,
   { check: ({ paths }) => … })` returning per path `{ path, real } | { path, reason }` against this
   location (no session needed; `existing` = earlier paths in the same call); `/add-dir` via
   `ctx.command.transform`: text `""` → list the session's folders; `remove <path>` → drop the matching
   entry (match by `validate`'s real path or the raw stored string); else add. Add/remove go through
   `Session.Service.setMetadata` with GET-merge (other keys kept), so the guard runs; refusal →
   `Effect.fail(new Error(reason))` (as `/remember`). Success → `ctx.session.synthetic({ sessionID,
   text: "Folders this session can work in: …", resume: false })`. Register after
   `KeteUnattended.PolicyPlugin` in `pre` and add to `guarded` (`internal.ts`, marked).
5. **Ceiling**: in `permission-ceiling.ts` Plugin, `policy: (id) =>` existing rules plus
   `KeteAddDir.rules(lookup, id)` = for each folder `{action: "external_directory", resource:
   slash(folder) and slash(folder) + "/*", effect: "allow"}`. Lexical-only matching here is safe: the
   ceiling only tightens, the real-path check already ran in step 3.
6. **Sandbox**: `resolve.ts` `Input.extraWrite`; `real()` each and join into `writable` at `:401`
   (masks follow). `sandbox.ts` `Deps.session` (optional, `(id) => Effect<Option<Info>>`); `prepare`
   reads `KeteAddDir.dirs` for `sessionID` and passes them; `notice` text says "the workspace, added
   folders, temp …". `shell.ts`: add `session: (id) => sessions.get(id).pipe(Effect.option)` inside
   the existing marked block.
7. **CLI**: `cli/src/kete/add-dir.ts` — `normalize(cwd, home, values)` (absolute; keeps `~`
   expansion consistent with `FileAccess.resolvePath`), `refuseInJob(env)` (exit 2, "--add-dir isn't
   available in a job: jobs have one workspace"), `check(client, paths)` (RPC, 15 s timeout like
   `kete sandbox`), `apply(sessions, id, reals)` (GET-merge-PATCH, read back, fail if not stored). Flag
   in `PermissionParams`; `run.ts`: check then apply in the marked block before the first prompt,
   refusal → `reportRunError` with every reason. `default.ts`: job-mode refusal, pass normalized
   `addDirs` in TUI args.
8. **TUI**: `tui/src/kete/add-dir.tsx` `useKeteAddDir()` — RPC `check` once at start when
   `args.addDirs`; accepted real paths kept in a signal, refusals shown in one error toast;
   `createMetadata()` → `{ "kete.dirs": accepted }` or undefined; resumed session: GET-merge-PATCH once
   (union with stored). Prompt line `:1256` merges both metadata objects. `/add-dir` needs no TUI code
   (server command).
9. **Not loaded from an added folder (AC7)**: no code expected — config, plugins, agents, commands
   and skills are discovered from the location only, and nested `AGENTS.md` skips external reads
   (`instructions` card). Write the test first (read a file in an added folder that has `.kete/`,
   `AGENTS.md`, `CLAUDE.md`, `.kete/skills/x/SKILL.md`; assert none of their marker text is in the
   session's instructions, skills or commands). If nested `CLAUDE.md` (`memory-files.ts:361-393`) does
   load it, add an "inside the location root" check there (Kete file) and record it.
10. **Tests** (narrowest first, see Verification). Security cases: `..` traversal
    (`../lib/../../secret` resolves outside), symlink in an added folder to `~/.ssh` (and to a sibling
    folder), folder replaced by a symlink after adding, Windows-style path through `FSUtil.contains`
    with `\\` separators (string-level, cheap), metadata written straight through the SDK update with
    an invalid entry (refused, nothing stored), a child session inheriting.
11. **Docs**: `docs/permissions.md` "Extra working directories" (what it grants, what still applies,
    deny wins, session only); `docs/sandbox.md` (added folders writable; masks; when the sandbox is
    unavailable the cwd check is the only control); README + CHANGELOG; `docs/upstream-patches.md`
    section listing the upstream edits above.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `cd packages/core && bun run test ./test/kete/add-dir.test.ts -t "grants"` |
| AC2 | `cd packages/core && bun run test ./test/kete/add-dir.test.ts -t "command"`; `cd packages/tui && bun test ./test/kete/add-dir.test.tsx`; `cd packages/cli && bun test ./test/kete/add-dir.test.ts` |
| AC3 | `cd packages/core && bun run test ./test/kete/add-dir.test.ts -t "refuses"` |
| AC4 | `cd packages/core && bun run test ./test/kete/add-dir.test.ts -t "symlink\|traversal"` |
| AC5 | `cd packages/core && bun run test ./test/kete/add-dir.test.ts -t "deny\|plan"` then `bun run test ./test/kete/permission-ceiling.test.ts` |
| AC6 | `cd packages/core && KETE_SANDBOX_TESTS=required bun run test ./test/kete/sandbox-shell.test.ts` (macOS here; Linux in CI) and `bun run test ./test/kete/sandbox.test.ts` |
| AC7 | `cd packages/core && bun run test ./test/kete/add-dir.test.ts -t "not loaded"` and `bun run test ./test/kete/memory-files.test.ts` |
| AC8 | `cd packages/cli && bun test ./test/kete/add-dir.test.ts -t "job"`; `cd packages/core && bun run test ./test/kete/add-dir.test.ts -t "job"` |
| AC9 | `cd packages/core && bun run test ./test/kete/job-fs-sites.test.ts`; then `bun run typecheck` and `bun run test ./test/kete` in core; `bun run typecheck` + `bun test ./test/kete` in cli and tui; `bun run test ./test/kete/permission-mode-service.test.ts ./test/permission` (affected upstream tests) in core; `bun run lint` (root); `bun run --cwd packages/kete-tools upstream:check`; `bun run generate` in `packages/protocol` shows no diff; `bun run --cwd packages/kete-tools verify --base main` |

## Cards to update after the build
- `permissions`: `kete.add-dir` in the `evaluate` order (after `KeteUnattended.PolicyPlugin`, the only
  other loosening hook), what it grants, ceiling allowance; plus the scout's gap (FileAccess.resolve,
  `external_directory` resources `<dir>/*`, which tools call it, saved approvals are project-scoped).
- `sandbox`: `Input.extraWrite`, `Deps.session`; how writable roots are decided (`resolve.ts:397-401`).
- `cli`: `--add-dir` on `kete` and `kete run`, `cli/src/kete/add-dir.ts`, job-mode refusal.
- `instructions`: added folders load nothing (AC7 test).
- `job-mode`: `kete.dirs` refused in job mode.
- `pitfalls`: a server-side defect reaches clients as a generic error, so a refusal that needs a clear
  reason needs a client pre-check (RPC) as well as the guard.
