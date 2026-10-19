// The snapshot a session share uploads (docs/platform/session-shares-v1.md, snapshot v1). Pure: the
// plugin reads the session and passes the messages and diffs in.
//
// Sent: user text and attached file NAMES, assistant text, tool name/status/input/output, `!` shell
// commands and output, compaction markers, and the session's diffs. Never sent: reasoning, system and
// synthetic messages, skill bodies, compaction summaries, file contents, instructions, memory, the
// system prompt, the contents of secret files (`.env`, keys, credentials: diffs and reads). Absolute
// workspace and home paths in every string become `.` and `~`. Every string is cut to a window, redacted (KeteRedact), then cut to its cap, so
// redaction always runs before truncation and a secret straddling a cut is never half-exposed. The
// field caps are the platform's Zod limits: the builder cuts to them so a share never gets a 400.

export * as KeteShareSnapshot from "./snapshot.js"

import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type { FileDiff } from "@opencode/schema/file-diff"
import type { SessionMessage } from "@opencode/schema/session-message"
import { KeteRedact } from "@opencode/util/kete/redact"
import { KeteShellRisk } from "../shell-risk.js"

export const MAX_BYTES = 2 * 1024 * 1024
const KiB = 1024
/** Extra bytes scanned past a field's cap, so the redactor sees a secret that straddles the cap. */
const WINDOW_EXTRA = 16 * KiB

export const CAPS = {
  title: 200,
  text: 256 * KiB,
  command: 8 * KiB,
  name: 128,
  version: 64,
  status: 32,
  path: 1024,
  file: 1024,
  input: 2 * KiB,
  output: 4 * KiB,
  patch: 16 * KiB,
  messages: 10_000,
  diffs: 2000,
  files: 200,
  tools: 500,
} as const

export type Tool = { name: string; status: string; input: string; output: string }
export type Message =
  | { type: "user"; text: string; files: string[] }
  | { type: "assistant"; text: string; tools: Tool[] }
  | { type: "shell"; command: string; exit: number | null; output: string }
  | { type: "compaction" }
export type Diff = { path: string; additions: number; deletions: number; patch: string }
export type Snapshot = {
  version: 1
  created_at: string
  runtime_version: string
  title: string
  model?: string
  truncated: boolean
  redactions: number
  messages: Message[]
  diffs: Diff[]
}

export type Input = {
  messages: ReadonlyArray<SessionMessage.Info>
  diffs: ReadonlyArray<FileDiff.Info>
  /** The diffs could not all be read (for example a location change inside the session). */
  diffsIncomplete?: boolean
  workspace: string
  /** Shown as `~`; defaults to os.homedir(). */
  home?: string
  title: string
  version: string
  now: Date
  /** Defaults to MAX_BYTES; tests pass a smaller one. */
  limit?: number
}

export type Built = {
  snapshot: Snapshot
  redactions: number
  bytes: number
  /** sha256 of the snapshot without `created_at`: the same session content gives the same digest. */
  digest: string
  counts: { messages: number; tools: number; diffs: number }
}

const marks = (value: string) => value.match(/\[REDACTED/g)?.length ?? 0
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

export const SECRET_FILE = "[contents not shared: secret file]"

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Matches `directory` as a path prefix with either separator (doubled too, as in JSON), or undefined for a root or empty one. */
function prefix(directory: string): RegExp | undefined {
  if (directory === "" || path.dirname(directory) === directory) return undefined
  const parts = directory.split(/[\\/]+/).filter(Boolean).map(escape)
  const lead = /^[\\/]/.test(directory) ? "[\\\\/]+" : ""
  return new RegExp(`${lead}${parts.join("[\\\\/]+")}(?![^\\\\/\\s"'\`:;,)\\]}>])`, process.platform === "win32" ? "gi" : "g")
}

class Counter {
  n = 0
  secretFiles = false
  private readonly places: ReadonlyArray<readonly [RegExp, string]>
  constructor(workspace: string, home: string) {
    // The workspace first: it is usually inside the home folder.
    this.places = ([[workspace, "."], [home, "~"]] as const).flatMap(([directory, label]) => {
      const pattern = prefix(directory)
      return pattern ? [[pattern, label] as const] : []
    })
  }
  /** Absolute workspace and home paths shown as `.` and `~`, then window, redact, and cut to `cap` bytes. */
  field(value: string, cap: number): string {
    const local = this.places.reduce((text, [pattern, label]) => text.replace(pattern, label), value)
    const windowed = KeteRedact.truncate(local, cap + WINDOW_EXTRA)
    const redacted = KeteRedact.text(windowed)
    this.n += Math.max(0, marks(redacted) - marks(windowed))
    return KeteRedact.truncate(redacted, cap)
  }
  /** A JSON-ish value: strings go through `field`, a secret-looking key hides its whole value. */
  value(input: unknown, depth = 0): unknown {
    if (typeof input === "string") return this.field(input, CAPS.input)
    if (depth > 8) return "[too deep]"
    if (Array.isArray(input)) return input.slice(0, 50).map((item) => this.value(item, depth + 1))
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input)) {
        if (KeteRedact.isSecretKey(key)) {
          out[key] = "[REDACTED]"
          this.n++
        } else out[key] = this.value(item, depth + 1)
      }
      return out
    }
    return input
  }
}

const baseName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? ""

/** A path relative to the workspace when inside it; otherwise only its base name. */
export function display(workspace: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(workspace, file) : path.normalize(file)
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.startsWith("../"))
    return baseName(file)
  return relative.replaceAll("\\", "/")
}

