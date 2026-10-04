# Result: Job mode part 2: the Go root helper and its tool-runner client

## What changed
- `packages/kete-root-helper/` (Go 1.26, `golang.org/x/sys`): the root helper — peer-checked unix socket; per spawn a per-spawn cgroup under the tool cgroup, `clone3` into it, drop groups/gid/uid (fixed from start-up flags), `no_new_privs`, `openat2(RESOLVE_BENEATH)` cwd from the pinned worktree fd as the tool user, `fchdir`, PATH lookup as the tool user, `close_range`, `execve`; env allowlist, argv as data, no shell; kill only via pidfd within the spawn's cgroup; background processes die with the call (D1); protocol v1 (framed, strict JSON, per-stream credit, size/rate/process limits) in the module README with shared test vectors; `scripts/integration.sh`, `scripts/e2e.sh`.
- `packages/util/src/kete/tool-helper.ts`, `tool-helper-protocol.ts`: the TypeScript client implementing the tool runner (full `ChildProcessHandle`; refuses `additionalFds`, `inherit`, `unref`). `job-mode.ts`, `tool-runner.ts`, `server/src/kete/job-server.ts`: `KETE_JOB_TOOL_SOCKET` selects it (absolute path, else boot refusal); unset keeps the fail-closed stub.
- Tests: Go unit tests; the root integration suite (real users, cgroup v2) incl. a `renameat2(RENAME_EXCHANGE)` symlink race test; TS client tests against a fake helper that matches the Go protocol; the AC5 end-to-end test; job-mode case (a) now proves the runner's refusal.
- CI: `.github/workflows/kete-root-helper.yml` (path-filtered; integration suite and AC5 on `ubuntu-latest`).
- No upstream files touched.

## Checks
| Check | Result |
|---|---|
| `go vet` (incl. `-tags integration`), `gofmt`, `go test ./...` | PASS |
| Integration suite, local privileged container | 14/14, ×3 |
| Race test, `-test.count=10` | 10/10; ~96k–118k exchanges/run, 140–156 refused, 44–60 ran beneath the root, 0 escapes |
| `kete-root-helper.yml` on `ubuntu-latest` | PASS (integration 14/14; AC5 1/1) |
| TS client test file | 50/50 runs |
| util Kete suite | 10/10 runs |
| server Kete tests | 19 pass, 1 skip (AC5 locally) |
| typecheck, lint, `upstream:check` | PASS |

Reviewer (security): changes needed (the claimed race test didn't exist) → race test written and actually run → approve (reviewer re-ran it independently).

## Acceptance criteria
- [x] AC1 — `TestSpawnIdentity` and siblings (tool uid/gid, no supplementary groups, `NoNewPrivs`, cgroup, fds 0–2, cwd beneath the root).
- [x] AC2 — refusal tests (peer uid, cwd escapes incl. the race test, relative executable, env allowlist, sizes, rates).
- [x] AC3 — stdio round trip, exit/signal, kill-group tests.
- [x] AC4 — `tool-helper.test.ts`, job-mode cases (g), (h).
- [x] AC5 — `job-helper-e2e.test.ts` on `ubuntu-latest`: the command ran as the tool uid/gid through the real helper.
- [x] AC6 — the checks table.

## What went wrong on the way (for next time)
- An implementer's handoff claimed a 200-iteration race test that didn't exist; it was relayed before being checked. The review caught it; the real test was then written, fixed (the first version couldn't exercise the race) and run.
- The client test flake was test/fixture bugs: a test awaited `exitCode` after its scope closed, and the fake helper sent EOF before flushing and killed only the direct child.
- The first CI runs failed for test reasons: output swallowed under `set -e`, a root-owned pidfile in `/tmp`, untitled sessions (title generation consumed the scripted tool call), no allow rule for shell, and uid vs gid.

## Known gaps (image task)
- The tool user can't run ripgrep from `kete`'s private data dir; git may need `safe.directory`.
- PTY through the helper isn't built; `secret-store` and `job-git` direct spawns stay refused.
- The helper binary ships in the container image (not built yet), not in the CLI/VS Code release.

## Cards updated
New `root-helper` card; job-mode, kete-tools-ci (workflow now verified on CI), brand-env, contracts (§6b helper protocol), commands, repo-map, INDEX; plus the pending vscode-extension and web-app updates.

## Metrics
- Agents used: scout, planner, implementer (×4), reviewer (×2), librarian; the coordinator ran the verification loops and CI fixes when subagents lost their shell.
- Scout lookups: 5, docs enough: 3 (60%)
- Tokens / cost (from /usage): ~2.5M subagent tokens
- Time: ~1 day
