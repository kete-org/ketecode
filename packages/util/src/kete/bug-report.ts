// The problem report behind `kete bug` (packages/cli/src/kete/bug.ts), `/feedback` in the TUI
// (packages/tui/src/kete/feedback.tsx) and the issue link they open. Plain functions, no Node imports:
// each surface collects the facts it can and this module turns them into one privacy-safe markdown
// report the person reviews before anything leaves the machine. Nothing here sends anything.
//
// What a report holds: version and channel, OS and architecture, terminal (TERM, TERM_PROGRAM),
// shell name, install method, whether someone is signed in (yes/no only), the model provider IDs in
// use, the permission mode, the sandbox state, the offline flag, MCP server names and states, and the
// last lines of the log file with only an allowlist of fields kept. Never: keys, tokens, emails,
// organization IDs, other environment values, prompts, file contents or session messages. Every piece
// of text passes through `scrub` (KeteRedact, emails, IDs, URL query strings, home directory to `~`,
// control, bidi and zero-width characters), and the rendered report passes through it once more. Log
// free text (`message`, `error`, `cause`, `reason`) also goes through `scrubLine`: first line only,
// absolute paths outside home as `<path>`, JSON payloads as `<data>`, and a byte cap.

export * as KeteBugReport from "./bug-report.js"

import { Brand } from "./brand.js"
import { KeteRedact } from "./redact.js"

/** Log lines a report keeps, newest last. */
export const LOG_LINES = 200
/** The longest issue link opened in a browser: GitHub's practical limit is about 8 KB. */
export const MAX_URL = 6000
/** The longest description a report keeps, in characters. */
export const MAX_DESCRIPTION = 1500
/** The longest value of one log field, in UTF-8 bytes. */
const MAX_FIELD = 300
/** The longest `error`, `cause` or `reason` a report keeps, in UTF-8 bytes: enough to say what failed. */
const MAX_ERROR = 120

export const SECURITY_NOTICE = `Security problem? Don't open a public issue; report it privately: ${Brand.urls.securityReport}`

/** What opening the pre-filled issue form means for the report, said wherever the form can be opened. */
export const LINK_NOTICE = "Opening the form sends this report to GitHub in the link; it becomes public only when you submit the issue."

export type Environment = Readonly<Record<string, string | undefined>>

export type McpState = { readonly name: string; readonly status: string }

export type Sandbox = {
  readonly state: string
  readonly mechanism?: string
  readonly mode?: string
  readonly network?: string
}

/** What one surface knows. `undefined` means "couldn't find out"; the report says so. */
export interface Facts {
  /** Where the report was made: shown in the report and the issue. */
  readonly source: "cli" | "tui"
  readonly version: string
  readonly channel: string
  readonly os: { readonly platform: string; readonly release: string; readonly arch: string }
  /** The process environment. Only TERM, TERM_PROGRAM(_VERSION), TMUX/STY, SHELL and ComSpec are read. */
  readonly env: Environment
  readonly install?: string
  readonly signedIn: "yes" | "no" | "unknown"
  readonly providers?: readonly string[]
  readonly permissionMode?: string
  readonly sandbox?: Sandbox
  readonly offline: boolean
  readonly mcp?: readonly McpState[]
  /** The tail of the log file, as read; `logLines` filters it. `undefined` when there is no log. */
  readonly log?: string
  /** What the person wrote about the problem. */
  readonly description?: string
}

export interface Report {
  readonly title: string
  /** The full report, markdown. */
  readonly text: string
  readonly facts: Facts
  readonly home: Home
}

// ---------------------------------------------------------------------------------------------
// Scrubbing

