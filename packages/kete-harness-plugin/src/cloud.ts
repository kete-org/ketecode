// Kete-owned. `cloud` mode: starts a Kete cloud job through the platform API
// (`POST /api/v1/jobs`, docs/platform/jobs-v1.md) on a repository connected to a Kete project, then
// polls `GET /api/v1/jobs/{id}` with backoff until the job is terminal or the step's own wait limit
// (the job's time limit plus a grace period for provisioning and finishing) passes, in which case
// it asks the platform to cancel the job. A cancelled step (SIGTERM from the runner, or Ctrl-C:
// `abort`) and a step that loses the job's status both ask the platform to cancel the job too, so
// no cloud job outlives the step that started it. The Kete API key goes only into the Authorization
// header.

import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { Git } from "./git.js"
import { Outputs } from "./outputs.js"
import { Run } from "./run.js"
import type { Secrets } from "./secrets.js"
import { Settings } from "./settings.js"
import { Task } from "./task.js"

export * as Cloud from "./cloud.js"

export type Deps = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch: typeof fetch
  /** Prints one line; the caller redacts it (main's logger does). */
  readonly log: (line: string) => void
  readonly redact: Secrets.Redactor
  /** Aborted when the step is cancelled (SIGTERM, SIGINT): the job is cancelled and the step ends. */
  readonly abort?: AbortSignal
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  /** Poll backoff: first wait, multiplier and cap. */
  readonly poll?: { readonly initialMs: number; readonly factor: number; readonly maxMs: number }
  /** Wait beyond the job's time limit for provisioning and finishing. */
  readonly graceMs?: number
  readonly requestTimeoutMs?: number
  /** The cancel request's own, shorter limit: a cancelled step has little time left. */
  readonly cancelTimeoutMs?: number
}

export const terminal = ["succeeded", "failed", "cancelled", "timed_out"] as const
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The fields of the platform's `Job` this step reads; the rest is ignored (responses only gain fields). */
type Job = {
  id: string
  status: string
  outcome: string | null
  branch: string | undefined
  pushStatus: string | undefined
  prURL: string | null
  summary: string | null
}

type Report = Run.Report

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** A platform error code goes into the outputs only when it looks like one. */
export function errorCode(raw: unknown, status: number): string {
  return typeof raw === "string" && /^[a-z0-9_]{1,60}$/.test(raw) ? raw : `http_${status}`
}

