// Kete-owned. `run` mode: `kete job run` (docs/jobs.md, ADR 0008) in the pipeline's workspace.
// `kete job run` creates its own worktree and branch from the workspace's HEAD, denies every
// permission the policy doesn't allow, and refuses to start without a budget and a time limit; this
// step writes the spec, starts it with a minimal environment, copies its (already redacted) audit
// log into the workspace as an artifact, writes a redacted summary, and optionally commits the
// worktree and pushes it to a NEW branch.
//
// Model keys never go into the agent's environment: kete's shell tool hands every command the whole
// server environment (core/src/shell.ts), and nothing in `kete job run` outside job mode removes keys
// from it. Each key goes into its own 0600 file in a 0700 directory outside the workspace, and the
// provider config (`KETE_CONFIG_CONTENT`) references it with `{file:...}`, which kete reads when it
// loads its config. The directory is deleted when the run ends.

import { spawn } from "node:child_process"
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { KeteRedact } from "@opencode/util/kete/redact"
import { Git } from "./git.js"
import { Outputs } from "./outputs.js"
import { Secrets } from "./secrets.js"
import { Settings } from "./settings.js"
import { Task } from "./task.js"

export * as Run from "./run.js"

export type Env = Readonly<Record<string, string | undefined>>

export type Report = {
  readonly exit: Outputs.ExitCode
  readonly values: Outputs.Values
}

export type Deps = {
  readonly env: Env
  /** The `kete` executable (the image's /usr/local/bin/kete, or `kete` on PATH). */
  readonly kete: string
  /** Prints one line; the caller redacts it (main's logger does). */
  readonly log: (line: string) => void
  readonly redact: Secrets.Redactor
  /** Extra time after the run's own limit before the step stops `kete` itself. */
  readonly graceMs?: number
}

/** The provider id the step defines for `PLUGIN_MODEL_URL` (an OpenAI-compatible endpoint). */
export const endpointProvider = "endpoint"

/** kete's result v1 (docs/jobs.md "Output"); only the fields this step reads. */
type JobResult = {
  outcome?: unknown
  text?: unknown
  branch?: unknown
  worktree?: unknown
  isolated?: unknown
  cost_usd?: unknown
  audit_log?: unknown
  audit_local?: unknown
  denied?: unknown
  message?: unknown
}

export function workspace(env: Env): string {
  return env.DRONE_WORKSPACE?.trim() || env.HARNESS_WORKSPACE?.trim() || process.cwd()
}

