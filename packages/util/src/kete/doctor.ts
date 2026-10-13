// `kete doctor` (packages/cli/src/kete/doctor.ts) and `/doctor` (packages/tui/src/kete/doctor.tsx):
// what each surface found out (`Facts`) becomes a list of checks, each ok, a warning, a failure or
// information, with how to fix it. Plain functions, no Node imports and no I/O: the surfaces gather the
// facts (the runtime's `kete.doctor`, `kete.sandbox`, provider, model and MCP answers, and local state)
// and render the checks. A fact that couldn't be found out is `undefined`, and the check says so
// rather than guessing. Nothing here leaves the machine.

export * as KeteDoctor from "./doctor.js"

import { Brand } from "./brand.js"

export type Status = "ok" | "warn" | "fail" | "info"

export const GROUPS = ["Install", "Runtime", "Config", "Models", "MCP servers", "Sandbox", "Terminal"] as const
export type Group = (typeof GROUPS)[number]

export interface Check {
  readonly group: Group
  readonly status: Status
  readonly title: string
  /** More lines under the title (a file's errors, held-back settings). */
  readonly details?: readonly string[]
  /** What to do about it. */
  readonly fix?: string
}

/** The runtime's `kete.doctor` answer (schema/src/kete/doctor.ts `KeteDoctorRpc.Report`). */
export interface RuntimeReport {
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly scope: "global" | "project" | "explicit"
    readonly state: "ok" | "warnings" | "invalid" | "rejected" | "unreadable"
    readonly messages: readonly string[]
  }>
  readonly trust: {
    readonly state: "trusted" | "untrusted" | "clear" | "pending"
    readonly reason?: "store" | "run" | "job"
    readonly held: readonly string[]
    readonly heldCount: number
    readonly refusal?: string
  }
}

/** The runtime's `kete.sandbox` status (schema/src/kete/sandbox.ts). */
export interface Sandbox {
  readonly state: string
  readonly mechanism?: string
  readonly mode?: string
  readonly reason?: string
}

export type Environment = Readonly<Record<string, string | undefined>>

export interface Facts {
  readonly version: string
  readonly channel: string
  /** How this binary was installed (cli/src/kete/updater.ts `detect`); the CLI only. */
  readonly install?: string
  readonly platform: string
  /** The process environment. Only TERM, COLORTERM, TERM_PROGRAM, TMUX, STY, WT_SESSION and NO_COLOR are read. */
  readonly env: Environment
  /** stdin and stdout are terminals; `undefined` when the surface is a terminal UI anyway. */
  readonly interactive?: boolean
  /** Every `kete` executable on PATH, in PATH order, and the running one; the CLI only. */
  readonly binaries?: { readonly onPath: readonly string[]; readonly running: string }
  readonly offline: boolean
  readonly signedIn: "yes" | "no" | "unknown"
  /** Whether the runtime answered at all. */
  readonly runtime: boolean
  readonly providers?: readonly string[]
  /** The model new sessions use; `null` when the runtime has none. */
  readonly defaultModel?: { readonly provider: string; readonly model: string } | null
  readonly mcp?: ReadonlyArray<{ readonly name: string; readonly status: string }>
  readonly sandbox?: Sandbox
  readonly report?: RuntimeReport
  /** Shown with `~` for this path. */
  readonly home?: string
}

const cli = Brand.cliName

/** `~` for the home directory, so the output is shorter and safe to paste. */
export function shown(file: string, home: string | undefined) {
  if (!home) return file
  const trimmed = home.replace(/[\\/]+$/, "")
  if (file === trimmed) return "~"
  for (const separator of ["/", "\\"])
    if (file.startsWith(trimmed + separator)) return `~${separator}${file.slice(trimmed.length + 1)}`
  return file
}

const INSTALLS: Readonly<Record<string, string>> = {
  direct: "standalone binary",
  homebrew: "installed with Homebrew",
  npm: "installed with npm",
  extension: "bundled with the editor extension",
  source: "source checkout or local build",
}

/** At most this many held-back settings are listed; the rest are counted. */
export const MAX_HELD_SHOWN = 5