const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
// Long opaque strings (API keys of unknown shape, base64 secrets, account and organization IDs):
// 32+ letters, digits and underscores with at least one letter and one digit.
const opaque = /\b(?=\w*[0-9])(?=\w*[A-Za-z])\w{32,}\b/g
// A URL's query string and fragment can carry tokens (any scheme: https, wss, ftp, …): kept out, the
// scheme, host and path stay.
const urlQuery = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>()]+)[?#][^\s"'<>()]*/gi
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
// C0 and C1 control characters, and zero-width, bidi and other format characters that can hide or
// reorder text in a terminal or on the issue page.
const control = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The home directory, or every spelling of it (as given, its real path, the profile prefix of the temp
 * directory; see `KeteBugReportFile.homes`). Each one is shown as `~`.
 */
export type Home = string | readonly string[]

const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * Patterns for the home directory's spellings: each as given, with the other separator and URL-encoded,
 * longest first. A spelling matches only as a whole path prefix (not inside `/private/home/bob` or
 * `/home/bobby`), and Windows spellings match in any case.
 */
function homes(home: Home): RegExp[] {
  const spellings = new Set<string>()
  for (const given of typeof home === "string" ? [home] : home) {
    const trimmed = given.replace(/[\\/]+$/, "")
    if (trimmed.length < 2) continue
    for (const spelling of [trimmed, trimmed.replace(/\\/g, "/"), trimmed.replace(/\//g, "\\")]) {
      spellings.add(spelling)
      spellings.add(encodeURI(spelling.replace(/[\ud800-\udfff]/g, "")))
    }
  }
  return [...spellings]
    .sort((a, b) => b.length - a.length)
    .map(
      (spelling) =>
        new RegExp(`(?<![\\w.%~-])${escape(spelling)}(?=$|[\\\\/\\s"'\`):,;\\]}>?#])`, windowsPath.test(spelling) ? "gi" : "g"),
    )
}

/**
 * Text safe to show and send: secrets, emails, IDs, URL query strings and the home directory masked,
 * no control, bidi or zero-width characters.
 */
export function scrub(input: string, home: Home): string {
  let out = input.replace(ansi, "").replace(/\r\n?/g, "\n").replace(control, "")
  out = out.replace(urlQuery, "$1?[…]")
  out = KeteRedact.text(out)
  out = out.replace(email, "[EMAIL]")
  out = out.replace(uuid, "[ID]")
  out = out.replace(opaque, "[REDACTED]")
  for (const pattern of homes(home)) out = out.replace(pattern, "~")
  return out
}

// JSON-looking payloads (request and response bodies, tool arguments): a `{…}` object, or a `[…]`
// array of objects, strings or arrays, also when cut off before its end.
const payload = /\{[\s\S]*\}|\{\s*"[\s\S]*$|\[\s*[{["][\s\S]*\]|\[\s*[{["][\s\S]*$/g
// Absolute paths, starting at the beginning or after a space, quote, bracket, `=`, `,` or `;`.
// The home directory is `~` by now and stays; everything else becomes `<path>`.
const pathStart = `(?<=^|[\\s"'\`(\\[{<=,;])`
const pathChar = `[^\\s"'\`<>|()\\[\\]{},;]`
const segment = `[^\\s"'\`<>|()\\[\\]{},;/\\\\]+`
const absolutePaths = [
  /\bfile:\/\/[^\s"'`<>()]*/gi,
  new RegExp(`${pathStart}\\\\\\\\${pathChar}+`, "g"), // \\server\share\…
  new RegExp(`${pathStart}[A-Za-z]:[\\\\/]${pathChar}*`, "g"), // C:\… or C:/…
  new RegExp(`${pathStart}/${segment}(?:/${segment})+/?`, "g"), // /a/b…, two segments or more
]

/**
 * One line of free text from somewhere else (an error message, a log `message`, `error`, `cause` or
 * `reason`), made safe to send: `scrub`bed, JSON-looking payloads replaced with `<data>`, absolute paths
 * outside the home directory replaced with `<path>`, only the first line kept (no stack frames), and cut
 * to `maxBytes` UTF-8 bytes.
 */
export function scrubLine(input: string, home: Home, maxBytes: number): string {
  let out = scrub(input.replace(payload, "<data>"), home)
  out = out.trimStart().split("\n")[0]!.trimEnd()
  for (const pattern of absolutePaths) out = out.replace(pattern, "<path>")
  const cut = KeteRedact.truncate(out, maxBytes)
  return cut === out ? out : `${cut}…`
}

// ---------------------------------------------------------------------------------------------
// Log lines

/**
 * Log fields a report keeps. Everything else (`args`, `event.data`, `command`, `path`, `http.url`, IDs)
 * is dropped. The free-text fields (`FREE_TEXT`) can carry third-party text, such as an MCP server's
 * error body or a Cause with its stack, so they go through `scrubLine`: first line only, paths outside
 * home as `<path>`, JSON payloads as `<data>`, and `error`, `cause` and `reason` cut to 120 bytes.
 */
export const LOG_FIELDS = [
  "timestamp",
  "level",
  "message",
  "role",
  "component",
  "service",
  "type",
  "backend",
  "durationMs",
  "http.method",
  "http.status",
  "version",
  "channel",
  "attempt",
  "reason",
  "error",
  "cause",
] as const
const kept = new Set<string>(LOG_FIELDS)
const FREE_TEXT = new Set<string>(["message", "error", "cause", "reason"])
const pair = /([^\s=]+)=("(?:[^"\\]|\\.)*"|\S*)/g

function unquote(value: string) {
  if (!value.startsWith('"')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "string" ? parsed : value
  } catch {
    return value.slice(1, -1)
  }
}

function quote(value: string) {
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

/**
 * The last `limit` lines of a log (logfmt, as util/observability writes it) with only `LOG_FIELDS`
 * kept and each value scrubbed and capped. Lines that aren't logfmt are left out and counted.
 */
export function logLines(raw: string, home: Home, limit = LOG_LINES): { readonly lines: string[]; readonly skipped: number } {
  const all = raw.split(/\r?\n/).filter((line) => line.trim() !== "")
  const lines: string[] = []
  let skipped = 0
  for (const line of all.slice(-limit)) {
    const fields: string[] = []
    let level = false
    for (const match of line.matchAll(pair)) {
      const key = match[1]!
      if (key === "level") level = true
      if (!kept.has(key)) continue
      const text = unquote(match[2]!)
      const value = FREE_TEXT.has(key)
        ? scrubLine(text, home, key === "message" ? MAX_FIELD : MAX_ERROR)
        : KeteRedact.truncate(scrub(text, home), MAX_FIELD)
      fields.push(`${key}=${quote(value)}`)
    }
    if (!level) {
      skipped++
      continue
    }
    // A code fence in a value would end the report's log block.
    lines.push(fields.join(" ").replace(/`{3,}/g, "'''"))
  }
  return { lines, skipped }
}

// ---------------------------------------------------------------------------------------------
// Runtime answers (external input: decoded defensively, only IDs, names and states kept)

const providerID = /^[A-Za-z0-9._:-]{1,64}$/
const serverName = /^[A-Za-z0-9._@-]{1,64}$/
const mcpStatuses = new Set(["connected", "pending", "disabled", "failed", "needs_auth"])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Provider IDs that aren't disabled, from `GET /api/provider`'s `data`. `undefined` when it isn't a list. */
export function providerIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = new Set<string>()
  for (const item of value) {
    const info = record(item)
    if (!info || typeof info.id !== "string" || info.activation === "disabled") continue
    if (providerID.test(info.id)) ids.add(info.id)
  }
  return [...ids].sort().slice(0, 30)
}

/** MCP server names and states, from `GET /api/mcp`'s `data` (error messages are never kept). */
export function mcpStates(value: unknown): McpState[] | undefined {
  if (!Array.isArray(value)) return undefined
  const states: McpState[] = []
  for (const item of value.slice(0, 50)) {
    const server = record(item)
    if (!server) continue
    const status = record(server.status)?.status
    states.push({
      name: typeof server.name === "string" && serverName.test(server.name) ? server.name : "(unnamed)",
      status: typeof status === "string" && mcpStatuses.has(status) ? status : "unknown",
    })
  }
  return states
}

// ---------------------------------------------------------------------------------------------
// Environment descriptions

export function describeOS(os: Facts["os"]): string {
  const name = os.platform === "darwin" ? "macOS" : os.platform === "win32" ? "Windows" : os.platform === "linux" ? "Linux" : os.platform
  return `${name} ${os.release} (${os.arch})`
}

const word = (value: string | undefined) => (value && /^[\w.+@:/-]{1,64}$/.test(value) ? value : undefined)

export function describeTerminal(env: Environment): string {
  const program = word(env.TERM_PROGRAM)
  const version = word(env.TERM_PROGRAM_VERSION)
  const term = word(env.TERM)
  const parts = [program ? `${program}${version ? ` ${version}` : ""}` : undefined, term ? `TERM ${term}` : undefined]
  const multiplexer = env.TMUX ? ", in tmux" : env.STY ? ", in screen" : ""
  const text = parts.filter(Boolean).join(", ")
  return `${text || "unknown"}${multiplexer}`
}

/** The shell's name only (never its path). */
export function describeShell(env: Environment, platform: string): string {
  const value = env.SHELL ?? (platform === "win32" ? env.ComSpec : undefined)
  const name = value?.split(/[\\/]/).pop()?.replace(/\.exe$/i, "")
  return word(name) ?? "unknown"
}

// ---------------------------------------------------------------------------------------------
// Rendering

const unavailable = "unavailable (couldn't ask the runtime)"

function describeSandbox(sandbox: Sandbox | undefined) {
  if (!sandbox) return unavailable
  const mechanism = word(sandbox.mechanism)
  const mode = word(sandbox.mode)
  const network = word(sandbox.network)
  const details = [mechanism, mode ? `mode ${mode}` : undefined, network ? `network ${network}` : undefined]
    .filter((item) => item !== undefined)
    .join("; ")
  return `${word(sandbox.state) ?? "unknown"}${details ? ` (${details})` : ""}`
}

function describeMcp(mcp: readonly McpState[] | undefined) {
  if (!mcp) return unavailable
  if (mcp.length === 0) return "none"
  return `${mcp.length} (${mcp.map((server) => `${server.name}: ${server.status}`).join(", ")})`
}

function environmentLines(facts: Facts): string[] {
  return [
    `- ${Brand.displayName}: ${facts.version} (channel ${facts.channel})`,
    `- OS: ${describeOS(facts.os)}`,
    `- Terminal: ${describeTerminal(facts.env)}`,
    `- Shell: ${describeShell(facts.env, facts.os.platform)}`,
    `- Install: ${facts.install ?? "unknown"}`,
    `- Signed in: ${facts.signedIn}`,
    `- Model providers: ${facts.providers ? (facts.providers.length ? facts.providers.join(", ") : "none") : unavailable}`,
    `- Permission mode: ${facts.permissionMode ?? "unknown"}`,
    `- Sandbox: ${describeSandbox(facts.sandbox)}`,
    `- Offline mode: ${facts.offline ? "on" : "off"}`,
    `- MCP servers: ${describeMcp(facts.mcp)}`,
  ]
}

function description(facts: Facts, home: Home) {
  const text = facts.description?.trim()
  if (!text) return undefined
  const scrubbed = scrub(text, home)
  return scrubbed.length > MAX_DESCRIPTION ? `${scrubbed.slice(0, MAX_DESCRIPTION)}…` : scrubbed
}

/** The report body with at most `logCount` log lines (the newest), and an optional note under the log. */
function body(facts: Facts, home: Home, log: { lines: string[]; skipped: number }, logCount: number, note?: string) {
  const command = facts.source === "cli" ? `\`${Brand.cliName} bug\`` : "`/feedback`"
  const lines = [
    "## Description",
    "",
    description(facts, home) ?? "_What happened, what you expected, and how to reproduce it._",
    "",
    "## Environment",
    "",
    ...environmentLines(facts),
    "",
  ]
  const shown = logCount > 0 ? log.lines.slice(-logCount) : []
  const left = log.lines.length - shown.length
  if (facts.log === undefined) lines.push("## Log", "", "No log file found.", "")
  else {
    lines.push(`## Log (last ${shown.length} lines, only diagnostic fields)`, "", "```", ...shown, "```", "")
    if (log.skipped > 0) lines.push(`${log.skipped} lines not in the log format were left out.`, "")
    if (left > 0 && note) lines.push(`${left} earlier log lines were left out of this link. ${note}`, "")
  }
  lines.push(`_Made with ${command}._`)
  return scrub(lines.join("\n"), home)
}

/** The full report from what a surface collected. `home` is the home directory to show as `~`. */
export function build(facts: Facts, home: Home): Report {
  const log = logLines(facts.log ?? "", home)
  const first = description(facts, home)?.split("\n")[0]?.trim()
  const title = first ? (first.length > 80 ? `${first.slice(0, 79)}…` : first) : "Bug report"
  return { title, text: body(facts, home, log, log.lines.length), facts, home }
}

/**
 * The bug-report form on the issue tracker, pre-filled (field IDs of .github/ISSUE_TEMPLATE/bug-report.yml).
 * When the whole report doesn't fit in `max` characters, the oldest log lines are left out and the
 * body says the full report is in `file` (a file name, never a path). `complete` says whether it all fit.
 */
export function issueURL(report: Report, file?: string, max = MAX_URL): { readonly url: string; readonly complete: boolean } {
  const { facts, home } = report
  const log = logLines(facts.log ?? "", home)
  const note = file
    ? `The full report is in the file ${file.split(/[\\/]/).pop()} on the reporter's machine; attach it if you can.`
    : "The full report has them."
  const make = (description: string) => {
    const url = new URL(`${Brand.urls.issues}/new`)
    url.searchParams.set("template", "bug-report.yml")
    url.searchParams.set("title", report.title)
    url.searchParams.set("description", description)
    url.searchParams.set("opencode-version", facts.version)
    url.searchParams.set("os", describeOS(facts.os))
    url.searchParams.set("terminal", describeTerminal(facts.env))
    return url.toString()
  }
  const full = make(body(facts, home, log, log.lines.length))
  if (full.length <= max) return { url: full, complete: true }
  // The most recent log lines that still fit.
  let lo = 0
  let hi = log.lines.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (make(body(facts, home, log, mid, note)).length <= max) lo = mid
    else hi = mid - 1
  }
  const url = make(body(facts, home, log, lo, note))
  if (url.length <= max) return { url, complete: false }
  // Even without log lines it's too long: send the environment only.
  return { url: make(body({ ...facts, description: undefined }, home, log, 0, note)), complete: false }
}
