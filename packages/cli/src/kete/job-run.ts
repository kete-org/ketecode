// `kete job run`'s orchestration (ADR 0005/0008): validates a job spec, creates an isolated git
// worktree and branch for it (D1 — the CLI runs `git worktree add -b` itself, never
// `POST /api/worktree`, so no project setup script runs outside the job's policy and audit),
// starts an unattended session there, waits for it to finish, and reports how it ended.
//
// In job mode (`Input.jobMode`, a cloud job) the root entrypoint has already cloned the repository
// and created the worktree and branch (ADR 0019 rule 5), and `kete` may not run git at all, so the
// run uses cwd as that prepared worktree instead of creating one.
//
// Pure over `Deps` (every side effect — the SDK client, git, the filesystem, the clock, output —
// is injected) so tests run it against fakes, and the server package's end-to-end test
// (`server/test/kete/job-run.test.ts`) can import this module directly against a real embedded
// server. That test crosses a package boundary, so this file deliberately imports only
// `@opencode/client/promise`, `@opencode/schema/*`, `@opencode/util/*`, `node:*` and `effect`
// (never another `cli/src/*` module, not even `./job-spec.js` or `./job-git.js` — `Spec`/`Git`
// below are written out structurally instead, so a `JobSpec.Spec` or the real `JobGit` module can
// be passed in without an import here).

export * as JobRun from "./job-run.js"

import path from "node:path"
import type { JsonValue, OpenCodeClient } from "@opencode/client/promise"
import { Model } from "@opencode/schema/model"
import { SessionMessage } from "@opencode/schema/session-message"
import { Brand } from "@opencode/util/kete/brand"

// --- Input: an already-parsed, already-validated job spec (job.ts calls `JobSpec.parse` first). ---

export interface AllowRule {
  readonly action: string
  readonly resource: string
}

export interface Policy {
  readonly version: 1
  readonly allow?: ReadonlyArray<AllowRule>
  readonly budget: number
  readonly timeout: number
}

export interface Spec {
  readonly version: 1
  readonly prompt: string
  readonly agent?: string
  readonly model?: string
  readonly policy: Policy
  readonly branch?: string
}

export interface Input {
  readonly spec: Spec
  /** The directory the job runs in; job-relative paths (the worktree, the session location) are
   * computed from here. */
  readonly cwd: string
  /** Set only when the user passed `--server <url>` explicitly (D1's locality check). */
  readonly serverUrl?: string
  readonly json: boolean
  /** Job mode (`KeteJobMode.enabled`): `cwd` is the worktree the cloud job's entrypoint already
   * prepared (ADR 0019 rule 5). The run makes no git call at all (`job-git.ts` refuses every one in
   * job mode), needs `spec.branch` (the branch the entrypoint checked out) and a `.git` in `cwd`,
   * and reports `isolated: true` with `worktree` = `cwd`. Nothing is created or cleaned up. */
  readonly jobMode?: boolean
}

// --- Deps: every side effect, written out structurally so callers never import this module's
// sibling files (see the header). `JobGit`'s exports already match `Git`; `job.ts` passes it
// (or a fake with the same shape) directly. ---

export interface GitResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface GitDiscardResult {
  readonly remove: GitResult
  readonly branch: GitResult
}

