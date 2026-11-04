// Output styles (parity B7, docs/output-styles.md): `kete.outputStyle` picks how the agent writes its
// replies. The style's text goes in the system prompt, after the agent's prompt, of a session's requests
// (the `context` hook); subagents, summaries (compaction), titles and job mode are left as they are.
// Built-in styles live here; a custom style is a Markdown file in the global config's
// `output-styles/` folder (a repository can name a style but can't supply one).

export * as KeteOutputStyles from "./output-styles.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Effect, Option } from "effect"
import path from "path"
import { Config } from "../config.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"

export const id = "kete.output-styles"

/** Style names: lowercase letters, digits, `-` and `_`, so a name can't reach outside the folder. */
export const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Characters (code points) of a custom style file used; the rest is cut. */
export const MAX_CUSTOM = 16 * 1024

export const BUILT_IN: Readonly<Record<string, string>> = {
  explanatory: [
    "Output style: explanatory.",
    "While you work, explain the reasoning behind your choices so the user learns the codebase and the trade-offs:",
    "- Before a non-obvious change, say in a sentence or two why this approach and not the alternatives.",
    "- Point out patterns, conventions and pitfalls you notice in the code you read, briefly and only where they matter to the task.",
    "- Keep explanations short and separate from the work itself; never let them replace doing the task.",
  ].join("\n"),
  learning: [
    "Output style: learning.",
    "Help the user learn by doing part of the work themselves:",
    "- Do the routine parts yourself, but for small, meaningful pieces (a function body, a condition, a test case) leave a clearly marked TODO for the user and explain what it should do and why.",
    "- Ask the user to write at most one or two such pieces per task, and wait for them before building on that code.",
    "- Explain the concepts behind your changes as you go, in plain language.",
    "- When the user asks you to just do something, do it fully.",
  ].join("\n"),
  reviewer: [
    "Output style: reviewer.",
    "Act as a careful code reviewer:",
    "- Lead with problems: bugs, security issues, missing error handling, missing tests, risky changes. Rank them by severity and give the file and line.",
    "- Back each finding with the evidence you checked; say plainly when you're unsure.",
    "- Keep praise and summaries short. Suggest the smallest fix for each problem.",
    "- Don't change code unless the user asks you to.",
  ].join("\n"),
}

export const NAMES = ["default", ...Object.keys(BUILT_IN)] as const

export interface Deps {
  /** The style name from the loaded config. */
  readonly style?: () => Effect.Effect<string | undefined>
  /** Whether the session is a subagent's. */
  readonly subagent?: (sessionID: string) => Effect.Effect<boolean>
  readonly env?: Record<string, string | undefined>
}

/** The text a style adds, or why it adds nothing. */
export const resolve = Effect.fnUntraced(function* (
  name: string | undefined,
  read: (file: string) => Effect.Effect<string | undefined, Error>,
  folder: string,
) {
  if (name === undefined || name === "default") return { kind: "none" as const }
  if (!NAME.test(name)) return { kind: "invalid" as const }
  if (Object.hasOwn(BUILT_IN, name)) return { kind: "text" as const, text: BUILT_IN[name]! }
  const text = (yield* read(path.join(folder, `${name}.md`)).pipe(Effect.orElseSucceed(() => undefined)))?.trim()
  if (!text) return { kind: "missing" as const }
  return { kind: "text" as const, text: `Output style: ${name}.\n${Array.from(text).slice(0, MAX_CUSTOM).join("")}` }
})

export function make(deps: Deps = {}) {
  return define({
    id,
    effect: Effect.fn("KeteOutputStyles.Plugin")(function* (ctx) {
      if (KeteJobMode.enabled(deps.env ?? process.env)) return
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const config = yield* Config.Service
      const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      const folder = path.join(global.config, "output-styles")
      const style =
        deps.style ?? (() => config.entries().pipe(Effect.map((entries) => Config.latest(entries, "kete")?.outputStyle)))
      const subagent =
        deps.subagent ??
        ((sessionID: string) =>
          sessions
            ? sessions.get(sessionID as SessionSchema.ID).pipe(
                Effect.map((info) => info.parentID !== undefined),
                Effect.orElseSucceed(() => false),
              )
            : Effect.succeed(false))
      const warned = new Set<string>()

      yield* ctx.session.hook("context", (event) =>
        Effect.gen(function* () {
          const name = yield* style()
          if (name === undefined || name === "default") return
          if (yield* subagent(event.sessionID)) return
          const result = yield* resolve(name, (file) => fs.readFileStringSafe(file), folder)
          if (result.kind === "text") event.system.push({ type: "text", text: result.text })
          else if (result.kind !== "none" && !warned.has(name)) {
            warned.add(name)
            yield* Effect.logWarning(
              result.kind === "invalid"
                ? "output style name invalid (lowercase letters, digits, - and _); using the default"
                : "output style not found; using the default",
              { style: name.slice(0, 80), folder },
            )
          }
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("output style failed", { cause }))),
      )
    }),
  })
}

export const Plugin = make()
