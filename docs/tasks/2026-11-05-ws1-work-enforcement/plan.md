# Plan: WS1 Work enforcement

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Large, security-critical (spec approved 2026-11-05).** One upstream edit: `core/src/plugin/internal.ts`
(register + guard the new plugin; there is no other way to add an internal plugin). Everything else is
Kete-owned. No config schema, protocol, client or server change; audit line format v1 gets one additive
line type. Budget ~600 changed lines: keep tests table-driven.

## Cards read
- docs/context/modules/permissions.md (verified-at 08f5855d87, stale: no)
- docs/context/modules/sandbox.md (verified-at ce02e0bcc9, stale: no)
- docs/context/modules/audit-log.md (verified-at ce02e0bcc9, stale: no)
- docs/context/modules/add-dir.md (verified-at 063cfce610, stale: no)
- docs/context/modules/config-kete.md (stale: no)
- docs/context/modules/roles-skills.md (stale: no; nothing needed from it: the Work agent is 1.4)
- docs/context/pitfalls.md, decisions.md, commands.md

## Design (one plugin, three seams, no new engine)
`core/src/kete/work-mode.ts`, plugin id `kete.work-mode`. Per call it resolves the **root-most** session's
`KeteSessionMode.mode(metadata)` (walk `parentID`, max depth 32; a missing session or a too-deep chain =
treat as Work, i.e. fail closed), cached per session id in a bounded map (cleared at 1000, like
`KeteAudit.makeResolveCache`; safe because the mode is locked). Code → every hook returns immediately.
Root walk, not the child's own metadata: `guardCreate` returns `undefined` for a child created without
metadata, so the root is the reliable answer. Profile = `KeteModes.get("work")`; its fields drive the rules.

| Rule | Seam | What it does |
|---|---|---|
| Tools | `tool.execute.before` + `session` `context`/`compaction`/`generate` hooks (as `review-mode.ts:208-226`) | Allowlist: `read glob grep edit write patch todowrite skill subagent question present_plan`, `shell` unless `profile.shell.run === "off"`, `webfetch websearch` iff `profile.web`. Everything else (MCP `<server>_<tool>`, `worktree_create/list/remove`, `session_move`, `memory`, `workflow`, `artifact_*`, `schedule*`, `models`, `list_mcp_resources`/`read_mcp_resource`, future plugin tools) is refused with `Tool.Error` and deleted from `event.tools`. |
| Files | `permission` `evaluate` for actions `read`, `edit`, `external_directory` | Every resource → absolute (`path.resolve(location.directory, r)`; strip a trailing `/*` for `external_directory`) → `KeteRealPath.follow` → must pass `KeteRealPath.inside(fs, real, roots)`; `undefined`/`UNRESOLVED`/outside → `effect = "deny"` with a Work message. Covers read (incl. its sibling-name recovery), edit/write/patch (all assert `edit`) and every `external_directory` (denied, never asked). |
| Files (tools whose permission resource is a pattern) | `tool.execute.before` for `glob`, `grep`, `shell` | Same check on `input.path` (default `.`) for glob/grep and `input.workdir` (default `.`) for shell; also refuse a glob/grep `pattern`/`include` that is absolute or has a `..` segment. |
| Shell | `tool.execute.before` for `shell` (pure `shellGate(command, profile, platform)`) | `platform === "win32"` and `profile.shell.windows === "off"` → refuse. Else `KeteShellRisk.tokenize` with `{posix:true}` and `{posix:false}`: both must be `ok` (it fails closed on `$(`, backticks, subshells, heredocs, unbalanced quotes), ≥1 segment, and in every segment the first word is not expanded/glob/brace, contains no `=` (env prefix) and no path separator, is in `profile.shell.allow`, and is not `git`/`gh` when `!profile.git`; no redirect to a file (only fd duplications like `2>&1`). `cd`, `sh`, `env`, `sudo`, `xargs`, `eval`, `curl` all fail the allowlist, so no wrapper table is needed. |
| Network | `evaluate` + `kete/sandbox.ts` `prepare` | On `shell`: `KeteSandboxActions.markWork(event.metadata)` (same copy/original `mark` as `markApproved`). On `sandbox_off`/`sandbox_network`: deny (so Work also refuses to run unsandboxed: sandbox off or unavailable ⇒ shell refused, fail closed). In `prepare`, `work = KeteSandboxActions.work(approvals.get(invocation))` ⇒ network `false` whatever `kete.sandbox.network` says; `request` `"network"`/`"off"` ⇒ `RefusedError`. |
| Audit | every refusal above | `KeteAudit.appendWork(state, root, line)`; on `WriteError` → `Effect.logError(...)`, the refusal stands (no interrupt, per spec). |