export interface Git {
  readonly run: (
    cwd: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ) => Promise<GitResult>
  readonly worktreeAdd: (
    root: string,
    input: { readonly branch: string; readonly path: string; readonly base: string },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<GitResult>
  readonly worktreeDiscard: (
    root: string,
    input: { readonly path: string; readonly branch: string },
    options?: { readonly signal?: AbortSignal },
  ) => Promise<GitDiscardResult>
}

export interface StatLike {
  readonly size: number
  readonly isFile: () => boolean
}

export interface Deps {
  readonly client: OpenCodeClient
  readonly git: Git
  readonly readFile: (file: string) => Promise<string>
  readonly stat: (file: string) => Promise<StatLike>
  readonly exists: (file: string) => Promise<boolean>
  readonly realpath: (file: string) => Promise<string>
  /** Where job worktrees are created: `<dataDir>/worktree/<project id[0:6]>/job-<id8>` (handler
   * default: `Global.Path.data`, upstream's own worktree-parent convention). */
  readonly dataDir: string
  /** Where the unattended audit log lives (handler default: `path.join(Global.Path.data, "audit")`). */
  readonly auditDir: string
  /** How long to poll for the audit log's "run ended" line before falling back to the event
   * stream (default 5s, `job.ts` never overrides it — for tests only). */
  readonly auditPollTimeoutMs?: number
  /** Job mode (piece A3): the audit log has no file; this returns the root's kept lines from the
   * audit relay (JSON Lines), or `undefined`. Without it the file under `auditDir` is read. */
  readonly readAudit?: (rootID: string) => Promise<string | undefined>
  /** Job mode: the audit relay's failure, if any — the run then ends `audit_failed`. */
  readonly auditFailure?: () => string | undefined
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** Registers this run's SIGINT responder; called at most once. The real handler (`job.ts`) wires
   * `process.on("SIGINT", ...)` and owns the "second SIGINT exits at once" behavior itself — this
   * run only needs to know a person asked to stop. Returns an unregister function. */
  readonly onInterrupt: (handler: () => void) => () => void
  /** `Env.session()` when the server is the background service; omitted for `--standalone`/`--server`. */
  readonly environment?: Readonly<Record<string, string>>
  readonly randomId: () => string
  /** True when `client` is attached to the background service (controls whether `session.environment` runs). */
  readonly attached: boolean
}

// --- Result (the `--json` contract, v1: additive-only from here on). ---

export type Outcome = "completed" | "error" | "refused" | "audit_failed" | "time_limit" | "budget" | "interrupted"

export interface Denial {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly message?: string
}

export interface Result {
  readonly version: 1
  readonly outcome: Outcome
  readonly exit_code: number
  readonly session_id?: string
  readonly text?: string
  readonly isolated?: boolean
  readonly branch?: string
  readonly worktree?: string
  readonly directory?: string
  readonly cost_usd?: number
  readonly cost_scope?: "family" | "root"
  readonly duration_ms?: number
  readonly audit_log?: string
  readonly audit_local?: boolean
  readonly denied: ReadonlyArray<Denial>
  readonly message?: string
}

const EXIT_FOR_REASON: Record<string, number> = {
  completed: 0,
  error: 1,
  refused: 2,
  audit_failed: 2,
  time_limit: 3,
  budget: 4,
  interrupted: 130,
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host === "::1") return true
  const octets = host.split(".")
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** A partial `Result`, filled in as the run progresses; `finish` turns it into the real thing. */
type Partial = Omit<Result, "version" | "denied" | "exit_code" | "outcome"> & { denied?: ReadonlyArray<Denial> }

function finish(outcome: Outcome, partial: Partial, exitCode?: number): { readonly exitCode: number; readonly result: Result } {
  const code = exitCode ?? EXIT_FOR_REASON[outcome] ?? 1
  return { exitCode: code, result: { version: 1, outcome, exit_code: code, denied: partial.denied ?? [], ...partial } }
}

function refuse(message: string, partial: Partial = {}): { readonly exitCode: number; readonly result: Result } {
  return finish("refused", { ...partial, message })
}

// --- git helpers ---

async function repoRoot(deps: Deps, cwd: string): Promise<string | undefined> {
  const result = await deps.git.run(cwd, ["rev-parse", "--show-toplevel"])
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

async function headSha(deps: Deps, root: string): Promise<string | undefined> {
  const result = await deps.git.run(root, ["rev-parse", "HEAD"])
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

async function hasUncommittedChanges(deps: Deps, root: string): Promise<boolean> {
  const result = await deps.git.run(root, ["status", "--porcelain"])
  return result.exitCode === 0 && result.stdout.trim().length > 0
}

/** Upstream's own worktree-name collision handling (`core/src/worktree.ts:219-224`): `name`, then
 * `name-2` … `name-10`; `undefined` past that. */
async function pickWorktreePath(deps: Deps, parent: string, name: string): Promise<string | undefined> {
  let candidate = path.join(parent, name)
  if (!(await deps.exists(candidate))) return candidate
  for (let suffix = 2; suffix <= 10; suffix++) {
    candidate = path.join(parent, `${name}-${suffix}`)
    if (!(await deps.exists(candidate))) return candidate
  }
  return undefined
}

// --- audit log ---

interface AuditRunEnded {
  readonly reason: string
  readonly message?: string
}

function parseAuditLines(content: string): ReadonlyArray<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) lines.push(parsed as Record<string, unknown>)
    } catch {
      // A truncated or partially-flushed final line: ignore it, like a reader tailing the file would.
    }
  }
  return lines
}

