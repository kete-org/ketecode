// The append-only local record ADR 0008 promises for an unattended run: one JSON Lines file per
// root session family, under `<data dir>/audit/<root session id>.jsonl` (mode 0600, directory
// 0700). Nothing here runs for an interactive session — every handler resolves the family first
// and returns immediately when it isn't unattended.
//
// Two write paths:
// - `make`/`begin` (called once per step from run-checks.ts, before `KeteUnattended.check`)
//   creates the root's file and writes the `run started` line exactly once, however many
//   sessions/processes reach it first; any failure to create or open the file refuses the step
//   (fail closed — an unattended run that can't be audited doesn't continue).
// - `install` (called from the end of `KeteUnattended.Plugin`'s effect, after it registers its own
//   late `evaluate` hook) registers the hooks that record everything else: a read-only permission
//   `evaluate` hook, `tool.execute.before`/`execute.after`, and one ordered bus subscription for
//   model steps and the run's end. All of it goes through one append path per root, serialized by
//   a per-root mutex, that redacts every field and enforces the per-run size cap.
//
// A write failure inside a hook (hooks besides `tool.execute.before` can't fail) marks the root
// broken, logs, and interrupts the root session; a broken run then refuses every further tool call
// until (if ever) the file becomes writable again — checked back at the next step's `begin`.
//
// Storage (job mode piece A3, D2/N3): outside job mode, the file above. In job mode the log goes
// only to the inherited audit pipe (KeteJobAuditSink, KETE_JOB_AUDIT_FD; `kete job run` relays it to
// the entrypoint) and no file or directory is created under `<data dir>/audit`: `kete` can append,
// never seek, truncate or rewrite. Caps there count bytes: detail lines stop at 19,000,000 bytes
// across all roots (one `truncated` line per root), and any write past 20,000,000 is a write failure
// — so the entrypoint's own 20 MB cap is never reached by a working `kete`. Job mode without a sink
// refuses the step.

export * as KeteAudit from "./audit.js"

import { mkdir, open, appendFile, stat } from "node:fs/promises"
import path from "node:path"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Tool } from "@opencode/schema/tool"
import { Duration, Effect, Predicate, Schema, Stream } from "effect"
import { KeteJobAuditSink } from "@opencode/util/kete/job-audit-sink"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteRedact } from "@opencode/util/kete/redact"
import { KeteUnattendedSchema } from "@opencode/schema/kete/unattended"
import { Global } from "@opencode/util/global"
import { Bus } from "../bus.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { SessionError } from "@opencode/schema/session-error"
import { StepFailedError } from "../session/error.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
// Type-only: avoids a runtime import cycle with unattended.ts, whose Plugin calls `install` below.
import type { KeteUnattended } from "./unattended.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

/** Per-run cap; 2 KB per string field; 16 KB per serialized line; 20 items per array (D3: constants, not config). */
export const MAX_RUN_BYTES = 20 * 1024 * 1024
export const MAX_FIELD_BYTES = 2 * 1024
export const MAX_LINE_BYTES = 16 * 1024
export const MAX_ARRAY_ITEMS = 20
/** Bytes of a string scanned by the redactor before it's cut to `MAX_FIELD_BYTES`: a tool result
 * (webfetch, grep, MCP) can be multi-MB, and redacting the whole thing is needless CPU under the
 * per-root mutex. A secret straddling this window's edge still ends up outside the kept
 * `MAX_FIELD_BYTES`, so it's never partially exposed either way. */
export const PRE_REDACT_WINDOW_BYTES = 16 * 1024

/** No path traversal: the root session id must look like an id, never a path segment. */
export const ROOT_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export class WriteError extends Schema.TaggedError<WriteError>()("KeteAudit.WriteError", {
  path: Schema.String,
  code: Schema.String,
}) {
  override get message() {
    return `${this.path}: ${this.code}`
  }
}

interface LineBase {
  readonly v: 1
  readonly ts: string
  readonly session_id: string
  readonly root_id: string
  readonly message_id?: string
  readonly tool_call_id?: string
}

export type RunReason = "completed" | "time_limit" | "budget" | "refused" | "audit_failed" | "interrupted" | "error"

