// Whether this machine can sandbox commands (ADR 0013): `sandbox-exec` on macOS, a working `bwrap` on
// Linux. Each check runs the mechanism once with a trivial command, because being installed isn't
// enough: Ubuntu 24.04 restricts unprivileged user namespaces with AppArmor, and containers often
// forbid them, so `bwrap` can be present and still fail. Windows has no sandbox in v1.
//
// Never called in job mode (the job's own sandbox applies), and guarded anyway: this is a direct
// spawn outside the runtime's process service (core/test/kete/job-spawn-sites.test.ts).

export * as KeteSandboxProbe from "./probe.js"

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteSeatbelt } from "./seatbelt.js"
import { KeteBubblewrap } from "./bubblewrap.js"

export type Result =
  | { readonly available: true; readonly mechanism: "seatbelt" | "bubblewrap"; readonly executable: string }
  | { readonly available: false; readonly reason: string }

const TIMEOUT_MS = 5_000
const MAX_REASON = 200

/** Runs `file args` with no input; resolves with the exit code and the first line of stderr. */
function run(file: string, args: ReadonlyArray<string>): Promise<{ code: number | null; error: string }> {
  KeteJobMode.refuseSpawn(path.basename(file))
  return new Promise((resolve) => {
    let stderr = ""
    let settled = false
    const done = (code: number | null, error: string) => {
      if (settled) return
      settled = true
      resolve({ code, error })
    }
    const child = spawn(file, [...args], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "" } })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done(null, `timed out after ${TIMEOUT_MS / 1000}s`)
    }, TIMEOUT_MS)
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      done(null, error.message)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      done(code, stderr.split("\n").find((line) => line.trim() !== "")?.trim() ?? "")
    })
  })
}

const short = (value: string) => (value.length > MAX_REASON ? value.slice(0, MAX_REASON) + "…" : value)

/** The first `bwrap` on PATH, then the usual locations. */
export function findBubblewrap(env: Record<string, string | undefined> = process.env) {
  const dirs = [...(env.PATH ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir)), "/usr/bin", "/usr/local/bin", "/bin"]
  for (const dir of dirs) {
    const candidate = path.join(dir, KeteBubblewrap.name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function probe(platform: NodeJS.Platform = process.platform): Promise<Result> {
  if (platform === "darwin") {
    if (!existsSync(KeteSeatbelt.executable)) return { available: false, reason: `${KeteSeatbelt.executable} is missing` }
    const result = await run(KeteSeatbelt.executable, ["-p", "(version 1)\n(allow default)\n", "--", "/usr/bin/true"])
    if (result.code === 0) return { available: true, mechanism: "seatbelt", executable: KeteSeatbelt.executable }
    return { available: false, reason: short(`sandbox-exec doesn't work here: ${result.error || `exit ${result.code}`}`) }
  }
  if (platform === "linux") {
    const executable = findBubblewrap()
    if (!executable) return { available: false, reason: "bubblewrap (bwrap) isn't installed" }
    const truePath = ["/usr/bin/true", "/bin/true"].find((candidate) => existsSync(candidate)) ?? "true"
    // The same namespaces a sandboxed command uses, network off (the stricter case).
    const result = await run(executable, [
      "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-net",
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", truePath,
    ])
    if (result.code === 0) return { available: true, mechanism: "bubblewrap", executable }
    return {
      available: false,
      reason: short(
        `bwrap can't create a sandbox here (${result.error || `exit ${result.code}`}); unprivileged user namespaces may be off (Ubuntu 24.04: AppArmor's kernel.apparmor_restrict_unprivileged_userns)`,
      ),
    }
  }
  if (platform === "win32") return { available: false, reason: "Windows has no Kete Code sandbox yet" }
  return { available: false, reason: `no sandbox for ${platform}` }
}
