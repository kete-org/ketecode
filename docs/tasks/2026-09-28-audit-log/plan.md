# Plan: Audit log for unattended runs (ADR 0008)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large task — security-relevant (secret redaction, fail-closed enforcement, a new local file of
> sensitive data) and a new on-disk format that later readers depend on (`v: 1`, additive only).
> The user approves this plan before building.**
>
> **Upstream edits: none (recommended design, D1).** The audit hooks are installed from inside
> Kete's existing `KeteUnattended.Plugin` (`packages/core/src/kete/unattended.ts`, Kete-owned),
> so `packages/core/src/plugin/internal.ts` is not edited. This deviates from the spec's
> "a marked line in `plugin/internal.ts`" — see D1; if the user picks option A instead, the two
> upstream edits are listed there.

## Decisions for the user

- **D1 — where the audit hooks register (upstream-first).**
  - **A (spec as written):** new plugin `KeteAudit.Plugin` (`id: "kete.audit"`), registered in
    `plugin/internal.ts` `post` after `KeteUnattended.Plugin` (one `// kete_change` line), and its
    id added to `guarded` (inside the existing `kete_change start/end` block) so repository config
    can't remove it. Two upstream-file edits; the `unattended` card's "KeteUnattended.Plugin stays
    last in `post`" rule becomes "last *deciding* hook; only the read-only audit hook after it".
  - **B (recommended, CLAUDE.md §4 rank 3 over rank 5):** `KeteUnattended.Plugin`'s effect calls
    `KeteAudit.install(ctx, …)` right after it registers `applyLate`. Hooks run in registration
    order (`packages/core/src/plugin/hooks.ts:68-92`), so the audit `evaluate` hook still sees the
    final decision; audit inherits `kete.unattended`'s `guarded` status for free. Zero upstream
    edits. Cost: audit rides on the `kete.unattended` plugin id (it is part of the same ADR).
  - The plan below is written for **B**; for A, step 5 moves into a `define({ id: "kete.audit" })`
    in `audit.ts` plus the two `internal.ts` edits and a `docs/upstream-patches.md` entry per edit.
- **D2 — config-rule denies.** `Permission.Service` returns `deny` for a configured deny rule
  *before* any `evaluate` hook runs (`packages/core/src/permission.ts:173-176`), so no hook (and no
  `permission` line) sees it. Recommended: accept; such a call still produces a `tool` line with
  `status: "error"` and the (redacted) denial message; document it in the card. Alternative: a
  marked upstream edit in `permission.ts` (not planned).
- **D3 — limits are constants, not config** (no config-schema change): 20 MB per run, 2 KB per
  string field, 16 KB per line, 20 array items. Recommended: constants now; a `kete.audit` key only
  when a user asks.

## Cards read
- docs/context/modules/unattended.md (verified-at a6f16f244a, stale: no)
- docs/context/modules/permissions.md — **stale** (only `plugin/internal.ts`: 895f9e239b moved the
  `guarded` marker into a `kete_change start/end` block, comment-only, lines shift by one). Not
  relied on: the plan takes hook order from the unattended card and the code. Logged in handoff for
  the librarian.
- docs/context/INDEX.md, pitfalls.md, commands.md, decisions.md (0008), conventions.md (plugins).

## Design (B)

- **Module `packages/core/src/kete/audit.ts`** (`export * as KeteAudit`). One file per run:
  `<Global.Service.data>/audit/<root session id>.jsonl`; directory mode 0700, file 0600 (best-effort
  on Windows). The root id must match `^[A-Za-z0-9_-]+$` or the write fails (fail closed, no path
  traversal).
- **Line format v1** (every line: `v: 1`, `ts` ISO-8601, `type`, `session_id`, `root_id`, plus
  `message_id`/`tool_call_id` when known):
  - `run` — `event: "started"` with `policy` (the decoded policy; `invalid` flag if it failed to
    decode), `limits` `{ budget_usd?, timeout_minutes? , missing[] }`; `event: "ended"` with
    `reason: "completed" | "time_limit" | "budget" | "refused" | "audit_failed" | "interrupted" | "error"`
    and a redacted `message`.
  - `tool` — `tool`, `agent`, `input` (redacted JSON text, ≤ 2 KB, `input_truncated` when cut),
    `status` (`completed`/`error`), `output_bytes`, `excerpt` (redacted, ≤ 2 KB), `error` (redacted).
  - `permission` — `action`, `resources` (redacted, ≤ 20 items), `effect` (`allow`/`deny`),
    `message` on deny; ids from `event.source` (`packages/schema/src/permission.ts:16-22`).
  - `model` — `provider`, `model`, `tokens`, `cost_usd`, `finish`; `status: "failed"` + error type
    on `Step.Failed`.
  - `file` — `path` (workspace-relative resource when available), `operation`
    (`edit` | `write` | `add` | `update` | `delete`), `tool_call_id`.
  - `command` — `command` (redacted, ≤ 2 KB), `cwd`, `exit` (absent for background), `background`,
    `timeout`, `duration_ms`.
  - `truncated` — written once when the next detail line would pass 20 MB.