export type RunStarted = LineBase & {
  readonly type: "run"
  readonly event: "started"
  readonly policy: unknown
  readonly invalid?: boolean
  readonly limits: { readonly budget_usd?: number; readonly timeout_minutes?: number; readonly missing: ReadonlyArray<string> }
}
export type RunEnded = LineBase & {
  readonly type: "run"
  readonly event: "ended"
  readonly reason: RunReason
  readonly message?: string
}
export type ToolLine = LineBase & {
  readonly type: "tool"
  readonly tool: string
  readonly agent: string
  readonly input: string
  readonly status: "completed" | "error"
  readonly output_bytes?: number
  readonly excerpt?: string
  readonly error?: string
}
export type PermissionLine = LineBase & {
  readonly type: "permission"
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly effect: "allow" | "deny" | "ask"
  readonly message?: string
}
export type ModelLine = LineBase & {
  readonly type: "model"
  readonly provider: string
  readonly model: string
  readonly tokens?: unknown
  readonly cost_usd?: number
  readonly finish?: string
  readonly status?: "failed"
  readonly error?: string
}
export type FileLine = LineBase & {
  readonly type: "file"
  readonly path: string
  readonly operation: "edit" | "write" | "add" | "update" | "delete"
}
export type CommandLine = LineBase & {
  readonly type: "command"
  readonly command: string
  readonly cwd?: string
  readonly exit?: number
  readonly background: boolean
  readonly timeout?: boolean
  readonly duration_ms?: number
}
export type TruncatedLine = LineBase & { readonly type: "truncated" }

export type Line = RunStarted | RunEnded | ToolLine | PermissionLine | ModelLine | FileLine | CommandLine | TruncatedLine

const isErrnoCode = (error: unknown): string => (Predicate.isObject(error) && "code" in error && typeof error.code === "string" ? error.code : "unknown")

/** `<dataDir>/audit/<root>.jsonl`; fails rather than build a path from an id that isn't one. */
export function filePath(dataDir: string, root: string): Effect.Effect<string, WriteError> {
  const location = path.join(dataDir, "audit", `${root}.jsonl`)
  if (!ROOT_ID_PATTERN.test(root)) return Effect.fail(new WriteError({ path: location, code: "invalid-root-id" }))
  return Effect.succeed(location)
}

/**
 * Creates the root's file and writes `line` to it, exactly once regardless of which caller gets
 * there first: `wx` (exclusive create) then write; on `EEXIST` opens for append and closes without
 * writing (a writability probe). Any other failure to `mkdir`, open or write is a `WriteError`.
 */
export const create = Effect.fn("KeteAudit.create")(function* (dataDir: string, root: string, line: Line) {
  const file = yield* filePath(dataDir, root)
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      try {
        const handle = await open(file, "wx", 0o600)
        try {
          await handle.writeFile(serialize(line), "utf8")
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (isErrnoCode(error) !== "EEXIST") throw error
        const handle = await open(file, "a", 0o600)
        await handle.close()
      }
    },
    catch: (error) => new WriteError({ path: file, code: isErrnoCode(error) }),
  })
})

/**
 * Redacts and caps every field in one pass: a string is first cut to `PRE_REDACT_WINDOW_BYTES`
 * (bounding the redactor's regex work regardless of the field's real size, e.g. a multi-MB tool
 * result), *then* redacted, *then* cut again to `MAX_FIELD_BYTES` — so a secret straddling the
 * window edge always ends up outside the kept field. A secret-looking key replaces its whole value,
 * whatever type it is (mirrors `KeteRedact.deep`, using its `isSecretKey` directly so the size
 * bounding can sit in between).
 */
function prepareValue(value: unknown): unknown {
  if (typeof value === "string") {
    const windowed = KeteRedact.truncate(value, PRE_REDACT_WINDOW_BYTES)
    return KeteRedact.truncate(KeteRedact.text(windowed), MAX_FIELD_BYTES)
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(prepareValue)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = KeteRedact.isSecretKey(key) ? "[REDACTED]" : prepareValue(item)
    return out
  }
  return value
}

/** Redacts every field (bounded, see `prepareValue`), caps string/array sizes, then the whole
 * line — dropping `excerpt`/`input` first if it's still too large, never the id fields. Pure and
 * CPU-only: callers do this outside any lock. */
function serialize(line: Line): string {
  const capped = prepareValue(line) as Record<string, unknown>
  let json = JSON.stringify(capped) + "\n"
  if (Buffer.byteLength(json, "utf8") > MAX_LINE_BYTES) {
    const { excerpt: _excerpt, input: _input, ...rest } = capped
    json = JSON.stringify(rest) + "\n"
  }
  return json
}

