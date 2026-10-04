---
module: audit-log
paths: [packages/core/src/kete/audit.ts, packages/util/src/kete/redact.ts, packages/util/src/kete/job-audit-sink.ts]
verified-at: 508e1f85ba
---

## Quick answers
- Where does the log live in a job (piece A3)? Nowhere on disk: with job mode on, `storageFor()`
  (`audit.ts:229`) picks the **sink** storage (`sinkStorage`, `:226`), whose destination is the
  process's audit fd (`KeteJobAuditSink.get`, set by `KeteJobServe.prepare`); outside job mode the file
  storage is unchanged. `kete` can append to the pipe, never seek, truncate or rewrite. Chain: serve
  child fd 4 -> `kete job run`'s relay -> the entrypoint's pipe -> a root file -> upload (`job-mode` and
  `job-entrypoint` cards). `kete job run` reads the relay's lines, not a file (`Deps.readAudit`,
  `job-run.ts`); its result carries no `audit_log` in job mode (`audit_local: true`).
- What are the sink's caps (N3)? Counted in **bytes** (`Buffer.byteLength`), not the file mode's
  UTF-16 length: detail lines stop at `MAX_DETAIL_BYTES` 19,000,000, with a 1,000,000 reserve for the
  `truncated` line and `permission`/`run` lines; any write past `MAX_TOTAL_BYTES` 20,000,000 fails
  and interrupts the run (`util/src/kete/job-audit-sink.ts:34-36`; `audit.ts:306-325`). Accounting is
  per sink writer (a `WeakMap`, `audit.ts:259`), shared by `begin` and the hooks across roots.
- Does the file mode's 20 MiB cap count bytes? No: `MAX_RUN_BYTES` (`audit.ts:54`) is checked against
  `serialized.length` (UTF-16 units, `audit.ts:358`) and applies to detail lines only;
  `permission`/`run` lines are uncapped. The entrypoint's upload cap is 20,000,000 bytes.
- Where's the sink tested? `core/test/kete/audit-sink.test.ts` and `util/test/kete/job-audit-sink.test.ts`.
- Is there a reader now? Yes — `kete job run` (`cli/src/kete/job-run.ts`, `pollAuditEnded`) polls
  `<auditDir>/<root session id>.jsonl` for up to 5 s (`Deps.auditPollTimeoutMs`, default 5000ms)
  for a `type:"run", event:"ended"` line (the audit hook writes it asynchronously after the client
  sees the execution event on the wire); it also sums every `model` line's `cost_usd` for the
  whole family, and reads every `type:"permission", effect:"deny"` line into the job's `denied`
  list. No local file (a remote `--server`, or the audit write itself refused before any line was
  written) → the job classifies the root session's own execution event instead
  (`@opencode/schema/kete/unattended`'s `classify`, `unattended` card). See the `cli` card and
  `docs/jobs.md`.
- Where does the audit-unavailable message text come from now? `audit.ts:299`'s
  `StepFailedError` message is built via `KeteUnattendedSchema.auditUnavailable(path, code)`
  (`@opencode/schema/kete/unattended`) — wording unchanged, but no longer inlined here; see the
  `unattended` card's "Where do the wire shapes and stop-message text live now?".
- Which hooks feed the log, and where does it register? A read-only `permission.evaluate` hook, a
  `tool.execute.before`/`execute.after` pair, and one ordered `bus.subscribe([Step.Started,
  Step.Ended, Step.Failed, Execution.Succeeded, Execution.Failed, Execution.Interrupted])` stream
  (`audit.ts:584-603` `install`). It is **not** a separate plugin registered in
  `plugin/internal.ts` — `install` is called from inside `KeteUnattended.Plugin`'s own effect
  (`unattended.ts`), right after that plugin registers its late `evaluate` hook, so the audit hooks
  ride on `kete.unattended`'s plugin id and guarded status (D1 option B; zero new upstream edits;
  see the `unattended` card and `docs/upstream-patches.md` "Unattended runs").