const unknownRuntime = "unknown (the runtime didn't answer)"

function install(facts: Facts): Check[] {
  const how = facts.install ? `, ${INSTALLS[facts.install] ?? facts.install}` : ""
  const checks: Check[] = [
    { group: "Install", status: "info", title: `${Brand.displayName} ${facts.version} (${facts.channel} channel${how})` },
  ]
  const binaries = facts.binaries
  if (binaries) {
    const [first] = binaries.onPath
    if (!first)
      checks.push({
        group: "Install",
        status: "warn",
        title: `\`${cli}\` isn't on your PATH`,
        fix: `Add the folder with the ${cli} executable to PATH, or reinstall from ${Brand.urls.releases}.`,
      })
    else if (binaries.onPath.length > 1)
      checks.push({
        group: "Install",
        status: "warn",
        title: `${binaries.onPath.length} \`${cli}\` executables are on your PATH`,
        details: binaries.onPath.map((item, index) => `${index === 0 ? "runs: " : "hidden: "}${shown(item, facts.home)}`),
        fix: "Remove the installs you don't use, so updates go to the one that runs.",
      })
    else if (first !== binaries.running)
      checks.push({
        group: "Install",
        status: "info",
        title: `Typing \`${cli}\` runs ${shown(first, facts.home)}, not this one`,
      })
  }
  return checks
}

function runtime(facts: Facts): Check[] {
  if (facts.runtime) return [{ group: "Runtime", status: "ok", title: "The runtime answered" }]
  return [
    {
      group: "Runtime",
      status: "fail",
      title: "Couldn't reach the runtime",
      fix: `Try \`${cli} doctor --standalone\`; if it still fails, \`${cli} bug\` makes a report with the log.`,
    },
  ]
}

const scopes = { global: "your config", project: "project config", explicit: "config" } as const

function config(facts: Facts): Check[] {
  const report = facts.report
  if (!report) return [{ group: "Config", status: "info", title: `Config files: ${unknownRuntime}` }]
  const checks: Check[] = report.files.map((file): Check => {
    const name = `${scopes[file.scope]} ${shown(file.path, facts.home)}`
    switch (file.state) {
      case "ok":
        return { group: "Config", status: "ok", title: name }
      case "warnings":
        return { group: "Config", status: "warn", title: `${name}: some settings are ignored`, details: file.messages }
      case "invalid":
        return {
          group: "Config",
          status: "fail",
          title: `${name} isn't valid JSON, so none of it applies`,
          details: file.messages,
          fix: "Fix the file; until then the runtime ignores all of it.",
        }
      case "rejected":
        return {
          group: "Config",
          status: "fail",
          title: `${name} isn't a valid config, so none of it applies`,
          details: file.messages,
          fix: `Fix the file${Brand.urls.configSchema ? ` (the schema is at ${Brand.urls.configSchema})` : ""}; until then the runtime ignores all of it.`,
        }
      case "unreadable":
        return { group: "Config", status: "fail", title: `${name} couldn't be read`, details: file.messages }
    }
  })
  if (report.files.length === 0) checks.push({ group: "Config", status: "info", title: "No config files: the defaults apply" })
  const trust = report.trust
  if (trust.state === "trusted")
    checks.push({
      group: "Config",
      status: "ok",
      title:
        trust.reason === "run"
          ? "This folder's project config is trusted for this run"
          : trust.reason === "job"
            ? "Job mode: the job decides what project config loads"
            : "This folder's project config is trusted",
    })
  if (trust.state === "untrusted") {
    const listed = trust.held.slice(0, MAX_HELD_SHOWN)
    const more = trust.heldCount - listed.length
    checks.push({
      group: "Config",
      status: trust.refusal ? "info" : "warn",
      title: `This folder isn't trusted, so ${trust.heldCount} of its project settings are held back`,
      details: [...listed, ...(more > 0 ? [`and ${more} more`] : []), ...(trust.refusal ? [`Can't be trusted: ${trust.refusal}`] : [])],
      ...(trust.refusal ? {} : { fix: `Trust it with \`${cli} trust add\` if you trust the repository.` }),
    })
  }
  return checks
}