function truncatedLine(like: Line): TruncatedLine {
  return { v: 1, ts: like.ts, session_id: like.session_id, root_id: like.root_id, type: "truncated" }
}

/** Where lines go: the per-root file (default), or job mode's inherited pipe. `writer` is read at
 * write time, so a sink set after install is still found; none set in job mode is a write failure. */
export type Storage = { readonly kind: "file" } | { readonly kind: "sink"; readonly writer: () => KeteJobAuditSink.Writer | undefined }

export const fileStorage: Storage = { kind: "file" }
export const sinkStorage: Storage = { kind: "sink", writer: KeteJobAuditSink.get }

/** The storage the current process uses: the sink in job mode (on or invalid), else the file. */
export function storageFor(env: Record<string, string | undefined> = process.env): Storage {
  return KeteJobMode.enabled(env) ? sinkStorage : fileStorage
}

/** Mutable per-process writer state: one mutex and byte count per root, and which roots are broken. */
export interface WriterState {
  readonly dataDir: string
  readonly mutex: KeyedMutex.KeyedMutex<string>
  readonly bytes: Map<string, number>
  readonly truncated: Set<string>
  readonly broken: Set<string>
  readonly storage: Storage
}

export function makeWriterState(dataDir: string, mutex: KeyedMutex.KeyedMutex<string>, storage: Storage = fileStorage): WriterState {
  return { dataDir, mutex, bytes: new Map(), truncated: new Set(), broken: new Set(), storage }
}

// --- Sink storage (job mode): one pipe for every root, shared by `begin` and the hooks. ---

/** Byte accounting for one sink, shared by every writer state using it (`begin` and `install` each
 * build their own state). Bytes are reserved before the write is awaited, so concurrent appends
 * can't overshoot the caps. */
interface SinkAccount {
  readonly started: Set<string>
  readonly truncated: Set<string>
  total: number
  detail: number
}

const sinkAccounts = new WeakMap<KeteJobAuditSink.Writer, SinkAccount>()

function sinkAccount(writer: KeteJobAuditSink.Writer): SinkAccount {
  let account = sinkAccounts.get(writer)
  if (account === undefined) {
    account = { started: new Set(), truncated: new Set(), total: 0, detail: 0 }
    sinkAccounts.set(writer, account)
  }
  return account
}

const sinkPath = (writer: KeteJobAuditSink.Writer | undefined) => (writer === undefined ? "fd:-" : `fd:${writer.fd}`)

function resolveSink(storage: Extract<Storage, { kind: "sink" }>, root: string): Effect.Effect<KeteJobAuditSink.Writer, WriteError> {
  const writer = storage.writer()
  if (writer === undefined) return Effect.fail(new WriteError({ path: sinkPath(writer), code: "no-audit-sink" }))
  if (!ROOT_ID_PATTERN.test(root)) return Effect.fail(new WriteError({ path: sinkPath(writer), code: "invalid-root-id" }))
  const failure = writer.failure()
  if (failure !== undefined) return Effect.fail(new WriteError({ path: sinkPath(writer), code: failure }))
  return Effect.succeed(writer)
}

/** Reserves `bytes` against the hard cap and writes them; past the cap is a write failure. */
function sinkWrite(writer: KeteJobAuditSink.Writer, account: SinkAccount, bytes: Uint8Array): Effect.Effect<void, WriteError> {
  return Effect.suspend(() => {
    if (account.total + bytes.byteLength > KeteJobAuditSink.MAX_TOTAL_BYTES)
      return Effect.fail(new WriteError({ path: sinkPath(writer), code: "audit-cap" }))
    account.total += bytes.byteLength
    return Effect.tryPromise({
      try: () => writer.write(bytes),
      catch: (error) =>
        new WriteError({ path: sinkPath(writer), code: error instanceof KeteJobAuditSink.WriteFailure ? error.code : isErrnoCode(error) }),
    })
  })
}

/** Sink `create`: writes `run started` once per root (in memory); every later call only checks the
 * sink is still writable. */
export const createSink = (storage: Extract<Storage, { kind: "sink" }>, root: string, line: Line): Effect.Effect<void, WriteError> =>
  Effect.gen(function* () {
    const writer = yield* resolveSink(storage, root)
    const account = sinkAccount(writer)
    if (account.started.has(root)) return
    account.started.add(root)
    yield* sinkWrite(writer, account, new TextEncoder().encode(serialize(line)))
  })