- Is there a generic redactor to reuse? Yes — `KeteRedact` (`packages/util/src/kete/redact.ts`):
  `text(s)` (secret shapes and `name=value`/`name: value`/`"name": "value"` pairs), `deep(value)`
  (walks JSON, redacting strings and whole values under a secret-looking key), `truncate(s, bytes)`
  (UTF-8-boundary-safe cut), `isSecretKey(name)` (the bare key-name test `deep` and `audit.ts`'s
  `prepareValue` share). No prior generic redactor existed before this task; only
  `cli/src/commands/handlers/debug/redact.ts` `redactConfig()` and `session/transfer.ts`'s
  `--sanitize` existed, both narrower and config/session-specific.
- Where does the log live, and what bounds it? One file per root session family:
  `<Global.Service.data>/audit/<root session id>.jsonl` (`audit.ts:137-141` `filePath`; directory
  mode 0700, file mode 0600, best-effort on Windows). Bounds: `MAX_RUN_BYTES = 20 MiB` per run in file mode (UTF-16 length; the job-mode sink has its own byte caps, see the first answers),
  `MAX_FIELD_BYTES = 2 KB` per string field, `MAX_LINE_BYTES = 16 KB` per serialized line,
  `MAX_ARRAY_ITEMS = 20` (`audit.ts:43-46`, D3: constants, not config).
- The redaction window, precisely: a string field is first cut to `PRE_REDACT_WINDOW_BYTES = 16 KB`
  (bounding the redactor's regex work against a multi-MB tool result), **then** redacted
  (`KeteRedact.text`), **then** cut again to `MAX_FIELD_BYTES = 2 KB` (`audit.ts:47-51,178-182`
  `prepareValue`) — so a secret straddling the 16 KB window edge always ends up outside the kept
  2 KB field; a cut never exposes half a secret. A secret-looking **key** (`KeteRedact.isSecretKey`)
  replaces its whole value regardless of type, at any nesting depth, before the size bounding is
  applied to it.
- Is there a per-process cap and mutex? Yes, both live in one process's in-memory `WriterState`
  (`audit.ts:210-221`): a `KeyedMutex` keyed by root id (`effect/keyed-mutex.ts`) serializes each
  root's appends and byte-count updates, and a `Map<root, bytes>` (lazily seeded from `stat`) tracks
  the per-run cap. **Not** cross-process: two `kete serve` processes writing the same root's file
  wouldn't coordinate (not expected today — one server per workspace;
  `docs/upstream-patches.md` "Unattended runs"). Redaction/serialization (the CPU-bound part) happen
  *before* the mutex is acquired (`audit.ts:236-238` `append`), so one root's expensive line never
  blocks another root's append; the mutex guards only the shared byte count and the actual
  `stat`/`appendFile`.
- Is there an unaudited-call window? Yes — a write failure inside a hook marks the root broken, logs,
  and calls `sessions.interrupt(root)` (`audit.ts:345-360` `writeGuarded`), but a tool call already
  in flight when the failure happens can finish — and go unaudited — before the interrupt takes
  effect; only the *next* tool call in that root is refused via `Tool.Error`
  (`audit.ts:389-398` `onToolBefore`), and the *next step* is refused via `KeteAudit.begin`'s
  fail-closed check if the file is still unwritable.
- Do config-rule permission denies ever produce a `permission` line? No (D2) — `Permission.Service`
  returns `deny` for a configured deny rule *before* triggering any `evaluate` hook
  (`permission.ts:173-176`), so neither the policy hooks nor the read-only audit `onEvaluate` hook
  ever sees it. Such a call still produces a `tool` line with `status: "error"` and the (redacted)
  denial message (`audit.ts:473-491` `onToolAfter`) — that `tool` line is the only audit trace of a
  config-rule deny.
- Does the redactor over-redact anything predictable? Yes — a bare `pass`/`PASS` key or
  `name=value`/`name: value` pair matches the anchored `pass` alternative in `NAME`
  (`redact.ts:14-20`) even when it isn't a password: `pass: 42`, `PASS=1` (a plain count/flag) get
  redacted to `pass: [REDACTED]`/`PASS=[REDACTED]`. Deliberate (favors over- over under-redaction,
  `CLAUDE.md:237-239`), not a bug to narrow away — see Gotchas.
- What does an interactive session's family write? Nothing — every handler resolves the family
  first via a bounded resolve cache and returns immediately when `state.kind !== "unattended"`
  (`audit.ts:369-372,389-393,473-476,521-529`).
- Is there a reader (`kete audit …`)? No — out of scope for this task; `kete job run` (a future
  task) will print the file's path. The nearest existing precedent is
  `kete session export [--sanitize]` (`cli/src/commands/commands.ts:424-437`).