function models(facts: Facts): Check[] {
  const checks: Check[] = []
  if (facts.offline)
    checks.push({ group: "Models", status: "info", title: "Offline mode is on: only local models are used" })
  checks.push(
    facts.signedIn === "yes"
      ? { group: "Models", status: "ok", title: `Signed in to your ${Brand.displayName} account` }
      : facts.signedIn === "no"
        ? {
            group: "Models",
            status: "info",
            title: `Not signed in to a ${Brand.displayName} account (needed only for the ${Brand.displayName} gateway)`,
          }
        : { group: "Models", status: "info", title: "Couldn't read the account state" },
  )
  if (facts.providers === undefined) checks.push({ group: "Models", status: "info", title: `Model providers: ${unknownRuntime}` })
  else if (facts.providers.length === 0)
    checks.push({
      group: "Models",
      status: "fail",
      title: "No model provider is set up",
      fix: `Run \`${cli} login\` for the ${Brand.displayName} gateway, \`${cli} auth login\` to add an API key, or start a local model server such as Ollama.`,
    })
  else checks.push({ group: "Models", status: "ok", title: `Model providers: ${facts.providers.join(", ")}` })
  if (facts.defaultModel === null)
    checks.push({
      group: "Models",
      status: "fail",
      title: "No model is available for new sessions",
      fix: `Set \`model\` in your config, or add a provider (see above).`,
    })
  else if (facts.defaultModel)
    checks.push({ group: "Models", status: "ok", title: `New sessions use ${facts.defaultModel.provider}/${facts.defaultModel.model}` })
  return checks
}

function mcp(facts: Facts): Check[] {
  if (facts.mcp === undefined) return [{ group: "MCP servers", status: "info", title: `MCP servers: ${unknownRuntime}` }]
  if (facts.mcp.length === 0) return [{ group: "MCP servers", status: "info", title: "No MCP servers are configured" }]
  return facts.mcp.map((server): Check => {
    switch (server.status) {
      case "connected":
        return { group: "MCP servers", status: "ok", title: `${server.name}: connected` }
      case "needs_auth":
        return {
          group: "MCP servers",
          status: "warn",
          title: `${server.name}: needs you to sign in`,
          fix: `Run \`${cli} mcp auth ${server.name}\`.`,
        }
      case "failed":
        return {
          group: "MCP servers",
          status: "fail",
          title: `${server.name}: failed to start or connect`,
          fix: `Check its command or URL with \`${cli} mcp list\`; the log has the error.`,
        }
      case "disabled":
        return { group: "MCP servers", status: "info", title: `${server.name}: turned off` }
      case "pending":
        return { group: "MCP servers", status: "info", title: `${server.name}: still connecting` }
      default:
        return { group: "MCP servers", status: "info", title: `${server.name}: ${server.status}` }
    }
  })
}

function sandbox(facts: Facts): Check[] {
  const status = facts.sandbox
  if (!status) return [{ group: "Sandbox", status: "info", title: `OS sandbox: ${unknownRuntime}` }]
  const why = status.reason ? [status.reason] : undefined
  switch (status.state) {
    case "on":
      return [{ group: "Sandbox", status: "ok", title: `Agent commands run in the OS sandbox${status.mechanism ? ` (${status.mechanism})` : ""}` }]
    case "off":
      return [
        {
          group: "Sandbox",
          status: "warn",
          title: "The OS sandbox is off: agent commands can reach all your files",
          details: why,
          fix: "Turn it back on unless you meant to (docs/sandbox.md).",
        },
      ]
    case "unavailable":
      return [
        status.mode === "required"
          ? {
              group: "Sandbox",
              status: "fail",
              title: "The OS sandbox is required but isn't available, so agent commands are refused",
              details: why,
              fix: facts.platform === "linux" ? "Install bubblewrap (bwrap)." : "See docs/sandbox.md for supported platforms.",
            }
          : {
              group: "Sandbox",
              status: "warn",
              title: "The OS sandbox isn't available: agent commands run without it",
              details: why,
              ...(facts.platform === "linux" ? { fix: "Install bubblewrap (bwrap) to turn it on." } : {}),
            },
      ]
    case "job":
      return [{ group: "Sandbox", status: "info", title: "Job mode: commands run in the job's own sandbox" }]
    default:
      return [{ group: "Sandbox", status: "info", title: `OS sandbox: ${status.state}` }]
  }
}