/** Sink `append`: N3's byte caps (detail lines to MAX_DETAIL_BYTES across all roots, then one
 * `truncated` line per root; any write past MAX_TOTAL_BYTES fails). */
const appendSink = (
  storage: Extract<Storage, { kind: "sink" }>,
  root: string,
  line: Line,
  kind: "detail" | "always",
): Effect.Effect<void, WriteError> =>
  Effect.gen(function* () {
    const writer = yield* resolveSink(storage, root)
    const account = sinkAccount(writer)
    if (kind === "detail" && account.truncated.has(root)) return
    const bytes = new TextEncoder().encode(serialize(line))
    if (kind === "detail") {
      if (account.detail + bytes.byteLength > KeteJobAuditSink.MAX_DETAIL_BYTES) {
        account.truncated.add(root)
        account.detail = KeteJobAuditSink.MAX_DETAIL_BYTES
        return yield* sinkWrite(writer, account, new TextEncoder().encode(serialize(truncatedLine(line))))
      }
      account.detail += bytes.byteLength
    }
    yield* sinkWrite(writer, account, bytes)
  })

/**
 * Appends `line` to `root`'s file. `kind: "detail"` is subject to the per-run cap (a single
 * `truncated` line is written once, on the append that would cross it, and every further detail
 * line for that root is skipped); `kind: "always"` (permission, run) is never capped.
 *
 * Redaction and serialization (CPU-bound, can be sizeable for a large tool result — see
 * `prepareValue`) happen *before* the per-root mutex is acquired, so one root's expensive line
 * never blocks another root's append; the mutex guards only the shared byte count and the actual
 * write.
 */
export const append = (state: WriterState, root: string, line: Line, kind: "detail" | "always"): Effect.Effect<void, WriteError> =>
  state.storage.kind === "sink" ? appendSink(state.storage, root, line, kind) : appendToFile(state, root, line, kind)

const appendToFile = (state: WriterState, root: string, line: Line, kind: "detail" | "always"): Effect.Effect<void, WriteError> =>
  Effect.gen(function* () {
    const file = yield* filePath(state.dataDir, root)
    if (kind === "detail" && state.truncated.has(root)) return
    const serialized = serialize(line)
    yield* state.mutex.withLock(root)(
      Effect.gen(function* () {
        if (kind === "detail" && state.truncated.has(root)) return
        let bytes = state.bytes.get(root)
        if (bytes === undefined) {
          bytes = yield* Effect.tryPromise(() => stat(file).then((info) => info.size).catch(() => 0)).pipe(
            Effect.orElseSucceed(() => 0),
          )
          state.bytes.set(root, bytes)
        }
        if (kind === "detail" && bytes + serialized.length > MAX_RUN_BYTES) {
          state.truncated.add(root)
          const marker = serialize(truncatedLine(line))
          yield* Effect.tryPromise({
            try: () => appendFile(file, marker, { mode: 0o600 }),
            catch: (error) => new WriteError({ path: file, code: isErrnoCode(error) }),
          })
          state.bytes.set(root, bytes + marker.length)
          return
        }
        yield* Effect.tryPromise({
          try: () => appendFile(file, serialized, { mode: 0o600 }),
          catch: (error) => new WriteError({ path: file, code: isErrnoCode(error) }),
        })
        state.bytes.set(root, bytes + serialized.length)
      }),
    )
  })

// --- `begin`: run-checks.ts calls this before every step of an unattended family, passing the
// already-resolved family state and its already-computed `KeteUnattended.limits`. ---

export const make = Effect.gen(function* () {
  const global = yield* Global.Service
  const storage = storageFor()
  return Effect.fn("KeteAudit.begin")(function* (
    state: KeteUnattendedPolicy.Unattended,
    sessionID: SessionSchema.ID,
    limits: KeteUnattended.Limits,
  ) {
    const line: RunStarted = {
      v: 1,
      ts: new Date().toISOString(),
      type: "run",
      event: "started",
      session_id: sessionID,
      root_id: state.root.id,
      policy: state.policy,
      ...(state.invalid !== undefined ? { invalid: true as const } : {}),
      limits: {
        budget_usd: limits.budget,
        timeout_minutes: limits.timeout !== undefined ? Duration.toMinutes(limits.timeout) : undefined,
        missing: limits.missing,
      },
    }
    yield* (storage.kind === "sink" ? createSink(storage, state.root.id, line) : create(global.data, state.root.id, line)).pipe(
      Effect.mapError(
        (error) =>
          new StepFailedError({
            error: SessionError.Error.make({
              type: "unattended",
              message: KeteUnattendedSchema.auditUnavailable(error.path, error.code),
            }),
          }),
      ),
    )
  })
})

