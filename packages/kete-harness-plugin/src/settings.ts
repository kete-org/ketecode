// Kete-owned. Parses and validates the step's settings. Harness CI (like Drone) hands a Plugin
// step's `settings:` to the container as `PLUGIN_<NAME>` environment variables (upper-cased); list
// values arrive comma-joined, objects as JSON. Every problem is a refusal (exit 2) whose message
// names the setting and never its value: several settings hold secrets.

export * as Settings from "./settings.js"

export type Env = Readonly<Record<string, string | undefined>>

export type AllowRule = { readonly action: string; readonly resource: string }

export type Preset = "fix-build" | "review" | "release-notes"
export const presets: readonly Preset[] = ["fix-build", "review", "release-notes"]

/** Where `run` mode's model access comes from. Keys are kept here only to hand to `kete`'s environment. */
export type ModelAccess =
  | { readonly kind: "gateway"; readonly key: string; readonly gatewayURL: string }
  | { readonly kind: "providers"; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: "endpoint"; readonly url: string; readonly key: string | undefined }

type Common = {
  /** The task text, when given. At least one of `task` and `preset` is set. */
  readonly task: string | undefined
  readonly preset: Preset | undefined
  /** Workspace-relative path of the previous step's log (`fix-build`). */
  readonly log: string | undefined
  /** Base ref for `review` and `release-notes` (a branch, tag or commit), when given. */
  readonly base: string | undefined
  readonly allow: readonly AllowRule[]
  /** USD for the whole run. */
  readonly budget: number
  /** Minutes for the whole run. */
  readonly timeout: number
  readonly agent: string | undefined
  /** Workspace-relative directory for summary.md, result.json and audit.jsonl. */
  readonly outputDir: string
}

export type RunSettings = Common & {
  readonly mode: "run"
  readonly model: string | undefined
  readonly access: ModelAccess
  /** A new branch to push the result to, or "generated" for the run's own `kete/job/<hex>`. */
  readonly pushBranch: string | undefined
  readonly platformURL: string
  readonly authorName: string
  readonly authorEmail: string
}

export type CloudSettings = Common & {
  readonly mode: "cloud"
  readonly key: string
  readonly baseURL: string
  readonly project: string
  readonly repository: string
  readonly agent: string
  readonly baseRef: string | undefined
  /** `push: true`, with an optional branch suffix (the platform names the branch `kete/job/<suffix>`). */
  readonly push: { readonly suffix: string | undefined } | undefined
  readonly openPR: boolean
  readonly idempotencyKey: string | undefined
}

export type Settings = RunSettings | CloudSettings

export class SettingsError extends Error {
  override readonly name = "SettingsError"
}

/** The Kete platform's address when `PLUGIN_BASE_URL` isn't set. */
export const defaultBaseURL = "https://app.ketecode.ai"

export const limits = {
  /** The cloud API's maximum (`JOB_BUDGET_MAX_MICROS`, docs/platform/jobs-v1.md). */
  cloudBudgetUSD: 25,
  /** The cloud API's maximum (`JOB_TIMEOUT_MAX_MINUTES`). */
  cloudTimeoutMinutes: 120,
  /** One day: a CI step longer than that is a mistake, not a plan. */
  runTimeoutMinutes: 1440,
  taskBytes: 200_000,
  allowRules: 50,
} as const

/** BYOK settings and the environment variables `kete` reads them from (models.dev `env` names). */
export const providerKeys: Readonly<Record<string, readonly string[]>> = {
  PLUGIN_ANTHROPIC_API_KEY: ["ANTHROPIC_API_KEY"],
  PLUGIN_OPENAI_API_KEY: ["OPENAI_API_KEY"],
  PLUGIN_GEMINI_API_KEY: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  PLUGIN_OPENROUTER_API_KEY: ["OPENROUTER_API_KEY"],
  PLUGIN_DEEPSEEK_API_KEY: ["DEEPSEEK_API_KEY"],
}

const fail = (message: string): never => {
  throw new SettingsError(message)
}

function value(env: Env, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === "" ? undefined : trimmed
}

function bool(env: Env, name: string): boolean {
  const raw = value(env, name)
  if (raw === undefined) return false
  const lower = raw.toLowerCase()
  if (lower === "true" || lower === "1" || lower === "yes") return true
  if (lower === "false" || lower === "0" || lower === "no") return false
  return fail(`${name} must be true or false.`)
}

/** A secret must be one line of printable ASCII (no spaces): anything else is a paste error, refused without echoing it. */
function secret(env: Env, name: string): string | undefined {
  const raw = value(env, name)
  if (raw === undefined) return undefined
  if (!/^[\x21-\x7E]{1,4096}$/.test(raw))
    return fail(`${name} is not a valid key (one line of printable characters, no spaces).`)
  return raw
}