- **Who writes what, and when:**
  - `KeteRunChecks` (before every step of an unattended family): `audit.begin(state, limits)` creates
    the root's file with the exclusive-create flag (`wx`, 0600) and writes the `run started` line —
    exactly once per run regardless of which process/session gets there first; if the file already
    exists it opens it for append and closes it (a writability probe). Any failure → the step is
    refused with `StepFailedError({ type: "unattended", message: "Unattended run stopped: its audit
    log can't be written (<path>: <code>)." })`. This is the clear, user-visible fail-closed error.
  - The audit hooks (installed by `KeteUnattended.Plugin`) write every other line through one
    per-root `KeyedMutex` (`core/src/effect/keyed-mutex.ts`), tracking bytes per root (initialised
    from `stat`) for the cap. All state (resolve cache, mutex, byte counts, step-model map, shell
    start times, broken roots) lives in the plugin's scope — no module-level state.
  - Hooks: `permission.evaluate` (after `applyLate`), `tool.execute.before` (fail a call in a
    broken run with `Tool.Error`; record shell start time), `tool.execute.after` (`tool`, plus
    `file` for `edit`/`write`/`patch` and `command` for `shell`), and one ordered
    `bus.subscribe([Step.Started, Step.Ended, Step.Failed, Execution.Succeeded, Execution.Failed,
    Execution.Interrupted])` stream (`model` lines; `run ended` for the root only).
  - `run ended` reason: `Succeeded` → `completed`; `Failed`/`Interrupted` → recompute with the new
    pure `KeteUnattended.stopReason(lookup, sessionID)` (deadline passed → `time_limit`, family cost
    ≥ budget → `budget`, missing limit → `refused`), else `audit_failed` if the root is marked broken,
    else `interrupted`/`error`. No parsing of error messages.
  - **Interactive sessions:** every handler first resolves the family via
    `KeteUnattendedPolicy.resolve`, cached per session id (safe: `kete.unattended` can't change after
    creation — `guardMetadata`); interactive → return before any I/O. Cache bounded (clear at 1000).
  - **Write failure inside a hook** (hooks can't fail except `execute.before`): mark the root broken,
    `Effect.logError` with `session_id`/root/path/error code, and `sessions.interrupt(root)` (the
    subagent stop cascade stops the family, `subagents` card). The next step's `begin` refuses if the
    file is still unwritable; a new tool call in a broken run fails with `Tool.Error`.
- **Redactor `packages/util/src/kete/redact.ts`** (`export * as KeteRedact`; pure, no deps):
  `text(s)` masks API-key shapes (`sk-…`, `sk-ant-…`, `ghp_/gho_/github_pat_…`, `xox[abp]-…`,
  `AKIA…`, `AIza…`, JWT-looking `eyJ…​.…​.…`), `Bearer <token>` / `Authorization:` values,
  PEM private-key blocks (to the END line, or to end of string if the END line is missing),
  `NAME=value` / `NAME: value` / `"name": "value"` where NAME matches
  `/(secret|token|passw(or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)/i`,
  and `scheme://user:pass@` in URLs (keep scheme/host). `deep(value)` walks JSON values: redacts
  every string and replaces the whole value under a secret-looking key. `truncate(s, bytes)` cuts
  on a UTF-8 boundary. **Order: redact before truncating**; redact at most the first 8 KB of a long
  output, then truncate to 2 KB (a cut must never expose half a secret).

## Files
| File | Read / change | Why |
|---|---|---|
| docs/tasks/2026-09-28-audit-log/spec.md | read | goal, scope, ACs |
| docs/context/modules/unattended.md | read | resolve, plugin order, fail-closed rules |
| packages/core/src/kete/unattended.ts | read + change | install audit in `Plugin` after `applyLate`; add pure `stopReason`; reuse `limits`, `Lookup`, `familyCost`, `StepFailedError` shape |
| packages/core/src/kete/unattended-policy.ts | read | `resolve`, `Get`, `Policy`, `emptyPolicy`, `metadataKey` |
| packages/core/src/kete/run-checks.ts | read + change | call `audit.begin` for an unattended family before `unattendedCheck`; extend `nodes` |
| packages/core/src/kete/audit.ts | create | line types, writer (cap, mutex, modes), handlers, `install`, `make` for run-checks |
| packages/core/src/kete/stale-write.ts | read | pattern for tool before/after hooks and `stringField` over tool input/output |
| packages/core/src/effect/keyed-mutex.ts | read | per-root append lock |
| packages/core/src/plugin/hooks.ts | read (:60-92) | hooks run in registration order; only `execute.before` may fail |
| packages/plugin/src/effect/tool.ts | read | `execute.before/after` event shapes |
| packages/plugin/src/effect/permission.ts | read | `PermissionEvaluation` |
| packages/schema/src/permission.ts | read (:16-22) | `Source` → `message_id`/`tool_call_id` |
| packages/schema/src/session-event.ts | read (:242-262, :331-390) | `Execution.*`, `Step.Started/Ended/Failed` payloads |
| packages/core/src/bus.ts | read (:748-760) | `subscribe([...])` ordered multi-event stream |
| packages/core/src/tool/plugin/shell.ts | read (:47-100) | shell input (`command`, `workdir`, `background`) and output (`exit`, `timeout`, `status`) |
| packages/core/src/tool/plugin/edit.ts | read (:24-45) | edit input/output (path, files) |
| packages/core/src/tool/plugin/write.ts | read (:23-35) | write input/output (`target`, `resource`) |
| packages/core/src/tool/plugin/patch.ts | read (:21-37) | `applied[]` `{type, resource, target}` |
| packages/util/src/global.ts | read | `Global.Service` (`data`), `Global.node` |
| packages/util/src/kete/account.ts | read (:64-81) | mkdir 0700 / file 0600 / `chmod` pattern with `node:fs/promises` |
| packages/util/src/kete/redact.ts | create | the redactor |
| packages/util/test/kete/redact.test.ts | create | AC3 unit tests |
| packages/core/test/kete/unattended-service.test.ts | read | real `Permission.Service` + hooks registered in order (pattern for audit-service test) |
| packages/core/test/kete/unattended.test.ts | read | pure `Lookup` fakes (pattern for `stopReason`, `begin`) |
| packages/core/test/fixture/tmpdir.ts | read | temp data dir for writer tests |
| packages/core/test/kete/audit.test.ts | create | writer, cap, line shapes, fail closed, `begin` refusal, `stopReason` |
| packages/core/test/kete/audit-service.test.ts | create | real permission chain + hooks: deny/allow lines, subagent → root file, interactive writes nothing |
| packages/core/src/kete/skill/kete.md | change (:88-100) | where the log is, what it holds, fail-closed |
| docs/upstream-patches.md | change (§"Unattended runs", :487) | one line: audit hooks ride on `KeteUnattended.Plugin`, no new upstream edit (D1 B); under A, the two `internal.ts` edits |

29 files (19 read-only, 5 created, 5 changed). No generated files, no config schema, no server
endpoints.

## Steps
1. **Redactor** — create `packages/util/src/kete/redact.ts` (`text`, `deep`, `truncate`, shapes
   above) and `packages/util/test/kete/redact.test.ts`: each secret shape in AC3 redacted, a
   non-secret text unchanged, a PEM block without an END line, redaction before truncation, UTF-8
   boundary truncation.
2. **`stopReason`** — in `unattended.ts` add an exported pure `stopReason(lookup, sessionID)`
   reusing `resolve`, `limits`, the deadline and `familyCost` logic of `check` (refactor `check`
   to share it only if that keeps `check`'s behaviour byte-for-byte; otherwise duplicate the three
   comparisons). Returns `"time_limit" | "budget" | "refused" | undefined`.
3. **Writer** in `audit.ts`: `path(dataDir, root)` with the id check; `create(dir, root, line)`
   (`mkdir` recursive 0700, `open` with `wx` 0600, write, close; `EEXIST` → append-probe);
   `append(state, root, line, kind)` under the per-root mutex: lazily `stat` bytes, for
   `kind: "detail"` skip once over the cap and write the single `truncated` line on first overflow;
   `permission`/`run` always written; every line redacted field-by-field via `KeteRedact.deep`,
   strings truncated to 2 KB, arrays to 20, the serialized line to 16 KB (drop `excerpt`/`input`
   first, never the ids). Errors are typed (`AuditWriteError { path, code }`), never swallowed.
4. **Handlers** in `audit.ts`, pure over a `Lookup` (`session: Get`, `dataDir`, `interrupt`,
   `now`, `unattended` stop-reason lookup) so tests call them directly: `onEvaluate`,
   `onToolBefore` (may return `Tool.Error` for a broken run), `onToolAfter`, `onEvent` (bus). Map
   the tool/file/command/model/run lines as in Design. `make` (for run-checks) resolves
   `Global.Service` and `Config.Service`, returns `begin`.
5. **Install (D1 B)** — `KeteAudit.install(ctx, lookup)` registers `ctx.permission.hook("evaluate")`,
   `ctx.tool.hook("execute.before"/"execute.after")` and the ordered bus stream (forked scoped,
   `Effect.catchCause` → `logError` + mark broken + interrupt, like `watch`). Call it at the end of
   `KeteUnattended.Plugin`'s effect, **after** `ctx.permission.hook("evaluate", applyLate)`; add a
   comment there that the audit hook must stay after `applyLate`. Update `unattended.ts`'s header
   comment.
6. **Run checks** — in `run-checks.ts`, for `state.kind === "unattended"`: `yield* audit.begin(...)`
   (policy, `KeteUnattended.limits`, root id), then `unattendedCheck`. Interactive path unchanged.
   Add `Global.node` to `nodes` if the runner's layer doesn't already provide it (`agent.ts:134`
   depends on it, so it should); keep the file's header comment accurate.
7. **Tests** — `audit.test.ts` (temp data dir from `tmpdir.ts`, never the real data dir) and
   `audit-service.test.ts` (real `Permission.Service` with `applyPolicy`, `applyLate`, then the
   audit evaluate hook, as in `unattended-service.test.ts:138-141`). Cover every AC below; assert
   mode `0o600` only when `process.platform !== "win32"`. Unwritable case: create a *file* at
   `<tmp>/audit` so `mkdir` fails (works on every OS and as root).
8. **Docs** — `skill/kete.md` (path `<data dir>/audit/<root id>.jsonl`, what's recorded, redaction
   is best-effort, a run that can't be audited stops); `docs/upstream-patches.md` line (§ "Unattended
   runs"). No `docs/context` edits — the librarian does those at close.

## Verification
All commands inside the named package; narrowest first. Use
`node scripts/agent/check-summary.mjs bash -c "cd packages/<pkg> && <command>"`.

| Criterion | Command (narrowest first) |
|---|---|
| AC1 run started/ended | core: `bun run test ./test/kete/audit.test.ts -t "run"` → `bun run test ./test/kete/audit.test.ts` |
| AC2 tool/deny/allow/model/edit/shell lines, subagent → root file | core: `bun run test ./test/kete/audit-service.test.ts` → `bun run test ./test/kete/audit.test.ts` |
| AC3 redaction and truncation | util: `bun test ./test/kete/redact.test.ts`; core: `bun run test ./test/kete/audit.test.ts -t "redact"` |
| AC4 per-run cap, one `truncated` line, permission/run continue | core: `bun run test ./test/kete/audit.test.ts -t "cap"` |
| AC5 unwritable file stops the run with a clear error | core: `bun run test ./test/kete/audit.test.ts -t "fail"` |
| AC6 interactive writes nothing | core: `bun run test ./test/kete/audit-service.test.ts -t "interactive"` |
| AC7 | core: `bun run typecheck`, `bun run test ./test/kete`; util: `bun run typecheck`, `bun test ./test/kete`; root: `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main` |
| Regression (unattended unchanged) | core: `bun run test ./test/kete/unattended.test.ts ./test/kete/unattended-service.test.ts ./test/kete/unattended-session.test.ts ./test/kete/budget.test.ts` |

## Risks
- Redaction is pattern-based and best-effort; excerpts (not full outputs) and 0600 limit exposure.
- Hook latency: one small append per tool call/permission/step, only for unattended families; the
  resolve cache keeps interactive sessions at one lookup per session.
- External (user) plugins registered after the internal ones could still change an `evaluate`
  result after the audit hook records it — the same pre-existing gap as `applyLate`; noted in card.
- Shell commands run by a person (`SessionEvent.Shell.*`) aren't audited: unattended runs have no
  person; only the `shell` tool is.
- Multiple prompts on one root: one `run started` (file creation), one `run ended` per root
  execution; readers take the last `ended`. Documented in the card.

## Cards to update after the build
- **New `docs/context/modules/audit-log.md`** — paths `packages/core/src/kete/audit.ts`,
  `packages/util/src/kete/redact.ts`; Quick answers for the scout's gaps (which hooks feed the
  log; where it registers; the redactor; storage and bound; readers/format v1; config-rule denies
  not seen, D2).
- `unattended.md` — `Plugin` also installs the audit hooks (audit hook after `applyLate`);
  `run-checks.ts` writes `run started` and refuses on audit failure; `stopReason`.
- `permissions.md` — refresh (stale), and note the read-only audit `evaluate` hook at the end of
  the chain.
- `pitfalls.md` — "a generic redactor exists: `KeteRedact`; redact before truncating".
- `INDEX.md` — add the `audit-log` row.
