# Result: WS1 Work enforcement

## What changed
- `packages/core/src/kete/work-mode.ts` (new): the `kete.work-mode` plugin. For a Work family (root's `kete.sessionMode`; a missing session counts as Work):
  - tool allowlist at `tool.execute.before`, refused tools removed from each request;
  - file roots (location + live `kete.dirs`, real paths) on `read`/`edit`/`external_directory` and on glob/grep/shell paths and patterns;
  - `shellGate`: allowlisted programs only, no wrappers, substitutions or redirects, nothing on Windows;
  - a `shell` permission request is allowed only for a shell tool call that passed the gate (so a worktree setup script or command template can't run);
  - the `worktree` action and a subagent `worktree` field are refused, and the subagent's `worktree` is pinned to `false` (covers `kete.subagents.worktree: "background"`);
  - sandbox escapes (`sandbox_off`, `sandbox_network`) denied; every refusal audited.
- `kete/sandbox.ts`: `networkFor` (Work: no network, network requests refused); a Work command is refused outside the sandbox, on any mechanism other than seatbelt, and in job mode; Work commands get `policy.noLinks`.
- `kete/sandbox/policy.ts`, `seatbelt.ts`: `noLinks` → `(deny file-write-create (vnode-type SYMLINK))`, `(deny file-link)`.
- `kete/sandbox/actions.ts`: the Work mark. `kete/audit.ts`: additive `work_refusal` line and `appendWork`.
- `modes/work.jsonc`: `python3` added; still `available: false`.
- Upstream, marked: `core/src/plugin/internal.ts` (registration, `guarded`). Recorded in `docs/upstream-patches.md`.
- Tests: `work-mode.test.ts`, `work-mode-service.test.ts` (real permission service), `sandbox.test.ts` (network decision, noLinks profile, a real `sandbox-exec` run on macOS), `audit.test.ts`.

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| core `bun run typecheck` | clean (after typing a test helper) |
| core `bun run test ./test/kete` | 1813 pass / 12 skip / 0 fail |
| server `bun run test ./test/kete` | 49 pass |
| `bun run lint`, `upstream:check` | exit 0; pass |
| `verify --base main` | see PR |
| Review | reviewer: approve (minors: duplicate refusal text, job-mode note, verify) |
| Security review | 1st pass: high (symlink race between the file tools' check and their I/O), medium (worktree subagent and setup script bypass), low (job mode skipped Work) → fixed as above. 2nd pass: medium/low closed; high **narrowed, not closed** (see below) |

Fixed after the implementer: the service test's expected audit count (3 refusals × 2 sessions = 6).

## Known residual (blocks making Work available)
The file tools check a path's real path and then open the path, so a sandboxed Work command that **renames a
directory already holding a symlink** into a checked location can win the race (link creation itself is now
blocked on macOS). The root fix is verifying the opened descriptor (fstat dev/ino against the re-resolved
real path; writes open without truncation, verify, then truncate) in the shared read and write paths, which
also protects Code mode. Follow-up **1.3b** before Work becomes available; Work stays `available: false`.
Also open (hardening, no known trigger): `prepare` learns a session is Work only from the permission mark, so a
command `ShellScan` and the tokenizer disagree on could run unmarked.

## Acceptance criteria
- [x] AC1 files: outside read/write, symlink out, `..`, sibling folder refused; location and `kete.dirs` allowed.
- [x] AC2 shell: python/node pass; curl, git, gh, `sh -c`, `env`, pipes to other programs, `$(…)` refused; Windows refuses all; Linux (bwrap) refuses Work commands.
- [x] AC3 tools: MCP, worktree, unknown refused and removed; web allowed.
- [x] AC4 network: Work gets no network with a global `all`; network requests refused.
- [x] AC5 audit lines per refusal, redacted; Code sessions unaffected.
- [x] AC6 checks above.

## Cards updated
See the librarian's close-out (permissions, sandbox, audit-log and the cards the plan lists).

## Metrics
- Agents used: scout, librarian ×3, planner, implementer (no shell), reviewer, security-reviewer ×2
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-05)
