// `kete job run`'s own server in job mode (job mode piece A1, kete-code-platform docs/jobs.md §8
// item 3): the Kete sibling of services/standalone.ts, which every TUI and `kete run --standalone`
// keep using unchanged.
//
// Differences from the upstream standalone child, all so no other process in the job's container
// can reach the server or learn its secrets:
// - the server listens on a unix socket, `<dir>/s`, in a fresh 0700 directory under the runtime dir
//   (XDG_RUNTIME_DIR, else TMPDIR — kete's private tmp in a job); there is never a TCP fallback;
// - the per-run password, the gateway key and the organization id (from the first sync, job-sync.ts)
//   reach the child as one JSON message on fd 3
//   (KETE_JOB_SECRETS_FD=3; read by job-serve.ts), never as environment variables;
// - the ready line must name exactly that socket;
// - the child's stderr is forwarded to ours (in a job, the entrypoint's kete log file), and its last
//   line is kept, so a child that refuses to start reports why in the job's result;
// - the directory is removed when the run's scope closes, after the child has exited;
// - the audit log (piece A3): the child writes it to its own fd 4 (KETE_JOB_AUDIT_FD=4), a pipe to
//   us, and we relay the bytes unchanged into the entrypoint's audit pipe (our own fd, from
//   job-preflight.ts), keeping the lines `kete job run`'s result needs. A relay failure (a broken or
//   full downstream pipe, the 20 MB cap) stops the relay and is reported at once to whoever
//   subscribed (job.ts interrupts the session; the result is `audit_failed`). We stop reading the
//   child's fd 4 but can't close it — the shared spawner doesn't expose its end of that pipe — so
//   the child's writes fill the pipe's buffer and then block, never landing anywhere unseen; its
//   writer gives up after 10 s (KeteJobAuditSink.WRITE_TIMEOUT_MS) and interrupts the run itself if
//   the parent's interrupt hasn't already ended it. Lines already buffered when the relay failed are
//   lost, which is why the run is reported `audit_failed`; we don't drain the pipe to nowhere, so the
//   child can't keep writing lines that would be dropped unseen.

export * as KeteJobStandalone from "./job-standalone.js"

