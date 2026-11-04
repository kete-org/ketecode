// Kete-owned. Launches the packaged desktop app (from `pack`, not the dev build) with an isolated state
// directory, checks its runtime's `kete.handshake`, kills the runtime and waits for the app to restart
// it. Usage: bun script/kete-packaged-smoke.ts [--dir <dist/desktop>] [--app <path>] [--channel <c>] [--keep]
// (docs/desktop.md). Never prints the service password.

import { Service } from "@opencode/client/effect/service"
import { KeteHandshakeRpc } from "@opencode/schema/kete/handshake"
import { Brand } from "@opencode/util/kete/brand"
import { KeteDesktop } from "@opencode/util/kete/desktop"
import { Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Env = Record<string, string | undefined>
export type App = { kind: "tar"; tar: string; bundle: string } | { kind: "exe"; exe: string } | { kind: "bundle"; bundle: string }

const isChannel = (value: string): value is KeteDesktop.Channel => value in KeteDesktop.productNames

export function findApp(input: { dir: string; platform: string; channel: string; app?: string }): App {
  if (input.app) {
    if (input.app.endsWith(".app.tar")) return { kind: "tar", tar: input.app, bundle: path.basename(input.app, ".tar") }
    if (input.app.endsWith(".app")) return { kind: "bundle", bundle: input.app }
    return { kind: "exe", exe: input.app }
  }
  if (!isChannel(input.channel)) throw new Error(`Unknown channel "${input.channel}"`)
  const name = KeteDesktop.productNames[input.channel]
  if (input.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64"
    const tar = path.join(input.dir, `${KeteDesktop.artifactPrefix}-mac-${arch}.app.tar`)
    return { kind: "tar", tar, bundle: `${name}.app` }
  }
  if (input.platform === "win32") return { kind: "exe", exe: path.join(input.dir, "app", `${name}.exe`) }
  throw new Error(`No packaged smoke for platform ${input.platform}`)
}

export function executable(bundle: string) {
  return path.join(bundle, "Contents", "MacOS", path.basename(bundle, ".app"))
}

export function smokeEnv(root: string, base: Env): Env {
  return {
    ...base,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DESKTOP_TEST_ROOT: path.join(root, "app"),
  }
}

/** The test root moves the app's XDG dirs under it (main/lifecycle/configure.ts `createTestRoot`). */
export function registrationDir(env: Env) {
  if (!env.OPENCODE_DESKTOP_TEST_ROOT) throw new Error("OPENCODE_DESKTOP_TEST_ROOT is not set")
  return path.join(env.OPENCODE_DESKTOP_TEST_ROOT, "state", Brand.appDirectory)
}

/** The file's name depends on the CLI's channel (`service.json`, `service-<channel>.json`); the dir is fresh. */
export async function findRegistration(dir: string) {
  const names = await fs.readdir(dir).catch(() => [])
  const name = names.find((entry) => entry.startsWith("service") && entry.endsWith(".json"))
  return name === undefined ? undefined : path.join(dir, name)
}

/** undefined while the file is missing or partly written; throws when it is complete but invalid. */
export async function readRegistration(file: string) {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  const info = await Schema.decodeUnknownPromise(Service.Info)(json)
  if (info.password === undefined) throw new Error("Registration has no password")
  return { url: info.url, pid: info.pid, password: info.password }
}

/** A free local port, so the isolated runtime can't collide with a service already running here (each channel has a fixed default). */
export function freePort() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = server.port
  server.stop(true)
  return port
}

/** The CLI's own service config (cli/src/services/service-config.ts `configFile`), under the test root's config dir. */
export async function writeServiceConfig(testRoot: string, port: number) {
  await Bun.write(path.join(testRoot, "config", Brand.appDirectory, "service.json"), JSON.stringify({ port }))
}

/** The line the app's main process logs once its first connection is done and its watcher runs (main/service/background-service.ts). */
export const connectedLine = "v2 CLI background service ready"

/** Whether the app has logged its first connection; the runtime can answer before that. */
export async function appConnected(testRoot: string) {
  for await (const log of new Bun.Glob("desktop/logs/*/main.log").scan({ cwd: testRoot, absolute: true }))
    if ((await Bun.file(log).text().catch(() => "")).includes(connectedLine)) return true
  return undefined
}

export function handshakeRequest(url: string, password: string) {
  return new Request(new URL("/api/rpc/kete.handshake/get", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic " + btoa("opencode:" + password) },
    body: JSON.stringify({ input: {} }),
    signal: AbortSignal.timeout(5_000),
  })
}

export async function handshake(url: string, password: string) {
  const response = await fetch(handshakeRequest(url, password)).catch(() => {
    throw new Error(`no service at ${url}`)
  })
  if (response.status !== 200) throw new Error(`handshake HTTP ${response.status} from ${url}`)
  const body: unknown = await response.json()
  const output = typeof body === "object" && body !== null && "output" in body ? body.output : undefined
  const result = await Schema.decodeUnknownPromise(KeteHandshakeRpc.Result)(output)
  if (result.protocol !== KeteHandshakeRpc.PROTOCOL)
    throw new Error(`protocol ${result.protocol}, expected ${KeteHandshakeRpc.PROTOCOL}`)
  if (!result.modes.includes("code")) throw new Error(`modes ${result.modes.join(",")} lacks "code"`)
  return result
}

export function redact(text: string, secrets: string[]) {
  return secrets
    .filter(Boolean)
    .flatMap((secret) => [btoa("opencode:" + secret), secret])
    .reduce((out, secret) => out.split(secret).join("[redacted]"), text)
}

