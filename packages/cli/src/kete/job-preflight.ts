// `kete job run`'s first step in job mode (job mode piece A1, kete-code-platform docs/jobs.md §8
// item 3), before the spec is read or anything is spawned:
//
// 1. become non-dumpable (dumpable.ts) before any secret is read; failure refuses;
// 2. read the gateway key once from the descriptor KETE_JOB_GATEWAY_KEY_FD names (the entrypoint's
//    pipe), close it, and drop the variable;
// 3. drop secret environment variables (KETE_GATEWAY_KEY, KETE_PASSWORD, KETE_SERVER_PASSWORD):
//    an environment key is ignored in job mode and must not reach the server child;
// 4. without a descriptor key, refuse: in job mode the descriptor key is the only gateway key (D2 —
//    an account file or a configured key is never used, so every model call is metered on the
//    job's key);
// 5. take the audit pipe KETE_JOB_AUDIT_FD names (piece A3: the entrypoint's pipe, where the job's
//    audit log goes instead of a file): it must be a pipe other than the key's descriptor; it is
//    marked close-on-exec (so no child inherits it) and the variable is dropped. Without it, refuse.
//
// Refusals name the variable and the rule, never the content.

export * as KeteJobPreflight from "./job-preflight.js"

import { KeteJobAuditSink } from "@opencode/util/kete/job-audit-sink"
import { KeteJobSecrets } from "@opencode/util/kete/job-secrets"
import { KeteLinuxFfi } from "@opencode/util/kete/linux-ffi"
import { KeteDumpable } from "./dumpable"

export type Deps = {
  readonly env: Record<string, string | undefined>
  readonly dumpable: () => KeteDumpable.Result
  readonly readDescriptor: (fd: number, options: KeteJobSecrets.ReadOptions) => Promise<string>
  /** `undefined` when the audit descriptor is an open pipe; else why not. */
  readonly validateAudit: (fd: number) => string | undefined
  /** Marks a descriptor close-on-exec; throws on failure. */
  readonly setCloexec: (fd: number) => void
}

export type Outcome =
  | { readonly kind: "ok"; readonly gatewayKey: string; readonly auditFd: number }
  | { readonly kind: "refused"; readonly message: string }

const defaults = (): Deps => ({
  env: process.env,
  dumpable: () => KeteDumpable.disable(),
  readDescriptor: KeteJobSecrets.readDescriptor,
  validateAudit: (fd) => KeteJobAuditSink.validate(fd, "fifo"),
  setCloexec: (fd) => KeteLinuxFfi.setCloexec(fd),
})

const readTimeoutMs = 10_000
const name = KeteJobSecrets.gatewayKeyFdPublicName
const auditName = KeteJobAuditSink.publicName

export async function run(overrides: Partial<Deps> = {}): Promise<Outcome> {
  const deps = { ...defaults(), ...overrides }
  const dumpable = deps.dumpable()
  if (dumpable.kind === "failed") return { kind: "refused", message: KeteDumpable.message(dumpable) }

  const value = deps.env[KeteJobSecrets.gatewayKeyFdVariable]
  delete deps.env[KeteJobSecrets.gatewayKeyFdVariable]
  const audit = KeteJobAuditSink.parse(deps.env)
  delete deps.env[KeteJobAuditSink.variable]
  for (const secret of KeteJobSecrets.environmentSecrets) delete deps.env[secret]

  if (value === undefined || value === "")
    return { kind: "refused", message: `Job mode: no gateway key — pass it on a descriptor with ${name}.` }
  const fd = KeteJobSecrets.parseDescriptor(value)
  if (fd === undefined) return { kind: "refused", message: `Job mode: ${name} is not a descriptor number (3–1023).` }

  const text = await deps
    .readDescriptor(fd, { maxBytes: KeteJobSecrets.maxGatewayKeyBytes, timeoutMs: readTimeoutMs })
    .then((read) => ({ ok: true as const, read }))
    .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
  if (!text.ok) return { kind: "refused", message: `Job mode: could not read ${name}: ${text.error}` }
  if (!KeteJobSecrets.validGatewayKey(text.read))
    return { kind: "refused", message: `Job mode: ${name} did not hold a gateway key (1–4096 printable ASCII characters).` }

  if (audit.kind === "missing")
    return { kind: "refused", message: `Job mode: no audit sink — pass a pipe with ${auditName}.` }
  if (audit.kind === "invalid" || audit.fd === fd)
    return { kind: "refused", message: `Job mode: ${auditName} is not a descriptor number (3–1023) other than ${name}'s.` }
  const invalid = deps.validateAudit(audit.fd)
  if (invalid !== undefined) return { kind: "refused", message: `Job mode: ${auditName}: ${invalid}.` }
  try {
    deps.setCloexec(audit.fd)
  } catch (error) {
    return { kind: "refused", message: `Job mode: ${auditName}: ${error instanceof Error ? error.message : String(error)}.` }
  }
  return { kind: "ok", gatewayKey: text.read, auditFd: audit.fd }
}
