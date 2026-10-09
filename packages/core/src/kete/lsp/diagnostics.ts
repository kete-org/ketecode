// What the agent reads back after an edit: the errors language servers report for the files it
// just touched, bounded and without repeating itself.
//
// Only errors (severity 1) are reported; warnings and hints would cost tokens on every edit. Per
// session and file, an error already reported is not reported again while it persists: the report
// lists new errors in full, and says in one line how many earlier ones remain or that they are gone.
// At most 20 errors per file and 5 files per report; messages are cut at 300 characters and
// stripped of control characters (server output is external input).

export * as KeteLspDiagnostics from "./diagnostics.js"

import path from "path"

export const MAX_PER_FILE = 20
export const MAX_FILES = 5
export const MAX_MESSAGE = 300
/** Sessions whose reported errors are remembered (least recently used dropped first). */
export const MAX_SESSIONS = 200

export interface Diagnostic {
  readonly line: number
  readonly character: number
  readonly severity: number
  readonly message: string
  readonly source?: string
  readonly code?: string
}

/** Reads one LSP `Diagnostic` (external input); undefined when it isn't one. */
export function parse(value: unknown): Diagnostic | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const range = record.range as { start?: { line?: unknown; character?: unknown } } | undefined
  const line = range?.start?.line
  const character = range?.start?.character
  if (typeof line !== "number" || typeof character !== "number" || typeof record.message !== "string") return undefined
  return {
    line,
    character,
    severity: typeof record.severity === "number" ? record.severity : 1,
    message: record.message,
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.code === "string" || typeof record.code === "number" ? { code: String(record.code) } : {}),
  }
}

export function clean(text: string, max = MAX_MESSAGE) {
  // eslint-disable-next-line no-control-regex
  const single = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return single.length > max ? single.slice(0, max - 1) + "…" : single
}

const key = (item: Diagnostic) => `${item.line}:${item.character}:${clean(item.message)}`

export function pretty(item: Diagnostic) {
  const origin = item.source ? ` (${clean(item.source, 40)}${item.code ? ` ${clean(item.code, 40)}` : ""})` : ""
  return `ERROR [${item.line + 1}:${item.character + 1}] ${clean(item.message)}${origin}`
}

/** Per-session memory of the errors already reported for each file. */
export class Reported {
  private readonly sessions = new Map<string, Map<string, Set<string>>>()

  constructor(private readonly limit = MAX_SESSIONS) {}

  get(sessionID: string, file: string) {
    return this.sessions.get(sessionID)?.get(file)
  }

  set(sessionID: string, file: string, keys: Set<string>) {
    const files = this.sessions.get(sessionID) ?? new Map<string, Set<string>>()
    this.sessions.delete(sessionID)
    this.sessions.set(sessionID, files)
    if (keys.size === 0) files.delete(file)
    else files.set(file, keys)
    for (const oldest of this.sessions.keys()) {
      if (this.sessions.size <= this.limit) break
      this.sessions.delete(oldest)
    }
  }
}

/**
 * The report for the files an edit touched (absolute path → that file's current diagnostics), or
 * undefined when there is nothing new to say. Updates `reported`.
 */
export function report(input: {
  readonly sessionID: string
  readonly workspace: string
  readonly files: ReadonlyMap<string, ReadonlyArray<Diagnostic>>
  readonly reported: Reported
}): string | undefined {
  const blocks: string[] = []
  let skipped = 0
  for (const [file, diagnostics] of input.files) {
    const errors = diagnostics.filter((item) => item.severity === 1)
    const before = input.reported.get(input.sessionID, file) ?? new Set<string>()
    const keys = new Set(errors.map(key))
    input.reported.set(input.sessionID, file, keys)
    const fresh = errors.filter((item) => !before.has(key(item)))
    const remaining = errors.length - fresh.length
    const relative = path.relative(input.workspace, file)
    const name = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file
    if (fresh.length === 0) {
      if (before.size > 0 && errors.length === 0) blocks.push(`${name}: the errors reported earlier are fixed.`)
      continue
    }
    if (blocks.length >= MAX_FILES) {
      skipped++
      continue
    }
    const shown = fresh.slice(0, MAX_PER_FILE)
    const lines = shown.map(pretty)
    if (fresh.length > shown.length) lines.push(`... and ${fresh.length - shown.length} more`)
    if (remaining > 0) lines.push(`(${remaining} error${remaining === 1 ? "" : "s"} reported earlier still present)`)
    blocks.push(`<diagnostics file="${name}">\n${lines.join("\n")}\n</diagnostics>`)
  }
  if (blocks.length === 0) return undefined
  const more = skipped > 0 ? `\n... and new errors in ${skipped} more file${skipped === 1 ? "" : "s"}` : ""
  return `Language server diagnostics for the edited files:\n${blocks.join("\n")}${more}`
}