function terminal(facts: Facts): Check[] {
  const env = facts.env
  const checks: Check[] = []
  if (facts.interactive === false)
    checks.push({ group: "Terminal", status: "info", title: "Not running in a terminal (output is piped or redirected)" })
  const term = env.TERM
  if (term === "dumb")
    checks.push({
      group: "Terminal",
      status: "warn",
      title: "TERM is \"dumb\": the terminal UI can't draw",
      fix: "Run it in a terminal emulator, or set TERM (for example xterm-256color).",
    })
  else if (facts.platform !== "win32" && !term)
    checks.push({ group: "Terminal", status: "warn", title: "TERM isn't set", fix: "Set TERM, for example to xterm-256color." })
  const truecolor = env.COLORTERM === "truecolor" || env.COLORTERM === "24bit"
  if (env.NO_COLOR) checks.push({ group: "Terminal", status: "info", title: "NO_COLOR is set: colours are off" })
  else if (truecolor) checks.push({ group: "Terminal", status: "ok", title: "Full colour (24-bit)" })
  else if (term?.includes("256color")) checks.push({ group: "Terminal", status: "ok", title: "256 colours" })
  else if (facts.platform === "win32" && env.WT_SESSION) checks.push({ group: "Terminal", status: "ok", title: "Windows Terminal" })
  else if (term !== "dumb")
    checks.push({
      group: "Terminal",
      status: "info",
      title: "The terminal may show only a few colours",
      fix: "Themes look best in a terminal with 24-bit colour (COLORTERM=truecolor).",
    })
  if (facts.platform === "win32" && !env.WT_SESSION && !env.TERM_PROGRAM)
    checks.push({
      group: "Terminal",
      status: "warn",
      title: "This looks like the classic Windows console",
      fix: "Use Windows Terminal for keys, colours and mouse support.",
    })
  if (env.TMUX) checks.push({ group: "Terminal", status: "info", title: "Running in tmux" })
  else if (env.STY) checks.push({ group: "Terminal", status: "info", title: "Running in screen" })
  return checks
}

export function checks(facts: Facts): Check[] {
  return [
    ...install(facts),
    ...runtime(facts),
    ...config(facts),
    ...models(facts),
    ...mcp(facts),
    ...sandbox(facts),
    ...terminal(facts),
  ]
}

export function counts(list: readonly Check[]) {
  return {
    fail: list.filter((check) => check.status === "fail").length,
    warn: list.filter((check) => check.status === "warn").length,
  }
}

/** 1 when any check failed. */
export function exitCode(list: readonly Check[]) {
  return counts(list).fail > 0 ? 1 : 0
}

export const SYMBOL: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" }

export function summary(list: readonly Check[]) {
  const { fail, warn } = counts(list)
  if (fail === 0 && warn === 0) return "Everything looks fine."
  const parts = [fail > 0 ? `${fail} ${fail === 1 ? "problem" : "problems"}` : undefined, warn > 0 ? `${warn} ${warn === 1 ? "warning" : "warnings"}` : undefined]
  return `${parts.filter(Boolean).join(", ")}.`
}

/** Plain text, grouped, for a terminal or a file. */
export function render(list: readonly Check[]): string {
  const lines: string[] = []
  for (const group of GROUPS) {
    const items = list.filter((check) => check.group === group)
    if (items.length === 0) continue
    if (lines.length > 0) lines.push("")
    lines.push(group)
    for (const check of items) {
      lines.push(`  ${SYMBOL[check.status]} ${check.title}`)
      for (const detail of check.details ?? []) lines.push(`      ${detail}`)
      if (check.fix) lines.push(`      → ${check.fix}`)
    }
  }
  lines.push("", summary(list))
  return lines.join("\n")
}