export const nodes = [Global.node] as const

// --- Handlers: pure over `Deps` (mutable caches + a `WriterState`), so tests call them directly. ---

/** Bounded per-session cache of `KeteUnattendedPolicy.resolve`: safe because `kete.unattended`
 * can't change after a session is created (`guardMetadata`). Cleared outright once it reaches 1000
 * entries, rather than evicting individually. */
export interface ResolveCache {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<KeteUnattendedPolicy.State>
}

export function makeResolveCache(get: KeteUnattendedPolicy.Get): ResolveCache {
  const cache = new Map<string, KeteUnattendedPolicy.State>()
  return {
    get: (sessionID) =>
      Effect.gen(function* () {
        const cached = cache.get(sessionID)
        if (cached !== undefined) return cached
        const state = yield* KeteUnattendedPolicy.resolve(get, sessionID)
        if (cache.size >= 1000) cache.clear()
        cache.set(sessionID, state)
        return state
      }),
  }
}

export type StopReason = "time_limit" | "budget" | "refused" | undefined

export interface Deps {
  readonly writer: WriterState
  readonly resolve: ResolveCache
  readonly stopReason: (sessionID: SessionSchema.ID) => Effect.Effect<StopReason>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly stepModels: Map<string, { readonly provider: string; readonly model: string }>
  readonly shellStarts: Map<string, number>
}

/** Marks `root` broken, logs, and interrupts it — the fail-closed reaction to a write failure
 * inside a hook (hooks besides `tool.execute.before` can't fail; see plugin/hooks.ts). */
function writeGuarded(deps: Deps, root: string, sessionID: string, line: Line, kind: "detail" | "always") {
  return append(deps.writer, root, line, kind).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        deps.writer.broken.add(root)
        yield* Effect.logError("kete audit: failed to write an audit line; stopping the run", {
          sessionID,
          root,
          path: error.path,
          code: error.code,
        })
        yield* deps.interrupt(root as SessionSchema.ID)
      }),
    ),
  )
}

function sourceIds(source: PermissionEvaluation["source"]): { message_id?: string; tool_call_id?: string } {
  if (source === undefined) return {}
  return { message_id: source.messageID, tool_call_id: source.id }
}

/** Read-only: records the final `evaluate` decision, never changes it. Registered after
 * `KeteUnattended.Plugin`'s own late hook, so it sees the run's own deny/allow. */
export const onEvaluate = (deps: Deps, event: PermissionEvaluation) =>
  Effect.gen(function* () {
    const state = yield* deps.resolve.get(event.sessionID)
    if (state.kind !== "unattended") return
    const line: PermissionLine = {
      v: 1,
      ts: new Date().toISOString(),
      type: "permission",
      session_id: event.sessionID,
      root_id: state.root.id,
      ...sourceIds(event.source),
      action: event.action,
      resources: event.resources,
      effect: event.effect,
      ...(event.message !== undefined ? { message: event.message } : {}),
    }
    yield* writeGuarded(deps, state.root.id, event.sessionID, line, "always")
  })

/** Fails a call in a broken run; otherwise just records a shell call's start time. */
export const onToolBefore = (deps: Deps, event: ToolHooks["execute.before"]) =>
  Effect.gen(function* () {
    const state = yield* deps.resolve.get(event.sessionID)
    if (state.kind !== "unattended") return
    if (deps.writer.broken.has(state.root.id))
      return yield* new Tool.Error({
        message: "Unattended run stopped: its audit log can't be written; the run has been interrupted.",
      })
    if (event.tool === "shell") deps.shellStarts.set(event.id, Date.now())
  })

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return "[unserializable]"
  }
}

const stringField = (value: unknown, field: string): string | undefined =>
  Predicate.isObject(value) && Predicate.hasProperty(value, field) && typeof value[field] === "string" ? value[field] : undefined

const booleanField = (value: unknown, field: string): boolean | undefined =>
  Predicate.isObject(value) && Predicate.hasProperty(value, field) && typeof value[field] === "boolean" ? value[field] : undefined