export async function run(settings: Settings.CloudSettings, deps: Deps): Promise<Report> {
  const redact = deps.redact
  const abort = deps.abort
  const baseSleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // Sleeps end early when the step is cancelled.
  const sleep = (ms: number) =>
    abort === undefined
      ? baseSleep(ms)
      : abort.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const done = () => {
              abort.removeEventListener("abort", done)
              resolve()
            }
            abort.addEventListener("abort", done)
            baseSleep(ms).then(done, done)
          })
  const now = deps.now ?? Date.now
  const poll = deps.poll ?? { initialMs: 5_000, factor: 1.5, maxMs: 30_000 }
  const root = realpathSync(Run.workspace(deps.env))
  const output = Run.outputDirectory(root, settings.outputDir)
  const finish = (
    exit: Outputs.ExitCode,
    outcome: string,
    summary: string,
    extra: { url?: string; branch?: string; lines?: string[] } = {},
  ): Report => {
    Outputs.writeArtifact(
      output,
      "summary.md",
      redact(
        [`## Kete Code cloud job: ${outcome}`, "", ...(extra.lines ?? []).map((l) => `- ${l}`), "", summary, ""].join(
          "\n",
        ),
      ),
    )
    return {
      exit,
      values: {
        KETE_OUTCOME: outcome,
        KETE_SUMMARY: Outputs.oneLine(summary, redact),
        KETE_BRANCH: extra.branch ?? "",
        KETE_JOB_URL: extra.url ?? "",
      },
    }
  }

  let built: Task.Built
  try {
    const latestTag =
      settings.preset === "release-notes" && settings.base === undefined
        ? Git.latestTag(root, { env: Run.sanitize(deps.env), redact })
        : undefined
    built = Task.build(settings, {
      workspace: root,
      targetBranch: deps.env.DRONE_TARGET_BRANCH?.trim() || undefined,
      latestTag,
      redact,
    })
  } catch (error) {
    if (error instanceof Task.TaskError) {
      deps.log(`refused: ${error.message}`)
      return finish(2, "refused", error.message)
    }
    throw error
  }

  if (abort?.aborted) {
    deps.log("the step was cancelled before the job was started")
    return finish(1, "step_cancelled", "The step was cancelled before the cloud job was started.")
  }
  const api = client(settings, deps, sleep)
  const body = {
    project_id: settings.project,
    repository_id: settings.repository,
    agent: settings.agent,
    prompt: built.prompt,
    allow: built.allow,
    budget_micros: Math.round(settings.budget * 1_000_000),
    timeout_minutes: settings.timeout,
    ...(settings.baseRef ? { base_ref: settings.baseRef } : {}),
    ...(settings.push?.suffix ? { branch_suffix: settings.push.suffix } : {}),
    push: settings.push !== undefined,
    open_pr: settings.openPR,
  }
  // A key per step invocation (or the configured one) makes the create's own retries safe.
  const idempotencyKey = settings.idempotencyKey ?? `kete-harness-${randomUUID()}`

  let job: Job
  try {
    job = await api.create(body, idempotencyKey)
  } catch (error) {
    if (error instanceof ApiError) {
      const refused = [400, 401, 402, 403, 404, 422].includes(error.status)
      const outcome = refused ? error.code : "error"
      deps.log(
        `${refused ? "refused" : "error"}: the platform didn't start the job (HTTP ${error.status} ${error.code}): ${error.message}`,
      )
      return finish(
        refused ? 2 : 1,
        outcome,
        `The platform didn't start the job (HTTP ${error.status} ${error.code}): ${error.message}`,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.log(`error: couldn't reach the Kete platform: ${message}`)
    return finish(1, "error", `Couldn't reach the Kete platform: ${message}`)
  }

  const url = `${settings.baseURL}/jobs/${job.id}`
  deps.log(`started cloud job ${job.id}: ${url}`)
  /** Best effort, bounded by `cancelTimeoutMs`: a failure is logged, never thrown. */
  const cancel = async (why: string) => {
    deps.log(`${why}; asking the platform to cancel job ${job.id}`)
    try {
      await api.cancel(job.id)
      return true
    } catch (error) {
      deps.log(`cancel failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  const cancelled = async () => {
    const ok = await cancel("the step was cancelled")
    return finish(
      1,
      "step_cancelled",
      ok
        ? "The step was cancelled; cancellation of the cloud job was requested."
        : `The step was cancelled; cancelling the cloud job failed, so it may still be running: ${url}`,
      { url, lines: [`Job: ${url}`] },
    )
  }
  const deadline = now() + settings.timeout * 60_000 + (deps.graceMs ?? 15 * 60_000)
  let wait = poll.initialMs
  let failures = 0
  let lastStatus = job.status
  while (!(terminal as readonly string[]).includes(job.status)) {
    if (abort?.aborted) return cancelled()
    if (now() >= deadline) {
      await cancel(`the job didn't finish within ${settings.timeout} min plus the grace period`)
      return finish(
        1,
        "time_limit",
        "The cloud job didn't finish within the step's time limit; cancellation was requested.",
        {
          url,
          lines: [`Job: ${url}`],
        },
      )
    }
    await sleep(Math.min(wait, Math.max(0, deadline - now())))
    if (abort?.aborted) return cancelled()
    wait = Math.min(Math.round(wait * poll.factor), poll.maxMs)
    try {
      job = await api.get(job.id)
      failures = 0
    } catch (error) {
      failures++
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        deps.log(`error: the platform refused the status request (HTTP ${error.status} ${error.code})`)
        return finish(1, "error", `Lost access to the job's status (HTTP ${error.status} ${error.code}).`, {
          url,
          lines: [`Job: ${url}`],
        })
      }
      if (failures >= 6) {
        deps.log(`error: status requests keep failing: ${message}`)
        const ok = await cancel("the step can't follow the job any more")
        return finish(
          1,
          "error",
          ok
            ? "Status requests kept failing; cancellation of the cloud job was requested."
            : `Status requests kept failing and cancelling failed; the job may still be running: ${url}`,
          { url, lines: [`Job: ${url}`] },
        )
      }
      deps.log(`status request failed (${failures}), retrying: ${message}`)
      continue
    }
    if (job.status !== lastStatus) {
      deps.log(`job ${job.status}`)
      lastStatus = job.status
    }
  }

  const outcome = job.outcome ?? job.status
  const exit: Outputs.ExitCode =
    job.status === "succeeded" ? 0 : job.status === "failed" ? Outputs.exitCode(outcome) : 1
  const branch = job.pushStatus === "created" && job.branch ? job.branch : ""
  const lines = [
    `Job: ${url}`,
    `Status: ${job.status}${job.outcome ? ` (${job.outcome})` : ""}`,
    ...(job.pushStatus && job.pushStatus !== "not_requested"
      ? [`Push: ${job.pushStatus}${branch ? ` (${branch})` : ""}`]
      : []),
    ...(job.prURL ? [`Pull request: ${job.prURL}`] : []),
  ]
  for (const line of lines) deps.log(line)
  return finish(exit, outcome, job.summary ?? "", { url, branch, lines })
}

function client(settings: Settings.CloudSettings, deps: Deps, sleep: (ms: number) => Promise<void>) {
  const timeoutMs = deps.requestTimeoutMs ?? 30_000
  const cancelTimeoutMs = deps.cancelTimeoutMs ?? 10_000
  const headers = {
    authorization: `Bearer ${settings.key}`,
    accept: "application/json",
    "user-agent": "kete-harness-plugin",
  }
  const call = async (
    method: string,
    route: string,
    body?: unknown,
    extra: Record<string, string> = {},
    limitMs = timeoutMs,
  ) => {
    const response = await deps.fetch(`${settings.baseURL}${route}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(limitMs),
      redirect: "error",
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
      const code = errorCode(error?.code, response.status)
      const message = typeof error?.message === "string" ? deps.redact(error.message).slice(0, 500) : "no details"
      throw new ApiError(response.status, code, message)
    }
    return json
  }
  /** Retries network errors, 429 and 5xx with backoff, bounded. */
  const retrying = async <T>(fn: () => Promise<T>): Promise<T> => {
    let delay = 1_000
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn()
      } catch (error) {
        const transient = !(error instanceof ApiError) || error.status === 429 || error.status >= 500
        if (!transient || attempt >= 4) throw error
        await sleep(delay)
        delay *= 2
      }
    }
  }
  return {
    create: (body: unknown, idempotencyKey: string) =>
      retrying(() => call("POST", "/api/v1/jobs", body, { "idempotency-key": idempotencyKey })).then(parseJob),
    get: (id: string) => call("GET", `/api/v1/jobs/${id}`).then(parseJob),
    cancel: (id: string) => call("POST", `/api/v1/jobs/${id}/cancel`, undefined, {}, cancelTimeoutMs),
  }
}

/** Validates the part of `JobResponse` this step relies on. */
export function parseJob(json: unknown): Job {
  const job = (json as { job?: Record<string, unknown> } | undefined)?.job
  if (!job || typeof job !== "object") throw new Error("the platform's response has no job")
  const id = job.id
  const status = job.status
  if (typeof id !== "string" || !GUID.test(id)) throw new Error("the platform's response has no valid job id")
  if (typeof status !== "string" || !/^[a-z_]{1,40}$/.test(status))
    throw new Error("the platform's response has no valid job status")
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined)
  const pr = str(job.pr_url, 500)
  const reported = job.reported as { summary_text?: unknown } | undefined
  return {
    id,
    status,
    outcome: str(job.outcome, 40) ?? null,
    branch: str(job.branch, 255),
    pushStatus: str(job.push_status, 40),
    prURL: pr && pr.startsWith("https://") ? pr : null,
    summary: str(reported?.summary_text, 8192) ?? null,
  }
}
