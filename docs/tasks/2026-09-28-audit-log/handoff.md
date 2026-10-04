# Handoff: Audit log for unattended runs (ADR 0008)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-09-28 scout

(Pasted by the coordinator; the scout has no write tool.)

- Q1 seams → docs enough: no — missing: which hooks feed an audit log and where an always-on plugin registers (new audit-log card). Tool calls: `ctx.tool.hook("execute.before"|"execute.after")` (`packages/plugin/src/effect/tool.ts:20-52`) and `SessionEvent.Tool.Called/Success/Failed` (`packages/schema/src/session-event.ts:510-569`). Permission: `permission.evaluate` (`permission.ts:173-189`); a read-only hook last in `post` (after `KeteUnattended.Plugin`, `plugin/internal.ts:315-316`) sees the final decision. Model: `session.hook("model.request")` (`effect/session.ts:63-70,144`), cost/tokens on `SessionEvent.Step.Ended` (`session-event.ts:358-373`). Files: no dedicated event; `edit`/`write`/`patch` tool calls. Shell: `shell.hook("create.before")` (`effect/shell.ts`), `SessionEvent.Shell.Started/Ended` (`session-event.ts:308-329`). Registration needs a marked line in `plugin/internal.ts`.
- Q2 redaction → docs enough: no — missing: no generic redactor exists (audit-log card, pitfalls). Only `cli/src/commands/handlers/debug/redact.ts` `redactConfig()`, `core/src/session/transfer.ts:171-334` (`session export --sanitize`), and login-flow specifics.
- Q3 storage → docs enough: no — missing: where an audit log would live and a bounded append-only pattern (audit-log card). Sessions: SQLite under `Global.Path.data` (`session/sql.ts`, `util/src/global.ts:14-27`). Closest pattern: `util/src/observability/logging.ts` (append, 50 MB → 25 MB trim, mkdir lock). Atomic state writes: `util/src/kete/account.ts:64-81`.
- Q4 platform upload → docs enough: yes. None exists; central audit logs are platform-owned (`architecture.md:185`).
- Q5 readers → docs enough: no — missing: an export precedent (audit-log card). `kete session export [--sanitize]` (`cli/src/commands/commands.ts:424-437`); no `kete job`/`kete audit` yet.

## 2026-09-28 coordinator

- spec.md approved by the user (2026-09-28).

## 2026-09-28 planner