function findRunEnded(lines: ReadonlyArray<Record<string, unknown>>): AuditRunEnded | undefined {
  for (const line of lines) {
    if (line["type"] === "run" && line["event"] === "ended") {
      const reason = line["reason"]
      const message = line["message"]
      if (typeof reason === "string") return { reason, message: typeof message === "string" ? message : undefined }
    }
  }
  return undefined
}

function sumModelCost(lines: ReadonlyArray<Record<string, unknown>>): number | undefined {
  let total = 0
  let any = false
  for (const line of lines) {
    if (line["type"] !== "model") continue
    const cost = line["cost_usd"]
    if (typeof cost === "number") {
      total += cost
      any = true
    }
  }
  return any ? total : undefined
}

function collectDenials(lines: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<Denial> {
  const denials: Denial[] = []
  for (const line of lines) {
    if (line["type"] !== "permission" || line["effect"] !== "deny") continue
    const action = line["action"]
    const resources = line["resources"]
    if (typeof action !== "string" || !Array.isArray(resources)) continue
    const message = line["message"]
    denials.push({ action, resources: resources.filter((item): item is string => typeof item === "string"), message: typeof message === "string" ? message : undefined })
  }
  return denials
}

const DEFAULT_AUDIT_POLL_TIMEOUT_MS = 5_000

/** Polls `<auditDir>/<rootID>.jsonl` (job mode: the relay's lines, `Deps.readAudit`) for up to `deps.auditPollTimeoutMs` (default 5s) for a
 * `type:"run", event:"ended"` line — the audit hook writes it asynchronously after the execution
 * event a client sees on the wire. The default is what job.ts uses; tests shrink it. */
async function readAuditContent(deps: Deps, auditFile: string, rootID: string): Promise<string | undefined> {
  if (deps.readAudit !== undefined) return deps.readAudit(rootID).catch(() => undefined)
  if (!(await deps.exists(auditFile))) return undefined
  return deps.readFile(auditFile).catch(() => undefined)
}

async function pollAuditEnded(deps: Deps, auditFile: string, rootID: string): Promise<ReadonlyArray<Record<string, unknown>> | undefined> {
  const deadline = deps.now() + (deps.auditPollTimeoutMs ?? DEFAULT_AUDIT_POLL_TIMEOUT_MS)
  while (deps.now() < deadline) {
    // A failed relay delivers nothing more: stop waiting (the caller reports `audit_failed`).
    if (deps.auditFailure?.() !== undefined) return undefined
    const content = await readAuditContent(deps, auditFile, rootID)
    if (content !== undefined) {
      const lines = parseAuditLines(content)
      if (findRunEnded(lines) !== undefined) return lines
    }
    await deps.sleep(250)
  }
  return undefined
}

// --- event stream ---

interface WatchState {
  bugTriggered: boolean
  terminal?: { readonly type: string; readonly reason?: string; readonly error?: { readonly type: string; readonly message: string } }
  disconnected?: Error
}

/** Watches the event stream for the job's root session: replies `reject` and interrupts on a
 * `permission.asked` (a runtime bug — an unattended family should never ask, D3/applyLate), and
 * records the root's own terminal execution event for the no-local-audit-file fallback. Stops on
 * that terminal event, a stream error, or the controller being aborted from outside. Continues an
 * iterator `run` already opened and read the first ("connected") event from — one subscription,
 * not two, so nothing arriving between the connect check and this function starting is missed. */
async function watchEvents(
  iterator: AsyncIterator<{ readonly type: string; readonly data: unknown }>,
  client: OpenCodeClient,
  controller: AbortController,
  rootSessionID: string,
  state: WatchState,
  first: { readonly type: string; readonly data: unknown },
): Promise<void> {
  const handle = async (event: { readonly type: string; readonly data: unknown }): Promise<boolean> => {
    const data = event.data as Record<string, unknown>
    if (event.type === "permission.asked" && data["sessionID"] === rootSessionID && !state.bugTriggered) {
      state.bugTriggered = true
      const requestID = data["id"]
      if (typeof requestID === "string")
        await client.permission.reply({ sessionID: rootSessionID, requestID, decision: "reject" }).catch(() => {})
      await client.session.interrupt({ sessionID: rootSessionID }).catch(() => {})
      return true
    }
    if (
      (event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted") &&
      data["sessionID"] === rootSessionID
    ) {
      state.terminal = {
        type: event.type,
        reason: typeof data["reason"] === "string" ? (data["reason"] as string) : undefined,
        error: isErrorLike(data["error"]) ? (data["error"] as { type: string; message: string }) : undefined,
      }
      return true
    }
    return false
  }
  try {
    if (await handle(first)) return
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      if (await handle(next.value)) return
    }
  } catch (error) {
    if (controller.signal.aborted) return // we stopped the stream ourselves; not a disconnect
    state.disconnected = error instanceof Error ? error : new Error(String(error))
  }
}

function isErrorLike(value: unknown): value is { readonly type: string; readonly message: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)["type"] === "string" &&
    typeof (value as Record<string, unknown>)["message"] === "string"
  )
}