function toolOutput(state: SessionMessage.AssistantTool["state"]): string {
  if (state.status === "completed" || state.status === "error") {
    // Never named from the uri: a data: uri holds the file's content.
    const parts = (state.content ?? []).map((part) => (part.type === "text" ? part.text : `[file: ${part.name ? baseName(part.name) : part.mime}]`))
    if (state.status === "error") parts.unshift(state.error.message)
    return parts.join("\n")
  }
  return ""
}

/** The read tool's target when it is a secret file (`.env`, keys, credentials): its output is not sent. */
const secretRead = (item: SessionMessage.AssistantTool) => {
  const input: unknown = item.state.status === "streaming" ? undefined : item.state.input
  const target = input !== null && typeof input === "object" && "path" in input ? input.path : undefined
  return item.name === "read" && typeof target === "string" && KeteShellRisk.credential(target)
}

function tool(item: SessionMessage.AssistantTool, counter: Counter): Tool {
  const secret = secretRead(item)
  if (secret) counter.secretFiles = true
  const raw = item.state.status === "streaming" ? item.state.input : JSON.stringify(counter.value(item.state.input))
  return {
    name: counter.field(item.name, CAPS.name),
    status: counter.field(item.state.status, CAPS.status),
    input: counter.field(raw, CAPS.input),
    output: secret ? SECRET_FILE : counter.field(toolOutput(item.state), CAPS.output),
  }
}

function message(item: SessionMessage.Info, counter: Counter): Message | undefined {
  switch (item.type) {
    case "user":
      return {
        type: "user",
        text: counter.field(item.text, CAPS.text),
        files: (item.files ?? []).slice(0, CAPS.files).map((file) =>
          counter.field(
            file.name ?? (file.source.type === "uri" && !file.source.uri.startsWith("data:") ? baseName(file.source.uri) : `[file: ${file.mime}]`),
            CAPS.file,
          ),
        ),
      }
    case "assistant": {
      const text = item.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n\n")
      const tools = item.content.flatMap((part) => (part.type === "tool" ? [tool(part, counter)] : [])).slice(-CAPS.tools)
      if (text === "" && tools.length === 0) return undefined
      return { type: "assistant", text: counter.field(text, CAPS.text), tools }
    }
    case "shell":
      return {
        type: "shell",
        command: counter.field(item.command, CAPS.command),
        exit: Number.isInteger(item.exit) ? (item.exit as number) : null,
        output: counter.field(item.output?.output ?? "", CAPS.output),
      }
    case "compaction":
      return { type: "compaction" }
    default:
      return undefined
  }
}

/**
 * Over `limit` bytes: empty the oldest tool outputs, then the oldest patches, until it fits.
 * Returns false when it still does not fit (the caller refuses; nothing over the limit is sent).
 */
export function cap(snapshot: Snapshot, limit: number): boolean {
  let total = size(snapshot)
  if (total <= limit) return true
  if (!snapshot.truncated) total += 1 // `false` becomes `true`
  snapshot.truncated = true
  const shrink = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8") - 2
  for (const item of snapshot.messages) {
    if (item.type !== "assistant") continue
    for (const entry of item.tools) {
      if (total <= limit) return true
      total -= shrink(entry.output)
      entry.output = ""
    }
  }
  for (const entry of snapshot.diffs) {
    if (total <= limit) return true
    total -= shrink(entry.patch)
    entry.patch = ""
  }
  return total <= limit
}

export const digest = (snapshot: Snapshot) =>
  createHash("sha256").update(JSON.stringify({ ...snapshot, created_at: undefined })).digest("hex")

/** Builds the snapshot, or undefined when it cannot be brought under the size limit. */
export function build(input: Input): Built | undefined {
  const counter = new Counter(input.workspace, input.home ?? os.homedir())
  let truncated = input.diffsIncomplete === true
  const all = input.messages.flatMap((item) => {
    const mapped = message(item, counter)
    return mapped ? [mapped] : []
  })
  if (all.length > CAPS.messages) truncated = true
  const messages = all.slice(-CAPS.messages)
  if (input.messages.some((item) => item.type === "user" && (item.files?.length ?? 0) > CAPS.files)) truncated = true
  if (input.messages.some((item) => item.type === "assistant" && item.content.filter((part) => part.type === "tool").length > CAPS.tools))
    truncated = true
  if (input.diffs.length > CAPS.diffs) truncated = true
  const diffs = input.diffs.slice(-CAPS.diffs).map(
    (diff): Diff => ({
      path: counter.field(display(input.workspace, diff.file), CAPS.path),
      additions: diff.additions,
      deletions: diff.deletions,
      patch: KeteShellRisk.credential(diff.file) ? SECRET_FILE : counter.field(diff.patch, CAPS.patch),
    }),
  )
  if (counter.secretFiles || diffs.some((diff) => diff.patch === SECRET_FILE)) truncated = true
  const model = input.messages.findLast((item) => item.type === "assistant")
  const snapshot: Snapshot = {
    version: 1,
    created_at: input.now.toISOString(),
    runtime_version: KeteRedact.truncate(input.version, CAPS.version),
    title: counter.field(input.title, CAPS.title),
    ...(model?.type === "assistant" ? { model: KeteRedact.truncate(`${model.model.providerID}/${model.model.id}`, CAPS.name) } : {}),
    truncated,
    redactions: 0,
    messages,
    diffs,
  }
  snapshot.redactions = counter.n
  if (!cap(snapshot, input.limit ?? MAX_BYTES)) return undefined
  return {
    snapshot,
    redactions: counter.n,
    bytes: size(snapshot),
    digest: digest(snapshot),
    counts: {
      messages: messages.length,
      tools: messages.reduce((total, item) => total + (item.type === "assistant" ? item.tools.length : 0), 0),
      diffs: diffs.length,
    },
  }
}