- Done: `plan.md` written (design B: audit hooks installed from `KeteUnattended.Plugin`, no upstream edit).
- Stale card: `permissions` (stale-cards.mjs: `plugin/internal.ts` changed since a6f16f244a — 895f9e239b, comment-only `kete_change start/end` move, `guarded` lines shift by one). Not relied on; librarian must refresh it at close.
- Docs enough: no — missing: hook call order within one plugin and across plugins (`plugin/hooks.ts:68-92`, registration order) — audit-log card.
- Docs enough: no — missing: `Permission.Service` denies on a config rule before any `evaluate` hook (`permission.ts:173-176`), so hooks never see those denies — audit-log/permissions cards.
- Docs enough: no — missing: `tool.execute.*` hook `tool` field is the effective name (`edit`/`write`/`patch`/`shell`), payload shapes (`core/src/tool.ts:103-149`), and the shell/edit/write/patch input/output fields — audit-log card.
- Docs enough: no — missing: `shell.create.before` has no sessionID; `SessionEvent.Shell.*` is the person-run shell, not the `shell` tool — audit-log card.
- Docs enough: no — missing: `Step.Started` carries the model, `Step.Ended` cost/tokens (pair by `assistantMessageID`); `Execution.Succeeded/Failed/Interrupted` payloads (`session-event.ts:242-262`) — audit-log card.
- Docs enough: no — missing: `Permission.Source` gives `messageID`/tool call `id` for a permission line (`schema/src/permission.ts:16-22`) — audit-log card.
- Docs enough: no — missing: `Global.Service` is in the plugin `services` list and `Global.node` is a global node (`util/src/global.ts:83`); `KeyedMutex` exists (`core/src/effect/keyed-mutex.ts`) — audit-log card.
- Docs enough: yes — unattended card: resolve, plugin order, run-checks seam, refusal error shape.
- Decisions for the user: D1 (registration: B no upstream edit, recommended, vs A spec's `internal.ts` line + `guarded`), D2 (config-rule denies only appear as a `tool` error line), D3 (limits as constants, no config key).

## 2026-09-28 coordinator

- plan.md approved by the user (2026-09-28): D1 inside KeteUnattended (no upstream edit); D2 accept (config-rule denies appear only as a failed tool line); D3 constants.

## 2026-09-28 implementer

Built the plan exactly as written (design B, D1/D2/D3 as decided). Zero upstream files touched —
confirmed by `upstream:check`.

**Files created:**
- `packages/util/src/kete/redact.ts` — `KeteRedact.text`/`deep`/`truncate`.
- `packages/util/test/kete/redact.test.ts` — 15 tests (AC3 shapes, redact-before-truncate, UTF-8 boundary).
- `packages/core/src/kete/audit.ts` — line types (`v: 1`), the writer (`filePath`/`create`/`append`,
  redaction+truncation+cap via `KeteRedact`), `make`/`begin` (run-checks seam), the handlers
  (`onEvaluate`, `onToolBefore`, `onToolAfter`, `onEvent`), `install` (registers the hooks from
  inside `KeteUnattended.Plugin`).
- `packages/core/test/kete/audit.test.ts` — 16 tests: `create`'s exclusive-create/probe/0600/0700,
  path-traversal rejection, `begin`'s fail-closed error (AC5), handler line shapes, redaction (AC3),
  the per-run cap and `truncated` line (AC4), array capping.
- `packages/core/test/kete/audit-service.test.ts` — 5 tests over the real `Permission.Service` +
  `Session.Service` (root/child), the audit `evaluate` hook registered last: deny-with-reason,
  allow, a subagent's lines landing in the root's file (AC2), an interactive session writing nothing
  (AC6), and a tool/model/file/command line batch (AC2).

**Files changed:**
- `packages/core/src/kete/unattended.ts` — added pure `stopReason(lookup, sessionID)` (duplicates
  `check`'s three comparisons rather than refactoring `check`, per the plan's fallback); `Plugin`'s
  effect now also builds a `KeteUnattended.Lookup` and calls `KeteAudit.install(ctx, {..., stopReason})`
  right after registering `applyLate`, with a comment that order must be preserved. Header comment
  updated. No `kete_change` marker needed (Kete-owned path).
- `packages/core/src/kete/run-checks.ts` — for an unattended family, computes
  `KeteUnattended.limits(state.policy, kete)` (added `Config.Service`) and calls
  `yield* auditBegin(state, input.sessionID, limits)` before `unattendedCheck`. `nodes` gained
  `KeteAudit.nodes` and `Config.node`.
- `packages/core/src/kete/skill/kete.md` — new "Unattended audit log" bullet after "Unattended runs".
- `docs/upstream-patches.md` — new paragraph in "Unattended runs" documenting the audit log
  addition, D1 (no new upstream edit), and the deliberate type-only import from `audit.ts` to
  `unattended.ts` that avoids a runtime cycle.

**Design decision not fully spelled out in the plan (documented here, not a plan deviation in
effect, just a concretization):** the plan's step 6 says `audit.begin(state, limits)`/step 3 implies
`audit.ts` might resolve `KeteUnattended.limits` and `KeteUnattended.stopReason` itself. Doing that
literally would make `kete/audit.ts` import `kete/unattended.ts` at runtime *and* `unattended.ts`
import `audit.ts` at runtime (for `install`) — a circular ES module dependency. Resolved by: (1)
`run-checks.ts` computes `limits` via `KeteUnattended.limits` (it already imports `KeteUnattended`)
and passes the value into `audit.begin(state, sessionID, limits)` — matching the plan's literal
signature; (2) `audit.ts` takes only a **type-only** (`import type`) reference to `unattended.ts` for
the `Limits` type, and its `Deps`/`InstallLookup` take a `stopReason: (sessionID) => Effect<StopReason>`
callback instead of a `KeteUnattended.Lookup` value; `unattended.ts`'s `Plugin` builds that closure
itself (`(sessionID) => stopReason(auditLookup, sessionID)`) and passes it into `KeteAudit.install`.
Net effect matches the plan's design (D1 B, zero upstream edits); only the plumbing of `Limits`/
`stopReason` is inverted to avoid the cycle. `SessionStore.node`/`Global.node` needed by the writer
and family-cost walk were already available without touching `plugin/internal.ts`: `Global.node` is
already in the plugin `requirements` group there, and subagent listing reuses `Session.Service.list`
(no need for a new `SessionStore.Service` dependency inside the plugin).

**Checks run (all PASS):**
- `packages/util`: `bun run typecheck` — PASS; `bun test ./test/kete` — 70 pass, 0 fail (includes
  the new `redact.test.ts`, 15 pass).
- `packages/core`: `bun run typecheck` — PASS; `bun run test ./test/kete` — 194 pass, 0 fail
  (includes `audit.test.ts` 16 pass, `audit-service.test.ts` 5 pass); regression
  (`unattended.test.ts`, `unattended-service.test.ts`, `unattended-session.test.ts`,
  `budget.test.ts`) — 48 pass, 0 fail.
- Named-filter checks from the plan's verification table all matched and passed:
  `audit.test.ts -t "run"` (7), `-t "redact"` (2), `-t "cap"` (2), `-t "fail"` (3);
  `audit-service.test.ts -t "interactive"` (1).
- Root `bun run lint` — PASS.
- `bun turbo typecheck` — PASS.
- `bun run --cwd packages/kete-tools upstream:check` — PASS (zero upstream edits; the new
  uncommitted-edit check in this command found nothing to flag).
- `bun run --cwd packages/kete-tools verify --base main` — PASS (764.6s; ran in the background
  after exceeding the interactive timeout, waited for it to finish before reporting).

**Open questions / follow-ups for the librarian (per plan "Cards to update after the build"):**
- New `docs/context/modules/audit-log.md` — paths `packages/core/src/kete/audit.ts`,
  `packages/util/src/kete/redact.ts`; should cover: which hooks feed the log and where they
  register (inside `KeteUnattended.Plugin`, after `applyLate`); the writer's redact→truncate→cap
  order and the type-only import from `audit.ts` to `unattended.ts` (cycle avoidance, worth a
  "gotcha" note for anyone tempted to give `audit.ts` a runtime import of `unattended.ts`); the line
  format v1 (additive-only contract) and its `run`/`tool`/`permission`/`model`/`file`/`command`/
  `truncated` shapes; the fail-closed `begin` error and the broken-root behavior; D2 (config-rule
  denies never reach any `evaluate` hook, so they only ever appear as a `tool` line with
  `status: "error"`).
- `unattended.md` — note that `Plugin` also installs the audit hooks last, and that `run-checks.ts`
  now writes `run started` and can refuse the step (`StepFailedError`, `type: "unattended"`) if the
  log can't be written; document `stopReason` alongside `check`.
- `permissions.md` — already flagged stale by the planner (`plugin/internal.ts` comment-only shift,
  895f9e239b); refresh and add the read-only audit `evaluate` hook at the end of the chain.
- `pitfalls.md` — "a generic redactor exists: `KeteRedact` (`util/src/kete/redact.ts`); redact
  before truncating, and redact only the first ~8 KB of a long field before truncating to the final
  bound, so a cut never exposes half a secret" (the writer applies this via
  `KeteRedact.deep`+`truncate` over the whole line, not per-field pre-truncation — worth being
  precise about in the card since the plan's wording of "8 KB scan window" isn't implemented as a
  literal separate step, see below).
