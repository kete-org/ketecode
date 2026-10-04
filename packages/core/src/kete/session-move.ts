// Checks on the model's `session_move` tool, which upstream runs without asking. Moving a session
// moves what it may touch, so:
// - an agent may move only its own session or one of its subagents' sessions, not any session;
// - a move out of the session's repository asks the `external_directory` permission for the
//   destination, as reading or writing a file there would;
// - a move into another session's subagent worktree is refused with the reason (session/move.ts
//   refuses it for every caller; this gives the model a message it can act on).
// Moves the user asks for (the UI or HTTP API) are the user's choice and aren't asked about.

export * as KeteSessionMove from "./session-move.js"

import { Tool } from "@opencode/schema/tool"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect, Option, Predicate } from "effect"
import path from "path"
import { KV } from "../kv.js"
import { Permission } from "../permission.js"
import { Project } from "../project.js"
import { AbsolutePath } from "../schema.js"
import { Session } from "../session.js"
import { SessionSchema } from "../session/schema.js"
import { KeteWorktreeLease } from "./worktree-lease.js"
import { KeteWorktrees } from "./worktrees.js"

export const isSessionMove = (tool: string) => tool === "session_move" || tool.endsWith("_session_move")

const slash = (value: string) => value.replaceAll("\\", "/")

/** Longest ancestor chain followed when checking that a session is a descendant. */
const MAX_DEPTH = 32

export const Plugin = {
  id: "kete.session-move",
  effect: Effect.fn("KeteSessionMove.Plugin")(function* (ctx: PluginContext) {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const kv = yield* KV.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service

    /** Whether `sessionID` is `ancestorID` or one of its descendants. */
    const within = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, ancestorID: SessionSchema.ID) {
      let current: SessionSchema.ID | undefined = sessionID
      for (let depth = 0; current !== undefined && depth <= MAX_DEPTH; depth++) {
        if (current === ancestorID) return true
        const session: Option.Option<SessionSchema.Info> = yield* sessions.get(current).pipe(Effect.option)
        current = Option.isSome(session) ? session.value.parentID : undefined
      }
      return false
    })

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (!isSessionMove(event.tool) || !Predicate.isObject(event.input)) return
        const input = event.input
        if (typeof input.directory !== "string") return
        const targetID = typeof input.sessionID === "string" ? SessionSchema.ID.make(input.sessionID) : event.sessionID
        if (!(yield* within(targetID, event.sessionID)))
          return yield* new Tool.Error({
            message: "session_move can only move the current session or one of its subagents' sessions.",
          })
        const target = yield* sessions.get(targetID).pipe(Effect.option)
        // Unknown sessions are left to the tool, which reports them.
        if (Option.isNone(target)) return

        const value = input.directory.trim()
        const expanded =
          value === "~" ? global.home : value.startsWith("~/") ? path.join(global.home, value.slice(2)) : value
        const destination = AbsolutePath.make(path.resolve(target.value.location.directory, expanded))

        const leased = yield* KeteWorktreeLease.leasedTo(kv, destination, targetID)
        if (leased !== undefined)
          return yield* new Tool.Error({
            message: `${leased.root} is subagent ${leased.sessionID}'s worktree (branch ${leased.branch}); another session can't move into it.`,
          })

        const repository = KeteWorktrees.projectDirectory(target.value)
        if (FSUtil.contains(target.value.location.directory, destination) || FSUtil.contains(repository, destination))
          return
        yield* permission
          .assert({
            action: "external_directory",
            resources: [slash(path.join(destination, "*"))],
            save: [slash(path.join((yield* Project.root(fs, destination)) ?? destination, "*"))],
            sessionID: event.sessionID,
            agent: event.agent,
            source: { type: "tool", messageID: event.messageID, id: event.id },
          })
          .pipe(
            Effect.catchTags({
              "Permission.BlockedError": (error) => Effect.fail(new Tool.Error({ message: error.message })),
              "Permission.CorrectedError": (error) =>
                Effect.fail(new Tool.Error({ message: `Move declined: ${error.feedback}` })),
              "Session.NotFoundError": () => Effect.void,
            }),
          )
      }),
    )
  }),
}