## Purpose
ADR 0008: every unattended run leaves a local, append-only record of what it did — tool calls,
permission decisions (including denies and their reason), model steps, file changes and shell
commands — with secrets redacted, so a person (and later `kete job run` and the cloud worker) can
see afterwards what happened and which permissions to allow. Interactive sessions are completely
unaffected: no extra writes, no overhead beyond one cached family lookup per session.

## Entry points
- `audit.ts` `make`/`begin` — called once per step from `run-checks.ts`, before
  `KeteUnattended.check`, for an unattended family only. Creates the root's file and writes the
  `run started` line exactly once, however many sessions/processes reach it first; any failure to
  create/open the file refuses the step (`StepFailedError({type: "unattended"})`, fail closed).
- `audit.ts` `install(ctx, lookup)` — called at the end of `KeteUnattended.Plugin`'s effect
  (`unattended.ts`), after that plugin registers its own late `evaluate` hook. Registers the
  `evaluate`/`execute.before`/`execute.after` hooks and the bus subscription that record everything
  else.
- No `plugin/internal.ts` edit and no new plugin id — see Quick answers and the `unattended`/
  `permissions` cards for exactly where in the hook chain the audit `evaluate` hook sits.

## Key files
- `audit.ts:137-141` `filePath(dataDir, root)` — `<dataDir>/audit/<root>.jsonl`; fails
  (`WriteError`) rather than build a path from an id that isn't `ROOT_ID_PATTERN` (`:54`,
  `^[A-Za-z0-9_-]+$`) — no path traversal from a root session id.
- `audit.ts:148-168` `create` — `mkdir` recursive 0700, `open` with `wx` (exclusive create) 0600,
  write, close; on `EEXIST` opens for append and closes without writing (a writability probe, used
  by every non-first caller into the same root).
- `audit.ts:178-191` `prepareValue` / `:196-204` `serialize` — the redact→cap pipeline (Quick
  answers) applied recursively to every field, then the whole serialized line capped to
  `MAX_LINE_BYTES`, dropping `excerpt`/`input` first if still too large, never the id fields.
- `audit.ts:233-265` `append(state, root, line, kind)` — `kind: "detail"` is subject to the per-run
  cap (writes one `truncated` line on first overflow, then skips further detail lines for that
  root); `kind: "always"` (`permission`, `run`) is never capped. Redaction/serialization happen
  outside the per-root mutex (see Quick answers).
- `audit.ts:310-330` `makeResolveCache` — bounded per-session cache of
  `KeteUnattendedPolicy.resolve`; safe because `kete.unattended` can't change after a session is
  created (`guardMetadata`, `unattended` card); cleared outright at 1000 entries.
- `audit.ts:345-360` `writeGuarded` — the fail-closed reaction to a write failure inside a hook:
  marks the root broken, `Effect.logError` (message "kete audit: failed to write an audit line;
  stopping the run"), `sessions.interrupt(root)`.
- `audit.ts:369-386` `onEvaluate` — read-only; writes a `permission` line from the *final*
  `event.effect`/`event.message`, never changes them; ids from `event.source`
  (`schema/src/permission.ts:16-22` `Source`, `type: "tool"` gives `messageID`/`id`).
- `audit.ts:389-398` `onToolBefore` — fails a call in a broken run with `Tool.Error`; otherwise just
  records a shell call's start time (`deps.shellStarts`) for the later `command` line's duration.
- `audit.ts:417-491` `fileLines`/`commandLine`/`onToolAfter` — `tool` line (input, status,
  `output_bytes`, a redacted excerpt — not the full output) plus derived `file` lines for
  `edit`/`write`/`patch` and a `command` line for `shell`, read from the tool's own input/output
  shape (`core/src/tool.ts:103-149` builds the `execute.before`/`execute.after` event; the `tool`
  field is the effective tool name — `edit`/`write`/`patch`/`shell`).
- `audit.ts:519-564` `onEvent` — pairs `Step.Started`'s model with `Step.Ended`/`Step.Failed`'s
  cost/tokens (keyed by `assistantMessageID`) into a `model` line; writes `run ended` only for the
  root's own `Execution.Succeeded/Failed/Interrupted` event, with `reason` from
  `KeteUnattended.stopReason` first, else `audit_failed` if the root is broken, else
  `interrupted`/`error`.
- `redact.ts:53-64` `text` / `:70-81` `deep` / `:84-90` `truncate` / `:25-27` `isSecretKey` — the
  redactor itself; see Quick answers for the shapes it catches and the `pass`/`PASS`
  over-redaction trade-off.

## Data flow
1. **Run start (per step, unattended family):** `run-checks.ts` calls `KeteAudit.begin` before
   `KeteUnattended.check` → `create` makes/opens the root's file → `run started` line (policy,
   effective limits) written exactly once per root, or the step is refused if the file can't be
   written.