// ---- runner ----

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function until<T>(what: string, ms: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== undefined) return value
      last = undefined
    } catch (cause) {
      last = cause
    }
    await Bun.sleep(250)
  }
  const why = last instanceof Error ? ` (last error: ${last.message})` : ""
  throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${why}`, { cause: last })
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function kill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
  }
}

async function taskkill(pid: number) {
  await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
}

async function main() {
  const dir = option("--dir") ?? path.join(import.meta.dir, "../../../dist/desktop")
  const app = findApp({
    dir,
    platform: process.platform,
    channel: option("--channel") ?? process.env.OPENCODE_CHANNEL ?? "dev",
    app: option("--app"),
  })
  const source = app.kind === "tar" ? app.tar : app.kind === "exe" ? app.exe : app.bundle
  if (!(await fs.stat(source).catch(() => undefined))) {
    const listing = await fs.readdir(dir).catch(() => [])
    throw new Error(
      `packaged app not found at ${source} (run \`bun run pack\` first); ${dir} has: ${listing.join(", ") || "nothing"}`,
    )
  }

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-packaged-smoke-")))
  const env = smokeEnv(root, process.env)
  const registrations = registrationDir(env)
  const runtimePids = new Set<number>()
  const secrets: string[] = []
  let appProcess: ReturnType<typeof Bun.spawn> | undefined
  let failure: unknown

  const current = async () => {
    const file = await findRegistration(registrations)
    return file === undefined ? undefined : readRegistration(file)
  }

  const registered = (exclude?: number) => async () => {
    const registration = await current()
    if (!registration || registration.pid === exclude) return undefined
    if (!secrets.includes(registration.password)) secrets.push(registration.password)
    runtimePids.add(registration.pid)
    await handshake(registration.url, registration.password)
    return registration
  }

  try {
    let exe: string
    if (app.kind === "exe") exe = app.exe
    else if (app.kind === "bundle") exe = executable(app.bundle)
    else {
      const unpacked = path.join(root, "bundle")
      await fs.mkdir(unpacked)
      const tar = Bun.spawn(["tar", "-xf", app.tar, "-C", unpacked], { stdout: "ignore", stderr: "inherit" })
      if ((await tar.exited) !== 0) throw new Error(`tar failed on ${app.tar}`)
      exe = executable(path.join(unpacked, app.bundle))
    }
    await writeServiceConfig(env.OPENCODE_DESKTOP_TEST_ROOT ?? root, freePort())
    const started = Date.now()
    // To a file, not a pipe: the runtime the app starts inherits these and outlives the app.
    const log = Bun.file(path.join(root, "app-output.log"))
    appProcess = Bun.spawn([exe], { env: env as Record<string, string>, stdout: log, stderr: log })
    const first = await until("the runtime to register and pass the handshake", 180_000, registered())
    console.log(`ready in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    // Killing it before the app's own start-up finishes tests the start-up, not the watcher (0.2).
    await until("the app to finish connecting", 120_000, () => appConnected(env.OPENCODE_DESKTOP_TEST_ROOT ?? root))
    console.log(`app connected in ${((Date.now() - started) / 1000).toFixed(1)} s`)

    kill(first.pid, "SIGKILL")
    const killed = Date.now()
    await until("the app to restart the runtime", 60_000, registered(first.pid))
    console.log(`restart ${((Date.now() - killed) / 1000).toFixed(1)} s (target 5 s, ceiling 60 s)`)
  } catch (cause) {
    failure = cause
  } finally {
    if (appProcess) {
      if (process.platform === "win32") {
        await taskkill(appProcess.pid)
      } else {
        kill(appProcess.pid, "SIGTERM")
        const exited = await Promise.race([appProcess.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
        if (!exited) kill(appProcess.pid, "SIGKILL")
      }
      await Promise.race([appProcess.exited, Bun.sleep(10_000)])
    }
    // A runtime that registered after the last check still belongs to this run.
    const last = await current().catch(() => undefined)
    if (last) runtimePids.add(last.pid)
    // The runtime is detached from the app, so the app's process tree doesn't include it.
    for (const pid of runtimePids) process.platform === "win32" ? await taskkill(pid) : kill(pid, "SIGKILL")
    const left = await until("processes to exit", 10_000, async () =>
      [...runtimePids, ...(appProcess ? [appProcess.pid] : [])].every((pid) => !alive(pid)) ? true : undefined,
    ).then(
      () => undefined,
      () => [...runtimePids, ...(appProcess ? [appProcess.pid] : [])].filter(alive),
    )
    if (left?.length) failure ??= new Error(`left a process behind: ${left.join(", ")}`)
    if (failure) {
      for await (const log of new Bun.Glob("**/*.log").scan({ cwd: root, absolute: true })) {
        const text = await Bun.file(log).text().catch(() => "")
        console.error(`--- ${log}\n` + redact(text.split("\n").slice(-200).join("\n"), secrets))
      }
    }
    if (process.argv.includes("--keep")) console.error(`kept ${root}`)
    else
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch((cause: unknown) => {
        console.error(`warning: could not remove ${root}: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }
  // The thrown message may quote decoded registration data; scrub it while the secrets are known.
  if (failure) throw new Error(redact(failure instanceof Error ? failure.message : String(failure), secrets), { cause: failure })
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    console.error("packaged smoke failed: " + (cause instanceof Error ? cause.message : String(cause)))
    process.exitCode = 1
  })
}