Hook order: register in `pre` right after `KetePermissionMode.Plugin` (after both loosening hooks, so
`kete.dirs` grants are in place). It only ever sets `deny` (return early when already `deny`), which no later
hook loosens. Add its id to `guarded`.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/core/src/kete/work-mode.ts` | create (~220 lines) | The plugin: `Deps` (mode/root lookup, roots, fs, platform, audit writer), pure `shellGate`, `allowedTools(profile)`, `filterTools`, handlers `onEvaluate`, `onToolBefore`, `Plugin`. Header comment states the rules and the residual risk below. |
| `packages/core/src/kete/review-mode.ts` | read | Template: tool gate, `filterTools`, the three session hooks, `Tool.Error`. |
| `packages/core/src/kete/add-dir-plugin.ts` | read | `evaluate` hook shape, `FSUtil`/`Lookup` wiring. |
| `packages/core/src/kete/add-dir.ts` | read | `live(fs, context(fs, dir), {session}, id)` and `context` (as used at `tool/plugin/shell.ts:140`). |
| `packages/core/src/kete/real-path.ts` | read | `follow`, `inside`, `UNRESOLVED`. |
| `packages/core/src/kete/session-mode.ts` | read | `mode(metadata)`. |
| `packages/core/src/kete/modes.ts` | read | `get("work")`. |
| `packages/core/src/kete/modes/work.jsonc` | change (1 line) | `shell.allow`: add `"python3"` (spec). Keep `available: false` (comment: until 1.4 adds the agent). |
| `packages/core/src/kete/shell-risk.ts` | read (`tokenize` `:92`, types `:48-72`) | Tokenizer. `Segment`/`Word` aren't exported: use `Extract<ReturnType<typeof KeteShellRisk.tokenize>, { ok: true }>["segments"]`. Don't edit it. |
| `packages/core/src/kete/sandbox/actions.ts` | change (~12 lines) | `workKey = "kete.sandbox.work"`, `markWork(metadata)` (via the existing `mark`), `work(metadata)`; a line in the header comment. |
| `packages/core/src/kete/sandbox.ts` | change (~15 lines) | Extract the network decision in `prepare` (`:195-204`) into an exported pure `networkFor(settingsNetwork, approved, work, request)` returning `boolean \| "ask" \| "refuse-config" \| "refuse-work"` so AC4 is unit-testable without a real sandbox; read `work` from `approvals.get(invocation)`; `request === "off"` with `work` → `RefusedError` before `unsandboxed("requested")`. Generic message: "Work mode: commands run only inside the sandbox, without network." |
| `packages/core/src/kete/audit.ts` | change (~30 lines) | `WorkRefusalLine = LineBase & { type: "work_refusal"; rule: "tool" \| "files" \| "shell" \| "network"; tool: string; input?: string; message: string }`, added to `Line`; export `appendWork(state, root, line)`: `filePath` → `mkdir(dirname, { recursive: true, mode: 0o700 })` (`appendToFile` doesn't create the dir; `create` only writes a first line) → `append(state, root, line, "always")`. `input` via the existing `safeJson`; `serialize` already redacts and caps every field. Readers (`cli/src/kete/job-run.ts:286-312`) ignore unknown types. |
| `packages/core/src/plugin/internal.ts` | **upstream edit** (~4 lines, `kete_change`) | Import `KeteWorkMode`; add `KeteWorkMode.Plugin` to `pre` after `KetePermissionMode.Plugin` (`:327`) with a `// kete_change:` comment on its own line; add its id inside the existing marked `guarded` block (`:411-421`). No other seam adds an internal plugin. `FSUtil.Service`, `Session.Service`, `Global.Service` are already plugin services. |
| `packages/plugin/src/effect/permission.ts`, `packages/plugin/src/effect/session.ts:15-40` | read | `PermissionEvaluation`; `SessionContext` (has `sessionID`, `tools`). |
| `packages/core/src/tool.ts:120-140` | read | `execute.before` event: `tool`, `sessionID`, `messageID`, `id`, `input`. |
| `packages/core/src/file-access.ts:80-125` | read | Resources are location-relative inside and absolute outside; a sibling folder of the project counts as internal, so the Work rule must check every `read`/`edit` resource, not only `external_directory`. |
| `packages/core/test/kete/work-mode.test.ts` | create (~250 lines) | Handler-level, real temp dirs (location, a granted folder via a fake `kete.dirs`, a sibling in the same project, outside, a symlink inside → outside, a `../` path), fake session lookup, real `appendWork` into a temp data dir. AC1, AC2 (table, incl. `platform: "win32"`), AC3, AC4 (evaluate side: denies `sandbox_network`/`sandbox_off`, marks shell metadata), AC5 (audit lines have `rule`/`tool`, a secret in input is redacted; every case re-run as a Code session passes unchanged). |
| `packages/core/test/kete/work-mode-service.test.ts` | create (~80 lines) | "Real Work session": real `Session.Service` + `Permission.Service` as in `permission-mode-service.test.ts`; make Work available with `mock.module` on the modes module (precedent `test/plugin/provider-gitlab.test.ts:74`) before the session layer is imported; create a Work session and a child without metadata; a read outside is denied for both, a `kete.dirs` read is allowed, the audit line lands in the root's file. If `mock.module` can't reach `session.ts`'s import, stop and record it in `handoff.md`; don't add a production override. |
| `packages/core/test/kete/permission-mode-service.test.ts` | read | Service-test layer setup to copy. |
| `packages/core/test/kete/review-mode.test.ts`, `packages/core/test/plugin/host.ts` | read | Plugin host for hook tests. |
| `packages/core/test/kete/sandbox.test.ts` | change (~25 lines) | AC4: `networkFor("all", false, true, undefined) === false`; `networkFor(_, _, true, "network") === "refuse-work"`; Code cases keep today's results; `markWork` on a copy reaches the original (`linked`). |
| `packages/core/test/kete/audit.test.ts` | change (~20 lines) | `appendWork` creates `audit/` (0700, skip mode checks on win32) and the file (0600), redacts a secret in `input`. |
| `packages/core/test/kete/modes.test.ts`, `packages/schema/test/kete/modes.test.ts` | read | Confirm the `python3` addition breaks no assertion. |
| `docs/upstream-patches.md` | change | New section "Work enforcement (WS1 1.3)" after "Session mode (WS1 1.2)": the `internal.ts` entry and why; no other upstream file changed. |

