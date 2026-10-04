// Job-mode secrets by descriptor (job mode piece A1, kete-code-platform docs/jobs.md §8 item 3).
//
// In a cloud job the gateway key and the standalone server's per-run password must never sit in an
// environment variable: `/proc/<pid>/environ` is readable by the job's other processes, and every
// child inherits it. Instead:
//
// - the entrypoint passes the gateway key on an inherited descriptor named by
//   KETE_JOB_GATEWAY_KEY_FD; `kete job run` reads it once and closes it;
// - `kete job run` hands the password and the key to its `kete serve` child the same way
//   (KETE_JOB_SECRETS_FD, one JSON message; internal, not a contract);
// - the child keeps the key in this module's in-memory overlay, which the gateway provider
//   (core/src/kete/gateway.ts) reads in job mode instead of the environment.
//
// The overlay is the one piece of process-scoped state this needs: written once, before the server
// boots, and read by the gateway plugin — the same lifetime `process.env` would have had, without
// being visible in `/proc/<pid>/environ` or inherited by children. It is write-once so no later
// code can swap the key. The organization id from `kete job run`'s first sync (piece A2) sits beside
// it under the same rule: the sync plugin (core/src/kete/sync) finds the cache it wrote by it.
//
// Reading uses Bun's file stream rather than `fs.createReadStream`: a blocking threadpool read of a
// pipe whose writer stays open can't be interrupted (the timeout would hang), while Bun's stream
// polls pipes and sockets and can be cancelled.

export * as KeteJobSecrets from "./job-secrets.js"

import { closeSync, fstatSync } from "node:fs"
import { KeteEnv } from "./env.js"
import { KeteSyncCache } from "./sync/cache.js"

/** The internal name for KETE_JOB_GATEWAY_KEY_FD (entrypoint → `kete job run`; a contract). */
export const gatewayKeyFdVariable = "OPENCODE_JOB_GATEWAY_KEY_FD"
export const gatewayKeyFdPublicName = KeteEnv.publicName(gatewayKeyFdVariable)

/** The internal name for KETE_JOB_SECRETS_FD (`kete job run` → its `kete serve` child; internal). */
export const secretsFdVariable = "OPENCODE_JOB_SECRETS_FD"
export const secretsFdPublicName = KeteEnv.publicName(secretsFdVariable)

/** Environment names that carry secrets and are ignored (and removed) in job mode. */
export const environmentSecrets = ["OPENCODE_GATEWAY_KEY", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"] as const

/** The largest gateway key accepted — the entrypoint's claim check uses the same bound. */
export const maxGatewayKeyBytes = 4096

export class DescriptorError extends Error {
  override readonly name = "KeteJobSecrets.DescriptorError"
}

/** Parses a descriptor number: digits only, 3..1023 (0–2 are stdio). `undefined` when invalid. */
export function parseDescriptor(value: string): number | undefined {
  if (!/^[0-9]{1,4}$/.test(value)) return undefined
  const fd = Number(value)
  return fd >= 3 && fd <= 1023 ? fd : undefined
}

/** A gateway key is 1–4096 bytes of printable ASCII (0x21–0x7e): no spaces, no newlines. */
export function validGatewayKey(text: string): boolean {
  return /^[\x21-\x7e]+$/.test(text) && text.length <= maxGatewayKeyBytes
}

export type ReadOptions = {
  /** The most bytes accepted; one more byte than this is an error. */
  readonly maxBytes: number
  /** How long to wait for the writer to finish. */
  readonly timeoutMs: number
}

function close(fd: number) {
  try {
    closeSync(fd)
  } catch (error) {
    // Already closed is the only acceptable failure; anything else is surfaced.
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error
  }
}

/**
 * Reads `fd` to EOF as UTF-8 and closes it — in every path, success or failure. The descriptor must
 * be a pipe (FIFO), a socket or a regular file; anything else (a tty, a directory, a device) is
 * refused. Errors name the rule that failed, never the content.
 */
export async function readDescriptor(fd: number, options: ReadOptions): Promise<string> {
  if (!Number.isInteger(fd) || fd < 0) throw new DescriptorError(`descriptor ${fd} is not a valid descriptor number`)
  let stat
  try {
    stat = fstatSync(fd)
  } catch {
    throw new DescriptorError(`descriptor ${fd} is not open`)
  }
  if (!stat.isFIFO() && !stat.isSocket() && !stat.isFile()) {
    close(fd)
    throw new DescriptorError(`descriptor ${fd} is not a pipe, socket or regular file`)
  }
  if (typeof Bun === "undefined") {
    close(fd)
    throw new DescriptorError("reading a secrets descriptor needs the Bun runtime")
  }

  const chunks: Uint8Array[] = []
  let total = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => Promise<void>) | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs)
  })
  try {
    const reader = Bun.file(fd).stream().getReader()
    cancel = () => reader.cancel()
    for (;;) {
      const next = await Promise.race([reader.read(), timeout])
      if (next === "timeout") throw new DescriptorError(`descriptor ${fd} was not closed within ${options.timeoutMs} ms`)
      if (next.done) break
      total += next.value.byteLength
      if (total > options.maxBytes) throw new DescriptorError(`descriptor ${fd} holds more than ${options.maxBytes} bytes`)
      chunks.push(next.value)
    }
  } finally {
    clearTimeout(timer)
    await cancel?.().catch(() => undefined)
    close(fd)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new DescriptorError(`descriptor ${fd} is not valid UTF-8`)
  }
}

let overlay: string | undefined

/** Sets the in-memory gateway key for this process. Write-once: a second call throws. */
export function setGatewayKey(key: string): void {
  if (overlay !== undefined) throw new Error("the job's gateway key is already set")
  if (!validGatewayKey(key)) throw new Error("the job's gateway key is not 1–4096 printable ASCII characters")
  overlay = key
}

/** The gateway key set by `setGatewayKey`, or `undefined`. */
export function gatewayKey(): string | undefined {
  return overlay
}

let organizationOverlay: string | undefined

/** Sets the organization id (a GUID) `kete job run`'s first sync found. Not a secret, but it travels
 * the same parent → child channel and has the same lifetime. Write-once: a second call throws. */
export function setOrganization(id: string): void {
  if (organizationOverlay !== undefined) throw new Error("the job's organization is already set")
  if (!KeteSyncCache.validOrganization(id)) throw new Error("the job's organization is not a valid organization id")
  organizationOverlay = id
}

/** The organization id set by `setOrganization`, or `undefined`. */
export function organization(): string | undefined {
  return organizationOverlay
}
