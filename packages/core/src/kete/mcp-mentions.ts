// `@`-mentioned MCP resources (parity B6, docs/mcp-resources.md). The TUI attaches a mentioned resource
// as a `kete-mcp:<server>/<uri>` file (KeteMcpMention); before the prompt is stored, this plugin reads
// it from its server and replaces it with the content, so the model sees the resource at once.
//
// Mentioning a resource is the user's own choice, like mentioning a file, so it doesn't ask; a rule
// denying `opencode_read_mcp_resource` for it (the read_mcp_resource tool's permission) still refuses
// it. A resource that can't be attached is dropped and the prompt says why, visibly.

export * as KeteMcpMentions from "./mcp-mentions.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { PromptInput } from "@opencode/schema/prompt-input"
import { KeteMcpMention } from "@opencode/util/kete/mcp-mention"
import { Effect } from "effect"
import { Mcp } from "../mcp/index.js"
import { Permission } from "../permission.js"
import type { SessionSchema } from "../session/schema.js"
import { Mime } from "../mime.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"

export const id = "kete.mcp-mentions"

/** Bytes of one mentioned resource's content; a larger one isn't attached. */
export const MAX_BYTES = 5 * 1024 * 1024

type File = PromptInput.FileAttachment

export interface Deps {
  readonly read: (input: { server: string; uri: string }) => Effect.Effect<Mcp.ResourceContent | undefined, Error>
  readonly denied: (input: { sessionID: string; server: string; uri: string }) => Effect.Effect<boolean>
}

const dataURL = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`

/** One line of a server's error for the prompt's note: no line breaks, at most 200 characters. */
const short = (message: string) => message.replace(/\s+/g, " ").trim().slice(0, 200)

/**
 * The attachments for one resource's content, or why it can't be attached. Every attachment is labelled
 * as the server's content, not the user's, and is checked against how SessionPrompt sniffs its type
 * (it ignores a data: URL's own type), so an attachment never fails the prompt later.
 */
export function attachments(file: File, resource: Mcp.ResourceContent): { files: File[] } | { error: string } {
  const label = `MCP resource ${resource.server}:${resource.uri}`
  const texts = resource.contents.flatMap((part) => (part.type === "text" ? [part.text] : []))
  const media = resource.contents.flatMap((part) =>
    part.type === "blob" && part.mimeType !== undefined && ReadToolFileSystem.MEDIA_MIMES.has(part.mimeType)
      ? [{ mime: part.mimeType, bytes: Buffer.from(part.blob, "base64") }]
      : [],
  )
  const skipped = resource.contents.length - texts.length - media.length
  if (texts.length === 0 && media.length === 0)
    return { error: skipped > 0 ? "it has only binary content the model can't read" : "it is empty" }
  // The header keeps the text from being taken for an image or PDF by its first bytes.
  const text = texts.length > 0 ? Buffer.from(`${label}\n\n${texts.join("\n\n")}`) : undefined
  const bytes = (text?.byteLength ?? 0) + media.reduce((sum, part) => sum + part.bytes.byteLength, 0)
  if (bytes > MAX_BYTES) return { error: `it is larger than ${MAX_BYTES / 1024 / 1024} MiB` }
  if (text && Mime.detect(text) !== "text/plain") return { error: "its text has content the model can't read (binary or control characters)" }
  for (const part of media)
    if (Mime.detect(part.bytes) !== part.mime) return { error: `its ${part.mime} content isn't valid ${part.mime}` }
  // The mention URI, so a prompt put back in the composer (edit, revert) reads the resource again.
  const source = { type: "uri" as const, uri: KeteMcpMention.encode(resource.server, resource.uri) }
  const files: File[] = []
  if (text) files.push({ uri: dataURL("text/plain", text), source, name: label, ...(file.mention ? { mention: file.mention } : {}) })
  for (const [index, part] of media.entries())
    files.push({
      uri: dataURL(part.mime, part.bytes),
      source,
      name: media.length === 1 ? label : `${label} (${index + 1})`,
      ...(files.length === 0 && file.mention ? { mention: file.mention } : {}),
    })
  return { files }
}

export function make(deps?: Deps) {
  return define({
    id,
    effect: Effect.fn("KeteMcpMentions.Plugin")(function* (ctx) {
      const resolved: Deps =
        deps ??
        (yield* Effect.gen(function* () {
          const mcp = yield* Mcp.Service
          const permission = yield* Permission.Service
          return {
            read: (input) => mcp.readResource(input),
            denied: (input) =>
              permission
                .assertNotDenied({
                  sessionID: input.sessionID as SessionSchema.ID,
                  action: "opencode_read_mcp_resource",
                  resources: [`${input.server}:${input.uri}`],
                  metadata: { server: input.server, uri: input.uri },
                })
                .pipe(
                  Effect.as(false),
                  Effect.catchCause(() => Effect.succeed(true)),
                ),
          } satisfies Deps
        }))

      yield* ctx.session.hook("prompt", (event) => {
        const original = event.prompt.files
        if (!original?.some((file) => KeteMcpMention.decode(file.uri))) return Effect.void
        return Effect.gen(function* () {
          const kept: File[] = []
          const notes: string[] = []
          // A prompt put back in the composer carries one mention file per attachment it became; read each resource once.
          const seen = new Map<string, number>()
          const mentions: Array<{ file: File; mention: { server: string; uri: string } }> = []
          for (const file of original) {
            const mention = KeteMcpMention.decode(file.uri)
            if (!mention) {
              kept.push(file)
              continue
            }
            const key = `${mention.server}\u0000${mention.uri}`
            const index = seen.get(key)
            if (index === undefined) {
              seen.set(key, mentions.length)
              mentions.push({ file, mention })
            } else if (!mentions[index]!.file.mention && file.mention) mentions[index] = { file, mention }
          }
          for (const { file, mention } of mentions) {
            const name = `${mention.server}:${mention.uri}`
            const result = yield* Effect.gen(function* () {
              if (yield* resolved.denied({ sessionID: event.sessionID, ...mention })) return { error: "a permission rule denies reading it" }
              const resource = yield* resolved.read(mention)
              if (!resource) return { error: "its MCP server is not connected or has no resources" }
              return attachments(file, resource)
            }).pipe(Effect.catch((error: Error) => Effect.succeed({ error: `the server returned an error (${short(error.message)})` })))
            if ("files" in result) kept.push(...result.files)
            else {
              notes.push(`[MCP resource ${short(name)} was not attached: ${result.error}]`)
              yield* Effect.logWarning("MCP resource mention not attached", { server: mention.server, error: result.error })
            }
          }
          event.prompt.files = kept as typeof event.prompt.files
          if (notes.length > 0) event.prompt.text = `${event.prompt.text}\n\n${notes.join("\n")}`
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // Never leave a kete-mcp: file behind: the prompt would fail on it.
              event.prompt.files = original.filter((file) => !KeteMcpMention.decode(file.uri)) as typeof event.prompt.files
              event.prompt.text = `${event.prompt.text}\n\n[MCP resources were not attached: an internal error occurred]`
              yield* Effect.logWarning("MCP resource mentions failed", { cause })
            }),
          ),
        )
      })
    }),
  })
}

export const Plugin = make()
