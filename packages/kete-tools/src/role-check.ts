// Behaviour check for the role agents (Phase 5): each role gets a small task in a throwaway git
// repository, with a throwaway HOME (so the runtime's starter roles are the ones in play), and the
// check verifies what it changed and what it reported, not just that it ran. It uses a real model,
// so it costs whatever that model costs: nothing runs without an explicit --model.
//
//   bun run --cwd packages/kete-tools role-check --model anthropic/claude-sonnet-4-5 [--kete <binary>] [--role qa]
//   bun run --cwd packages/kete-tools role-check --kete-account --model kete/claude-sonnet-4-5
//
// Model credentials come from the environment the check runs in (e.g. ANTHROPIC_API_KEY), a local
// model (--model ollama/<name>), or, with --kete-account, the Kete gateway of the account you're
// signed in to with `kete login`: the runs still aren't signed in (so the starter roles are the ones
// in play); they only get the gateway's URL and your key, and it spends your organization's credit.
// Nothing else from the developer's environment or account is visible to the runs.
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { KeteAccount } from "@opencode/util/kete/account"
import { changedFiles, evaluate, SCENARIOS, type Scenario } from "./role-scenarios"

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    kete: { type: "string", default: "kete" },
    role: { type: "string", multiple: true },
    timeout: { type: "string", default: "300" },
    keep: { type: "boolean", default: false },
    "kete-account": { type: "boolean", default: false },
  },
})
if (!values.model) {
  console.error("role-check: pass --model provider/model (it runs a real model and costs what that model costs)")
  process.exit(2)
}

/** --kete-account: the signed-in account's gateway, as the runtime's hand-configured `kete` provider. */
async function gatewayEnvironment(): Promise<Record<string, string>> {
  if (!values["kete-account"]) return {}
  const options = KeteAccount.defaults()
  const account = await KeteAccount.read(options)
  if (!account) {
    console.error("role-check: --kete-account needs `kete login` first")
    process.exit(2)
  }
  const key = await KeteAccount.key(options, account)
  if (!key) {
    console.error("role-check: the signed-in account's key is missing; run `kete login` again")
    process.exit(2)
  }
  console.log(`Using the Kete gateway of ${account.organization.name} (${account.gateway_url}); this spends its credit.\n`)
  return { KETE_GATEWAY_URL: account.gateway_url, KETE_GATEWAY_KEY: key, KETE_PLATFORM_URL: account.platform_url }
}

async function git(cwd: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" })
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`))))
  })
}

async function capture(cwd: string, args: string[]) {
  return new Promise<string>((resolve) => {
    const child = spawn("git", args, { cwd })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
    child.on("exit", () => resolve(out))
  })
}

async function run(scenario: Scenario, model: string, gateway: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), `kete-role-${scenario.role}-`))
  const repo = path.join(root, "repo")
  const home = path.join(root, "home")
  await mkdir(repo, { recursive: true })
  for (const [file, content] of Object.entries(scenario.files)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true })
    await writeFile(path.join(repo, file), content)
  }
  await git(repo, ["init", "-q"])
  await git(repo, ["-c", "user.email=check@kete.test", "-c", "user.name=check", "add", "."])
  await git(repo, ["-c", "user.email=check@kete.test", "-c", "user.name=check", "commit", "-qm", "fixture"])

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("KETE_") && !name.startsWith("OPENCODE_")),
  )
  Object.assign(environment, gateway)
  // A throwaway repository: `auto` scenarios approve every request, as `--auto` did before it became
  // the "auto" permission mode (which still asks, and so rejects, high-risk commands in `kete run`).
  const args = ["run", "--standalone", "--format", "json", "--model", model, "--agent", scenario.agent, ...(scenario.auto ? ["--dangerously-skip-permissions"] : []), scenario.task]
  const started = Date.now()
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(values.kete!, args, {
      cwd: repo,
      env: {
        ...environment,
        // kete run takes its workspace from PWD before the process's cwd: without this the run
        // would work in whatever directory role-check was started from.
        PWD: repo,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => child.kill("SIGTERM"), Number(values.timeout) * 1000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
  const status = await capture(repo, ["status", "--porcelain", "--untracked-files=all"])
  const result = evaluate(scenario, { exitCode: output.code, output: output.stdout, changed: changedFiles(status) })
  const log = path.join(root, "run.log")
  // The log never holds the gateway key: kete doesn't print it, and the command line doesn't carry it.
  await writeFile(log, `$ kete ${args.join(" ")}\n\n--- stdout\n${output.stdout}\n--- stderr\n${output.stderr}\n--- git status\n${status}`)
  if (!values.keep && result.ok) await rm(root, { recursive: true, force: true })
  return { ...result, seconds: Math.round((Date.now() - started) / 1000), log: result.ok && !values.keep ? undefined : log }
}

const selected = SCENARIOS.filter((scenario) => !values.role || values.role.includes(scenario.role))
const gateway = await gatewayEnvironment()
let failed = 0
for (const scenario of selected) {
  const result = await run(scenario, values.model, gateway)
  if (!result.ok) failed++
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${scenario.role.padEnd(14)} ${String(result.seconds).padStart(4)} s  ${result.reasons.join("; ") || "as expected"}`)
  if (result.log) console.log(`      log: ${result.log}`)
}
console.log(`\n${selected.length - failed}/${selected.length} roles behaved as expected`)
process.exit(failed > 0 ? 1 : 0)
