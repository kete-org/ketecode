// `kete job run <spec>` (ADR 0005/0008): reads and validates the spec file (job-spec.ts), wires
// real dependencies (the SDK client, git, the filesystem, the clock, SIGINT) and hands off to
// job-run.ts's pure `run`. See docs/jobs.md for the spec format and exit codes.
//
// In job mode (piece A1) it first becomes non-dumpable and reads the gateway key from its descriptor
// (job-preflight.ts), then starts its own server on a private unix socket with the secrets passed by
// descriptor (job-standalone.ts) and talks to it with Bun's `fetch` over that socket. Between the
// connection check and the server it makes the first sync with the job's key (job-sync.ts, piece A2):
// a failed sync is an error, a missing or unknown `spec.agent` a refusal, and nothing is spawned.
// The audit log goes to the entrypoint's pipe through the server's relay (piece A3): the run's
// result reads the relay's lines, and a relay failure interrupts the run as `audit_failed`.

import { Service } from "@opencode/client/effect/service"
import { OpenCode } from "@opencode/client/promise"
import { Global } from "@opencode/util/global"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Effect, Option } from "effect"
import { access, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { Commands } from "../commands/commands"
import { Env } from "../env"
import { Runtime } from "../framework/runtime"
import { ServerConnection } from "../services/server-connection"
import { JobConnection } from "./job-connection"
import { JobGit } from "./job-git"
import { KeteJobPreflight } from "./job-preflight"
import { JobRun } from "./job-run"
import { JobSpec } from "./job-spec"
import { KeteJobStandalone } from "./job-standalone"
import { KeteJobSync } from "./job-sync"

const exists = (file: string) =>
  access(file)
    .then(() => true)
    .catch(() => false)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Registers job-run.ts's SIGINT responder and owns "a second SIGINT exits at once" itself — the
 * hard exit is impure, so it stays out of job-run.ts (see that file's `Deps.onInterrupt`). */
function makeOnInterrupt(audit?: KeteJobStandalone.Audit): JobRun.Deps["onInterrupt"] {
  return (handler) => {
    let count = 0
    const listener = () => {
      count++
      handler()
      if (count >= 2) process.exit(130)
    }
    process.on("SIGINT", listener)
    // Job mode: a failed audit relay stops the run the same way (job-run.ts then reports
    // `audit_failed` from `auditFailure`).
    const unsubscribe = audit?.onFailure(() => handler())
    return () => {
      process.off("SIGINT", listener)
      unsubscribe?.()
    }
  }
}

function refusedResult(message: string): JobRun.Result {
  return { version: 1, outcome: "refused", exit_code: 2, denied: [], message }
}

function errorResult(message: string): JobRun.Result {
  return { version: 1, outcome: "error", exit_code: 1, denied: [], message }
}

function report(result: JobRun.Result, json: boolean) {
  if (json) process.stdout.write(JSON.stringify(result) + "\n")
  else process.stderr.write(`kete job run: ${result.message}\n`)
  process.exitCode = result.exit_code
}

/** Bun's default five-minute deadline would terminate the event stream a long-running job needs;
 * in job mode every request also goes over the server's unix socket. */
function clientFetch(socket?: string): typeof fetch {
  return ((request: RequestInfo | URL, requestInit?: RequestInit) =>
    fetch(request, {
      ...requestInit,
      timeout: false,
      ...(socket === undefined ? {} : { unix: socket }),
    } as BunFetchRequestInit)) as typeof fetch
}

export default Runtime.handler(
  Commands.commands.job.commands.run,
  Effect.fn("cli.kete.job.run")(function* (input: Runtime.Input<typeof Commands.commands.job.commands.run>) {
    const jobMode = KeteJobMode.enabled(process.env)
    // Before anything else: non-dumpable, then the gateway key from its descriptor (job-preflight.ts).
    const preflight = jobMode ? yield* Effect.promise(() => KeteJobPreflight.run()) : undefined
    if (preflight?.kind === "refused") return report(refusedResult(preflight.message), input.json)

    const specPath = path.resolve(process.cwd(), input.spec)
    const specDeps: JobSpec.Deps = {
      readFile: (file) => readFile(file, "utf8"),
      stat: (file) => stat(file),
      realpath: (file) => realpath(file),
    }

    const parsed = yield* Effect.tryPromise({
      try: async () => {
        const text = await readFile(specPath, "utf8")
        return await JobSpec.parse(text, { specDir: path.dirname(specPath), deps: specDeps })
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.map((spec) => ({ ok: true as const, spec })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    )

    if (!parsed.ok) {
      const result = refusedResult(parsed.error.message)
      if (input.json) process.stdout.write(JSON.stringify(result) + "\n")
      else process.stderr.write(`kete job run: ${result.message}\n`)
      process.exitCode = result.exit_code
      return
    }
    const spec = parsed.spec

    const server = Option.getOrUndefined(input.server)
    const connection = JobConnection.resolve({ server, standalone: input.standalone })
    if (connection.kind === "refused") {
      const result = refusedResult(connection.message)
      if (input.json) process.stdout.write(JSON.stringify(result) + "\n")
      else process.stderr.write(`kete job run: ${result.message}\n`)
      process.exitCode = result.exit_code
      return
    }
    // Job mode: the first sync with the job's key, before any server exists (job-sync.ts).
    const synced =
      preflight?.kind === "ok"
        ? yield* Effect.promise((signal) =>
            KeteJobSync.first({
              signal,
              key: preflight.gatewayKey,
              spec,
              environment: process.env,
              config: Global.Path.config,
              data: Global.Path.data,
            }),
          )
        : undefined
    if (synced?.kind === "error") return report(errorResult(synced.message), input.json)
    if (synced?.kind === "refused") return report(refusedResult(synced.message), input.json)
    const started =
      preflight?.kind === "ok" && synced?.kind === "ok"
        ? yield* KeteJobStandalone.start({
            gatewayKey: preflight.gatewayKey,
            organization: synced.organization,
            auditFd: preflight.auditFd,
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          )
        : undefined
    if (started?.ok === false)
      return report(errorResult(`could not start the job's server: ${started.error.message}`), input.json)
    // Job mode only ever talks to its own socket server; never fall back to TCP or the service.
    if (jobMode && started?.ok !== true)
      return report(errorResult("Job mode: the job's own server was not started; refusing any other connection."), input.json)
    const resolved = started?.ok ? { endpoint: started.value.endpoint, service: undefined } : yield* ServerConnection.resolve(connection.args)

    const client = OpenCode.make({
      baseUrl: resolved.endpoint.url,
      headers: Service.headers(resolved.endpoint),
      fetch: clientFetch(started?.ok ? started.value.socket : undefined),
    })

    const runDeps: JobRun.Deps = {
      client,
      git: JobGit,
      readFile: (file) => readFile(file, "utf8"),
      stat: (file) => stat(file),
      exists,
      realpath: (file) => realpath(file),
      dataDir: Global.Path.data,
      auditDir: path.join(Global.Path.data, "audit"),
      now: () => Date.now(),
      sleep,
      stdout: (text) => {
        process.stdout.write(text)
      },
      stderr: (text) => {
        process.stderr.write(text)
      },
      onInterrupt: makeOnInterrupt(started?.ok ? started.value.audit : undefined),
      ...(started?.ok
        ? {
            readAudit: async (rootID: string) => started.value.audit.read(rootID),
            auditFailure: started.value.audit.failure,
          }
        : {}),
      environment: resolved.service ? Env.session() : undefined,
      randomId: () => crypto.randomUUID(),
      attached: resolved.service !== undefined,
    }

    const { exitCode } = yield* Effect.promise(() =>
      JobRun.run(
        { spec, cwd: process.cwd(), serverUrl: server, json: input.json, jobMode },
        runDeps,
      ),
    )
    process.exitCode = exitCode
  }),
)
