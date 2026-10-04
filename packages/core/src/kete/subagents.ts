// Controls for subagents, configured under `kete.subagents`:
//
// - Timeout: a subagent that runs longer than `timeout` minutes (default 60, 0 = no limit) is
//   stopped, and its job fails with a timeout error. The parent hears about it like any other
//   failure: the subagent tool fails in the foreground, and a background run's completion notice
//   wakes the parent with the error.
// - Concurrency: one session may have at most `max_concurrent` subagents running at once
//   (default 4). The subagent tool refuses to start another one and tells the model why.
// - Stop cascade: when the user stops a session, its running subagents (foreground and
//   background) stop too, and so do theirs. Stopping a background subagent otherwise left it
//   running, and its completion notice then restarted the parent the user had just stopped.
// - Worktree report: a subagent that ran in its own worktree (kete/worktrees.ts) ends its answer,
//   or its error, with the branch that holds its work.
//
// The timeout wraps every subagent job, including slash-command subtasks. Only the subagent tool
// asks for admission: subtasks are started by the user, not the model. Background subagents that
// were recovered after a restart (session/execution/restart.ts starts them) aren't bound; the plugin
// gives them a timeout (`watchRecovered`).

export * as KeteSubagents from "./subagents.js"

import { ToolFailure } from "@opencode/ai"
import type { ConfigKete } from "@opencode/schema/config/kete"
import { Cause, Duration, Effect, Scope, Semaphore, Stream } from "effect"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Agent } from "../agent.js"
import { Job } from "../job.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
import { KeteWorktrees } from "./worktrees.js"

export const defaults = { timeout: 60, maxConcurrent: 4 } as const

export type Limits = {
  /** Undefined means no limit. */
  readonly timeout: Duration.Duration | undefined
  readonly maxConcurrent: number
}

export function limits(settings: ConfigKete.Subagents | undefined): Limits {
  const minutes = settings?.timeout ?? defaults.timeout
  return {
    timeout: minutes > 0 ? Duration.minutes(minutes) : undefined,
    maxConcurrent: settings?.max_concurrent ?? defaults.maxConcurrent,
  }
}

export class TimeoutError extends Error {
  constructor(readonly minutes: number) {
    super(
      `Subagent stopped after running for ${minutes} minute${minutes === 1 ? "" : "s"} (the "kete.subagents.timeout" limit).`,
    )
    this.name = "KeteSubagentTimeoutError"
  }
}

/** A place held for a subagent while it is being started; `bind` names the child it is for. */
export interface Ticket {
  readonly bind: (childID: SessionSchema.ID) => Effect.Effect<void>
}

/**
 * Counts one parent's running subagents: the children with a running subagent job, plus the
 * places held by starts in flight. A place bound to a child that is already running counts once.
 * `exclude` leaves out a child that is being continued rather than started.
 */