/** An http(s) URL without credentials, query or fragment; plain http only for this machine (tests, a local proxy). */
export function httpURL(name: string, raw: string): string {
  if (!URL.canParse(raw)) return fail(`${name} is not a URL.`)
  const url = new URL(raw)
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail(`${name} must be an https URL.`)
  if (url.username !== "" || url.password !== "") return fail(`${name} must not contain credentials.`)
  if (url.search !== "" || url.hash !== "") return fail(`${name} must not have a query or fragment.`)
  if (url.protocol === "http:" && !isLoopback(url.hostname))
    return fail(`${name} must be an https URL (plain http is only accepted for localhost).`)
  return url.toString().replace(/\/+$/, "")
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** Positive USD amount. */
export function budget(raw: string | undefined, max: number | undefined): number {
  if (raw === undefined) return fail("PLUGIN_BUDGET is required: the most the run may spend, in USD (for example 2).")
  const text = raw.replace(/^\$/, "")
  if (!/^\d+(?:\.\d{1,6})?$/.test(text))
    return fail("PLUGIN_BUDGET must be a positive amount in USD, such as 2 or 0.50.")
  const amount = Number(text)
  if (!(amount > 0)) return fail("PLUGIN_BUDGET must be greater than 0.")
  if (max !== undefined && amount > max) return fail(`PLUGIN_BUDGET must be at most ${max} USD in cloud mode.`)
  return amount
}

/** Whole minutes: `30`, `30m` or `2h`. */
export function timeout(raw: string | undefined, max: number): number {
  if (raw === undefined)
    return fail("PLUGIN_TIMEOUT is required: the most the run may take, in minutes (for example 30, 30m or 2h).")
  const match = /^(\d+)\s*(m|min|minutes?|h|hours?)?$/i.exec(raw)
  if (!match) return fail("PLUGIN_TIMEOUT must be whole minutes, such as 30, 30m or 2h.")
  const minutes = Number(match[1]) * (match[2]?.toLowerCase().startsWith("h") ? 60 : 1)
  if (!(minutes > 0)) return fail("PLUGIN_TIMEOUT must be greater than 0.")
  if (minutes > max) return fail(`PLUGIN_TIMEOUT must be at most ${max} minutes.`)
  return minutes
}

/**
 * `PLUGIN_ALLOW`: rules the run may proceed on without asking (ADR 0008), as a JSON array of
 * `{action, resource}` objects, or `action:resource` items separated by newlines or commas
 * (Harness joins a YAML list with commas). `question` and `budget` can never be allowed.
 */
export function allow(raw: string | undefined): AllowRule[] {
  if (raw === undefined) return []
  const rules: AllowRule[] = []
  if (raw.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return fail("PLUGIN_ALLOW is not valid JSON.")
    }
    if (!Array.isArray(parsed)) return fail("PLUGIN_ALLOW must be a JSON array.")
    parsed.forEach((item: unknown, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return fail(`PLUGIN_ALLOW[${index}] must be an object with action and resource.`)
      const keys = Object.keys(item)
      const extra = keys.find((key) => key !== "action" && key !== "resource")
      if (extra !== undefined) return fail(`PLUGIN_ALLOW[${index}] has an unknown field: ${extra}.`)
      const { action, resource } = item as { action?: unknown; resource?: unknown }
      if (typeof action !== "string" || typeof resource !== "string")
        return fail(`PLUGIN_ALLOW[${index}] needs string action and resource.`)
      rules.push(rule(action, resource, `PLUGIN_ALLOW[${index}]`))
    })
  } else {
    raw
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .forEach((item, index) => {
        const at = item.indexOf(":")
        if (at <= 0)
          return fail(`PLUGIN_ALLOW item ${index + 1} must look like action:resource (for example shell:bun test*).`)
        rules.push(rule(item.slice(0, at), item.slice(at + 1), `PLUGIN_ALLOW item ${index + 1}`))
      })
  }
  if (rules.length > limits.allowRules) return fail(`PLUGIN_ALLOW has more than ${limits.allowRules} rules.`)
  return rules
}

function rule(action: string, resource: string, where: string): AllowRule {
  const a = action.trim()
  const r = resource.trim()
  if (!/^[a-z][a-z0-9_.-]{0,199}$/i.test(a))
    return fail(`${where}: the action must be a permission name such as edit or shell.`)
  if (a === "question" || a === "budget") return fail(`${where}: "${a}" can never be allowed in an unattended run.`)
  if (r === "" || r.length > 500) return fail(`${where}: the resource must be 1 to 500 characters.`)
  return { action: a, resource: r }
}