import type { Endpoint } from "@opencode/client/effect/service"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Brand } from "@opencode/util/kete/brand"
import { KeteJobAuditSink } from "@opencode/util/kete/job-audit-sink"
import { Deferred, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { randomBytes } from "node:crypto"
import { lstatSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { selfCommand } from "../util/process"

/** sun_path is 108 bytes on Linux and 104 on macOS, including the NUL; 103 fits both (the server
 * uses the same limit, server/src/kete/socket-listen.ts). */
export const maxSocketBytes = 103

/** The longest stderr line kept as a start failure's reason. */
export const maxReasonLength = 300

/** The descriptor the secrets message travels on in the child. */
export const secretsFd = 3

/** The descriptor the child writes its audit log to (a pipe to us). */
export const auditFd = KeteJobAuditSink.childFd

const Ready = Schema.Struct({ url: Schema.String })
const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(Ready))

/** The directory the socket directory is created in: XDG_RUNTIME_DIR when set and absolute, else
 * the OS temporary directory (TMPDIR). */
export function runtimeBase(env: Record<string, string | undefined> = process.env, tmpdir: () => string = os.tmpdir) {
  const runtime = env.XDG_RUNTIME_DIR
  return runtime !== undefined && runtime !== "" && path.isAbsolute(runtime) ? runtime : tmpdir()
}

/** The base must be a directory no other user can replace entries in: not group- or
 * world-writable, unless it has the sticky bit (like /tmp). Throws otherwise. */
export function checkRuntimeBase(base: string) {
  const stat = (() => {
    try {
      return statSync(base)
    } catch {
      throw new Error(`Job mode: the runtime directory ${base} does not exist.`)
    }
  })()
  if (!stat.isDirectory()) throw new Error(`Job mode: the runtime directory ${base} is not a directory.`)
  if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    throw new Error(`Job mode: the runtime directory ${base} is writable by other users without the sticky bit.`)
}

/** Creates a fresh private directory for the socket and returns it and the socket path. Throws when
 * the base is unsafe, the directory isn't private to this user or the socket path is too long. */
export function makeSocketDirectory(base: string) {
  if (Buffer.byteLength(path.join(base, "kete-XXXXXX", "s"), "utf8") > maxSocketBytes)
    throw new Error(`Job mode: the runtime directory ${base} is too long for a unix socket path (${maxSocketBytes} bytes).`)
  checkRuntimeBase(base)
  const directory = mkdtempSync(path.join(base, "kete-"))
  const stat = lstatSync(directory)
  const owned = typeof process.geteuid !== "function" || stat.uid === process.geteuid()
  if (!stat.isDirectory() || !owned || (stat.mode & 0o077) !== 0) {
    rmdirSync(directory)
    throw new Error(`Job mode: the socket directory ${directory} is not private to this user.`)
  }
  const socket = path.join(directory, "s")
  if (Buffer.byteLength(socket, "utf8") > maxSocketBytes) {
    rmdirSync(directory)
    throw new Error(`Job mode: the socket path is longer than ${maxSocketBytes} bytes.`)
  }
  return { directory, socket }
}

/** Removes the socket (if the server didn't) and its directory (not recursively). */
export function removeSocketDirectory(directory: string, socket: string) {
  try {
    unlinkSync(socket)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  rmdirSync(directory)
}

export type CommandInput = {
  readonly password: string
  readonly gatewayKey: string
  /** The organization id (a GUID) the parent's first sync found; not a secret. */
  readonly organization: string
  /** An orchestrated job's spec section and job id (the `orchestrate` tool's); not a secret. */
  readonly orchestration?: { readonly jobID: string; readonly spec: unknown }
  readonly socket: string
  readonly command?: ReadonlyArray<string>
  readonly cwd?: string
}

/** The secrets message the child reads from fd 3 (job-serve.ts). */
export function secretsMessage(input: Pick<CommandInput, "password" | "gatewayKey" | "organization" | "orchestration">) {
  return JSON.stringify({
    v: 1,
    password: input.password,
    gateway_key: input.gatewayKey,
    organization: input.organization,
    ...(input.orchestration ? { orchestration: { job_id: input.orchestration.jobID, spec: input.orchestration.spec } } : {}),
  })
}

/** The child's command: `kete serve --stdio --socket <path>`, the secrets on fd 3. Pure. */
export function command(input: CommandInput) {
  const [executable, ...args] = input.command ?? selfCommand()
  if (!executable) throw new Error("Failed to resolve the job's server command")
  return ChildProcess.make(executable, [...args, "serve", "--stdio", "--socket", input.socket], {
    cwd: input.cwd ?? process.cwd(),
    // Only the descriptor's number travels in the environment; the child's env bridge renames it to
    // OPENCODE_JOB_SECRETS_FD.
    // KETE_JOB_AUDIT_FD overrides the value we inherited from the entrypoint: in the child it names
    // its own fd 4, the pipe to our relay.
    env: { [`${Brand.envPrefix}JOB_SECRETS_FD`]: String(secretsFd), [`${Brand.envPrefix}JOB_AUDIT_FD`]: String(auditFd) },
    extendEnv: true,
    // EOF on stdin ends the server's lease, as for the upstream standalone child.
    stdin: "pipe",
    // Piped, forwarded to our stderr and its last line kept (start); never dropped in a job.
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "3 seconds",
    additionalFds: {
      [`fd${secretsFd}`]: {
        type: "input",
        stream: Stream.make(new TextEncoder().encode(secretsMessage(input))),
      },
      [`fd${auditFd}`]: { type: "output" },
    },
  })
}

/** Checks the child's ready line names exactly our socket. */
export function readyUrl(line: string, socket: string): string {
  const ready = decodeReady(line)
  if (ready._tag === "None") throw new Error("Job mode: the server's ready line is not valid")
  if (ready.value.url !== `unix://${socket}`) throw new Error("Job mode: the server did not report listening on its socket")
  return ready.value.url
}

/** The audit relay as `kete job run` sees it. */
export type Audit = {
  /** The kept `run`/`model`/`permission` lines of one root session (JSON Lines), or `undefined`. */
  readonly read: (rootID: string) => string | undefined
  /** The relay's failure, if it failed. */
  readonly failure: () => string | undefined
  /** Calls `handler` once when the relay fails (at once if it already has); returns an unsubscribe. */
  readonly onFailure: (handler: (code: string) => void) => () => void
}

export type Started = {
  /** The base URL is a placeholder: requests go over `socket` (Bun `fetch` with `unix:`). */
  readonly endpoint: Endpoint
  readonly socket: string
  readonly pid: number
  readonly audit: Audit
}

export type StartOptions = {
  readonly gatewayKey: string
  readonly organization: string
  /** An orchestrated job's spec section and job id, for the child's `orchestrate` tool. */
  readonly orchestration?: { readonly jobID: string; readonly spec: unknown }
  /** The entrypoint's audit pipe (our own descriptor, KETE_JOB_AUDIT_FD). */
  readonly auditFd: number
  readonly command?: ReadonlyArray<string>
  readonly env?: Record<string, string | undefined>
}

export const start = Effect.fn("cli.kete.job.standalone")(
  function* (options: StartOptions) {
    const password = randomBytes(32).toString("base64url")
    const { directory, socket } = yield* Effect.try({
      try: () => makeSocketDirectory(runtimeBase(options.env)),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    // Registered before the spawn, so it runs after the child has been stopped.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => removeSocketDirectory(directory, socket)).pipe(
        Effect.catchCause((cause) => Effect.logWarning("could not remove the job's socket directory", { cause })),
      ),
    )
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const proc = yield* spawner.spawn(
      command({
        password,
        gatewayKey: options.gatewayKey,
        organization: options.organization,
        orchestration: options.orchestration,
        socket,
        command: options.command,
      }),
    )
    // Relay the child's audit log into the entrypoint's pipe. On failure, stop reading and tell the
    // subscribers at once; the child's further writes block (see the header) rather than succeed.
    const relay = KeteJobAuditSink.relay(KeteJobAuditSink.writer(options.auditFd))
    const handlers = new Set<(code: string) => void>()
    const failed = (code: string) => {
      for (const handler of [...handlers]) handler(code)
      handlers.clear()
    }
    yield* proc.getOutputFd(auditFd).pipe(
      Stream.runForEach((chunk) => Effect.tryPromise({ try: () => relay.push(chunk), catch: (error) => error })),
      Effect.catch(() => Effect.sync(() => failed(relay.failure() ?? "relay")).pipe(Effect.asVoid)),
      Effect.catchCause((cause) => Effect.logWarning("the job's audit relay stopped", { cause })),
      Effect.forkScoped,
    )
    const audit: Audit = {
      read: relay.read,
      failure: relay.failure,
      onFailure: (handler) => {
        const code = relay.failure()
        if (code !== undefined) {
          handler(code)
          return () => {}
        }
        handlers.add(handler)
        return () => void handlers.delete(handler)
      },
    }
    // Forward the child's stderr to ours and keep its last line, for a refusal's reason.
    const lastError = { line: "" }
    const stderrDone = yield* Deferred.make<void>()
    yield* proc.stderr.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          process.stderr.write(chunk)
          // Stack frames ("at …") follow an error's message: keep the message, not the last frame.
          const lines = new TextDecoder()
            .decode(chunk)
            .split("\n")
            .map((item) => item.trim())
            .filter((item) => item !== "" && !/^at\s/.test(item))
          const last = lines.at(-1)
          if (last !== undefined) lastError.line = last.slice(0, maxReasonLength)
        }),
      ),
      Effect.ensuring(Deferred.succeed(stderrDone, undefined)),
      Effect.forkScoped,
    )
    const readyLine = yield* Deferred.make<string, Error>()
    // Keep draining stdout after readiness so later server writes cannot hit EPIPE.
    yield* proc.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Deferred.succeed(readyLine, line)),
      Effect.ensuring(Deferred.fail(readyLine, new Error("The job's server exited before reporting readiness"))),
      Effect.forkScoped,
    )
    const line = yield* Deferred.await(readyLine).pipe(
      Effect.catch((error) =>
        // Give the child's last stderr line a moment to arrive, then report it with the failure.
        Deferred.await(stderrDone).pipe(
          Effect.timeoutOption("1 second"),
          Effect.andThen(
            Effect.fail(lastError.line ? new Error(`${error.message}: ${lastError.line}`) : error),
          ),
        ),
      ),
    )
    yield* Effect.try({
      try: () => readyUrl(line, socket),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    return {
      endpoint: { url: "http://localhost", auth: { type: "basic" as const, username: "opencode", password } },
      socket,
      pid: proc.pid,
      audit,
    } satisfies Started
  },
  Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
)
