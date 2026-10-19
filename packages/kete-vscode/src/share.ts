// Session sharing (docs/sharing.md): the requests to, and answers from, the runtime's `kete.share` RPC
// (`POST /api/rpc/kete.share/<method>?directory=…`). The extension asks for a preview, shows it in a
// modal message, and calls `share` only when the person picks the button. Answers are external input:
// each parser checks the shape and returns undefined for anything else. Kept free of the `vscode`
// module so it can be unit-tested.

export const RPC = "kete.share"
export type Method = "preview" | "share" | "unshare"
export type Visibility = "org" | "link"

export function rpcUrl(base: string, method: Method, directory: string) {
  return `${base}/api/rpc/${RPC}/${method}?directory=${encodeURIComponent(directory)}`
}

export const previewRequest = (sessionID: string) => ({ input: { sessionID } })
export const shareRequest = (sessionID: string, visibility: Visibility, digest?: string) => ({
  input: { sessionID, visibility, ...(digest ? { digest } : {}) },
})
export const unshareRequest = (sessionID: string) => ({ input: { sessionID } })

export type Preview = {
  readonly counts: { readonly messages: number; readonly tools: number; readonly diffs: number }
  readonly bytes: number
  readonly redactions: number
  readonly truncated: boolean
  readonly visibility: Visibility
  readonly linkAllowed: boolean
  readonly maxDays: number
  readonly existing: boolean
  /** Ties the upload to what was previewed: the runtime refuses if the session changed since. */
  readonly digest: string | undefined
}

/** A refusal's message, or a preview, or undefined when the answer is not a share answer. */
export type Parsed<T> = { readonly ok: T } | { readonly refusal: string } | undefined

export function parsePreview(body: unknown): Parsed<Preview> {
  const output = outputOf(body)
  if (!output) return undefined
  const refusal = refusalOf(output)
  if (refusal) return { refusal }
  const counts = isRecord(output.counts) ? output.counts : undefined
  if (!counts || !num(counts.messages) || !num(counts.tools) || !num(counts.diffs)) return undefined
  if (!num(output.bytes) || !num(output.redactions) || !num(output.maxDays)) return undefined
  if (typeof output.truncated !== "boolean" || typeof output.linkAllowed !== "boolean") return undefined
  if (output.visibility !== "org" && output.visibility !== "link") return undefined
  return {
    ok: {
      counts: { messages: counts.messages, tools: counts.tools, diffs: counts.diffs },
      bytes: output.bytes,
      redactions: output.redactions,
      truncated: output.truncated,
      visibility: output.visibility,
      linkAllowed: output.linkAllowed,
      maxDays: output.maxDays,
      existing: isRecord(output.existing),
      digest: typeof output.digest === "string" ? output.digest : undefined,
    },
  }
}

export function parseShare(body: unknown): Parsed<{ readonly url: string; readonly expiresAt: string }> {
  const output = outputOf(body)
  if (!output) return undefined
  const refusal = refusalOf(output)
  if (refusal) return { refusal }
  const record = isRecord(output.record) ? output.record : undefined
  if (!record || typeof record.url !== "string" || typeof record.expires_at !== "string") return undefined
  return { ok: { url: record.url, expiresAt: record.expires_at } }
}

export function parseUnshare(body: unknown): Parsed<{ readonly removed: boolean }> {
  const output = outputOf(body)
  if (!output) return undefined
  const refusal = refusalOf(output)
  if (refusal) return { refusal }
  return typeof output.removed === "boolean" ? { ok: { removed: output.removed } } : undefined
}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** The modal message shown before anything is uploaded. */
export function previewText(preview: Preview, visibility: Visibility = preview.visibility) {
  return [
    visibility === "link" ? "Anyone with the link can read this session." : "Members of your organization can read this session.",
    `${preview.counts.messages} messages, ${preview.counts.tools} tool calls, ${preview.counts.diffs} changed files (${size(preview.bytes)}).`,
    `Secrets removed: ${preview.redactions}.`,
    ...(preview.truncated ? ["Large parts were left out to fit the size limit."] : []),
    "Not sent: reasoning, system prompts, attached file contents, skills, memory.",
    `The share expires in ${preview.maxDays} days.`,
    ...(preview.existing ? ["This session is already shared: this updates the same share."] : []),
  ].join("\n")
}

/** The refusal shown as an error message. */
export const refusalText = (message: string) => `Kete Code can't share this session: ${message}`

function outputOf(body: unknown) {
  return isRecord(body) && isRecord(body.output) ? body.output : undefined
}

function refusalOf(output: Record<string, unknown>) {
  return isRecord(output.refusal) && typeof output.refusal.message === "string" ? output.refusal.message.slice(0, 500) : undefined
}

const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
