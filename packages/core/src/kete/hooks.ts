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
// Sandbox. Every hook runs in the OS sandbox (kete/sandbox.ts, the same profile as the agent's shell
// commands: the workspace and caches writable, credentials unreadable), without network unless the
// hook sets `network: true`. Only a hook in the global config may opt out (`sandbox: false`, a
// sandbox escape), and never against a policy denying `sandbox_off`. Without an active sandbox
// (turned off, unavailable, Windows) user hooks run unsandboxed (unless a policy forbids it) and
// project hooks run only when the global config sets `kete.hooks.unsandboxed` (hooks/settings.ts
// `placement`).
//
// Trust. A repository's own configuration is written by whoever wrote the repository, so its hooks
// are a way to run code on this machine. Hooks from the global config (`~/.config/kete/`) run
// directly; project hooks run only once the user trusts them: the first time they would run in a
// session, a form lists every project hook command (JSON-escaped), its network setting and the
// repository files it names, and asks. Trust is remembered per repository and fingerprint
// (settings.ts: the hooks and the referenced files' contents) and asked again whenever either
// changes; a "no" lasts until the runtime restarts. Commands with control or bidi characters are
// refused outright. Stop and Notification never ask; unattended runs never ask: project hooks run
// only when already trusted.
//
// - A policy denying `hooks:<event>` (`{"action":"permission","resource":"hooks:*","effect":"deny"}`,
//   from the organization or the global config — not a project's) turns hooks off.
// - Never in job mode (cloud, self-hosted and review jobs); its server doesn't load project config
//   either.
// - Kete's own credentials are removed from the environment.
// - A PreToolUse hook that fails, times out, can't start, isn't allowed to run, or would get a
//   truncated input blocks the call (fail closed), with a reason naming the hook. Failures of other
//   events are logged, never fatal. At most `MAX_BACKGROUND` Stop/Notification hooks run at once.

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
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KeteHooksRun } from "./hooks/run.js"
import { KeteHooksSettings } from "./hooks/settings.js"
import { KeteHooksTrust } from "./hooks/trust.js"
import { KeteSandbox } from "./sandbox.js"
import { KeteSandboxActions } from "./sandbox/actions.js"
import { KeteSandboxResolve } from "./sandbox/resolve.js"
import { KeteBubblewrap } from "./sandbox/bubblewrap.js"
import { KeteSeatbelt } from "./sandbox/seatbelt.js"
import { Shell } from "../shell.js"
import { KeteToolEnv } from "./tool-env.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

type Event = KeteHooksSettings.Event
type Entry = KeteHooksSettings.Entry

/** Characters of a tool's output (PostToolUse) or a prompt put in a hook's payload. */
export const MAX_PAYLOAD_TEXT = 32 * 1024
/** Bytes of a tool's input a PreToolUse hook gets; a larger input blocks the call. */
export const MAX_TOOL_INPUT = 4 * 1024 * 1024
/** Stop and Notification hooks running at once; more are skipped (logged). */
export const MAX_BACKGROUND = 8

/** Events that may ask the user to trust project hooks. */
const asking: ReadonlySet<Event> = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart"])

export const TRUST_FORM_KIND = "kete.hooks.trust"

/** The trust form's question (exported for tests). Commands are JSON-escaped so nothing is hidden. */
export function trustDescription(
  repository: string,
  entries: ReadonlyArray<Entry>,
  files: ReadonlyArray<KeteHooksSettings.Referenced> = [],
) {
  const lines = entries
    .filter((entry) => entry.source === "project")
    .map(
      (entry) =>
        `- ${entry.event}${entry.match ? ` (${JSON.stringify(entry.match)})` : ""}${entry.network ? " [network]" : ""}: ${JSON.stringify(entry.command)}`,
    )
  const referenced = files.length
    ? `\n\nFiles in the repository they name (their current contents are part of what you trust):\n${files.map((file) => `- ${JSON.stringify(file.path)} (sha256 ${file.sha256.slice(0, 12)})`).join("\n")}`
    : ""
  return `This repository's configuration (${JSON.stringify(repository)}) runs these commands during sessions — in the OS sandbox, with network only where marked, unless your global config lets project hooks run without it:\n\n${lines.join("\n")}${referenced}\n\nRun them? You'll be asked again if they or the files they name change. That is best effort: files reached any other way (a script's own scripts, npm run targets, paths in variables) aren't tracked — see docs/hooks.md.`
}