const numberField = (value: unknown, field: string): number | undefined =>
  Predicate.isObject(value) && Predicate.hasProperty(value, field) && typeof value[field] === "number" ? value[field] : undefined

function fileLines(deps: Deps, root: string, base: LineBase, event: ToolHooks["execute.after"]) {
  return Effect.gen(function* () {
    if (event.status !== "completed") return
    const output = event.result.output
    if (event.tool === "edit") {
      const files = Predicate.isObject(output) && Array.isArray(output.files) ? output.files : []
      for (const item of files) {
        const filePath = stringField(item, "file")
        if (filePath !== undefined) yield* writeGuarded(deps, root, base.session_id, { ...base, type: "file", path: filePath, operation: "edit" }, "detail")
      }
      return
    }
    if (event.tool === "write") {
      const resource = stringField(output, "resource")
      if (resource !== undefined) yield* writeGuarded(deps, root, base.session_id, { ...base, type: "file", path: resource, operation: "write" }, "detail")
      return
    }
    if (event.tool === "patch") {
      const applied = Predicate.isObject(output) && Array.isArray(output.applied) ? output.applied : []
      for (const item of applied) {
        const resource = stringField(item, "resource")
        const kind = stringField(item, "type")
        if (resource !== undefined && (kind === "add" || kind === "update" || kind === "delete"))
          yield* writeGuarded(deps, root, base.session_id, { ...base, type: "file", path: resource, operation: kind }, "detail")
      }
    }
  })
}

function commandLine(deps: Deps, root: string, base: LineBase, event: ToolHooks["execute.after"], now: number) {
  return Effect.gen(function* () {
    const input = event.input
    const command = stringField(input, "command") ?? ""
    const cwd = stringField(input, "workdir")
    const start = deps.shellStarts.get(event.id)
    if (start !== undefined) deps.shellStarts.delete(event.id)
    const output = event.status === "completed" ? event.result.output : undefined
    const exit = numberField(output, "exit")
    const timeout = booleanField(output, "timeout")
    const running = stringField(output, "status") === "running"
    const background = running || booleanField(input, "background") === true
    const line: CommandLine = {
      ...base,
      type: "command",
      command,
      cwd,
      exit,
      background,
      timeout,
      duration_ms: start !== undefined ? now - start : undefined,
    }
    yield* writeGuarded(deps, root, base.session_id, line, "detail")
  })
}

/** Tool calls, plus derived `file` lines (edit/write/patch) and `command` lines (shell). */
export const onToolAfter = (deps: Deps, event: ToolHooks["execute.after"]) =>
  Effect.gen(function* () {
    const state = yield* deps.resolve.get(event.sessionID)
    if (state.kind !== "unattended") return
    const root = state.root.id
    const now = Date.now()
    const base: LineBase = { v: 1, ts: new Date(now).toISOString(), session_id: event.sessionID, root_id: root, message_id: event.messageID, tool_call_id: event.id }
    const input = safeJson(event.input)
    if (event.status === "completed") {
      const outputText = safeJson(event.result.output ?? event.result.content)
      const line: ToolLine = { ...base, type: "tool", tool: event.tool, agent: event.agent, input, status: "completed", output_bytes: Buffer.byteLength(outputText, "utf8"), excerpt: outputText }
      yield* writeGuarded(deps, root, event.sessionID, line, "detail")
      yield* fileLines(deps, root, base, event)
    } else {
      const line: ToolLine = { ...base, type: "tool", tool: event.tool, agent: event.agent, input, status: "error", error: event.error.message }
      yield* writeGuarded(deps, root, event.sessionID, line, "detail")
    }
    if (event.tool === "shell") yield* commandLine(deps, root, base, event, now)
  })

type BusEvent =
  | SessionEvent.Step.Started
  | SessionEvent.Step.Ended
  | SessionEvent.Step.Failed
  | SessionEvent.Execution.Succeeded
  | SessionEvent.Execution.Failed
  | SessionEvent.Execution.Interrupted

function endedReason(deps: Deps, event: BusEvent, root: string) {
  return Effect.gen(function* () {
    if (event.type === "session.execution.succeeded") return "completed" as const
    const stop = yield* deps.stopReason(event.data.sessionID)
    if (stop !== undefined) return stop
    if (deps.writer.broken.has(root)) return "audit_failed" as const
    return event.type === "session.execution.interrupted" ? ("interrupted" as const) : ("error" as const)
  })
}