2. **Permission decisions:** `Permission.Service.assert` resolves the final `evaluate` decision
   (every other Kete permission hook already ran — `permissions` card) → the audit `onEvaluate` hook
   runs last and writes a `permission` line recording it, without ever changing it. A config-rule
   deny never reaches here (D2) — see Quick answers.
3. **Tool calls:** `execute.before` may fail a call in a broken run; `execute.after` always writes a
   `tool` line (redacted input, status, a redacted excerpt of the output) and, for
   `edit`/`write`/`patch`/`shell`, a derived `file`/`command` line.
4. **Model steps:** the ordered bus stream pairs `Step.Started`'s model with `Step.Ended`/
   `Step.Failed`'s cost/tokens into one `model` line per step.
5. **Run end:** the root's own `Execution.Succeeded`/`Failed`/`Interrupted` event writes one
   `run ended` line with a reason (`completed`, `time_limit`, `budget`, `refused`, `audit_failed`,
   `interrupted`, or `error`) and a redacted message.
6. **Every write** goes through `append`: redact+cap outside the per-root mutex, then (inside the
   mutex) check/update the per-run byte count and either append the line or, on first overflow,
   append one `truncated` line and skip further `detail` lines for that root; `permission`/`run`
   lines are never capped.
7. **A write failure** inside any hook (only `execute.before` may itself fail) marks the root
   broken, logs, and interrupts it — see the unaudited-call window in Quick answers.

## Data and APIs used
- `Global.Service` (`data`) — already in the plugin `services`/`requirements` list
  (`plugin/internal.ts:139,194`), so no upstream edit was needed to reach it from inside
  `KeteUnattended.Plugin`.
- `Bus.Service.subscribe([...])` (`core/src/bus.ts`) — one ordered multi-event stream for
  `Step.Started/Ended/Failed` and `Execution.Succeeded/Failed/Interrupted`
  (`schema/src/session-event.ts`).
- `KeyedMutex` (`core/src/effect/keyed-mutex.ts`) — per-root append lock; `makeUnsafe`/`make`.
- `KeteUnattendedPolicy.resolve`/`Get` — family resolution, reused (not re-implemented) via the
  bounded `ResolveCache`.
- `KeteUnattended.Limits`/`stopReason` — **type-only** import of `Limits`; `stopReason` is passed in
  as a closure (`InstallLookup.stopReason`) rather than imported at runtime, to avoid a cycle with
  `unattended.ts` (which imports `audit.ts` to call `install`) — see the `unattended` card's
  Gotchas.
- `node:fs/promises` (`mkdir`, `open`, `appendFile`, `stat`) — the writer's only I/O.

## Rules that must not break
- `install` must be called **after** `KeteUnattended.Plugin` registers its late `evaluate` hook, or
  the `permission` line would record a decision before the run's own fail-closed tightening — a
  comment in `unattended.ts`'s `Plugin` marks this ordering requirement.
- The audit `evaluate`/`tool` hooks must stay **read-only**: `onEvaluate` records `event.effect`/
  `event.message` but never assigns to them; a future change that makes the audit hook alter a
  decision would break the "never overrides another hook" invariant the `permissions` card relies
  on.
- Redact **before** truncating, and bound the pre-redact scan window before truncating to the final
  field size (`PRE_REDACT_WINDOW_BYTES` then `MAX_FIELD_BYTES`) — reversing the order, or truncating
  before the pre-redact window is applied, can leave a partial secret in the kept field.
- A write failure must mark the root broken and interrupt it (fail closed) — never swallow an
  append error or let a broken root's family keep running unaudited indefinitely.
