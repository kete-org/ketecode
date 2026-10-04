# Result: `kete job run` — local unattended jobs (ADR 0005, 0008)

## What changed
- `packages/cli/src/kete/job-spec.ts` (new): job spec v1 parser — strict fields; `prompt` or `prompt_file` (must resolve, through symlinks, inside the spec's directory; ≤ 256 KiB; read at the checked real path); `agent`, `model`; `policy` (`allow`, required `budget` and `timeout`); `branch`.
- `packages/cli/src/kete/job-git.ts` (new): the job's worktree and branch via `git worktree add -b` (no shell, timeouts, ref-name validation), at `<data dir>/worktree/<project>/job-<id>`; cleanup only before the prompt is sent.
- `packages/cli/src/kete/job-run.ts`, `job.ts` (new), `commands.ts`: `kete job run <spec.json> [--json]` with `kete run`'s server flags. Refuses a server on another machine (non-loopback host or a directory mismatch). Creates the root session with `kete.unattended` and an explicit title, streams, rejects any permission request, reads the outcome from the audit log's `run ended` line (or the execution event), prints the final text, a summary (outcome, branch, worktree, cost, duration, denials, audit path) or one JSON object. Exit codes: 0 completed, 1 error, 2 refused, 3 time limit, 4 budget, 130 interrupted.
- `packages/schema/src/kete/unattended.ts` (new): the `kete.unattended` policy schema and shared stop messages (moved from core so the CLI can validate without core).
- `packages/core/src/kete/unattended.ts`, `unattended-policy.ts`, `audit.ts`: in unattended runs, edits to `.kete/`, `kete.json(c)` at any level and the global config dir are denied (allow and ask alike), and shell commands naming them best-effort.
- Upstream: `packages/cli/src/index.ts` — one `kete_change start/end` block registering `job run` (recorded in `docs/upstream-patches.md`).
- Docs: `docs/jobs.md` (new), `skill/kete.md`.
- Tests: `cli/test/kete/job-spec.test.ts`, `job-run.test.ts`; `server/test/kete/job-run.test.ts` (end to end, real server, fake model, real git repo); core unattended/audit tests.

## Checks
| Check | Result |
|---|---|
| schema, core, cli, server typecheck; `bun turbo typecheck` | PASS |
| core `bun run test ./test/kete` | PASS (205) |
| cli `bun test ./test/kete` | PASS (112) |
| server `bun run test ./test/kete` | PASS (12, incl. 6 end to end) |
| `bun run lint` | PASS |
| protocol/client `check:generated` | clean (no endpoint change) |
| `upstream:check` | PASS |
| `kete-tools verify --base main` | PASS (757 s) |

Reviews: upstream-guard — approve. Reviewer — changes needed twice (major: `prompt_file` path traversal; major: check-then-read race on `prompt_file`; minor: uncaught bad `model`) → fixed → approve.

## Acceptance criteria
- [x] AC1 — `job-spec.test.ts`, `job-run.test.ts`: invalid specs exit 2 with the field named, nothing started.
- [x] AC2 — server `job-run.test.ts -t "creates a worktree"`: worktree on a new branch; root session carries the policy.
- [x] AC3 — `-t completes`: exit 0, final text, summary; `--json`.
- [x] AC4 — `-t "limit|budget|denied"`: outcomes and exit codes.
- [x] AC5 — `-t "checkout untouched"`.
- [x] AC6 — core unattended tests: `.kete/` edit denied despite allow rules; interactive unaffected.
- [x] AC7 — the checks table.

## Known limitations
- Local only: a server on another machine is refused (D1).
- A subagent's `permission.asked` isn't recognised as the runtime-bug case (the server denies it regardless).
- The config deny for shell commands is best-effort; symlinks into config paths are a known gap.
- A plugin-configured worktree directory is ignored by jobs.
- `prompt_file`: an in-place overwrite between stat and read is only caught by the size re-check.

## Cards updated
cli (full `kete job run` coverage), unattended (config-edit deny, shared schema module), audit-log (job run as the first reader), permissions, worktrees-parallel, server-sdk, roles-skills, account-login. All 9 "Docs enough: no" gaps folded in. contracts.md unchanged (job spec is a CLI ↔ cloud-worker contract, owned by `docs/jobs.md` and the cli card).

## Metrics
- Agents used: scout, planner (×2), implementer (×2), reviewer (×3), upstream-guard, librarian
- Scout lookups: 6, docs enough: 2 (33%); planner added 7 more gaps
- Tokens / cost (from /usage): ~2.1M subagent tokens
- Time: ~3 h 30 min