// --- main sequence ---

/** Defense in depth: `job.ts` always validates a spec through `JobSpec.parse` before building one
 * of these, but `run` doesn't trust its caller's TypeScript types alone — a bad `Spec` (this
 * module's tests build one directly) is refused here too, before any git or client call, exactly
 * like an unparseable spec file would be. */
function validateSpec(spec: Spec): string | undefined {
  if (spec.version !== 1) return "spec.version: must be 1"
  if (spec.prompt.trim().length === 0) return "spec.prompt: must not be empty"
  if (!Number.isFinite(spec.policy.budget) || spec.policy.budget <= 0) return "spec.policy.budget: must be a number greater than 0"
  if (!Number.isFinite(spec.policy.timeout) || spec.policy.timeout <= 0) return "spec.policy.timeout: must be a number greater than 0"
  if (spec.branch !== undefined && !validRefName(spec.branch)) return "spec.branch: is not a valid git branch name"
  if (spec.model !== undefined) {
    try {
      Model.Ref.parse(spec.model)
    } catch (error) {
      return `spec.model: ${error instanceof Error ? error.message : "invalid model reference"}`
    }
  }
  return undefined
}

/** The same conservative ref-name subset `job-spec.ts` checks (duplicated rather than imported —
 * see the header on why this module imports nothing from its siblings). */
function validRefName(name: string): boolean {
  if (name.length === 0) return false
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  if (name.includes("..") || name.includes("@{")) return false
  if (name.startsWith("-") || name.startsWith("/")) return false
  if (name.endsWith("/") || name.endsWith(".lock") || name.endsWith(".")) return false
  return true
}

/** Parses and validates a spec, runs the job, and returns `{exitCode, result}` — no I/O beyond
 * `deps` (git, the client, the filesystem). `run` (below) is the same thing plus the output
 * contract (`--json` vs. text + a summary); tests mostly call this one directly. */