- **Note for the librarian on one plan wording vs. implementation:** the plan's Redactor bullet says
  "redact at most the first 8 KB of a long output... then truncate to 2 KB". The implementation
  redacts the *whole* field via `KeteRedact.text`/`deep` (not capped to a first-8KB window) and then
  truncates the *redacted* result to 2 KB (`KeteRedact.truncate`, UTF-8-boundary-safe) — so ordering
  (redact-before-truncate) and the "never split a secret" guarantee both hold, but there's no
  separate 8 KB pre-scan window. This is a behavior simplification, not a security gap (redacting a
  longer string is strictly more thorough than redacting only its first 8 KB), but worth a line in
  the card so a future reader isn't confused by the discrepancy with the plan text.

No plan-wrongness found; the only adjustment was the limits/stopReason plumbing inversion above,
which stays within the plan's design (B) and doesn't change behavior or the file list.

## 2026-09-28 implementer (reviewer-fix pass)

Addressed all four reviewer findings on `feature/audit-log`. Not committed (per instructions).

1. **major — unbounded redaction under the mutex** (`packages/core/src/kete/audit.ts`):
   - Added `PRE_REDACT_WINDOW_BYTES = 16 * 1024`. Replaced `capValue` + the separate
     `KeteRedact.deep(line)` call with one `prepareValue` walker: a string is cut to
     `PRE_REDACT_WINDOW_BYTES` *first*, then redacted (`KeteRedact.text`), then cut again to
     `MAX_FIELD_BYTES` — a secret straddling the window edge always ends up outside the kept field.
     A secret-looking key still replaces its whole value (now via the newly exported
     `KeteRedact.isSecretKey`, reused instead of duplicating the pattern).
   - `append` now calls `serialize(line)` (the CPU-bound redact+cap work) *before* acquiring
     `state.mutex.withLock(root)`; the lock now guards only the shared byte count and the actual
     `stat`/`appendFile`. Re-checks `state.truncated.has(root)` both before (cheap early-out) and
     again inside the lock (authoritative, race-safe).
   - Test: `packages/core/test/kete/audit.test.ts` — "a ~5 MB tool result is bounded and written
     within a small time budget" (`onToolAfter` with a 5 MB `webfetch` result; asserts < 1000 ms and
     the written line's serialized size ≤ `MAX_LINE_BYTES`).
   - `docs/upstream-patches.md`'s audit paragraph gained the per-process cap/mutex + unaudited-gap
     note (finding 4, below) — the redaction-cost fix itself didn't need a doc update beyond that.