export function count(input: {
  readonly running: Iterable<SessionSchema.ID>
  readonly held: Iterable<{ readonly child?: SessionSchema.ID }>
  readonly exclude?: SessionSchema.ID
}) {
  const ids = new Set(input.running)
  let unbound = 0
  for (const place of input.held) {
    if (place.child === undefined) unbound++
    else ids.add(place.child)
  }
  if (input.exclude !== undefined) ids.delete(input.exclude)
  return ids.size + unbound
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const make: Effect.Effect<
  {
    readonly admit: (
      parentID: SessionSchema.ID,
      childID?: SessionSchema.ID,
    ) => Effect.Effect<Ticket, ToolFailure, Scope.Scope>
    readonly bound: <E>(childID: SessionSchema.ID, run: Effect.Effect<string, E>) => Effect.Effect<string, E | Error>
    readonly worktree: (
      input: { readonly worktree?: boolean; readonly background?: boolean },
      agent: Agent.Info,
    ) => Effect.Effect<boolean>
  },
  never,
  Config.Service | Session.Service | Job.Service | Scope.Scope
> = Effect.gen(function* () {
  const config = yield* Config.Service
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  const worktrees = yield* KeteWorktrees.optional
  // Admission reads the job registry and then holds a place; the lock makes the pair atomic for
  // parallel subagent calls in one turn.
  const lock = yield* Semaphore.make(1)
  const held = new Map<SessionSchema.ID, Set<{ child?: SessionSchema.ID }>>()

  const current = Effect.map(config.entries(), (entries) => limits(Config.latest(entries, "kete")?.subagents))

  const running = Effect.fnUntraced(function* (parentID: SessionSchema.ID) {
    const children = yield* sessions.list({ parentID })
    const ids: SessionSchema.ID[] = []
    for (const child of children.data) {
      const job = yield* jobs.get(child.id)
      if (job?.type === "subagent" && job.status === "running") ids.push(child.id)
    }
    return ids
  })

  const release = (parentID: SessionSchema.ID, place: { child?: SessionSchema.ID }) =>
    Effect.sync(() => {
      const places = held.get(parentID)
      places?.delete(place)
      if (places?.size === 0) held.delete(parentID)
    })

  /**
   * Holds a place for one subagent of `parentID` until the surrounding scope closes, or fails
   * when the parent already has `max_concurrent` running. Pass `childID` when continuing an
   * existing child, so a child that is already running isn't counted twice.
   */
  const admit = (parentID: SessionSchema.ID, childID?: SessionSchema.ID) =>
    Effect.acquireRelease(
      lock.withPermit(
        Effect.gen(function* () {
          const { maxConcurrent } = yield* current
          const places = held.get(parentID) ?? new Set()
          const active = count({ running: yield* running(parentID), held: places, exclude: childID })
          if (active >= maxConcurrent)
            return yield* new ToolFailure({
              message: [
                `This session already has ${active} subagent${active === 1 ? "" : "s"} running, the most allowed at once ("kete.subagents.max_concurrent" is ${maxConcurrent}).`,
                "Wait for a running subagent's completion notice before starting another, or do this task yourself.",
              ].join(" "),
            })
          const place: { child?: SessionSchema.ID } = childID === undefined ? {} : { child: childID }
          held.set(parentID, places.add(place))
          return place
        }),
      ),
      (place) => release(parentID, place),
    ).pipe(
      Effect.map(
        (place): Ticket => ({
          bind: (childID) =>
            Effect.sync(() => {
              place.child = childID
            }),
        }),
      ),
    )

  /** The note on a subagent's worktree; `release` removes one it didn't change. Never fails. */
  const note = (childID: SessionSchema.ID, release: boolean) =>
    (worktrees === undefined ? Effect.succeed(undefined) : worktrees.report(childID, { release })).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to report a subagent's worktree", { childID, cause }).pipe(Effect.as(undefined)),
      ),
    )

  /**
   * Runs one subagent job's work under the timeout, then appends its worktree note. On timeout the
   * job fails first, then the child is stopped: stopping it first would settle the job as
   * cancelled, which reads as the user's choice rather than a limit.
   */
  const bound = <E>(childID: SessionSchema.ID, run: Effect.Effect<string, E>) =>
    limited(childID, run).pipe(
      Effect.matchEffect({
        onSuccess: (text) =>
          note(childID, true).pipe(Effect.map((extra) => (extra === undefined ? text : `${text}\n\n${extra}`))),
        // A failed or stopped child may still be running, so its worktree is never removed here.
        onFailure: (error) =>
          note(childID, false).pipe(
            Effect.flatMap((extra) =>
              Effect.fail(extra === undefined ? error : new Error(`${errorMessage(error)}\n\n${extra}`)),
            ),
          ),
      }),
    )

  const limited = <A, E>(childID: SessionSchema.ID, run: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const { timeout } = yield* current
      if (timeout === undefined) return yield* run
      return yield* run.pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.gen(function* () {
              yield* jobs.wait({ id: childID }).pipe(
                Effect.andThen(sessions.interrupt(childID)),
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to stop a subagent after its timeout", { childID, cause }),
                ),
                Effect.forkIn(scope, { startImmediately: true }),
              )
              return yield* Effect.fail(new TimeoutError(Duration.toMinutes(timeout)))
            }),
        }),
      )
    })

  /**
   * Whether a new subagent runs in its own worktree: as asked, or by `kete.subagents.worktree`
   * ("background": background subagents whose agent may edit files).
   */
  const worktree = (input: { readonly worktree?: boolean; readonly background?: boolean }, agent: Agent.Info) =>
    Effect.gen(function* () {
      if (input.worktree !== undefined) return input.worktree
      const setting = Config.latest(yield* config.entries(), "kete")?.subagents?.worktree ?? "never"
      return (
        setting === "background" &&
        input.background === true &&
        Permission.evaluate("edit", "*", agent.permissions).effect !== "deny"
      )
    })

  return { admit, bound, worktree }
})