async function execute(input: Input, deps: Deps): Promise<{ readonly exitCode: number; readonly result: Result }> {
  const started = deps.now()
  const { spec } = input

  const specProblem = validateSpec(spec)
  if (specProblem !== undefined) return refuse(specProblem)

  // D1: a --server whose host isn't loopback is refused before anything is created. The
  // background service and --standalone are always local (no URL to check).
  if (input.serverUrl !== undefined) {
    let hostname: string
    try {
      hostname = new URL(input.serverUrl).hostname
    } catch {
      return refuse(`--server is not a valid URL: ${input.serverUrl}`)
    }
    if (!isLoopbackHost(hostname))
      return refuse(`kete job run needs the server on this machine (--server ${input.serverUrl} is not loopback)`)
  }

  const cwd = input.cwd
  const jobMode = input.jobMode === true
  if (jobMode) {
    if (spec.branch === undefined)
      return refuse("job mode needs spec.branch (the branch the job's prepared worktree is on)", { isolated: true })
    if (!(await deps.exists(path.join(cwd, ".git"))))
      return refuse(`job mode needs a prepared worktree, but ${cwd} has no .git`, { isolated: true, branch: spec.branch })
  }
  const root = jobMode ? undefined : await repoRoot(deps, cwd)
  const isolated = jobMode || root !== undefined
  if (!isolated && spec.branch !== undefined)
    return refuse(`a branch was requested ("${spec.branch}") but ${cwd} is not a git repository`, { isolated: false })

  // D1: the server (and thus the worktree the CLI is about to create) must be reachable at this
  // directory on this machine — a loopback tunnel to another host would otherwise pass the URL check above.
  const location = await deps.client.location
    .get({ location: { directory: cwd } })
    .catch((error: unknown) => ({ error }))
  if ("error" in location) return refuse(`could not reach the server to resolve ${cwd}: ${errorMessage(location.error)}`, { isolated })
  const [localReal, serverReal] = await Promise.all([
    deps.realpath(cwd).catch(() => cwd),
    deps.realpath(location.directory).catch(() => location.directory),
  ])
  if (localReal !== serverReal)
    return refuse(`kete job run needs the server on this machine (server sees ${location.directory}, not ${cwd})`, { isolated })

  let worktree: string | undefined
  let branch: string | undefined
  let sessionDirectory = cwd

  if (jobMode) {
    worktree = cwd
    branch = spec.branch
  } else if (isolated) {
    const rootDir = root!
    const sha = await headSha(deps, rootDir)
    if (sha === undefined) return refuse(`${rootDir} has no commits yet; kete job run needs a base commit`, { isolated })

    const id8 = deps.randomId().slice(0, 8).toLowerCase()
    branch = spec.branch ?? `${Brand.cliName}/job/${id8}`
    const parent = path.join(deps.dataDir, "worktree", location.project.id.slice(0, 6))
    const candidate = await pickWorktreePath(deps, parent, `job-${id8}`)
    if (candidate === undefined)
      return refuse(`could not find a free worktree directory under ${parent} for job-${id8}`, { isolated })
    worktree = candidate

    const created = await deps.git.worktreeAdd(rootDir, { branch, path: worktree, base: sha })
    if (created.exitCode !== 0)
      return refuse(`git worktree add failed: ${created.stderr.trim() || created.stdout.trim() || "unknown error"}`, {
        isolated,
        branch,
      })

    const subpath = path.relative(rootDir, cwd).split(path.sep).join("/")
    sessionDirectory = subpath ? path.join(worktree, subpath) : worktree
  }

  const cleanup = async () => {
    // Job mode: the worktree is the entrypoint's, never this run's to discard.
    if (jobMode || worktree === undefined || branch === undefined) return
    const discard = await deps.git.worktreeDiscard(root!, { path: worktree, branch })
    if (discard.remove.exitCode !== 0 || discard.branch.exitCode !== 0)
      deps.stderr(
        `warning: failed to clean up the unused worktree/branch (${worktree}, ${branch}): ${discard.remove.stderr.trim()} ${discard.branch.stderr.trim()}`.trim() +
          "\n",
      )
  }

  // Defense in depth: `validateSpec` above already refused a bad `model` before anything was
  // created, so this should never throw — but a thrown error here would otherwise crash the run
  // instead of reporting a clean `refused` outcome, after the worktree may already exist.
  let model: { readonly providerID: string; readonly id: string; readonly variant?: string } | undefined
  if (spec.model !== undefined) {
    try {
      model = parseModel(spec.model)
    } catch (error) {
      await cleanup()
      return refuse(`spec.model: ${errorMessage(error)}`, { isolated, branch, worktree, directory: sessionDirectory })
    }
  }
  const session = await deps.client.session
    .create({
      agent: spec.agent,
      model,
      // An explicit title, like `kete run --title`: skips a separate title-generation model
      // request most runs have no reason to pay for.
      title: spec.prompt.slice(0, 80) + (spec.prompt.length > 80 ? "…" : ""),
      location: { directory: sessionDirectory },
      metadata: { "kete.unattended": spec.policy as unknown as JsonValue },
    })
    .catch((error: unknown) => ({ error }))
  if ("error" in session) {
    await cleanup()
    return refuse(`could not create the job's session: ${errorMessage(session.error)}`, { isolated, branch, worktree, directory: sessionDirectory })
  }

  if (deps.attached && deps.environment !== undefined) {
    const result = await deps.client.session
      .environment({ sessionID: session.id, variables: deps.environment })
      .catch((error: unknown) => ({ error }))
    if (result !== undefined && "error" in result) {
      await cleanup()
      return refuse(`could not set the job's session environment: ${errorMessage(result.error)}`, {
        isolated,
        branch,
        worktree,
        directory: sessionDirectory,
        session_id: session.id,
      })
    }
  }

  deps.stderr(`kete job run: branch ${branch ?? "(none — not isolated)"}, worktree ${worktree ?? "(none)"}, session ${session.id}\n`)
  if (isolated && root !== undefined && (await hasUncommittedChanges(deps, root)))
    deps.stderr(`kete job run: ${cwd} has uncommitted changes; the job's worktree starts from the last commit only\n`)

  const controller = new AbortController()
  const watchState: WatchState = { bugTriggered: false }
  let admitted = false
  try {
    // Subscribe before prompting: the first event confirms the stream is live (`session-target.ts`/
    // `noninteractive.ts`'s pattern), and a permission.asked or the root's terminal event must never
    // be missed to a race with the prompt call.
    const iterator = deps.client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    const connected = await iterator.next()
    if (connected.done) throw new Error("event stream disconnected before the job's prompt was admitted")
    admitted = true
    const watching = watchEvents(iterator, deps.client, controller, session.id, watchState, connected.value)

    let weInterrupted = false
    const unregister = deps.onInterrupt(() => {
      weInterrupted = true
      void deps.client.session.interrupt({ sessionID: session.id }).catch(() => {})
    })

    try {
      await deps.client.session.prompt({
        sessionID: session.id,
        id: SessionMessage.ID.create(),
        text: spec.prompt,
        delivery: "steer",
      })

      // The watchdog is a last resort: if the runtime hasn't ended the run by timeout + 2 minutes,
      // interrupt it and move on to collecting the outcome — never wait unboundedly a second time,
      // even for a run whose interrupt itself doesn't take (e.g. a hung, non-cooperating shell).
      const watchdogMs = (spec.policy.timeout + 2) * 60_000
      let watchdogFired = false
      const waited = deps.client.session.wait({ sessionID: session.id })
      const watchdog = deps.sleep(watchdogMs).then(() => {
        watchdogFired = true
      })
      await Promise.race([waited, watchdog])
      if (watchdogFired) {
        weInterrupted = false // a watchdog stop is "the runtime never ended the run", not a user interrupt
        await deps.client.session.interrupt({ sessionID: session.id }).catch(() => {})
      }
      await Promise.race([watching, deps.sleep(2_000)])
      controller.abort()

      return await collectOutcome(deps, {
        session,
        cwd,
        root,
        worktree,
        branch,
        isolated,
        started,
        weInterrupted,
        watchState,
        timeoutMinutes: spec.policy.timeout,
      })
    } finally {
      unregister()
    }
  } catch (error) {
    controller.abort()
    if (!admitted) {
      await cleanup()
      return refuse(`could not reach the job's server: ${errorMessage(error)}`, { isolated, branch, worktree, directory: sessionDirectory, session_id: session.id })
    }
    return finish("error", {
      isolated,
      branch,
      worktree,
      directory: sessionDirectory,
      session_id: session.id,
      message: errorMessage(error),
    })
  }
}

