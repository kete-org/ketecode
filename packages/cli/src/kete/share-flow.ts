// `kete share [session-id] [--link] [--yes]` and `kete unshare [session-id]` (docs/sharing.md): the rules.
// The runtime's `kete.share` RPC does the work; this prints what a share would send, asks (or needs
// --yes), uploads, and prints the link. Nothing is uploaded without a yes. Every side effect is in
// `Deps`, so tests run it without a runtime or a terminal. Exit codes: 0 done, 1 failed, 2 refused
// (including no terminal and no --yes, a "no" answer, and a run from an agent's shell). Text from the
// platform (messages, the link) is printed without control characters.

export * as KeteShareFlow from "./share-flow"

import { KeteShareRpc } from "@opencode/schema/kete/share"
import { Brand } from "@opencode/util/kete/brand"
import { KeteShareClient } from "@opencode/util/kete/share"
import { Schema } from "effect"

export const EXIT = { ok: 0, failed: 1, refused: 2 } as const

export interface Deps {
  readonly interactive: boolean
  /** Started from a shell the agent runs (KeteEnv.inAgentShell): sharing is refused. */
  readonly agentShell: boolean
  readonly confirm: (message: string) => Promise<boolean>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  /** The given session, else the newest root session in the current folder; undefined when there is none. */
  readonly resolve: (sessionID: string | undefined) => Promise<{ readonly id: string; readonly directory: string } | undefined>
  /** One `kete.share` call; returns the raw output (decoded here). */
  readonly call: (directory: string, method: "preview" | "share" | "unshare", input: Record<string, string>) => Promise<unknown>
}

const cli = Brand.cliName
const decodePreview = Schema.decodeUnknownPromise(KeteShareRpc.PreviewOutput)
const decodeShare = Schema.decodeUnknownPromise(KeteShareRpc.ShareOutput)
const decodeUnshare = Schema.decodeUnknownPromise(KeteShareRpc.UnshareOutput)

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

export function previewText(preview: KeteShareRpc.PreviewOutput): string {
  return [
    preview.visibility === "link" ? "Anyone with the link can read this session." : "Members of your organization can read this session.",
    `${preview.counts.messages} messages, ${preview.counts.tools} tool calls, ${preview.counts.diffs} changed files (${size(preview.bytes)})`,
    `Secrets removed: ${preview.redactions}`,
    ...(preview.truncated ? ["Large parts were left out to fit the size limit."] : []),
    "Not sent: reasoning, system prompts, attached file contents, skills, memory.",
    `The share expires in ${preview.maxDays} days.`,
    ...(preview.existing ? ["This session is already shared: sharing again updates the same share (link and expiry stay)."] : []),
  ].join("\n")
}

const clean = KeteShareClient.printable

const code = (refusal: KeteShareRpc.Refusal) => (refusal.kind === "failed" ? EXIT.failed : EXIT.refused)

export async function share(deps: Deps, options: { readonly sessionID?: string; readonly link: boolean; readonly yes: boolean }) {
  if (deps.agentShell) {
    deps.err(`${cli} share: Sharing must be started by you, not from an agent's shell.\n`)
    return EXIT.refused
  }
  const target = await deps.resolve(options.sessionID)
  if (!target) {
    deps.err(`${cli} share: no session to share in this folder. Pass a session id.\n`)
    return EXIT.failed
  }
  const preview = await decodePreview(
    await deps.call(target.directory, "preview", { sessionID: target.id, ...(options.link ? { visibility: "link" } : {}) }),
  )
  if (preview.refusal) {
    deps.err(`${cli} share: ${clean(preview.refusal.message)}\n`)
    return code(preview.refusal)
  }
  if (options.link && preview.visibility !== "link") {
    deps.err(`${cli} share: this session is already shared with your organization only. Run \`${cli} unshare\` first to share it by link.\n`)
    return EXIT.refused
  }
  deps.out(previewText(preview) + "\n")
  if (!options.yes) {
    if (!deps.interactive) {
      deps.err(`${cli} share: uploading needs your confirmation. Run it in a terminal, or pass --yes.\n`)
      return EXIT.refused
    }
    if (!(await deps.confirm("Upload this session to the Kete portal?"))) {
      deps.err("Cancelled; nothing was uploaded.\n")
      return EXIT.refused
    }
  }
  const result = await decodeShare(
    await deps.call(target.directory, "share", {
      sessionID: target.id,
      visibility: preview.visibility,
      // Confirmed by a person: upload only what they saw. --yes saw nothing, so it uploads what it builds.
      ...(!options.yes && preview.digest ? { digest: preview.digest } : {}),
    }),
  )
  if (result.refusal || !result.record) {
    const refusal = result.refusal ?? { kind: "failed" as const, message: "the runtime shared nothing" }
    deps.err(`${cli} share: ${clean(refusal.message)}\n`)
    return code(refusal)
  }
  deps.out(`Shared: ${clean(result.record.url)}\nExpires ${clean(result.record.expires_at)}.\n`)
  return EXIT.ok
}

export async function unshare(deps: Deps, options: { readonly sessionID?: string }) {
  const target = await deps.resolve(options.sessionID)
  if (!target) {
    deps.err(`${cli} unshare: no session in this folder. Pass a session id.\n`)
    return EXIT.failed
  }
  const result = await decodeUnshare(await deps.call(target.directory, "unshare", { sessionID: target.id }))
  if (result.refusal) {
    deps.err(`${cli} unshare: ${clean(result.refusal.message)}\n`)
    return code(result.refusal)
  }
  deps.out(result.removed ? "Share deleted.\n" : "That session isn't shared.\n")
  return EXIT.ok
}