export async function run(settings: Settings.RunSettings, deps: Deps): Promise<Report> {
  const env = deps.env
  const redact = deps.redact
  const root = realpathSync(workspace(env))
  const targetBranch = env.DRONE_TARGET_BRANCH?.trim() || undefined
  const gitContext: Git.Context = { env: sanitize(env), redact }
  const report = (exit: Outputs.ExitCode, outcome: string, summary: string, branch: string): Report => ({
    exit,
    values: {
      KETE_OUTCOME: outcome,
      KETE_SUMMARY: Outputs.oneLine(summary, redact),
      KETE_BRANCH: branch,
      KETE_JOB_URL: "",
    },
  })
  const refuse = (message: string): Report => {
    deps.log(`refused: ${message}`)
    return report(2, "refused", message, "")
  }

  // git worktree add writes into .git: a workspace this user can't write is a setup problem, said plainly.
  const dotGit = path.join(root, ".git")
  if (existsSync(dotGit)) {
    try {
      accessSync(dotGit, constants.W_OK)
    } catch {
      return refuse(
        `the workspace's .git isn't writable by this step's user (uid ${process.getuid?.() ?? "?"}). Run the step as the user that cloned the repository (spec.runAsUser) or make the workspace writable.`,
      )
    }
  }

  let built: Task.Built
  try {
    const latestTag =
      settings.preset === "release-notes" && settings.base === undefined ? Git.latestTag(root, gitContext) : undefined
    built = Task.build(settings, { workspace: root, targetBranch, latestTag, redact })
  } catch (error) {
    if (error instanceof Task.TaskError) return refuse(error.message)
    throw error
  }

  // Everything a push depends on is read before the agent runs and can change the repository.
  let branch: string | undefined
  let push: { readonly remote: Git.Remote; readonly protected: Set<string> } | undefined
  if (settings.pushBranch !== undefined) {
    const protectedNames = Git.protectedBranches(root, gitContext)
    if (settings.pushBranch !== "generated") {
      if (Git.isProtected(protectedNames, settings.pushBranch))
        return refuse(
          `PLUGIN_PUSH_BRANCH names a protected branch (the target, default or current branch); push to a new branch instead.`,
        )
      branch = settings.pushBranch
    }
    const origin = Git.originURL(root, gitContext)
    if (origin.kind === "invalid") return refuse(`PLUGIN_PUSH_BRANCH: ${origin.message}`)
    push = { remote: origin.remote, protected: protectedNames }
  }

  const output = outputDirectory(root, settings.outputDir)
  const temp = mkdtempSync(path.join(tmpdir(), "kete-harness-"))
  try {
    // The key files must not be reachable from the workspace kete works in.
    const fromRoot = path.relative(root, realpathSync(temp))
    if (!fromRoot.startsWith("..") && !path.isAbsolute(fromRoot))
      return refuse("the temporary directory (TMPDIR) is inside the workspace; point TMPDIR outside it.")
    const specPath = path.join(temp, "job.json")
    const model = settings.access.kind === "endpoint" ? `${endpointProvider}/${settings.model}` : settings.model
    const spec = {
      version: 1,
      prompt: built.prompt,
      ...(settings.agent ? { agent: settings.agent } : {}),
      ...(model ? { model } : {}),
      policy: { version: 1, allow: built.allow, budget: settings.budget, timeout: settings.timeout },
      ...(branch ? { branch } : {}),
    }
    writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 })
    deps.log(
      `starting kete job run: budget ${settings.budget} USD, time limit ${settings.timeout} min, ${built.allow.length} allow rule(s)${model ? `, model ${model}` : ""}`,
    )

    const child = await spawnKete(deps.kete, specPath, root, keteEnv(settings, env, path.join(temp, "keys")), {
      limitMs: settings.timeout * 60_000 + (deps.graceMs ?? 5 * 60_000),
      log: (line) => deps.log(redact(line)),
    })
    const result = parseResult(child.stdout)
    if (!result) {
      const why = child.timedOut
        ? "kete job run didn't finish within its time limit"
        : `kete job run exited ${child.code} without a result`
      deps.log(`error: ${why}`)
      Outputs.writeArtifact(output, "summary.md", `## Kete Code: error\n\n${why}\n`)
      return report(1, child.timedOut ? "time_limit" : "error", why, "")
    }

    const outcome = typeof result.outcome === "string" ? result.outcome : "error"
    const text =
      typeof result.text === "string" ? result.text : typeof result.message === "string" ? result.message : ""
    const auditCopied = copyAudit(result, output, redact)
    Outputs.writeArtifact(output, "result.json", Secrets.json(result, redact) + "\n")

    let exit = Outputs.exitCode(outcome)
    let finalOutcome = outcome
    let pushed = ""
    const notes: string[] = []
    if (!auditCopied) notes.push("No audit log was available to copy.")
    if (push !== undefined) {
      const wt = typeof result.worktree === "string" ? result.worktree : undefined
      const runBranch = typeof result.branch === "string" ? result.branch : undefined
      if (outcome !== "completed") notes.push("Nothing was pushed: the run didn't complete.")
      else if (!wt || !runBranch || result.isolated !== true) {
        finalOutcome = "push_failed"
        exit = 1
        notes.push("Nothing was pushed: the run had no worktree and branch (is the workspace a git repository?).")
      } else {
        const target = branch ?? runBranch
        const published = commitAndPush(
          settings,
          { worktree: wt, branch: target, root, push, env, prompt: built.prompt },
          gitContext,
        )
        notes.push(published.note)
        if (published.kind === "pushed") pushed = target
        else if (published.kind === "refused") {
          finalOutcome = "push_refused"
          exit = 2
        } else if (published.kind === "failed") {
          finalOutcome = "push_failed"
          exit = 1
        }
      }
    }

    const cost = typeof result.cost_usd === "number" ? result.cost_usd : undefined
    const denied = Array.isArray(result.denied) ? result.denied.length : 0
    Outputs.writeArtifact(
      output,
      "summary.md",
      [
        `## Kete Code: ${finalOutcome}`,
        "",
        `- Outcome: ${outcome}${cost !== undefined ? ` · cost ${cost.toFixed(4)} USD` : ""} · ${denied} denied permission(s)`,
        ...(pushed ? [`- Pushed to new branch \`${pushed}\``] : []),
        ...notes.map((n) => `- ${n}`),
        "",
        redact(text),
        "",
      ].join("\n"),
    )
    deps.log(
      `outcome ${finalOutcome}${pushed ? `, pushed ${pushed}` : ""}; summary, result and audit log in ${path.relative(root, output) || "."}`,
    )
    return report(exit, finalOutcome, text, pushed)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** The output directory inside the workspace (created); a symlink out of the workspace is refused. */
export function outputDirectory(root: string, relative: string): string {
  const dir = path.resolve(root, relative)
  mkdirSync(dir, { recursive: true })
  const real = realpathSync(dir)
  const inside = path.relative(realpathSync(root), real)
  if (inside.startsWith("..") || path.isAbsolute(inside))
    throw new Settings.SettingsError("PLUGIN_OUTPUT_DIR must stay inside the workspace.")
  return real
}

/** Copies kete's audit log (already redacted by the runtime) through the step's redactor as well. */
function copyAudit(result: JobResult, output: string, redact: Secrets.Redactor): boolean {
  if (typeof result.audit_log !== "string" || result.audit_local !== true || !existsSync(result.audit_log)) return false
  const text = readFileSync(result.audit_log, "utf8")
  Outputs.writeArtifact(output, "audit.jsonl", text.split("\n").map(redact).join("\n"))
  return true
}

type PushOutcome = { kind: "pushed" | "no_changes" | "refused" | "failed"; note: string }