2. **major — `redact.ts` missed `pass`-only abbreviations** (`packages/util/src/kete/redact.ts`):
   - `NAME` now has an explicit, anchored `pass` alternative — `(?<![A-Za-z])pass(?![A-Za-z])` —
     alongside the existing unanchored `passw(?:or)?d`: catches `DB_PASS`, `APP_PASS`,
     `MYSQL_PASS`, bare `pass`/`PASS`, while a letter immediately before/after still blocks the
     match, so `passage` and `bypass` are untouched. `passw(?:or)?d` stays unanchored (unchanged),
     since that's specific enough to keep matching inside a compound like `dbPassword`.
   - Exported `KeteRedact.isSecretKey(name)` (wraps the existing `secretName` regex) so `deep()` and
     `audit.ts`'s bounded `prepareValue` share one implementation instead of two copies of the
     pattern.
   - Tests added to `packages/util/test/kete/redact.test.ts`: `text()` and `isSecretKey()` cases for
     `DB_PASS=…`, `APP_PASS=…`, `MYSQL_PASS=…`, `"db_pass": "…"`, plus negative cases (`passage`,
     `bypass` in prose, and as bare object keys via `deep`).

3. **minor — no test for a mid-run append failure** (`packages/core/test/kete/audit.test.ts`):
   - New `it.effect` test (uses the `TestConsole`-backed harness from `../lib/effect` to capture
     logger output): after `beginFile` creates the root's file, replaces it with a directory of the
     same name (`rm` then `mkdir` on the same path) so `appendFile` fails with `EISDIR` — root-proof
     (unlike a permission bit, which root bypasses; same reasoning as the existing
     directory-blocks-`mkdir` fail-closed test). Calls `onEvaluate`, then asserts
     `deps.writer.broken.has(rootID)`, `interrupted` contains `rootID`, and a log line containing
     "failed to write an audit line" was emitted.
   - Learned along the way: the default Effect logger writes through `console.log`, not
     `console.error`, unless `LogToStderr` is set — so the assertion reads `TestConsole.logLines`,
     not `.errorLines` (confirmed with a throwaway debug test, since deleted, before writing the
     real one).

4. **minor — doc gap on per-process scope and the unaudited-call window** (`docs/upstream-patches.md`,
   the "Audit log" paragraph under "Unattended runs"): added a sentence noting the per-run cap and
   the per-root mutex live in one process's in-memory `WriterState` (no cross-process coordination;
   not expected today, one server per workspace) and that a tool call already in flight when a write
   fails can complete — and go unaudited — before `sessions.interrupt(root)` takes effect.

**Files changed in this pass:**
- `packages/util/src/kete/redact.ts` — anchored `pass` alternative; exported `isSecretKey`.
- `packages/util/test/kete/redact.test.ts` — new `text`/`deep`/`isSecretKey` cases (6 new tests).
- `packages/core/src/kete/audit.ts` — bounded `prepareValue` (redact-then-cap replacing the old
  `capValue`+`deep` pair); `append` serializes outside the mutex.
- `packages/core/test/kete/audit.test.ts` — 2 new tests (bounded large-result timing/size; mid-run
  append-failure marks broken/logs/interrupts).
- `docs/upstream-patches.md` — cap/mutex-is-per-process + unaudited-gap note.

No upstream files touched (unchanged from the original pass).

**Checks re-run (all PASS):**
- `packages/util`: `bun run typecheck` — PASS; `bun test ./test/kete` — 75 pass, 0 fail.
- `packages/core`: `bun run typecheck` — PASS; `bun run test ./test/kete` — 196 pass, 0 fail
  (includes the 2 new audit.test.ts cases).
- Root `bun run lint` (oxlint) — PASS.
- `bun run --cwd packages/kete-tools upstream:check` — PASS (still zero upstream edits).
- `bun run --cwd packages/kete-tools verify --base main` — PASS (758.2s; ran in the background
  after exceeding the interactive timeout twice, waited for completion both times before reporting).
