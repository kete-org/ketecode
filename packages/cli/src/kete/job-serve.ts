// `kete serve` in job mode (job mode piece A1, kete-code-platform docs/jobs.md §8 item 3).
//
// Called by server-process.ts before the server password is read, for every `ServerProcess.run`
// caller. Outside job mode it only refuses `--socket` (D1). In job mode it enforces the shape `kete
// job run`'s standalone child has — `--stdio --socket <path>`, no `--port`/`--hostname` — so the
// background service, a TUI's standalone child or ACP refuse instead of opening a TCP port. Then:
//
// 1. the process becomes non-dumpable (dumpable.ts) before any secret is read;
// 2. the password and gateway key are read once from the descriptor KETE_JOB_SECRETS_FD names (one
//    JSON message, written by job-standalone.ts), and the descriptor is closed;
// 3. secret environment variables are removed, so nothing this process spawns inherits them;
// 4. the gateway key goes to the in-memory overlay (util/src/kete/job-secrets.ts), the only gateway
//    key the job uses (D2: account files and configured keys are ignored in job mode); the
//    organization id from the parent's first sync (piece A2) goes beside it, so the sync plugin
//    loads the cache that sync wrote;
// 5. (piece A3) the working tree can be opened with openat2 — else refuse (no fallback);
// 6. the audit sink (piece A3): KETE_JOB_AUDIT_FD names this process's fd 4, a pipe (or socket) to
//    `kete job run`, which relays it to the entrypoint. It is marked close-on-exec, the variable is
//    dropped, and the descriptor becomes the audit writer's only destination (core/src/kete/audit.ts).

export * as KeteJobServe from "./job-serve.js"

import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { KeteJobAuditSink } from "@opencode/util/kete/job-audit-sink"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteJobSecrets } from "@opencode/util/kete/job-secrets"
import { KeteLinuxFfi } from "@opencode/util/kete/linux-ffi"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { Effect, Schema } from "effect"
import { KeteDumpable } from "./dumpable"

export type Input = {
  readonly mode: "default" | "service" | "stdio"
  readonly socket?: string
  readonly hostname?: string
  readonly port?: number
}

export type Prepared = {
  readonly password: string
  readonly socket: string
}

export type Deps = {
  readonly env: Record<string, string | undefined>
  readonly platform: NodeJS.Platform
  readonly dumpable: () => KeteDumpable.Result
  readonly readDescriptor: (fd: number, options: KeteJobSecrets.ReadOptions) => Promise<string>
  readonly setGatewayKey: (key: string) => void
  readonly setOrganization: (id: string) => void
  readonly setOrchestration: (value: { readonly jobID: string; readonly spec: unknown }) => void
  readonly setReview: (value: unknown) => void
  /** `undefined` when the audit descriptor is an open pipe or socket; else why not. */
  readonly validateAudit: (fd: number) => string | undefined
  readonly setCloexec: (fd: number) => void
  readonly setAuditSink: (fd: number) => void
  /** `undefined` when the working tree (cwd) can be opened with openat2; else the refusal. The
   * server's own boot enforces this too (server/src/kete/job-server.ts); checking here first gives
   * `kete job run` a clear reason instead of a stack trace. */
  readonly confinable: () => string | undefined
}

