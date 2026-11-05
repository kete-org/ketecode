# Handoff: WS1 Work enforcement

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 planner
Done: `plan.md` written. All six cards current (`stale-cards.mjs`). One upstream edit (`plugin/internal.ts`, register + guard).

Decisions:
- Mode is resolved from the root-most session (child created without metadata gets none from `guardCreate`), missing ancestor = Work (fail closed).
- Network off via a per-request mark on the shell permission metadata (`kete.sandbox.work`, same mechanism as `markApproved`), not a new sandbox dep, so `tool/plugin/shell.ts` needs no edit.
- Work denies `sandbox_off`, so a machine with the sandbox off or unavailable refuses every Work shell command.
- Audit refusal write failure logs and keeps the refusal; no interrupt (spec).
- Residual: interpreters can write anywhere the sandbox allows (project dir incl. siblings + `kete.dirs`); deferred to WS2.

Docs enough: no — missing: how to create a Work session in a test while the profile is unavailable (no seam in `Session.create`; plan uses `mock.module`).
Docs enough: no — missing: which file tools' permission resources are paths (`read`/`edit` yes; `glob`/`grep` resources are patterns, path only via `external_directory`/metadata); a sibling folder of the project is "internal" to `FileAccess.resolve` (`file-access.ts:96-108`).
Docs enough: no — missing: exact tool names (`worktree_create/list/remove`, `todowrite`, `present_plan`, `memory`, `workflow`, `artifact_*`, `schedule*`, `models`, `list_mcp_resources`/`read_mcp_resource`); the permissions card says `worktree`.
Docs enough: no — missing: per-invocation seam in `KeteSandbox.prepare` (the approval metadata via `approvals`/`remember`) as the way to vary a single command's network; card points only to `deps.folders`.
Docs enough: no — missing: audit writer for a non-unattended root: `appendToFile` doesn't create the `audit/` dir and `create` only writes a first line.
Docs enough: no — missing: `KeteShellRisk.tokenize` result shape (`segments[].words[].value/expands/glob`, `redirects`), types not exported.

Open questions: none blocking. If `mock.module` can't make Work available for the service test, the implementer records it here instead of adding a production override.

## 2026-11-05 implementer
**NO CHECKS WERE RUN: this agent had no shell (Read/Edit/Write/Grep only).** Nothing is typechecked or tested. First action for whoever continues: `bun run typecheck` and `bun run test ./test/kete/work-mode.test.ts ./test/kete/work-mode-service.test.ts ./test/kete/sandbox.test.ts ./test/kete/audit.test.ts ./test/kete/modes.test.ts` in `packages/core`, then the plan's AC6 list.

Done (plan steps 1-8):
- `kete/sandbox/actions.ts`: `workKey`, `markWork`, `work`.
- `kete/sandbox.ts`: exported `networkFor` + `workRefusal`; `prepare` uses it; Work + `request: "off"` is refused before `unsandboxed("requested")`.
- `kete/audit.ts`: `WorkRefusalLine` (in `Line`), `appendWork` (mkdir 0700 for file storage, then `append(..., "always")`).
- `kete/modes/work.jsonc`: `python3`; comment updated (still `available: false`). `kete/modes.ts` header comment updated.
- `kete/work-mode.ts` (new): plugin `kete.work-mode`, `allowedTools`, `filterTools`, `shellGate`, `escapingPattern`, `resolveFamily` (root walk, bounded cache, fail closed and uncached on a missing/too-deep chain), `onEvaluate`, `onToolBefore`.
- `plugin/internal.ts` (upstream, `kete_change`): import, `pre` entry after `KetePermissionMode.Plugin`, id in `guarded`. `docs/upstream-patches.md`: new section appended with Edit.
- Tests: new `work-mode.test.ts`, `work-mode-service.test.ts`; added cases to `sandbox.test.ts`, `audit.test.ts`.

Decisions / deviations:
- Service test inserts session rows (root with `kete.sessionMode: work`, child with `parent_id` and no metadata) like `permission-mode-service.test.ts` instead of `mock.module` + `Session.create`: no override of the unavailable profile, no production seam. It exercises the real `Permission.Service` and `SessionStore`, not `Session.Service`.
- A `/*` resource keeps its text (`/*` is not stripped to ""), so the file-system root never resolves to the location.
- A shell call with `sandbox` set (any value) is refused at `tool.execute.before` (rule `network`); `prepare` also refuses it.
- `profile.mcp` is not read: MCP tools are never allowlisted (fail closed).
- `profile.shell.run === "any"` returns no shell gate (Work profile is `allowlist`).

Open questions / risks:
- The Work mark is set in the `shell` evaluate hook, which runs only when the shell tool asks permission (`parsed.commands.length > 0`). The shell gate rejects any command without a program, so this should always hold, but `ShellParse` was not checked against every gated command. If it returns no commands for an allowed one, the mark is missing and `settings.network: "all"` would give network. Worth a test against `ShellParse.scan` for the allowed commands.
- Tool name `subagent` and the permission resource shapes for `read`/`edit` were taken from the plan, not re-verified (no shell to run the tools).
- `Session.Info.parentID` for a root is assumed `undefined` (not `null`), as `KeteAddDir.dirs` assumes.
- Residual risk text (interpreters write anywhere the sandbox allows; separate audit writer state) is in the `work-mode.ts` header.
- Cards to update are in the plan (librarian).
