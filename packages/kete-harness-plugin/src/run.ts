// Kete-owned. `run` mode: `kete job run` (docs/jobs.md, ADR 0008) in the pipeline's workspace.
// `kete job run` creates its own worktree and branch from the workspace's HEAD, denies every
// permission the policy doesn't allow, and refuses to start without a budget and a time limit; this
// step writes the spec, starts it with a minimal environment, copies its (already redacted) audit
// log into the workspace as an artifact, writes a redacted summary, and optionally commits the
// worktree and pushes it to a NEW branch.

import { spawn } from "node:child_process"
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { KeteRedact } from "@opencode/util/kete/redact"
import { Git } from "./git.js"
import { Outputs } from "./outputs.js"
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
  readonly log: (line: string) => void
  /** Extra time after the run's own limit before the step stops `kete` itself. */
  readonly graceMs?: number
}

/** The provider id the step defines for `PLUGIN_MODEL_URL` (an OpenAI-compatible endpoint). */
export const endpointProvider = "endpoint"
// Not KETE_*: kete renames those to its internal names at startup, and the config reference would miss it.
const endpointKeyVariable = "PIPELINE_MODEL_ENDPOINT_KEY"

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
  const root = realpathSync(workspace(env))
  const targetBranch = env.DRONE_TARGET_BRANCH?.trim() || undefined
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
    built = Task.build(settings, { workspace: root, targetBranch })
  } catch (error) {
    if (error instanceof Task.TaskError) return refuse(error.message)
    throw error
  }

  let branch: string | undefined
  if (settings.pushBranch !== undefined && settings.pushBranch !== "generated") {
    if (Git.protectedBranches(root, env).has(settings.pushBranch))
      return refuse(
        `PLUGIN_PUSH_BRANCH names a protected branch (the target, default or current branch); push to a new branch instead.`,
      )
    branch = settings.pushBranch
  }

  const output = outputDirectory(root, settings.outputDir)
  const temp = mkdtempSync(path.join(tmpdir(), "kete-harness-"))
  try {
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

    const child = await spawnKete(deps.kete, specPath, root, keteEnv(settings, env), {
      limitMs: settings.timeout * 60_000 + (deps.graceMs ?? 5 * 60_000),
      log: deps.log,
    })
    const result = parseResult(child.stdout)
    if (!result) {
      const why = child.timedOut
        ? "kete job run didn't finish within its time limit"
        : `kete job run exited ${child.code} without a result`
      deps.log(`error: ${why}`)
      writeSummary(output, `## Kete Code: error\n\n${why}\n`)
      return report(1, child.timedOut ? "time_limit" : "error", why, "")
    }

    const outcome = typeof result.outcome === "string" ? result.outcome : "error"
    const text =
      typeof result.text === "string" ? result.text : typeof result.message === "string" ? result.message : ""
    const auditCopied = copyAudit(result, output)
    writeFileSync(path.join(output, "result.json"), JSON.stringify(KeteRedact.deep(result), null, 2) + "\n", {
      mode: 0o644,
    })

    let exit = Outputs.exitCode(outcome)
    let finalOutcome = outcome
    let pushed = ""
    const notes: string[] = []
    if (!auditCopied) notes.push("No audit log was available to copy.")
    if (settings.pushBranch !== undefined) {
      const wt = typeof result.worktree === "string" ? result.worktree : undefined
      const runBranch = typeof result.branch === "string" ? result.branch : undefined
      if (outcome !== "completed") notes.push("Nothing was pushed: the run didn't complete.")
      else if (!wt || !runBranch || result.isolated !== true) {
        finalOutcome = "push_failed"
        exit = 1
        notes.push("Nothing was pushed: the run had no worktree and branch (is the workspace a git repository?).")
      } else {
        const target = branch ?? runBranch
        const push = commitAndPush(settings, wt, target, root, env, built.prompt)
        notes.push(push.note)
        if (push.kind === "pushed") pushed = target
        else if (push.kind === "refused") {
          finalOutcome = "push_refused"
          exit = 2
        } else if (push.kind === "failed") {
          finalOutcome = "push_failed"
          exit = 1
        }
      }
    }

    const cost = typeof result.cost_usd === "number" ? result.cost_usd : undefined
    const denied = Array.isArray(result.denied) ? result.denied.length : 0
    writeSummary(
      output,
      [
        `## Kete Code: ${finalOutcome}`,
        "",
        `- Outcome: ${outcome}${cost !== undefined ? ` · cost ${cost.toFixed(4)} USD` : ""} · ${denied} denied permission(s)`,
        ...(pushed ? [`- Pushed to new branch \`${pushed}\``] : []),
        ...notes.map((n) => `- ${n}`),
        "",
        KeteRedact.text(text),
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

function report(exit: Outputs.ExitCode, outcome: string, summary: string, branch: string): Report {
  return {
    exit,
    values: { KETE_OUTCOME: outcome, KETE_SUMMARY: Outputs.oneLine(summary), KETE_BRANCH: branch, KETE_JOB_URL: "" },
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

function writeSummary(output: string, text: string) {
  writeFileSync(path.join(output, "summary.md"), text, { mode: 0o644 })
}

function copyAudit(result: JobResult, output: string): boolean {
  if (typeof result.audit_log !== "string" || result.audit_local !== true || !existsSync(result.audit_log)) return false
  copyFileSync(result.audit_log, path.join(output, "audit.jsonl"))
  return true
}

type PushOutcome = { kind: "pushed" | "no_changes" | "refused" | "failed"; note: string }

function commitAndPush(
  settings: Settings.RunSettings,
  worktree: string,
  branch: string,
  root: string,
  env: Env,
  prompt: string,
): PushOutcome {
  if (Git.protectedBranches(root, env).has(branch))
    return { kind: "refused", note: `Not pushed: ${branch} is a protected branch.` }
  const gitEnv = sanitize(env)
  const title = settings.preset ? `kete: ${settings.preset}` : `kete: ${prompt.split("\n")[0]!.slice(0, 60)}`
  const commit = Git.commitAll(
    worktree,
    `${title}\n\nMade by Kete Code in a Harness pipeline step.`,
    { name: settings.authorName, email: settings.authorEmail },
    gitEnv,
  )
  if (commit.kind === "no_changes") return { kind: "no_changes", note: "Nothing was pushed: the run changed no files." }
  if (commit.kind === "failed") return { kind: "failed", note: `Not pushed: ${commit.message}` }
  const push = Git.pushNew(worktree, branch, gitEnv, env)
  if (push.kind === "pushed") return { kind: "pushed", note: `Commit ${commit.sha.slice(0, 12)}.` }
  if (push.kind === "exists")
    return {
      kind: "refused",
      note: `Not pushed: branch ${branch} already exists on the remote; the step only creates new branches.`,
    }
  return { kind: "failed", note: `Not pushed: ${push.message}` }
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

export function keteEnv(settings: Settings.RunSettings, env: Env): Record<string, string> {
  const out = sanitize(env)
  // Never self-update inside a pipeline step; the image pins its kete.
  out.KETE_DISABLE_AUTOUPDATE = "1"
  out.KETE_PLATFORM_URL = settings.platformURL
  const access = settings.access
  if (access.kind === "gateway") {
    out.KETE_GATEWAY_URL = access.gatewayURL
    out.KETE_GATEWAY_KEY = access.key
  } else if (access.kind === "providers") {
    Object.assign(out, access.env)
  } else {
    // An OpenAI-compatible endpoint as a custom provider (docs/local-models.md); the key, if any, is
    // referenced from the environment rather than written into the config text.
    const provider: Record<string, unknown> = {
      name: "Pipeline model endpoint",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: access.url, ...(access.key ? { apiKey: `{env:${endpointKeyVariable}}` } : {}) },
      models: { [settings.model ?? ""]: {} },
    }
    out.KETE_CONFIG_CONTENT = JSON.stringify({ providers: { [endpointProvider]: provider } })
    if (access.key) out[endpointKeyVariable] = access.key
  }
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
      for (const line of lines) opts.log(`kete: ${KeteRedact.text(line)}`)
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
      if (pending) opts.log(`kete: ${KeteRedact.text(pending)}`)
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