/**
 * The subagent tool's checks, for slash-command subtasks (config/plugin/command.ts), which upstream
 * starts without them: the nesting depth (`experimental.subagent_depth`) and the parent agent's
 * `subagent` rules. A deny refuses; anything else runs, since the user started the subtask. A
 * primary agent is allowed: a subtask without its own agent runs the parent's.
 */
export const subtaskCheck = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const config = yield* Config.Service
  const agents = yield* Agent.Service
  return Effect.fnUntraced(function* (parentID: SessionSchema.ID, agentID: string) {
    const parent = yield* sessions.get(parentID)
    let current = parent
    let depth = 0
    while (current.parentID !== undefined) {
      depth++
      current = yield* sessions.get(current.parentID)
    }
    const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
    if (depth >= limit)
      return yield* Effect.fail(
        new Error(
          `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
        ),
      )
    const agent = yield* agents.resolve(parent.agent)
    const rules = agent === undefined ? [] : Permission.merge(agent.permissions, parent.permissions ?? [])
    if (agent === undefined || Permission.evaluate("subagent", agentID, rules).effect === "deny")
      return yield* Effect.fail(new Error(`This session's agent may not start ${agentID} as a subagent.`))
  })
})

/** Stops the running subagents of `parentID`. Each stopped child's own interruption stops its children in turn. */
export const stopChildren = Effect.fnUntraced(function* (parentID: SessionSchema.ID) {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const children = yield* sessions.list({ parentID })
  yield* Effect.forEach(
    children.data,
    Effect.fnUntraced(function* (child) {
      const job = yield* jobs.get(child.id)
      if (job?.type !== "subagent" || job.status !== "running") return
      yield* sessions.interrupt(child.id)
      // The child's interruption cancels its job once it settles; cancelling here as well covers a
      // job whose child isn't executing in this process.
      yield* jobs.cancel(child.id)
    }),
    { discard: true },
  )
})

/**
 * Background subagents recovered after a restart run without `bound`, so they'd have no timeout.
 * When a location's plugins activate, each running background subagent of a session here gets a
 * full timeout from now; one still running then is reported to its parent as stopped, and
 * stopped. Subagents that already have the timeout have finished by then, so this does nothing
 * for them.
 */
const watchRecovered: Effect.Effect<void, never, Session.Service | Job.Service | Config.Service | Location.Service> =
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const { timeout } = limits(Config.latest(yield* config.entries(), "kete")?.subagents)
    if (timeout === undefined) return
    const running = (yield* jobs.pendingBackground).flatMap((item) =>
      item.status === "running" && item.recovery.kind === "subagent" ? [item.recovery] : [],
    )
    yield* Effect.forEach(
      running,
      (recovery) =>
        Effect.gen(function* () {
          const child = yield* sessions.get(recovery.childSessionID).pipe(Effect.option)
          if (child._tag === "None" || child.value.location.directory !== location.directory) return
          yield* Effect.sleep(timeout)
          if ((yield* jobs.get(recovery.childSessionID))?.status !== "running") return
          const error = new TimeoutError(Duration.toMinutes(timeout))
          yield* sessions.synthetic({
            sessionID: recovery.parentSessionID,
            description: recovery.description,
            text: `<subagent sessionID="${recovery.childSessionID}" state="error" description="${recovery.description}">\n${error.message}\n</subagent>`,
            metadata: { source: "subagent", childID: recovery.childSessionID, agent: recovery.agent, state: "error" },
          })
          yield* sessions.interrupt(recovery.childSessionID)
          yield* jobs.cancel(recovery.childSessionID)
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to stop a recovered subagent after its timeout", { error }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
  })

export const Plugin = {
  id: "kete.subagents",
  effect: Effect.fn("KeteSubagents.Plugin")(function* () {
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    yield* watchRecovered.pipe(
      Effect.provideService(Session.Service, sessions),
      Effect.provideService(Job.Service, jobs),
      Effect.provideService(Config.Service, config),
      Effect.provideService(Location.Service, location),
      Effect.catchCause((cause) => Effect.logWarning("failed to watch recovered subagents", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* bus.subscribe(SessionEvent.Execution.Interrupted).pipe(
      // "user" is a deliberate stop; shutdown keeps background work for the next start, and
      // superseded or inactive runs aren't the user asking for everything to stop.
      Stream.filter((event) => event.data.reason === "user"),
      Stream.runForEach((event) =>
        stopChildren(event.data.sessionID).pipe(
          Effect.provideService(Session.Service, sessions),
          Effect.provideService(Job.Service, jobs),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("failed to stop a stopped session's subagents", {
                sessionID: event.data.sessionID,
                cause,
              }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
}
