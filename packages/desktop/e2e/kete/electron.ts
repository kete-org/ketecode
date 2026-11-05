// Kete-owned. Drives the packaged desktop app's window against a fake model: first window, runtime connected,
// add a project, send "hello", see the fake answer. A Bun script (not the Playwright runner) so it can reuse the
// smoke's Bun helpers. Usage: bun e2e/kete/electron.ts [--dir <dist/desktop>] [--app <path>] [--channel <c>] [--keep]
// (docs/desktop.md). On failure a trace and screenshot go to $KETE_E2E_RESULTS (or a fresh temp folder).
// Never prints the service password.

import { _electron } from "@playwright/test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  appConnected,
  findApp,
  findRegistration,
  freePort,
  readRegistration,
  redact,
  registrationDir,
  smokeEnv,
  stopAll,
  unpackApp,
  until,
  writeServiceConfig,
} from "../../script/kete-packaged-smoke"
import { FAKE_ANSWER, fakeProvider, writeProviderConfig } from "./fake-provider"

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const seconds = (since: number) => ((Date.now() - since) / 1000).toFixed(1)

/** Whether a config answer (an array of documents) declares `id` under a `provider`/`providers` object; the
 *  model name echoed elsewhere (`kete-e2e/fake`) doesn't count. */
export function declaresProvider(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((item) => declaresProvider(item, id))
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value).some(([key, child]) =>
    (key === "provider" || key === "providers") && typeof child === "object" && child !== null && id in child
      ? true
      : declaresProvider(child, id),
  )
}

async function main() {
  const dir = option("--dir") ?? path.join(import.meta.dir, "../../../../dist/desktop")
  const app = findApp({
    dir,
    platform: process.platform,
    channel: option("--channel") ?? process.env.OPENCODE_CHANNEL ?? "dev",
    app: option("--app"),
  })
  const source = app.kind === "tar" ? app.tar : app.kind === "exe" ? app.exe : app.bundle
  if (!(await fs.stat(source).catch(() => undefined)))
    throw new Error(`packaged app not found at ${source} (run \`bun run pack\` first)`)

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-e2e-")))
  const env = smokeEnv(root, process.env)
  const testRoot = env.OPENCODE_DESKTOP_TEST_ROOT ?? root
  const registrations = registrationDir(env)
  const results = process.env.KETE_E2E_RESULTS ?? (await fs.mkdtemp(path.join(os.tmpdir(), "kete-e2e-results-")))
  const runtimePids = new Set<number>()
  const secrets: string[] = []
  const provider = fakeProvider()
  let electronApp: Awaited<ReturnType<typeof _electron.launch>> | undefined
  let page: Awaited<ReturnType<NonNullable<typeof electronApp>["firstWindow"]>> | undefined
  let failure: unknown

  const current = async () => {
    const file = await findRegistration(registrations)
    return file === undefined ? undefined : readRegistration(file)
  }

  try {
    const exe = await unpackApp(app, root)
    await writeServiceConfig(testRoot, freePort())
    await writeProviderConfig(testRoot, provider.baseURL)
    // Skips onboarding (main/storage/keys.ts, main/lifecycle/onboarding.ts).
    await Bun.write(path.join(testRoot, "desktop", "opencode.settings"), JSON.stringify({ firstLaunchOnboardingComplete: true }))
    const project = path.join(root, "project")
    await fs.mkdir(project)

    const started = Date.now()
    electronApp = await _electron.launch({ executablePath: exe, env: env as Record<string, string>, cwd: root })
    await electronApp.context().tracing.start({ screenshots: true, snapshots: true })
    page = await electronApp.firstWindow()
    console.log(`window in ${seconds(started)} s`)
    await until("the app to finish connecting", 180_000, () => appConnected(testRoot))
    console.log(`connected in ${seconds(started)} s`)

    const registration = await until("the runtime to register", 60_000, current)
    secrets.push(registration.password)
    runtimePids.add(registration.pid)
    // The runtime drops an invalid config file silently, so check the provider loaded.
    const config = await fetch(new URL("/api/config", registration.url), {
      headers: { authorization: "Basic " + btoa("opencode:" + registration.password) },
      signal: AbortSignal.timeout(10_000),
    })
    if (!declaresProvider(await config.json().catch(() => undefined), "kete-e2e"))
      throw new Error(`the runtime did not load the kete-e2e provider (GET /api/config ${config.status})`)

    // Home's "add project" opens a native folder dialog; answer it in the main process.
    await electronApp.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    }, project)
    await page.locator('[data-action="home-add-project-row"]').click()
    // Kete's home shows the new-session composer for the added project; upstream's home has a button for it.
    const start = page.locator('[data-action="home-new-session"]')
    if (await start.isVisible().catch(() => false)) await start.click()

    const model = page.locator('[data-action="composer-model"]')
    await model.waitFor({ timeout: 60_000 })
    if (!(await model.innerText()).includes("Fake")) {
      await model.click()
      await page.getByText("Fake", { exact: true }).first().click()
    }
    const asked = Date.now()
    const editor = page.locator('[data-component="composer-editor"]')
    await editor.click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await page.getByText(FAKE_ANSWER).first().waitFor({ timeout: 90_000 })
    console.log(`answer in ${seconds(asked)} s (${provider.requests.length} model request(s))`)
  } catch (cause) {
    failure = cause
    await fs.mkdir(results, { recursive: true })
    if (electronApp) await electronApp.context().tracing.stop({ path: path.join(results, "trace.zip") }).catch(() => undefined)
    if (page) await page.screenshot({ path: path.join(results, "failure.png") }).catch(() => undefined)
    console.error(`results in ${results} (model requests: ${provider.requests.join(", ") || "none"})`)
  } finally {
    // The app first: killing the runtime first would make the app's watcher restart it.
    const child = electronApp?.process()
    // Before close(): the exit event usually fires during it.
    const exited = child && (child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve)))
    const closing = electronApp?.close()
    if (closing) await Promise.race([closing, Bun.sleep(15_000)]).catch(() => undefined)
    const pid = child?.pid
    const left = await stopAll({
      app: pid === undefined || exited === undefined ? undefined : { pid, exited },
      runtimePids,
      current,
    })
    provider.stop()
    if (left?.length) failure ??= new Error(`left a process behind: ${left.join(", ")}`)
    if (failure) {
      for await (const log of new Bun.Glob("**/*.log").scan({ cwd: root, absolute: true })) {
        const lines = (await Bun.file(log).text().catch(() => "")).split("\n")
        console.error(`--- ${log}\n` + redact(lines.slice(-100).join("\n"), secrets))
      }
    }
    if (process.argv.includes("--keep")) console.error(`kept ${root}`)
    else await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
  }
  if (failure) throw new Error(redact(failure instanceof Error ? failure.message : String(failure), secrets), { cause: failure })
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    console.error("e2e failed: " + (cause instanceof Error ? cause.message : String(cause)))
    process.exitCode = 1
  })
}
