# Result: Job mode, part 1: a process seam and job-mode config and model requests

## What changed
- `packages/util/src/kete/job-mode.ts`: `KETE_JOB_MODE` (strict; an invalid value is treated as on and the server refuses to start), `KETE_JOB_MAX_OUTPUT_TOKENS` (required in job mode), `refuseSpawn`.
- `packages/util/src/kete/tool-runner.ts`: the tool-runner interface and the fail-closed `unavailable` stub (the Go root helper replaces it later).
- `packages/server/src/kete/job-server.ts`: job-mode replacements appended last in `routes.ts`'s `build` — the spawner, PTY, config (no project config, no disk plugins), and the model request executor.
- `packages/core/src/kete/job-request.ts` + `job-request/{anthropic-messages,openai-responses,openai-chat,gemini}.ts`: model requests checked before sending (function tools only, no provider-side tools, inline content only, one candidate, output-token limit, Responses `store: false`); only the `kete` provider.
- `packages/core/src/kete/job-plugin.ts`: every MCP server disabled, non-`kete` models removed.
- `packages/core/src/kete/run-checks.ts`: job mode implies an unattended session. `sync/plugin.ts`: registration off.
- `packages/cli/src/kete/job-connection.ts`, `job.ts`: `kete job run` in job mode uses a standalone server and refuses `--server`. `job-git.ts`, `util/src/kete/secret-store.ts`: `refuseSpawn` guards.
- `packages/core/test/kete/job-spawn-sites.test.ts`: static AC1 check over core/server/cli/util.
- Upstream (marked, `docs/upstream-patches.md`): `server/src/routes.ts`, `core/src/plugin/internal.ts`; `server/package.json` + `bun.lock` (`@opencode/ai` direct dependency).
- Docs: kete-code `docs/jobs.md`, `skill/kete.md`.

## Checks
| Check | Result |
|---|---|
| core job-mode tests (spawn sites, request, plugin, unattended, policy sync) | PASS |
| util Kete tests | PASS (87) |
| cli Kete tests | PASS (118) |
| server tests (incl. job-mode e2e) | PASS (76) |
| `bun turbo typecheck`, `bun run lint`, `upstream:check` | PASS |
| `verify --base main` | PASS (no new failures) |
| Real-binary smoke test | job mode: shell and PTY refused, nothing spawned, registration off; control: spawns |

Reviews: reviewer — approve (traced the real `kete serve` graph); upstream-guard — approve (one doc note fixed).

## Acceptance criteria
- [x] AC1 — `job-spawn-sites.test.ts`.
- [x] AC2 — existing suites unchanged; `verify --base main`.
- [x] AC3 — server job-mode e2e and the real-binary smoke test.
- [x] AC4 — server job-mode e2e (`config.get`).
- [x] AC5 — `job-request.test.ts`, `job-request-service.test.ts`.
- [x] AC6 — `policy-sync.test.ts`, smoke-test log.
- [x] AC7 — the checks table.

## Known limitations / follow-ups
- The stub refuses every spawn: a real job can't run end to end until the Go root helper lands (D6).
- A refused shell call reaches the HTTP client as a bare 500 with an empty body; give it a typed error.
- The runtime checks the gateway's job rules (ADR 0020 rules 8, 16, 17), not its full strict per-route schemas (rule 18); the gateway still enforces those.
- Job mode is off unless the entrypoint sets `KETE_JOB_MODE=1` — the image must always set it.
- `routes.ts` replacements must stay last; an upstream reorder would drop them (the e2e test catches it).

## Metrics
- Agents used: planner, implementer, reviewer, upstream-guard, librarian
- Scout lookups: 0 (planner did the lookups), docs enough: planner logged 7 gaps
- Tokens / cost (from /usage): ~0.9M subagent tokens
- Time: ~4 h
