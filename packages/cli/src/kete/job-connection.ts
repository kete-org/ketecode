// `kete job run`'s server connection in job mode (D2, D5): the client can't verify that a server it
// didn't start itself is running with KETE_JOB_MODE set, so `--server` is refused outright. The
// background service is never used either — job mode always starts its own `kete serve` child on a
// private unix socket, with its secrets by descriptor (job-standalone.ts); the child inherits the
// bridged OPENCODE_JOB_MODE (`extendEnv: true`).
// Pure: no I/O, so `job.ts` can call this before touching the network or spawning anything.

export * as JobConnection from "./job-connection.js"

import { KeteJobMode } from "@opencode/util/kete/job-mode"

export interface Args {
  readonly server?: string
  readonly standalone: boolean
}

export type Resolution = { readonly kind: "ok"; readonly args: Args } | { readonly kind: "refused"; readonly message: string }

export function resolve(args: Args, env: KeteJobMode.Environment = process.env): Resolution {
  if (!KeteJobMode.enabled(env)) return { kind: "ok", args }
  if (args.server !== undefined)
    return {
      kind: "refused",
      message:
        "Job mode: kete job run can't connect to another server with --server; it can't verify that process is running in job mode.",
    }
  return { kind: "ok", args: { ...args, standalone: true } }
}
