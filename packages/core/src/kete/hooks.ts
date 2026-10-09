// Config hooks: shell commands the user configures under `kete.hooks` that run at points of the agent
// loop (docs/hooks.md). Built on the plugin hook system — this is an internal plugin that executes
// configured commands — so no upstream code changes:
//
// | Event            | When                                                  | Can                                   |
// | ---------------- | ----------------------------------------------------- | ------------------------------------- |
// | PreToolUse       | `tool.execute.before`                                 | block the call (exit 2 / deny)        |
// | PostToolUse      | `tool.execute.after`                                  | add context to the tool's result      |
// | UserPromptSubmit | `session.prompt`                                      | add context to the prompt             |
// | SessionStart     | `session.created` event                               | add context (a synthetic message)     |
// | Stop             | `session.execution.succeeded/failed/interrupted`      | — (notify, log, run checks)           |
// | Notification     | `permission.asked`, `form.created`                    | — (notify)                            |
//
// Trust. A repository's own configuration is written by whoever wrote the repository, so its hooks
// are a way to run code on this machine. Hooks from the global config (`~/.config/kete/`) run
// directly; project hooks run only once the user trusts their exact commands: the first time they
// would run in a session, a form lists every project hook command and asks. Trust is remembered per
// repository and fingerprint (hooks/trust.ts) and asked again whenever the hooks change; a "no" lasts
// until the runtime restarts. Stop and Notification never ask (they'd interrupt at the wrong time);
// they run project hooks only when already trusted. Unattended runs never ask: project hooks run only
// when already trusted.
//
// - A policy denying `hooks:<event>` (`{"action":"permission","resource":"hooks:*","effect":"deny"}`,
//   from the organization or configuration) turns hooks off.
// - Never in job mode (cloud, self-hosted and review jobs); its server doesn't load project config
//   either.
// - Hooks run with the user's permissions, outside the OS sandbox, like git hooks: they are commands
//   the user configured or explicitly trusted. Kete's own credentials are removed from their
//   environment.
// - A PreToolUse hook that fails, times out or can't start blocks the call (fail closed), with a
//   reason naming the hook. Failures of other events are logged and reported, never fatal.

export * as KeteHooks from "./hooks.js"

import path from "path"
import fs from "fs/promises"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Global } from "@opencode/util/global"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Effect, Option, Predicate, Stream } from "effect"
import type { Entry as ConfigEntry } from "@opencode/schema/config"
import { Config } from "../config.js"
import { Environment } from "../environment/index.js"
import { Form } from "../form.js"
import { Location } from "../location.js"
import { ManagedPolicy } from "../managed-policy.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KeteHooksRun } from "./hooks/run.js"
import { KeteHooksSettings } from "./hooks/settings.js"
import { KeteHooksTrust } from "./hooks/trust.js"
import { KeteToolEnv } from "./tool-env.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

type Event = KeteHooksSettings.Event
type Entry = KeteHooksSettings.Entry

/** Characters of a tool's input or output put in a hook's payload. */
export const MAX_PAYLOAD_TEXT = 32 * 1024

/** Events that may ask the user to trust project hooks. */
const asking: ReadonlySet<Event> = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart"])

export const TRUST_FORM_KIND = "kete.hooks.trust"

/** The trust form's question (exported for tests). */
export function trustDescription(repository: string, entries: ReadonlyArray<Entry>) {
  const lines = entries
    .filter((entry) => entry.source === "project")
    .map((entry) => `- ${entry.event}${entry.match ? ` (${entry.match})` : ""}: ${entry.command}`)
  return `This repository's configuration (${repository}) runs these commands on your computer, with your permissions, during sessions:\n\n${lines.join("\n")}\n\nRun them? You'll be asked again if they change.`
}

function bounded(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_PAYLOAD_TEXT ? value.slice(0, MAX_PAYLOAD_TEXT) + "…" : value
  let text: string
  try {
    text = JSON.stringify(value) ?? "null"
  } catch {
    return null
  }
  return text.length > MAX_PAYLOAD_TEXT ? text.slice(0, MAX_PAYLOAD_TEXT) + "…" : value
}