- The line format is versioned (`v: 1`) and additive-only — `kete job run`, the cloud worker and
  later the platform will read it; don't remove or repurpose a field, only add.
- Redaction/serialization must stay outside the per-root mutex (`append`'s ordering) — moving the
  CPU-bound work inside the lock would let one root's large tool result block every other root's
  writes.

## Testing
- `bun run test ./test/kete/audit.test.ts` inside `packages/core/` — pure/writer-level: `create`'s
  exclusive-create/probe/0600/0700 (mode assertions skipped on `win32`), path-traversal rejection,
  `begin`'s fail-closed error (AC5, including a mid-run append failure that marks the root broken,
  logs, and interrupts — via `TestConsole.logLines`, not `.errorLines`: the default Effect logger
  writes through `console.log` unless `LogToStderr` is set), handler line shapes, redaction (AC3),
  the per-run cap and `truncated` line (AC4), array capping, and a ~5 MB tool-result timing/size
  bound (the redaction-cost fix).
- `bun run test ./test/kete/audit-service.test.ts` inside `packages/core/` — real
  `Permission.Service`/`Session.Service` with the audit `evaluate` hook registered last:
  deny-with-reason, allow, a subagent's lines landing in the root's file (AC2), an interactive
  session writing nothing (AC6).
- `bun test ./test/kete/redact.test.ts` inside `packages/util/` — every secret shape in AC3,
  redact-before-truncate, UTF-8-boundary truncation, the anchored `pass`/`PASS` cases and their
  negative counterparts (`passage`, `bypass`).

## Changes
- `docs/upstream-patches.md` "Unattended runs" — the audit-log paragraph: D1 (no new upstream edit,
  hooks ride on `KeteUnattended.Plugin`), the type-only-import cycle avoidance, the per-process
  cap/mutex scope, and the unaudited-call window.
- `packages/core/src/kete/skill/kete.md` — "Unattended audit log" bullet: where the log is, what it
  records, fail-closed, interactive sessions write nothing, nothing uploads it.
- `docs/tasks/2026-09-28-audit-log/` — spec, plan (D1/D2/D3), handoff (implementer + reviewer-fix
  pass: the redaction-cost fix, the `pass` anchoring fix, the mid-run-failure test, the doc-gap
  note).
- `docs/tasks/2026-09-28-job-run/` — `kete job run` (`cli` card) became the first real reader:
  polls for `run ended`, sums `model` cost, reads `permission` deny lines; the audit-unavailable
  message moved to the shared `@opencode/schema/kete/unattended` builder (text unchanged).

## Gotchas
- **`pass: 42` / `PASS=1` (a plain count or flag) gets redacted** — the anchored bare-`pass`
  alternative in `NAME` (`redact.ts:14-20`) matches any delimited `pass`/`PASS`, not just an actual
  password field; this is a deliberate over-redaction trade-off (favor hiding too much over leaking
  a real `DB_PASS`/`APP_PASS`), not a defect to narrow away.
- **The plan's "redact at most the first 8 KB" wording differs from the implementation**: the
  redactor itself (`KeteRedact.text`) has no pre-scan window; `audit.ts`'s `prepareValue` supplies
  the bounding window itself, and it's `PRE_REDACT_WINDOW_BYTES = 16 KB`, not 8 KB. Both still
  satisfy "redact before truncate, never split a secret" — just don't expect an 8 KB constant
  anywhere in the code.
- **The per-run cap and per-root mutex are per-process, in-memory state** (`WriterState`) — nothing
  coordinates two `kete serve` processes appending to the same root's file. Not exploitable today
  (one server per workspace) but a real limitation if that assumption ever changes.
- **A tool call already in flight when a write fails can finish, unaudited**, before
  `sessions.interrupt(root)` takes effect — only the *next* tool call and the *next* step are
  guaranteed to be refused. This is a narrow, documented gap, not a bug.
- **Don't give `audit.ts` a runtime import of `unattended.ts`** — it already takes a type-only one
  for `Limits`; `unattended.ts` imports `audit.ts` at runtime to call `install`, so a runtime import
  the other way would cycle. Pass behavior in via a closure (`stopReason`) instead, as `install`
  already does.
- Config-rule permission denies (D2) never produce a `permission` line — only ever a `tool` line
  with `status: "error"`. Don't expect to find a denied config-rule call in the `permission` lines
  of a run's audit file.