function endedMessage(event: BusEvent): string | undefined {
  if (event.type === "session.execution.failed") return event.data.error.message
  if (event.type === "session.execution.interrupted") return `interrupted: ${event.data.reason}`
  return undefined
}

/** One ordered stream: pairs `Step.Started`'s model with `Step.Ended`/`Step.Failed`'s cost/tokens
 * into a `model` line, and writes `run ended` for the root's own `Execution.*` event. */
export const onEvent = (deps: Deps, event: BusEvent) =>
  Effect.gen(function* () {
    if (event.type === "session.step.started") {
      const state = yield* deps.resolve.get(event.data.sessionID)
      if (state.kind !== "unattended") return
      deps.stepModels.set(event.data.assistantMessageID, { provider: event.data.model.providerID, model: event.data.model.id })
      return
    }
    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      const state = yield* deps.resolve.get(event.data.sessionID)
      if (state.kind !== "unattended") return
      const model = deps.stepModels.get(event.data.assistantMessageID)
      deps.stepModels.delete(event.data.assistantMessageID)
      const line: ModelLine = {
        v: 1,
        ts: new Date().toISOString(),
        type: "model",
        session_id: event.data.sessionID,
        root_id: state.root.id,
        message_id: event.data.assistantMessageID,
        provider: model?.provider ?? "unknown",
        model: model?.model ?? "unknown",
        ...(event.type === "session.step.ended"
          ? { tokens: event.data.tokens, cost_usd: event.data.cost as number, finish: event.data.finish }
          : { status: "failed" as const, error: event.data.error.message }),
      }
      yield* writeGuarded(deps, state.root.id, event.data.sessionID, line, "detail")
      return
    }
    // Execution.Succeeded / Failed / Interrupted: `run ended` only for the root's own event.
    const state = yield* deps.resolve.get(event.data.sessionID)
    if (state.kind !== "unattended" || state.root.id !== event.data.sessionID) return
    const reason = yield* endedReason(deps, event, state.root.id)
    const message = endedMessage(event)
    const line: RunEnded = {
      v: 1,
      ts: new Date().toISOString(),
      type: "run",
      event: "ended",
      session_id: event.data.sessionID,
      root_id: state.root.id,
      reason,
      ...(message !== undefined ? { message } : {}),
    }
    yield* writeGuarded(deps, state.root.id, event.data.sessionID, line, "always")
  })

/** What `install` needs from the plugin, gathered by `KeteUnattended.Plugin`. `stopReason` is
 * `KeteUnattended.stopReason` bound to the plugin's own lookup — kept out of this module's runtime
 * imports so it doesn't import unattended.ts back (unattended.ts imports this module to call
 * `install`). */
export interface InstallLookup {
  readonly session: KeteUnattendedPolicy.Get
  readonly dataDir: string
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly stopReason: (sessionID: SessionSchema.ID) => Effect.Effect<StopReason>
}

/** Registers every hook that records detail lines. Call after the plugin's own late `evaluate`
 * hook, so the permission line reflects the run's final decision. */
export const install = Effect.fn("KeteAudit.install")(function* (ctx: PluginContext, lookup: InstallLookup) {
  const writer = makeWriterState(lookup.dataDir, KeyedMutex.makeUnsafe<string>(), storageFor())
  const resolve = makeResolveCache(lookup.session)
  const deps: Deps = { writer, resolve, stopReason: lookup.stopReason, interrupt: lookup.interrupt, stepModels: new Map(), shellStarts: new Map() }

  yield* ctx.permission.hook("evaluate", (event) => onEvaluate(deps, event))
  yield* ctx.tool.hook("execute.before", (event) => onToolBefore(deps, event))
  yield* ctx.tool.hook("execute.after", (event) => onToolAfter(deps, event))

  const bus = yield* Bus.Service
  yield* bus
    .subscribe([
      SessionEvent.Step.Started,
      SessionEvent.Step.Ended,
      SessionEvent.Step.Failed,
      SessionEvent.Execution.Succeeded,
      SessionEvent.Execution.Failed,
      SessionEvent.Execution.Interrupted,
    ])
    .pipe(
      Stream.runForEach((event) =>
        onEvent(deps, event).pipe(Effect.catchCause((cause) => Effect.logError("kete audit: failed to process an event", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
})
