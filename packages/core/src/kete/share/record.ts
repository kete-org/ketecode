// The session's own share, kept in its metadata under `kete.share`. The record carries the id of the
// session that made it: a child session or a fork inherits its parent's metadata (session.ts), and
// must not claim the parent's share, so a record for another session is ignored. A session import
// drops the key (`without`), so an imported session never claims someone else's share.

import { KeteShareRpc } from "@opencode/schema/kete/share"
import { Schema } from "effect"
import type { SessionSchema } from "../../session/schema.js"

export const metadataKey = "kete.share"

const decode = Schema.decodeUnknownOption(KeteShareRpc.Record)

/** The record in `metadata` if it belongs to `sessionID`. */
export const read = (metadata: SessionSchema.Metadata | undefined, sessionID: string): KeteShareRpc.Record | undefined => {
  const found = decode(metadata?.[metadataKey])
  return found._tag === "Some" && found.value.session === sessionID ? found.value : undefined
}

/** `metadata` without `kete.share`, for writes that bypass the plugin (a session import). */
export const without = (metadata: SessionSchema.Metadata | undefined): SessionSchema.Metadata | undefined => {
  if (metadata === undefined || !(metadataKey in metadata)) return metadata
  const { [metadataKey]: _, ...rest } = metadata
  return rest
}

export * as KeteShareRecord from "./record.js"
