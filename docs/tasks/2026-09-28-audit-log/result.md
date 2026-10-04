# Result: Audit log for unattended runs (ADR 0008)

## What changed
- `packages/util/src/kete/redact.ts` (new): `KeteRedact` — API keys, bearer tokens, private-key blocks, secret-named `NAME=value` / `name: value` / JSON fields (incl. `DB_PASS`-style names), credentials in URLs; `isSecretKey`, `deep`, `truncate`.
- `packages/core/src/kete/audit.ts` (new): `KeteAudit` — one JSONL file per unattended run at `<data dir>/audit/<root session id>.jsonl` (dir 0700, file 0600, root id validated against traversal). Lines (`v: 1`): `run` started/ended, `tool`, `permission` (final decision, after every hook), `model` (tokens, cost), `file`, `command`, `truncated`. Each string is cut to a 16 KB window, redacted, then capped at 2 KB; lines at 16 KB; runs at 20 MB (then only `permission`/`run` lines). Appends are serialized per root; redaction happens outside the lock.
- `packages/core/src/kete/unattended.ts`: `Plugin` installs the audit hooks after its late `evaluate` hook (D1: no new plugin, can't be removed by repository config); `stopReason`.
- `packages/core/src/kete/run-checks.ts`: `KeteAudit.begin` before the unattended check; a run whose file can't be written is refused. A failed write mid-run marks the run broken, logs, and interrupts the root.
- `packages/core/src/kete/skill/kete.md`, `docs/upstream-patches.md`: where the log is, and its limits.
- Tests: `util/test/kete/redact.test.ts`, `core/test/kete/audit.test.ts`, `core/test/kete/audit-service.test.ts`.
- No upstream file touched.

## Checks
| Check | Result |
|---|---|
| util, core typecheck; `bun turbo typecheck` | PASS |
| util `bun test ./test/kete` | PASS (75) |
| core `bun run test ./test/kete` | PASS (196) |
| `bun run lint` | PASS |
| `upstream:check` (now includes uncommitted edits) | PASS |
| `kete-tools verify --base main` | PASS (758 s) |

Reviewer: changes needed (2 major: unbounded redaction of multi-MB tool output under the lock; `DB_PASS`-style names not redacted; 2 minor: no mid-run write-failure test; per-process cap and unaudited window undocumented) → all fixed → approve.

## Acceptance criteria
- [x] AC1 — `audit.test.ts -t run`: started and ended lines with the reason.
- [x] AC2 — `audit.test.ts`, `audit-service.test.ts`: tool, unattended deny with reason, allow, model step, edit, command; subagent lines in the root's file.
- [x] AC3 — `redact.test.ts`, `audit.test.ts -t redact`: API key, bearer token, private key, `PASSWORD=…`/`DB_PASS=…`, URL credentials; truncation.
- [x] AC4 — `-t cap`: detail stops, one `truncated` line, permission/run lines continue.
- [x] AC5 — `-t fail`: refused when the file can't be created; stopped when a write fails mid-run.
- [x] AC6 — `-t interactive`: no file.
- [x] AC7 — the checks table.

## Known limitations
- Config-rule denies happen before any hook, so they appear only as a failed `tool` line (D2).
- Cap and lock are per process (one `kete serve`); a tool call in flight when a write fails can finish unaudited.
- Redaction is pattern matching; `pass: 42` / `PASS=1` count lines are over-redacted.
- No upload to the platform and no reading command yet.

## Cards updated
New `audit-log` card (and INDEX); permissions (refreshed), unattended, roles-skills; pitfalls (a generic redactor exists — redact before truncating; the `pass` over-redaction trade-off). All 7 "Docs enough: no" gaps folded into audit-log and permissions.

## Metrics
- Agents used: scout, planner, implementer (×2), reviewer (×2), librarian
- Scout lookups: 5, docs enough: 1 (20%); planner added 7 "no" gaps
- Tokens / cost (from /usage): ~1.3M subagent tokens
- Time: ~2 h 45 min