## Steps
1. `sandbox/actions.ts`: `workKey`, `markWork`, `work`.
2. `sandbox.ts`: `networkFor` and its use in `prepare` with `work`.
3. `audit.ts`: `WorkRefusalLine`, add to `Line`, `appendWork`.
4. `work.jsonc`: add `python3`.
5. `work-mode.ts`: family/mode resolver with bounded cache; `allowedTools(profile)`; `shellGate`; `fileAllowed(deps, sessionID, absolute)` (roots = `[ctx.location.directory, ...KeteAddDir.live(...)]`); `onEvaluate` (files, sandbox-action deny, shell mark), `onToolBefore` (tool gate → glob/grep/shell path → shell gate), session hooks with `filterTools`. Each refusal: audit, then deny / `Tool.Error`. User-facing messages say "Work mode", never "OpenCode", and carry no paths beyond the one requested.
6. `internal.ts`: register + guard, with markers.
7. Tests: work-mode, work-mode-service, sandbox, audit. Narrow runs first, then suites.
8. `docs/upstream-patches.md` section.

## Verification
| Criterion | Command (narrowest first; inside the package unless stated) |
|---|---|
| AC1 files | core: `bun run test ./test/kete/work-mode.test.ts -t files`; `bun run test ./test/kete/work-mode-service.test.ts` |
| AC2 shell | core: `bun run test ./test/kete/work-mode.test.ts -t shell` |
| AC3 tools | core: `bun run test ./test/kete/work-mode.test.ts -t tools` |
| AC4 network | core: `bun run test ./test/kete/sandbox.test.ts`; `bun run test ./test/kete/work-mode.test.ts -t network` |
| AC5 audit + Code unaffected | core: `bun run test ./test/kete/work-mode.test.ts -t audit`; `bun run test ./test/kete/audit.test.ts`; `bun run test ./test/kete/modes.test.ts`; schema: `bun test ./test/kete/modes.test.ts` |
| AC6 | core: `bun run typecheck`, `bun run test ./test/kete`; server: `bun run test ./test/kete`; root: `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main` |

Then `security-reviewer` on the diff (spec), plus the reviewer.

## Residual risk (state in the work-mode.ts header and result.md)
- An allowed interpreter (`python -c`, `node -e`, a script) can read any file the OS sandbox lets it read
  and write anywhere the sandbox makes writable: the **project** directory (sibling folders included) plus
  `kete.dirs`, not only the location. Network is off. Narrowing the sandbox's workspace to the location for
  Work sessions is left to WS2's grant store.
- Work refusal lines share the root's audit file with an unattended run's writer but use a separate writer
  state (separate per-root mutex; `always` lines are uncapped; append-only `appendFile`).

## Cards to update after the build
- `permissions`: the Work plugin in the `evaluate` hook order (after `KetePermissionMode`, guarded); correct
  the tool-name answer (`worktree_create/list/remove`, `todowrite`, `present_plan`, `memory`, `workflow`);
  "Are mode profile permissions enforced?" → yes.
- `sandbox`: the per-request Work mark (`kete.sandbox.work`), `networkFor`, Work refuses escapes and an
  off/unavailable sandbox; replace "Can the sandbox network be forced off per session? Not today".
- `audit-log`: the `work_refusal` line type, `appendWork`, written for interactive Work sessions; replace
  "Can the audit log be written for a non-unattended session? Not as built".
- `config-kete`: profile fields now enforced; `python3` in the Work allowlist; still `available: false`.
- `add-dir`: a Work session's file roots are the location plus live `kete.dirs`.