function resultText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => (Predicate.isObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("\n")
}

// Session IDs below come from the runtime's own events and tool calls; `as SessionSchema.ID` only
// re-applies the brand the plain event data lost.
const sessionOf = (data: unknown) =>
  Predicate.isObject(data) && typeof data.sessionID === "string" ? data.sessionID : undefined

export interface Deps {
  readonly env?: Record<string, string | undefined>
  /** Asks the user whether to trust the project hooks; default: a form in the session. */
  readonly ask?: (input: { sessionID: string; repository: string; entries: ReadonlyArray<Entry> }) => Effect.Effect<boolean>
  /** Whether the session belongs to an unattended run; default: KeteUnattendedPolicy. */
  readonly unattended?: (sessionID: string) => Effect.Effect<boolean>
}

export function make(deps: Deps = {}) {
  return {
    id: "kete.hooks",
    effect: Effect.fn("KeteHooks.Plugin")(function* (ctx: PluginContext) {
      const env = deps.env ?? process.env
      if (KeteJobMode.enabled(env)) return
      const config = yield* Config.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const environment = yield* Environment.Service
      const managed = yield* ManagedPolicy.Service
      const forms = Option.getOrUndefined(yield* Effect.serviceOption(Form.Service))
      const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      const trust = KeteHooksTrust.make(global.state)
      const cwd = location.directory
      const repository = location.project.directory ?? location.directory
      const repositoryKey = yield* Effect.promise(() => fs.realpath(repository).catch(() => path.resolve(repository)))
      const hookEnv = (event: Event) => {
        const result: Record<string, string> = {}
        for (const [name, value] of Object.entries(KeteToolEnv.withoutKeteCredentials(env)))
          if (value !== undefined) result[name] = value
        result.KETE_HOOK_EVENT = event
        result.KETE_PROJECT_DIR = cwd
        return result
      }

      const ask =
        deps.ask ??
        ((input: { sessionID: string; repository: string; entries: ReadonlyArray<Entry> }) =>
          Effect.gen(function* () {
            if (!forms) return false
            const state = yield* forms
              .ask({
                sessionID: input.sessionID as SessionSchema.ID,
                title: "Run this repository's hooks?",
                metadata: { kind: TRUST_FORM_KIND },
                fields: [
                  {
                    key: "decision",
                    type: "string",
                    title: "Repository hooks",
                    description: trustDescription(input.repository, input.entries),
                    required: true,
                    options: [
                      { value: "trust", label: "Trust and run them" },
                      { value: "skip", label: "Don't run them" },
                    ],
                  },
                ],
              })
              .pipe(Effect.orDie)
            return state.status === "answered" && state.answer.decision === "trust"
          }).pipe(Effect.catchCause(() => Effect.succeed(false))))

      const unattended =
        deps.unattended ??
        ((sessionID: string) =>
          sessions
            ? KeteUnattendedPolicy.resolve((id) => sessions.get(id).pipe(Effect.option), sessionID as SessionSchema.ID).pipe(
                Effect.map((state) => state.kind === "unattended"),
                Effect.catchCause(() => Effect.succeed(true)),
              )
            : Effect.succeed(false))

      // Trust decisions this process made, by fingerprint; pending questions are shared.
      const declined = new Set<string>()
      const pending = new Map<string, Promise<boolean>>()
      const warned = new Set<string>()
      const warnOnce = (key: string, message: string, fields: Record<string, unknown>) =>
        warned.has(key) ? Effect.void : Effect.sync(() => warned.add(key)).pipe(Effect.andThen(Effect.logWarning(message, fields)))

      const policies = (entries: ReadonlyArray<ConfigEntry>) => [
        ...entries.flatMap((entry) => (entry.type === "document" ? (entry.info.experimental?.policies ?? []) : [])),
        ...managed.current().statements,
      ]

      /** The hooks to run for an event in a session (user first, then trusted project hooks). */
      const select = Effect.fnUntraced(function* (event: Event, sessionID: string, tool?: string) {
        const entries = yield* config.entries()
        if (KeteHooksSettings.disabledByPolicy(policies(entries), event)) return []
        const all = KeteHooksSettings.collect(
          entries.flatMap((entry) => (entry.type === "document" ? [{ path: entry.path, hooks: entry.info.kete?.hooks }] : [])),
          global.config,
        )
        const relevant = all.filter((entry) => entry.event === event && KeteHooksSettings.matches(entry, tool))
        const user = relevant.filter((entry) => entry.source === "user")
        const project = relevant.filter((entry) => entry.source === "project")
        if (project.length === 0) return user
        const fingerprint = KeteHooksSettings.fingerprint(all)
        if (yield* Effect.promise(() => trust.trusted(repositoryKey, fingerprint).catch(() => false))) return [...user, ...project]
        if (declined.has(fingerprint) || !asking.has(event)) return user
        if (yield* unattended(sessionID)) {
          yield* warnOnce(`unattended ${fingerprint}`, "project hooks skipped in an unattended run: they aren't trusted", {
            repository: repositoryKey,
          })
          return user
        }
        let question = pending.get(fingerprint)
        if (!question) {
          question = Effect.runPromise(ask({ sessionID, repository: repositoryKey, entries: all })).then(async (yes) => {
            if (yes)
              await trust.trust(
                repositoryKey,
                fingerprint,
                all.filter((entry) => entry.source === "project").map((entry) => entry.command),
              )
            else declined.add(fingerprint)
            return yes
          })
          pending.set(fingerprint, question)
          question.finally(() => pending.delete(fingerprint)).catch(() => undefined)
        }
        const yes = yield* Effect.promise(() => question!.catch(() => false))
        return yes ? [...user, ...project] : user
      })

      const runAll = Effect.fnUntraced(function* (event: Event, sessionID: string, payload: Record<string, unknown>, tool?: string) {
        const selected = yield* select(event, sessionID, tool)
        const outcomes: Array<{ entry: Entry; outcome: KeteHooksRun.Outcome }> = []
        for (const entry of selected) {
          const outcome = yield* KeteHooksRun.run({
            spawner: environment.spawner,
            command: entry.command,
            cwd,
            env: hookEnv(event),
            payload: { event, session_id: sessionID, cwd, ...payload },
            timeout: entry.timeout,
          })
          if (outcome.kind === "error")
            yield* Effect.logWarning("hook failed", { event, source: entry.source, command: entry.command.slice(0, 200), error: outcome.message })
          outcomes.push({ entry, outcome })
          // A PreToolUse hook that blocks ends the event: later hooks don't run.
          if (event === "PreToolUse" && (outcome.kind !== "ok" || outcome.decision === "deny")) break
        }
        return outcomes
      })

      const contexts = (event: Event, outcomes: ReadonlyArray<{ entry: Entry; outcome: KeteHooksRun.Outcome }>) =>
        outcomes.flatMap(({ outcome }) => {
          if (outcome.kind === "ok" && outcome.context) return [outcome.context]
          if (outcome.kind === "ok" && outcome.decision === "deny" && outcome.reason) return [outcome.reason]
          if (outcome.kind === "deny") return [outcome.reason]
          return []
        }).map((text) => `<hook event="${event}">\n${text}\n</hook>`)

      const short = (command: string) => (command.length > 80 ? command.slice(0, 77) + "..." : command)

      // PreToolUse: block on deny, exit 2, or a hook that failed (fail closed).
      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.gen(function* () {
          const outcomes = yield* runAll("PreToolUse", event.sessionID, { tool: event.tool, tool_input: bounded(event.input) }, event.tool)
          for (const { entry, outcome } of outcomes) {
            if (outcome.kind === "deny") return yield* new Tool.Error({ message: `Blocked by a PreToolUse hook: ${outcome.reason}` })
            if (outcome.kind === "ok" && outcome.decision === "deny")
              return yield* new Tool.Error({ message: `Blocked by a PreToolUse hook: ${outcome.reason ?? "no reason given"}` })
            if (outcome.kind === "error")
              return yield* new Tool.Error({
                message: `Blocked: the PreToolUse hook \`${short(entry.command)}\` ${outcome.message}. Fix or remove the hook in kete.hooks.`,
              })
          }
        }),
      )

      // PostToolUse: context goes after the tool's result.
      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.gen(function* () {
          const payload =
            event.status === "completed"
              ? { tool: event.tool, tool_input: bounded(event.input), tool_result: { status: "completed", output: bounded(resultText(event.result.content)) } }
              : { tool: event.tool, tool_input: bounded(event.input), tool_result: { status: "error", error: bounded(event.error.message) } }
          const added = contexts("PostToolUse", yield* runAll("PostToolUse", event.sessionID, payload, event.tool))
          if (added.length === 0) return
          const text = added.join("\n")
          if (event.status === "completed") {
            const content = event.result.content
            event.result = {
              ...event.result,
              content:
                content === undefined
                  ? text
                  : typeof content === "string"
                    ? `${content}\n\n${text}`
                    : [...content, { type: "text", text }],
            }
          } else event.error = new Tool.Error({ message: `${event.error.message}\n\n${text}`, metadata: event.error.metadata })
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("PostToolUse hooks failed", { cause }))),
      )

      // UserPromptSubmit: context is appended to the prompt, visibly.
      yield* ctx.session.hook("prompt", (event) =>
        Effect.gen(function* () {
          const added = contexts("UserPromptSubmit", yield* runAll("UserPromptSubmit", event.sessionID, { prompt: bounded(event.prompt.text) }))
          if (added.length > 0) event.prompt.text = `${event.prompt.text}\n\n${added.join("\n")}`
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("UserPromptSubmit hooks failed", { cause }))),
      )

      const background = (event: Event, sessionID: string, payload: Record<string, unknown>) =>
        runAll(event, sessionID, payload).pipe(Effect.catchCause((cause) => Effect.logWarning(`${event} hooks failed`, { cause }).pipe(Effect.as([]))))

      yield* ctx.event.subscribe().pipe(
        Stream.runForEach((event) => {
          const sessionID = sessionOf(event.data)
          if (sessionID === undefined) return Effect.void
          const data: Record<string, unknown> = Predicate.isObject(event.data) ? event.data : {}
          if (event.type === "session.created")
            return Effect.forkDetach(
              background("SessionStart", sessionID, { agent: data.agent }).pipe(
                Effect.flatMap((outcomes) => {
                  const added = contexts("SessionStart", outcomes)
                  if (added.length === 0) return Effect.void
                  return ctx.session.synthetic({ sessionID: sessionID as SessionSchema.ID, text: added.join("\n"), resume: false }).pipe(Effect.asVoid)
                }),
                Effect.catchCause((cause) => Effect.logWarning("SessionStart hook context failed", { cause })),
              ),
            )
          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          )
            return Effect.forkDetach(background("Stop", sessionID, { status: event.type.slice("session.execution.".length) }))
          if (event.type === "permission.asked")
            return Effect.forkDetach(
              background("Notification", sessionID, {
                kind: "permission",
                message: `Kete Code needs your permission: ${typeof data.action === "string" ? data.action : "a tool"}`,
              }),
            )
          return Effect.void
        }),
        Effect.catchCause((cause) => Effect.logWarning("hook events stopped", { cause })),
        Effect.forkScoped({ startImmediately: true }),
      )

      // Questions from the agent (forms) other than this plugin's own trust question.
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "form.created"),
        Stream.runForEach((event) => {
          const form = Predicate.isObject(event.data) && Predicate.isObject(event.data.form) ? event.data.form : undefined
          const sessionID = typeof form?.sessionID === "string" ? form.sessionID : undefined
          const kind = Predicate.isObject(form?.metadata) ? form.metadata.kind : undefined
          if (!sessionID || kind === TRUST_FORM_KIND) return Effect.void
          return Effect.forkDetach(
            background("Notification", sessionID, {
              kind: "question",
              message: `Kete Code has a question: ${typeof form?.title === "string" ? form.title : "input needed"}`,
            }),
          )
        }),
        Effect.catchCause((cause) => Effect.logWarning("hook form events stopped", { cause })),
        Effect.forkScoped({ startImmediately: true }),
      )
    }),
  }
}

export const Plugin = make()