/** Escapes hook output placed in the `<hook>` pseudo-markup. */
export function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** A PreToolUse hook's view of the tool input: in full, unless larger than MAX_TOOL_INPUT. */
export function toolInput(input: unknown): { readonly value: unknown; readonly truncated: boolean } {
  let text: string
  try {
    text = JSON.stringify(input) ?? "null"
  } catch {
    return { value: null, truncated: true }
  }
  if (Buffer.byteLength(text) <= MAX_TOOL_INPUT) return { value: input, truncated: false }
  return { value: null, truncated: true }
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

function postResult(tool: string, input: unknown, status: "completed" | "error", text: string) {
  const truncated = text.length > MAX_PAYLOAD_TEXT
  const value = truncated ? text.slice(0, MAX_PAYLOAD_TEXT) : text
  return {
    tool,
    tool_input: bounded(input),
    tool_result: { status, ...(status === "completed" ? { output: value } : { error: value }), ...(truncated ? { truncated: true } : {}) },
  }
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
  readonly ask?: (input: {
    sessionID: string
    repository: string
    entries: ReadonlyArray<Entry>
    files: ReadonlyArray<KeteHooksSettings.Referenced>
  }) => Effect.Effect<boolean>
  /** Whether the session belongs to an unattended run; default: KeteUnattendedPolicy. */
  readonly unattended?: (sessionID: string) => Effect.Effect<boolean>
  /** Overrides the OS sandbox's availability (tests). */
  readonly availability?: () => Promise<{ available: true; mechanism: "seatbelt" | "bubblewrap"; executable: string } | { available: false; reason: string }>
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
      const permission = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
      const trust = KeteHooksTrust.make(global.state)
      const cwd = location.directory
      const repository = location.project.directory ?? location.directory
      const repositoryKey = yield* Effect.promise(() => fs.realpath(repository).catch(() => path.resolve(repository)))
      // Project hooks lose every credential-looking variable, as commands in an unattended run do;
      // the user's own hooks keep everything but Kete's credentials.
      const hookEnv = (event: Event, source: Entry["source"]): Record<string, string> => {
        const result: Record<string, string> = {}
        for (const [name, value] of Object.entries(KeteToolEnv.filter(env, { unattended: source === "project" })))
          if (value !== undefined) result[name] = value
        result.KETE_HOOK_EVENT = event
        result.KETE_PROJECT_DIR = cwd
        return result
      }

      const ask =
        deps.ask ??
        ((input: { sessionID: string; repository: string; entries: ReadonlyArray<Entry>; files: ReadonlyArray<KeteHooksSettings.Referenced> }) =>
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
                    description: trustDescription(input.repository, input.entries, input.files),
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

      const userDocument = (file: string | undefined) => file !== undefined && KeteHooksSettings.inside(file, global.config)
      // Policies from the global config and the organization only: a repository can't switch the
      // user's own hooks off, or loosen anything.
      const policies = Effect.fnUntraced(function* (entries: ReadonlyArray<ConfigEntry>) {
        for (const entry of entries)
          if (
            entry.type === "document" &&
            !userDocument(entry.path) &&
            (entry.info.experimental?.policies ?? []).some((policy) => policy.resource.startsWith("hooks:"))
          )
            yield* warnOnce(`project policy ${entry.path}`, "ignored hooks policy statements in project configuration", { file: entry.path })
        return [
          ...entries.flatMap((entry) =>
            entry.type === "document" && userDocument(entry.path) ? (entry.info.experimental?.policies ?? []) : [],
          ),
          ...managed.current().statements,
        ]
      })
      const availability = deps.availability ?? (() => Effect.runPromise(KeteSandbox.availability))

      const offAllowed = (sessionID: string, resource: string, reason: "disabled" | "unavailable") =>
        permission
          ? permission
              .assert({
                action: KeteSandboxActions.off,
                resources: [resource],
                save: [],
                metadata: { command: resource, reason, kind: "hook" },
                sessionID: sessionID as SessionSchema.ID,
              })
              .pipe(
                Effect.as(true),
                Effect.catchCause(() => Effect.succeed(false)),
              )
          : Effect.succeed(true)

      /** Where each hook runs, and the sandbox wrapper for those that run sandboxed. */
      const place = Effect.fnUntraced(function* (entries: ReadonlyArray<ConfigEntry>, entry: Entry, sessionID: string) {
        const settings = KeteSandbox.settingsFrom(entries, global.config, env)
        const available = yield* Effect.promise(() => availability())
        const documents = entries.flatMap((item) => (item.type === "document" ? [{ path: item.path, hooks: item.info.kete?.hooks }] : []))
        if (entry.source === "project" && entry.sandbox === false)
          yield* warnOnce(`project sandbox false ${entry.command}`, "ignored sandbox: false on a project hook (global config only)", {
            command: entry.command.slice(0, 200),
          })
        const placement = KeteHooksSettings.placement(entry, {
          mode: settings.mode,
          available: available.available,
          ...(available.available ? {} : { unavailableReason: available.reason }),
          projectOptIn: KeteHooksSettings.unsandboxedOptIn(documents, global.config),
          policyDeniesSandboxOff: KeteHooksSettings.sandboxOffDenied(yield* policies(entries)),
        })
        if (placement.kind === "unsandboxed") {
          // Every unsandboxed run passes the `sandbox_off` permission check, like an unsandboxed shell
          // command: organization policies (synced rules `{"action":"sandbox_off",…}` and
          // `{"action":"permission","resource":"sandbox_off:*"}` statements) and agent rules can refuse it.
          // The reason makes it a check that never asks a person.
          const reason = settings.mode === "off" || available.available ? "disabled" : "unavailable"
          const allowed = yield* offAllowed(sessionID, `hook: ${entry.command}`, reason)
          if (!allowed)
            return {
              placement: { kind: "refused", reason: "running it outside the OS sandbox is denied by policy (sandbox_off)" } as KeteHooksSettings.Placement,
              sandbox: undefined,
            }
        }
        if (placement.kind !== "sandboxed" || !available.available) return { placement, sandbox: undefined }
        const network = placement.network
        const sandbox: KeteHooksRun.Sandbox = async (input) => {
          const resolved = await KeteSandboxResolve.resolve(
            {
              platform: available.mechanism === "seatbelt" ? "darwin" : "linux",
              home: global.home,
              workspace: repositoryKey,
              directory: cwd,
              kete: global,
              shellOutput: path.join(global.data, Shell.DIRECTORY),
              settings,
              network,
              privateTmp: input.tmp,
              env,
            },
            KeteSandboxResolve.shared,
          )
          const wrapped =
            available.mechanism === "seatbelt"
              ? KeteSeatbelt.command(resolved.policy, input.file, input.args)
              : KeteBubblewrap.command(available.executable, resolved.policy, cwd, input.file, input.args)
          const sandboxEnv: Record<string, string> = {}
          for (const [name, value] of Object.entries(KeteSandbox.environment(input.env, input.tmp, network)))
            if (value !== undefined) sandboxEnv[name] = value
          return { ...wrapped, env: sandboxEnv, release: resolved.release }
        }
        return { placement, sandbox }
      })

      /** The hooks to run for an event in a session (user first, then trusted project hooks). */
      const select = Effect.fnUntraced(function* (event: Event, sessionID: string, tool?: string) {
        const entries = yield* config.entries()
        if (KeteHooksSettings.disabledByPolicy(yield* policies(entries), event)) return { entries, selected: [] as Entry[] }
        const all = KeteHooksSettings.collect(
          entries.flatMap((entry) => (entry.type === "document" ? [{ path: entry.path, hooks: entry.info.kete?.hooks }] : [])),
          global.config,
        )
        const relevant = all.filter((entry) => entry.event === event && KeteHooksSettings.matches(entry, tool))
        const user = relevant.filter((entry) => entry.source === "user")
        const result = (selected: Entry[]) => ({ entries, selected })
        // Project hooks that couldn't run anyway (no active sandbox, no opt-in) are skipped before
        // anyone is asked to trust them.
        const project: Entry[] = []
        for (const entry of relevant.filter((item) => item.source === "project")) {
          const where = yield* place(entries, entry, sessionID)
          if (where.placement.kind !== "refused") project.push(entry)
          else
            yield* warnOnce(`project refused ${where.placement.reason}`, "project hooks skipped", {
              repository: repositoryKey,
              reason: where.placement.reason,
            })
        }
        if (project.length === 0) return result(user)
        const allProject = all.filter((entry) => entry.source === "project")
        const unsafe = allProject.map((entry) => KeteHooksSettings.unsafeCommand(entry.command)).find((reason) => reason !== undefined)
        if (unsafe) {
          yield* warnOnce(`unsafe ${repositoryKey}`, `project hooks refused: a command can't be shown faithfully (${unsafe})`, {
            repository: repositoryKey,
          })
          return result(user)
        }
        const files = (yield* Effect.promise(() =>
          Promise.all(allProject.map((entry) => KeteHooksSettings.referencedFiles(entry.command, repositoryKey, cwd))),
        )).flat()
        const fingerprint = KeteHooksSettings.fingerprint(all, files)
        if (yield* Effect.promise(() => trust.trusted(repositoryKey, fingerprint).catch(() => false))) return result([...user, ...project])
        if (declined.has(fingerprint) || !asking.has(event)) return result(user)
        if (yield* unattended(sessionID)) {
          yield* warnOnce(`unattended ${fingerprint}`, "project hooks skipped in an unattended run: they aren't trusted", {
            repository: repositoryKey,
          })
          return result(user)
        }
        let question = pending.get(fingerprint)
        if (!question) {
          question = Effect.runPromise(ask({ sessionID, repository: repositoryKey, entries: all, files })).then(async (yes) => {
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
        return result(yes ? [...user, ...project] : user)
      })

      const runAll = Effect.fnUntraced(function* (event: Event, sessionID: string, payload: Record<string, unknown>, tool?: string) {
        const { entries, selected } = yield* select(event, sessionID, tool)
        const outcomes: Array<{ entry: Entry; outcome: KeteHooksRun.Outcome }> = []
        for (const entry of selected) {
          const where = yield* place(entries, entry, sessionID)
          const outcome: KeteHooksRun.Outcome =
            where.placement.kind === "refused"
              ? { kind: "error", message: `not run: ${where.placement.reason}` }
              : yield* KeteHooksRun.run({
                  spawner: environment.spawner,
                  command: entry.command,
                  cwd,
                  env: hookEnv(event, entry.source),
                  payload: { event, session_id: sessionID, cwd, ...payload },
                  timeout: entry.timeout,
                  ...(where.sandbox ? { sandbox: where.sandbox } : {}),
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
        }).map((text) => `<hook event="${event}">\n${escape(text)}\n</hook>`)

      const short = (command: string) => (command.length > 80 ? command.slice(0, 77) + "..." : command)

      // PreToolUse: block on deny, exit 2, or a hook that failed (fail closed).
      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.gen(function* () {
          const input = toolInput(event.input)
          const outcomes = yield* runAll(
            "PreToolUse",
            event.sessionID,
            { tool: event.tool, tool_input: input.value, ...(input.truncated ? { tool_input_truncated: true } : {}) },
            event.tool,
          )
          if (input.truncated && outcomes.length > 0)
            return yield* new Tool.Error({
              message: `Blocked: the tool input is larger than PreToolUse hooks receive (${MAX_TOOL_INPUT} bytes), so they couldn't check it.`,
            })
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
              ? postResult(event.tool, event.input, "completed", resultText(event.result.content))
              : postResult(event.tool, event.input, "error", event.error.message)
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

      let inFlight = 0
      const background = (event: Event, sessionID: string, payload: Record<string, unknown>) =>
        Effect.suspend(() => {
          if (inFlight >= MAX_BACKGROUND)
            return Effect.logWarning(`${event} hook skipped: ${MAX_BACKGROUND} hooks already running`).pipe(
              Effect.as([] as Array<{ entry: Entry; outcome: KeteHooksRun.Outcome }>),
            )
          inFlight++
          return runAll(event, sessionID, payload).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`${event} hooks failed`, { cause }).pipe(Effect.as([]))),
            Effect.ensuring(Effect.sync(() => inFlight--)),
          )
        })

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
