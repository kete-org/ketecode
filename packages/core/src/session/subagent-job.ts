export * as SubagentJob from "./subagent-job.js"

import { Effect, Scope } from "effect"
import { Config } from "../config.js" // kete_change
import { Job } from "../job.js"
import { KeteSubagents } from "../kete/subagents.js" // kete_change
import { Session } from "../session.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

interface Runner {
  start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
}

// kete_change start: Config.Service for KeteSubagents
type Requirements = Session.Service | Job.Service | Config.Service | Scope.Scope

export const make: Effect.Effect<Runner, never, Requirements> = Effect.gen(function* () {
  // kete_change end
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  const controls = yield* KeteSubagents.make // kete_change
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<string>()

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    const key = `${recovery.childSessionID}:${startedAt}`
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      const info = (yield* jobs.wait({ id: recovery.childSessionID })).info
      // kete_change start: a cancelled subagent's notice doesn't restart its parent; the user stopped it
      if (info)
        yield* SubagentCompletion.deliver(sessions, jobs, {
          ...info,
          recovery,
          ...(info.status === "cancelled" ? { resume: false } : {}),
        })
      // kete_change end
    }).pipe(
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  return {
    start: (recovery: Recovery) =>
      jobs.start({
        id: recovery.childSessionID,
        type: "subagent",
        title: recovery.description,
        metadata: {},
        recovery,
        run: Effect.gen(function* () {
          yield* sessions.resume(recovery.childSessionID)
          const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
          const assistant = messages.find(
            (message) =>
              message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
          )
          return SubagentCompletion.text(assistant)
        }).pipe((run) => controls.bound(recovery.childSessionID, run)), // kete_change: KeteSubagents timeout
      }),
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
      const info = yield* jobs.background(recovery.childSessionID)
      if (info) yield* notify(recovery, info.started_at)
    }),
    notify,
  }
})