function parseModel(value: string): { readonly providerID: string; readonly id: string; readonly variant?: string } {
  const ref = Model.Ref.parse(value)
  return { providerID: ref.providerID, id: ref.id, variant: ref.variant }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function collectOutcome(
  deps: Deps,
  input: {
    readonly session: { readonly id: string; readonly time: { readonly created: number } }
    readonly cwd: string
    readonly root: string | undefined
    readonly worktree: string | undefined
    readonly branch: string | undefined
    readonly isolated: boolean
    readonly started: number
    readonly weInterrupted: boolean
    readonly watchState: WatchState
    readonly timeoutMinutes: number
  },
): Promise<{ readonly exitCode: number; readonly result: Result }> {
  const duration_ms = () => deps.now() - input.started
  const base: Partial = {
    session_id: input.session.id,
    isolated: input.isolated,
    branch: input.branch,
    worktree: input.worktree,
    directory: input.cwd,
  }

  // A permission.asked in an unattended family can only mean a runtime bug (D3/applyLate denies
  // every ask); say so plainly rather than whatever the audit log's own "interrupted" reason says.
  if (input.watchState.bugTriggered)
    return finish("error", { ...base, duration_ms: duration_ms(), message: "bug: the runtime asked for a permission in an unattended run" })

  const auditFile = path.join(deps.auditDir, `${input.session.id}.jsonl`)
  // N2: in job mode the log has no path (it went to the entrypoint's pipe), so no `audit_log`.
  const auditPath: Partial = deps.readAudit === undefined ? { audit_log: auditFile } : {}

  // Job mode: a failed relay means part of the run went unaudited — the run is `audit_failed`
  // whatever the (possibly unrelayed) `run ended` line says. Checked before and again after the
  // poll: the relay keeps a line only once it was forwarded, so a `run ended` whose push failed
  // (the cap, a timeout, a broken pipe) never arrives, and the poll would otherwise fall back to the
  // event stream and report the run as if it had been audited.
  const auditFailed = async () => {
    const relayFailure = deps.auditFailure?.()
    if (relayFailure === undefined) return undefined
    const text = await lastAssistantText(deps.client, input.session.id)
    return finish("audit_failed", {
      ...base,
      duration_ms: duration_ms(),
      text,
      audit_local: true,
      message: `the job's audit log could not be delivered (${relayFailure}); the run was interrupted`,
    })
  }
  const failedBefore = await auditFailed()
  if (failedBefore !== undefined) return failedBefore

  const lines = await pollAuditEnded(deps, auditFile, input.session.id)

  const failedAfter = await auditFailed()
  if (failedAfter !== undefined) return failedAfter

  const text = await lastAssistantText(deps.client, input.session.id)

  if (lines !== undefined) {
    const ended = findRunEnded(lines)!
    const outcome = ended.reason as Outcome
    const cost = sumModelCost(lines)
    return finish(outcome, {
      ...base,
      duration_ms: duration_ms(),
      text,
      cost_usd: cost,
      cost_scope: cost !== undefined ? "family" : undefined,
      ...auditPath,
      audit_local: true,
      denied: collectDenials(lines),
      message: ended.message,
    })
  }

  // No local audit file (a remote server, or the run stopped before "run started" was written):
  // classify the root's own terminal execution event instead.
  deps.stderr(
    deps.readAudit === undefined
      ? `kete job run: no local audit log at ${auditFile}; reporting from the event stream instead\n`
      : "kete job run: no run-ended line from the job's audit sink; reporting from the event stream instead\n",
  )
  const terminal = input.watchState.terminal
  const rootCost = await rootSessionCost(deps.client, input.session.id)
  const fallbackBase: Partial = {
    ...base,
    duration_ms: duration_ms(),
    text,
    cost_usd: rootCost,
    cost_scope: rootCost !== undefined ? "root" : undefined,
    ...auditPath,
    audit_local: false,
  }

  if (terminal === undefined) {
    const message =
      input.watchState.disconnected !== undefined
        ? `event stream disconnected: ${input.watchState.disconnected.message}`
        : "the run ended without a local audit log or a terminal event to classify it from"
    return finish("error", { ...fallbackBase, message })
  }
  if (terminal.type === "session.execution.succeeded") return finish("completed", fallbackBase)
  if (terminal.type === "session.execution.failed") {
    const classified = terminal.error?.type === "unattended" ? classifyUnattended(terminal.error.message) : undefined
    if (classified !== undefined) return finish(classified, { ...fallbackBase, message: terminal.error?.message })
    return finish("error", { ...fallbackBase, message: terminal.error?.message })
  }
  // session.execution.interrupted: our own SIGINT wins; otherwise the run's own clock decides
  // whether this is the time limit (no local audit file to say so directly) or an outside interrupt.
  if (input.weInterrupted) return finish("interrupted", fallbackBase)
  const deadline = input.session.time.created + input.timeoutMinutes * 60_000
  if (deps.now() >= deadline) return finish("time_limit", fallbackBase)
  return finish("error", { ...fallbackBase, message: `interrupted: ${terminal.reason ?? "unknown"}` })
}

function classifyUnattended(message: string): Outcome | undefined {
  if (message.startsWith("Unattended run refused:")) return "refused"
  if (!message.startsWith("Unattended run stopped:")) return undefined
  if (message.includes("audit log can't be written")) return "audit_failed"
  if (message.includes("time limit")) return "time_limit"
  if (message.includes("budget")) return "budget"
  return undefined
}

async function lastAssistantText(client: OpenCodeClient, sessionID: string): Promise<string | undefined> {
  let cursor: string | undefined
  let last: string | undefined
  for (;;) {
    const page = await client.message
      .list(cursor ? { sessionID, limit: 200, cursor } : { sessionID, limit: 200, order: "desc" })
      .catch(() => undefined)
    if (page === undefined) return last
    for (const message of page.data) {
      if (message.type !== "assistant") continue
      const text = message.content
        .filter((item): item is { readonly type: "text"; readonly text: string } => item.type === "text")
        .map((item) => item.text)
        .join("")
      if (text) last = text
    }
    cursor = page.cursor.next ?? undefined
    if (!cursor) return last
  }
}

async function rootSessionCost(client: OpenCodeClient, sessionID: string): Promise<number | undefined> {
  const session = await client.session.get({ sessionID }).catch(() => undefined)
  return session ? (session.cost as number) : undefined
}

/**
 * `execute` plus the output contract: `--json` prints exactly one `Result` object to stdout and
 * nothing else; otherwise the run's final answer goes to stdout (as `execute` itself already wrote
 * the start line, and a bad spec or a git/server failure writes nothing) and a summary — outcome,
 * exit code, branch, worktree, cost, duration, the audit log path, and every denial — goes to
 * stderr.
 */
export async function run(input: Input, deps: Deps): Promise<{ readonly exitCode: number; readonly result: Result }> {
  const outcome = await execute(input, deps)
  emit(deps, input, outcome.result)
  return outcome
}

function emit(deps: Deps, input: Input, result: Result): void {
  if (input.json) {
    deps.stdout(JSON.stringify(result) + "\n")
    return
  }
  if (result.text) deps.stdout(result.text.endsWith("\n") ? result.text : result.text + "\n")
  const parts = [
    `outcome: ${result.outcome}`,
    `exit: ${result.exit_code}`,
    result.branch !== undefined ? `branch: ${result.branch}` : undefined,
    result.worktree !== undefined ? `worktree: ${result.worktree}` : undefined,
    result.cost_usd !== undefined ? `cost: $${result.cost_usd.toFixed(2)} (${result.cost_scope})` : undefined,
    result.duration_ms !== undefined ? `duration: ${Math.round(result.duration_ms / 1000)}s` : undefined,
    result.audit_log !== undefined
      ? `audit log: ${result.audit_log}${result.audit_local ? "" : " (server-side; not read locally)"}`
      : undefined,
    result.message !== undefined ? `message: ${result.message}` : undefined,
  ].filter((part): part is string => part !== undefined)
  deps.stderr(`kete job run: ${parts.join(", ")}\n`)
  for (const denial of result.denied)
    deps.stderr(`kete job run: denied ${denial.action} (${denial.resources.join(", ")})${denial.message ? `: ${denial.message}` : ""}\n`)
}