function commitAndPush(
  settings: Settings.RunSettings,
  input: {
    readonly worktree: string
    readonly branch: string
    readonly root: string
    readonly push: { readonly remote: Git.Remote; readonly protected: Set<string> }
    readonly env: Env
    readonly prompt: string
  },
  ctx: Git.Context,
): PushOutcome {
  // The names read before the run, plus any the workspace has now (more protection, never less).
  if (
    Git.isProtected(input.push.protected, input.branch) ||
    Git.isProtected(Git.protectedBranches(input.root, ctx), input.branch)
  )
    return { kind: "refused", note: `Not pushed: ${input.branch} is a protected branch.` }
  const title = settings.preset ? `kete: ${settings.preset}` : `kete: ${input.prompt.split("\n")[0]!.slice(0, 60)}`
  const result = Git.publish(
    {
      worktree: input.worktree,
      branch: input.branch,
      remote: input.push.remote,
      message: `${title}\n\nMade by Kete Code in a Harness pipeline step.`,
      author: { name: settings.authorName, email: settings.authorEmail },
      credentials: input.env,
    },
    ctx,
  )
  if (result.kind === "no_changes") return { kind: "no_changes", note: "Nothing was pushed: the run changed no files." }
  if (result.kind === "pushed") return { kind: "pushed", note: `Commit ${result.sha.slice(0, 12)}.` }
  if (result.kind === "exists")
    return {
      kind: "refused",
      note: `Not pushed: branch ${input.branch} already exists on the remote; the step only creates new branches.`,
    }
  return { kind: "failed", note: `Not pushed: ${result.message}` }
}

/**
 * The environment the agent's process tree starts from: the step's own, without the plugin's
 * settings, the clone credentials or anything whose name looks like a secret, plus only the model
 * access this run needs.
 */
export function sanitize(env: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (name.startsWith("PLUGIN_") || name.startsWith("DRONE_NETRC_") || KeteRedact.isSecretKey(name)) continue
    out[name] = value
  }
  return out
}

/**
 * The agent's environment: `sanitize`d, plus the model access as config whose keys are `{file:...}`
 * references to 0600 files written into `keyDir` (created 0700; the caller deletes it). No key value
 * is in the returned environment.
 */
export function keteEnv(settings: Settings.RunSettings, env: Env, keyDir: string): Record<string, string> {
  const out = sanitize(env)
  // Never self-update inside a pipeline step; the image pins its kete.
  out.KETE_DISABLE_AUTOUPDATE = "1"
  if (settings.platformURL !== undefined) out.KETE_PLATFORM_URL = settings.platformURL
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  const keyFile = (name: string, key: string) => {
    const file = path.join(keyDir, name)
    writeFileSync(file, key, { mode: 0o600, flag: "wx" })
    // Forward slashes: kete's `{file:}` reference is config text (and Windows accepts them).
    return `{file:${file.replace(/\\/g, "/")}}`
  }
  const access = settings.access
  const providers: Record<string, unknown> = {}
  if (access.kind === "gateway") {
    out.KETE_GATEWAY_URL = access.gatewayURL
    providers.kete = { settings: { apiKey: keyFile("kete", access.key) } }
  } else if (access.kind === "providers") {
    for (const [id, key] of Object.entries(access.keys)) providers[id] = { settings: { apiKey: keyFile(id, key) } }
  } else {
    // An OpenAI-compatible endpoint as a custom provider (docs/local-models.md).
    providers[endpointProvider] = {
      name: "Pipeline model endpoint",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: access.url, ...(access.key ? { apiKey: keyFile(endpointProvider, access.key) } : {}) },
      models: { [settings.model ?? ""]: {} },
    }
  }
  out.KETE_CONFIG_CONTENT = JSON.stringify({ providers })
  return out
}

type Child = { code: number | null; stdout: string; timedOut: boolean }

const stdoutMax = 16 * 1024 * 1024

function spawnKete(
  kete: string,
  spec: string,
  cwd: string,
  env: Record<string, string>,
  opts: { limitMs: number; log: (line: string) => void },
): Promise<Child> {
  return new Promise((resolve, reject) => {
    const child = spawn(kete, ["job", "run", spec, "--json", "--standalone"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let pending = ""
    let timedOut = false
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < stdoutMax) stdout += chunk
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      pending += chunk
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) opts.log(`kete: ${line}`)
    })
    const stop = () => {
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.limitMs)
    // A cancelled step (SIGTERM from the runner, or Ctrl-C) stops kete too: it keeps its worktree
    // and writes its result; nothing is left running.
    const forward = () => stop()
    process.on("SIGTERM", forward)
    process.on("SIGINT", forward)
    const done = () => {
      clearTimeout(timer)
      process.off("SIGTERM", forward)
      process.off("SIGINT", forward)
    }
    child.on("error", (error) => {
      done()
      reject(error)
    })
    child.on("close", (code) => {
      done()
      if (pending) opts.log(`kete: ${pending}`)
      resolve({ code, stdout, timedOut })
    })
  })
}

function parseResult(stdout: string): JobResult | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JobResult) : undefined
  } catch {
    return undefined
  }
}
