// Non-dumpable job processes (job mode piece A1, kete-code-platform docs/jobs.md §8 item 3).
//
// `exec` resets a process's dumpable flag, so `kete` must clear it itself: with
// `prctl(PR_SET_DUMPABLE, 0)` no other process of the same user can ptrace it, read its memory or
// its `/proc/<pid>/{environ,fd,mem}` (they become root-owned), and it leaves no core dump. Both job
// processes — `kete job run` and its `kete serve` child — call `disable()` before reading any
// secret, and refuse to start when it fails on Linux.
//
// libc is reached through `bun:ffi`, like core's process lock (core/src/util/process-lock-ffi.bun.ts).
// It is loaded lazily with `require` so the Node build of the CLI, which has no `bun:ffi`, still
// bundles; there the call reports `failed` (job mode runs the Bun binary only).

export * as KeteDumpable from "./dumpable.js"

import { existsSync } from "node:fs"

const PR_GET_DUMPABLE = 3
const PR_SET_DUMPABLE = 4

export type Result =
  | { readonly kind: "ok" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly errno: number; readonly reason: string }

/** One `prctl(option, arg, 0, 0, 0)` call: its return value and `errno` when it returned -1. */
export type Prctl = (option: number, arg: number) => { readonly result: number; readonly errno: number }

/** The real `prctl` through libc (glibc, or musl when present). Linux only. */
export const linuxPrctl: Prctl = (option, arg) => {
  if (typeof Bun === "undefined") throw new Error("prctl needs the Bun runtime")
  // Lazy, so the Node build still bundles.
  const ffi = require("bun:ffi") as typeof import("bun:ffi")
  const musl = `/lib/libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`
  const library = ffi.dlopen(existsSync(musl) ? musl : "libc.so.6", {
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  })
  try {
    const result = library.symbols.prctl(option, arg, 0, 0, 0)
    if (result !== -1) return { result, errno: 0 }
    const pointer = library.symbols.__errno_location()
    return { result, errno: pointer === null ? 0 : ffi.read.i32(pointer, 0) }
  } finally {
    library.close()
  }
}

/** Clears the dumpable flag and reads it back. Non-Linux platforms (no job mode) are
 * `unsupported`, a no-op. */
export function disable(platform: NodeJS.Platform = process.platform, prctl: Prctl = linuxPrctl): Result {
  if (platform !== "linux") return { kind: "unsupported" }
  try {
    const set = prctl(PR_SET_DUMPABLE, 0)
    if (set.result !== 0) return { kind: "failed", errno: set.errno, reason: "prctl(PR_SET_DUMPABLE, 0) failed" }
    const get = prctl(PR_GET_DUMPABLE, 0)
    if (get.result !== 0)
      return { kind: "failed", errno: get.errno, reason: "the process is still dumpable after prctl(PR_SET_DUMPABLE, 0)" }
    return { kind: "ok" }
  } catch (error) {
    return { kind: "failed", errno: 0, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The refusal wording both job processes use. */
export function message(result: Extract<Result, { kind: "failed" }>): string {
  return `Job mode: could not make the process non-dumpable (${result.reason}${result.errno ? `, errno ${result.errno}` : ""}); refusing to start.`
}
