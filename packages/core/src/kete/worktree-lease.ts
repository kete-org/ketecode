// The record of a subagent's worktree and the lookup that keeps other sessions out of it. Kept
// apart from kete/worktrees.ts, with no session imports, so session/move.ts can use it.

export * as KeteWorktreeLease from "./worktree-lease.js"

import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Option, Schema } from "effect"
import type { KV } from "../kv.js"
import { Project } from "../project.js"
import { SessionSchema } from "../session/schema.js"

/** KV keys of the worktree index: one record per owning session, which outlives the session. */
export const indexPrefix = "kete.worktree/"

export const Record = Schema.Struct({
  /** The session that owns the worktree. */
  sessionID: SessionSchema.ID,
  projectID: Project.ID,
  /** The worktree's top-level directory. */
  root: Schema.String,
  branch: Schema.String,
  /** The commit the worktree started from. */
  base: Schema.String,
  /** The parent's repository directory, where the branch is managed once the worktree is gone. */
  source: Schema.String,
})
export type Record = typeof Record.Type

export const decode = Schema.decodeUnknownOption(Record)

/** The agent worktree that contains `directory` and belongs to a session other than `sessionID`. */
export const leasedTo = Effect.fnUntraced(function* (kv: KV.Interface, directory: string, sessionID: SessionSchema.ID) {
  let after: string | undefined
  do {
    const page = yield* kv.scan({ prefix: indexPrefix, after })
    for (const entry of page.entries) {
      const record = decode(entry.value)
      if (Option.isNone(record)) continue
      if (record.value.sessionID !== sessionID && FSUtil.contains(record.value.root, directory)) return record.value
    }
    after = page.next
  } while (after)
  return undefined
})
