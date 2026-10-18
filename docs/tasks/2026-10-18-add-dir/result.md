# Result: Extra working directories (A13)

## What changed
- `core/src/kete/add-dir.ts`: what may be added (`validate`), the metadata guard, `dirs`, `live` (re-validated folders), `withoutDirs`, `rules`.
- `core/src/kete/add-dir-plugin.ts`: the `external_directory` grant, `/add-dir`, the `kete.add-dir` RPC.
- `core/src/kete/sandbox.ts`, `sandbox/resolve.ts`: added folders writable; their `.git` and Kete config read-only.
- `core/src/kete/permission-ceiling.ts`: subagents get the root's live folders.
- `core/src/kete/session-move.ts`: the agent's `session_move` request is marked so the grant leaves it asking.
- Upstream (marked, in docs/upstream-patches.md): `session.ts`, `session/session.ts`, `session/transfer.ts`, `plugin/internal.ts`, `tool/plugin/shell.ts`, CLI `commands.ts`, `handlers/default.ts`, `handlers/run.ts`, `run/run.ts`, TUI `args.tsx`, `prompt/index.tsx`, `app.tsx`.
- `schema/src/kete/add-dir.ts`, `cli/src/kete/add-dir.ts`, `tui/src/kete/add-dir.tsx`; tests in core, cli, tui.
- Docs: `docs/permissions.md`, `docs/sandbox.md`, `.github/README.md`, `CHANGELOG.md`.

## Checks
| Check | Result |
|---|---|
| core `bun run typecheck` | pass |
| core `bun run test ./test/kete` | 1579 pass, 0 fail |
| cli / tui / util `bun test ./test/kete` | 413 / 112 / 426 pass, 0 fail |
| root `bun run lint` | 0 warnings, 0 errors |
| `upstream:check` | pass |
| `verify --base main` | see PR |

## Acceptance criteria
- [x] AC1 — `add-dir.test.ts` "grants an ask for a directory inside an added folder"; CLI flag in `cli/test/kete/add-dir.test.ts`.
- [x] AC2 — `tui/test/kete/add-dir.test.tsx`; command in add-dir-plugin.ts.
- [x] AC3 — `add-dir.test.ts` "refuses with a reason for each case" (also credentials list, ~/Library, PATH, wildcards).
- [x] AC4 — `add-dir.test.ts` symlinked-folder and swapped-folder tests.
- [x] AC5 — `add-dir.test.ts` explicit ask / deny tests; ceiling test.
- [x] AC6 — `sandbox-policy.test.ts`, `sandbox-shell.test.ts` (write in an added folder; `.git` read-only).
- [x] AC7 — `memory-files.test.ts` AC7 test.
- [x] AC8 — `add-dir.test.ts` job mode; CLI refusal.
- [x] AC9 — checks above.

Deviation: no end-to-end subagent test through a real child session; covered by `dirs`/ceiling unit tests.

## Review
Security review (two rounds) and re-review of the fixes: no medium or high findings left. Fixed after
review: imported sessions drop `kete.dirs`; the sandbox and the subagent ceiling re-validate folders
(`live`); the agent's session move still asks; refused list matches the sandbox's credentials, plus
PATH folders and wildcard paths; removing at the root reaches subagents.
Known, accepted: forking a subagent's session copies the folders it had (each still re-validated);
formatters run outside the sandbox (as before A13).

## Cards updated
See the librarian's update in this PR.