const defaults = (): Deps => ({
  env: process.env,
  platform: process.platform,
  dumpable: () => KeteDumpable.disable(),
  readDescriptor: KeteJobSecrets.readDescriptor,
  setGatewayKey: KeteJobSecrets.setGatewayKey,
  setOrganization: KeteJobSecrets.setOrganization,
  setOrchestration: KeteJobSecrets.setOrchestration,
  setReview: KeteJobSecrets.setReview,
  validateAudit: (fd) => KeteJobAuditSink.validate(fd, "fifo-or-socket"),
  setCloexec: (fd) => KeteLinuxFfi.setCloexec(fd),
  setAuditSink: KeteJobAuditSink.set,
  confinable: () => {
    try {
      const root = KeteConfinedFs.open(process.cwd(), KeteLinuxFfi.linux())
      root.sys.close(root.fd)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  },
})

const Message = Schema.Struct({
  v: Schema.Literal(1),
  password: Schema.NonEmptyString,
  gateway_key: Schema.String,
  organization: Schema.String,
  /** An orchestrated job's `spec.orchestration` and job id (checked by setOrchestration). */
  orchestration: Schema.optional(Schema.Struct({ job_id: Schema.String, spec: Schema.Unknown })),
  /** A pull request review job's `spec.review` (checked by setReview): the server's review mode. */
  review: Schema.optional(Schema.Unknown),
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))

/** The 16 KiB cap on the secrets message (a 4 KiB key, a password and JSON framing fit easily). */
export const maxMessageBytes = 16 * 1024
const readTimeoutMs = 10_000

const fail = (message: string) => Effect.fail(new Error(`Job mode: ${message}`))

/** `undefined` outside job mode (nothing changes); the password and socket in job mode. */
export const prepare = Effect.fnUntraced(function* (input: Input, overrides: Partial<Deps> = {}) {
  const deps = { ...defaults(), ...overrides }
  if (!KeteJobMode.enabled(deps.env)) {
    if (input.socket !== undefined) return yield* Effect.fail(new Error("--socket is only available in job mode"))
    return undefined
  }
  if (deps.platform === "win32") return yield* fail("kete serve is not supported on Windows.")
  if (input.mode !== "stdio" || input.socket === undefined)
    return yield* fail("kete serve runs only as `kete job run`'s child (`--stdio --socket <path>`); no TCP listener.")
  if (input.port !== undefined || input.hostname !== undefined)
    return yield* fail("--port and --hostname are refused; the server listens on its socket only.")

  const dumpable = deps.dumpable()
  if (dumpable.kind === "failed") return yield* Effect.fail(new Error(KeteDumpable.message(dumpable)))
  const unconfined = deps.confinable()
  if (unconfined !== undefined) return yield* Effect.fail(new Error(unconfined))

  const value = deps.env[KeteJobSecrets.secretsFdVariable]
  delete deps.env[KeteJobSecrets.secretsFdVariable]
  const audit = KeteJobAuditSink.parse(deps.env)
  delete deps.env[KeteJobAuditSink.variable]
  for (const name of KeteJobSecrets.environmentSecrets) delete deps.env[name]
  if (value === undefined) return yield* fail(`${KeteJobSecrets.secretsFdPublicName} is not set.`)
  const fd = KeteJobSecrets.parseDescriptor(value)
  if (fd === undefined) return yield* fail(`${KeteJobSecrets.secretsFdPublicName} is not a descriptor number (3–1023).`)

  const text = yield* Effect.tryPromise({
    try: () => deps.readDescriptor(fd, { maxBytes: maxMessageBytes, timeoutMs: readTimeoutMs }),
    catch: (error) =>
      new Error(
        `Job mode: could not read ${KeteJobSecrets.secretsFdPublicName}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
  const message = decodeMessage(text)
  if (message._tag === "None") return yield* fail(`${KeteJobSecrets.secretsFdPublicName} did not hold a valid secrets message.`)
  if (!KeteJobSecrets.validGatewayKey(message.value.gateway_key))
    return yield* fail(`${KeteJobSecrets.secretsFdPublicName} did not hold a valid gateway key.`)
  if (!KeteSyncCache.validOrganization(message.value.organization))
    return yield* fail(`${KeteJobSecrets.secretsFdPublicName} did not hold a valid organization id.`)
  if (audit.kind !== "fd") return yield* fail(`${KeteJobAuditSink.publicName} is not set to a descriptor number (3–1023).`)
  if (audit.fd === fd) return yield* fail(`${KeteJobAuditSink.publicName} must differ from ${KeteJobSecrets.secretsFdPublicName}.`)
  const invalid = deps.validateAudit(audit.fd)
  if (invalid !== undefined) return yield* fail(`${KeteJobAuditSink.publicName}: ${invalid}.`)
  yield* Effect.try({
    try: () => deps.setCloexec(audit.fd),
    catch: (error) => new Error(`Job mode: ${KeteJobAuditSink.publicName}: ${error instanceof Error ? error.message : String(error)}`),
  })
  deps.setGatewayKey(message.value.gateway_key)
  deps.setOrganization(message.value.organization)
  const orchestration = message.value.orchestration
  if (orchestration !== undefined)
    yield* Effect.try({
      try: () => deps.setOrchestration({ jobID: orchestration.job_id, spec: orchestration.spec }),
      catch: (error) =>
        new Error(`Job mode: ${KeteJobSecrets.secretsFdPublicName}: ${error instanceof Error ? error.message : String(error)}.`),
    })
  const review = message.value.review
  if (review !== undefined)
    yield* Effect.try({
      try: () => deps.setReview(review),
      catch: (error) =>
        new Error(`Job mode: ${KeteJobSecrets.secretsFdPublicName}: ${error instanceof Error ? error.message : String(error)}.`),
    })
  deps.setAuditSink(audit.fd)
  return { password: message.value.password, socket: input.socket } satisfies Prepared
})