/** A conservative git branch name (the platform's `isJobGitRef`): letters, digits, `._/-`, no `..`, no leading `-`/`/`/`.`. */
export function isBranchName(ref: string): boolean {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(ref) && !/(^[-/.]|\/$|\.$|\/\/|\.\.|\/\.|\.lock(\/|$)|@\{)/.test(ref)
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A workspace-relative path: no absolute path, no `..` segment. The caller still resolves symlinks. */
export function relativePath(name: string, raw: string): string {
  const normalized = raw.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized))
    return fail(`${name} must be a path inside the workspace, not an absolute path.`)
  if (normalized.split("/").includes("..")) return fail(`${name} must not contain "..".`)
  return normalized
}

export function parse(env: Env): Settings {
  const mode = (value(env, "PLUGIN_MODE") ?? "run").toLowerCase()
  if (mode !== "run" && mode !== "cloud") return fail(`PLUGIN_MODE must be run or cloud (got an unknown mode).`)

  const task = value(env, "PLUGIN_TASK")
  if (task !== undefined && Buffer.byteLength(task, "utf8") > limits.taskBytes)
    return fail(`PLUGIN_TASK is longer than ${limits.taskBytes} bytes.`)
  const presetRaw = value(env, "PLUGIN_PRESET")
  if (presetRaw !== undefined && !presets.includes(presetRaw as Preset))
    return fail(`PLUGIN_PRESET must be one of ${presets.join(", ")}.`)
  const preset = presetRaw as Preset | undefined
  if (task === undefined && preset === undefined)
    return fail("Set PLUGIN_TASK (what Kete Code should do) or PLUGIN_PRESET (fix-build, review or release-notes).")
  const logRaw = value(env, "PLUGIN_LOG")
  const log = logRaw === undefined ? undefined : relativePath("PLUGIN_LOG", logRaw)
  if (preset === "fix-build" && log === undefined)
    return fail("PLUGIN_PRESET fix-build needs PLUGIN_LOG: the path of the failed step's log inside the workspace.")
  const base = value(env, "PLUGIN_BASE")
  if (base !== undefined && !isBranchName(base)) return fail("PLUGIN_BASE must be a branch, tag or commit name.")
  const agent = value(env, "PLUGIN_AGENT")
  if (agent !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agent))
    return fail("PLUGIN_AGENT must be an agent name such as build.")

  const cloud = mode === "cloud"
  const common: Common = {
    task,
    preset,
    log,
    base,
    allow: allow(value(env, "PLUGIN_ALLOW")),
    budget: budget(value(env, "PLUGIN_BUDGET"), cloud ? limits.cloudBudgetUSD : undefined),
    timeout: timeout(value(env, "PLUGIN_TIMEOUT"), cloud ? limits.cloudTimeoutMinutes : limits.runTimeoutMinutes),
    agent,
    outputDir: relativePath("PLUGIN_OUTPUT_DIR", value(env, "PLUGIN_OUTPUT_DIR") ?? "kete-output"),
  }
  const baseURL = httpURL("PLUGIN_BASE_URL", value(env, "PLUGIN_BASE_URL") ?? defaultBaseURL)
  const pushRaw = value(env, "PLUGIN_PUSH_BRANCH")
  const key = secret(env, "PLUGIN_KETE_API_KEY")

  if (cloud) {
    if (key === undefined) return fail("Cloud mode needs PLUGIN_KETE_API_KEY (a Kete API key, from a Harness secret).")
    const project = value(env, "PLUGIN_PROJECT")
    if (project === undefined || !GUID.test(project))
      return fail("Cloud mode needs PLUGIN_PROJECT: the Kete project id.")
    const repository = value(env, "PLUGIN_REPO")
    if (repository === undefined || !GUID.test(repository))
      return fail("Cloud mode needs PLUGIN_REPO: the id of a repository connected to that Kete project.")
    if (agent === undefined)
      return fail("Cloud mode needs PLUGIN_AGENT: the slug of one of your organization's agents.")
    const baseRef = value(env, "PLUGIN_BASE_REF")
    if (baseRef !== undefined && !isBranchName(baseRef)) return fail("PLUGIN_BASE_REF must be a branch name.")
    let push: CloudSettings["push"]
    if (pushRaw !== undefined && pushRaw.toLowerCase() !== "false") {
      const suffix = pushRaw.toLowerCase() === "true" ? undefined : pushRaw.replace(/^kete\/job\//, "")
      if (suffix !== undefined && !isBranchName(`kete/job/${suffix}`))
        return fail("PLUGIN_PUSH_BRANCH must be true or a branch suffix (cloud jobs push to kete/job/<suffix>).")
      push = { suffix }
    }
    const openPR = bool(env, "PLUGIN_OPEN_PR")
    if (openPR && push === undefined) return fail("PLUGIN_OPEN_PR needs PLUGIN_PUSH_BRANCH.")
    const idempotencyKey = value(env, "PLUGIN_IDEMPOTENCY_KEY")
    if (idempotencyKey !== undefined && !/^[\x21-\x7E]{1,100}$/.test(idempotencyKey))
      return fail("PLUGIN_IDEMPOTENCY_KEY must be 1 to 100 printable characters.")
    return { ...common, mode: "cloud", key, baseURL, project, repository, agent, baseRef, push, openPR, idempotencyKey }
  }

  const model = value(env, "PLUGIN_MODEL")
  if (model !== undefined && !/^[A-Za-z0-9][\w.:@/+-]{0,200}(#[\w.-]+)?$/.test(model))
    return fail("PLUGIN_MODEL must be provider/model (or the model id at PLUGIN_MODEL_URL).")
  const access = modelAccess(env, key, model)
  let pushBranch: string | undefined
  if (pushRaw !== undefined && pushRaw.toLowerCase() !== "false") {
    pushBranch = pushRaw.toLowerCase() === "true" ? "generated" : pushRaw
    if (pushBranch !== "generated" && !isBranchName(pushBranch))
      return fail("PLUGIN_PUSH_BRANCH must be true or a valid new branch name.")
  }
  const authorName = value(env, "PLUGIN_GIT_AUTHOR_NAME") ?? "Kete Code"
  const authorEmail = value(env, "PLUGIN_GIT_AUTHOR_EMAIL") ?? "kete-code@users.noreply.invalid"
  if (/[\r\n<>]/.test(authorName) || authorName.length > 100) return fail("PLUGIN_GIT_AUTHOR_NAME is not a valid name.")
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(authorEmail)) return fail("PLUGIN_GIT_AUTHOR_EMAIL is not a valid email address.")
  return {
    ...common,
    mode: "run",
    model,
    access,
    pushBranch,
    platformURL: baseURL,
    authorName,
    authorEmail,
  }
}

function modelAccess(env: Env, key: string | undefined, model: string | undefined): ModelAccess {
  const endpoint = value(env, "PLUGIN_MODEL_URL")
  const providers: Record<string, string> = {}
  for (const [setting, names] of Object.entries(providerKeys)) {
    const v = secret(env, setting)
    if (v !== undefined) for (const name of names) providers[name] = v
  }
  const chosen = [key !== undefined, endpoint !== undefined, Object.keys(providers).length > 0].filter(Boolean).length
  if (chosen === 0)
    return fail(
      "Run mode needs model access: PLUGIN_KETE_API_KEY (with PLUGIN_GATEWAY_URL), a provider key such as PLUGIN_ANTHROPIC_API_KEY, or PLUGIN_MODEL_URL.",
    )
  if (chosen > 1)
    return fail("Use one kind of model access: PLUGIN_KETE_API_KEY, provider keys, or PLUGIN_MODEL_URL, not several.")
  if (key !== undefined) {
    const gateway = value(env, "PLUGIN_GATEWAY_URL")
    if (gateway === undefined)
      return fail("PLUGIN_KETE_API_KEY needs PLUGIN_GATEWAY_URL: your Kete Model Gateway address.")
    return { kind: "gateway", key, gatewayURL: httpURLAllowPrivate("PLUGIN_GATEWAY_URL", gateway) }
  }
  if (endpoint !== undefined) {
    if (model === undefined) return fail("PLUGIN_MODEL_URL needs PLUGIN_MODEL: the model id that endpoint serves.")
    return {
      kind: "endpoint",
      url: httpURLAllowPrivate("PLUGIN_MODEL_URL", endpoint),
      key: secret(env, "PLUGIN_MODEL_API_KEY"),
    }
  }
  return { kind: "providers", env: providers }
}

/**
 * A model or gateway address: https, or plain http on this machine or a private network (a model
 * server inside the pipeline's own network, as `kete` itself allows for local model servers).
 */
function httpURLAllowPrivate(name: string, raw: string): string {
  if (!URL.canParse(raw)) return fail(`${name} is not a URL.`)
  const url = new URL(raw)
  if (url.protocol === "http:" && isPrivate(url.hostname)) {
    if (url.username !== "" || url.password !== "") return fail(`${name} must not contain credentials.`)
    if (url.search !== "" || url.hash !== "") return fail(`${name} must not have a query or fragment.`)
    return url.toString().replace(/\/+$/, "")
  }
  return httpURL(name, raw)
}

function isPrivate(host: string): boolean {
  if (isLoopback(host)) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
