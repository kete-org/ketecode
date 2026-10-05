// Kete-owned. Makes the step's own process non-dumpable on Linux (`prctl(PR_SET_DUMPABLE, 0)`).
// The step's environment holds every `PLUGIN_*` secret, and `/proc/<pid>/environ` of a dumpable
// process is readable by any process of the same user, the agent's commands included; a
// non-dumpable process's `/proc/<pid>/{environ,mem,fd}` are root-owned and it can't be ptraced by
// them. `exec` resets the flag, so `kete` (which never gets the secrets in its environment) is not
// affected. Same libc call as the CLI's job mode (packages/cli/src/kete/dumpable.ts), through
// `bun:ffi`; failing is reported, not fatal (the step's user may be root, where it changes nothing).

import { existsSync } from "node:fs"

export * as Dumpable from "./dumpable.js"

const PR_GET_DUMPABLE = 3
const PR_SET_DUMPABLE = 4

export type Result =
  | { readonly kind: "ok" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly reason: string }

type Prctl = (option: number, arg: number) => number

function withPrctl<A>(use: (prctl: Prctl) => A): A {
  const ffi = require("bun:ffi") as typeof import("bun:ffi")
  const musl = `/lib/libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`
  const library = ffi.dlopen(existsSync(musl) ? musl : "libc.so.6", {
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
  })
  try {
    return use((option, arg) => library.symbols.prctl(option, arg, 0, 0, 0))
  } finally {
    library.close()
  }
}

export function disable(platform: NodeJS.Platform = process.platform): Result {
  if (platform !== "linux") return { kind: "unsupported" }
  try {
    return withPrctl((prctl): Result => {
      if (prctl(PR_SET_DUMPABLE, 0) !== 0) return { kind: "failed", reason: "prctl(PR_SET_DUMPABLE, 0) failed" }
      if (prctl(PR_GET_DUMPABLE, 0) !== 0) return { kind: "failed", reason: "the process is still dumpable" }
      return { kind: "ok" }
    })
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether the current process is dumpable (Linux), for tests. */
export function dumpable(): boolean | undefined {
  if (process.platform !== "linux") return undefined
  return withPrctl((prctl) => prctl(PR_GET_DUMPABLE, 0) === 1)
}
