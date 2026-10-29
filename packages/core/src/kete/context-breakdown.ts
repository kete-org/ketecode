// The `kete.context` RPC (schema/src/kete/context.ts) behind `/context`: how much of a session's context
// window each part takes. Read-only, and it sends nothing to a model: it re-assembles the request the way
// `SessionGenerate` does (`select` → `SessionHistory.preview` → `baseTranscript`), never through
// `SessionModelRequest.primary/generate`, whose `context` hooks have side effects (warming starts a loop).
//
// - Sizes are estimates (characters / 4, the Code Mode catalog's own ratio). Only `provider.tokens` is the
//   provider's count, from the last assistant step after the last completed compaction.
// - Each instruction source is sized on its own (`Instructions.List` keeps the keys). Text that other
//   plugins add to the system prompt per request (auto memory, guidance) isn't in a source: a `context`
//   hook registered last records its size, so it is reported "at the last request".
// - The location check comes first, like `SessionContext.select`'s; a session of another folder or
//   workspace is refused rather than interrupting.
// - Names and sizes only: no file contents, config, headers or environment leave the runtime.

export * as KeteContextBreakdown from "./context-breakdown.js"

import { Context, Effect, Layer, Schema } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { KeteContextRpc } from "@opencode/schema/kete/context"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { CodeModeCatalog, CHARACTERS_PER_TOKEN } from "../codemode/catalog.js"
import { Database } from "../database/database.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { SessionContext } from "../session/context.js"
import { SessionHistory } from "../session/history.js"
import type { SessionMessage } from "../session/message.js"
import { SessionModelRequest } from "../session/model-request.js"
import { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import { Tool } from "../tool.js"
import { KeteAutoMemory } from "./auto-memory.js"

/** The most sessions whose last request is remembered. */
export const MAX_SESSIONS = 100

/** The one place tokens are computed. */
export const estimate = (characters: number) => Math.ceil(characters / CHARACTERS_PER_TOKEN)

const clip = (text: string) => (text.length > KeteContextRpc.MAX_NAME ? `${text.slice(0, KeteContextRpc.MAX_NAME - 1)}…` : text)

const item = (name: string, characters: number): KeteContextRpc.Item => ({
  name: clip(name),
  characters,
  tokens: estimate(characters),
})

const LABELS: Record<KeteContextRpc.CategoryID, string> = {
  system: "System prompt",
  tools: "Tools",
  codemode: "Code Mode",
  mcp: "MCP guidance",
  memory: "Memory and instruction files",
  skills: "Skills",
  messages: "Messages",
  other: "Other",
}

/** Which category an instruction source belongs to; the ones named here are the sources core registers. */
function categoryOf(key: string): KeteContextRpc.CategoryID {
  if (key === "core/codemode") return "codemode"
  if (key === "core/mcp-guidance") return "mcp"
  if (key === "core/skill-guidance") return "skills"
  if (key === "core/instructions" || key.startsWith("api/")) return "memory"
  if (key === "core/date" || key === "core/environment") return "system"
  return "other"
}

const isNonValue = (value: unknown): value is Instructions.Unavailable | Instructions.Removed =>
  value === Instructions.unavailable || value === Instructions.removed

const decodeSummary = Schema.decodeUnknownOption(CodeModeCatalog.Summary)

/** What the last request added beyond the base prompt, per session. */
interface Observed {
  readonly total: number
  readonly auto: number
}

export interface Interface {
  readonly get: (sessionID: string) => Effect.Effect<KeteContextRpc.Output>
  /** Records the size of a request's system parts (the `context` hook calls it). */
  readonly observe: (sessionID: string, system: ReadonlyArray<{ readonly text: string }>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@kete/ContextBreakdown") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const context = yield* SessionContext.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const location = yield* Location.Service
    const registry = yield* Tool.Service
    const store = yield* SessionStore.Service
    // Insertion order is age; at most MAX_SESSIONS entries.
    const observed = new Map<string, Observed>()

    const observe: Interface["observe"] = (sessionID, system) =>
      Effect.sync(() => {
        const total = system.reduce((sum, part) => sum + part.text.length, 0)
        const auto = system.reduce((sum, part) => sum + (part.text.includes(KeteAutoMemory.HEADER) ? part.text.length : 0), 0)
        observed.delete(sessionID)
        observed.set(sessionID, { total, auto })
        for (const oldest of observed.keys()) {
          if (observed.size <= MAX_SESSIONS) break
          observed.delete(oldest)
        }
      })

    const get = Effect.fn("KeteContextBreakdown.get")(function* (sessionID: string) {
      const id = SessionSchema.ID.make(sessionID)
      const session = yield* store.get(id)
      if (!session) return refused("That session wasn't found.")
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return refused("That session belongs to another folder.")

      const selection = yield* context.select(id).pipe(Effect.catchTag("Session.AgentNotFoundError", () => Effect.succeed(undefined)))
      if (!selection) return refused("The session's agent wasn't found.")
      const model = yield* context.resolveModel(selection.session).pipe(Effect.orElseSucceed(() => undefined))
      const boundary = model?.ref ?? "latest"

      const history = yield* SessionHistory.preview(db, id, selection.instructions, boundary).pipe(
        Effect.catchTag("Instructions.InitializationBlocked", (error) =>
          Effect.logWarning("context breakdown: instructions are blocked, so messages are not sized", { sessionID, keys: error.keys }).pipe(
            Effect.as(undefined),
          ),
        ),
      )

      const categories = new Map<KeteContextRpc.CategoryID, KeteContextRpc.Item[]>()
      const add = (category: KeteContextRpc.CategoryID, value: KeteContextRpc.Item) => {
        const items = categories.get(category)
        if (items) items.push(value)
        else categories.set(category, [value])
      }

      // System prompt: the agent's own, or the default one.
      const names = selection.tools.definitions.map((tool) => tool.name)
      add("system", item("system prompt", (selection.agent.info.system ? selection.agent.info.system : SessionSystemPrompt.make(names)).length))

      // Tools: each definition as the model receives it. `execute` is Code Mode's.
      for (const tool of selection.tools.definitions) {
        const characters = JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length
        add(tool.name === "execute" ? "codemode" : "tools", item(tool.name, characters))
      }

      // Instruction sources, each sized by its own rendering. Every source's `read` returns a value
      // `select` already loaded (or the date/env text), so this connects to nothing and rebuilds nothing.
      let entries = 0
      let entryCharacters = 0
      for (const source of selection.instructions) {
        const value = yield* source.read
        if (isNonValue(value)) continue
        const text = source.initial(value)
        if (text === undefined) continue
        const category = categoryOf(source.key)
        if (source.key === "core/instructions") {
          const files = yield* discovery.list()
          if (Array.isArray(files) && files.length > 0) {
            for (const file of files) add("memory", item(file.path, `Instructions from: ${file.path}\n${file.content}`.length))
            continue
          }
        }
        if (source.key.startsWith("api/")) {
          entries++
          entryCharacters += text.length
          continue
        }
        if (source.key === "core/codemode") {
          const summary = decodeSummary(value)
          const detail = summary._tag === "Some" ? ` (${summary.value.total} tools, ${summary.value.shown} listed)` : ""
          add(category, item(`tool catalog${detail}`, text.length))
          continue
        }
        add(category, item(source.key.replace(/^core\//, ""), text.length))
      }
      if (entries > 0) add("memory", item(`session instruction entries (${entries})`, entryCharacters))

      // Plugin additions seen at the last request: auto memory is named, the rest is "other".
      const last = observed.get(sessionID)
      if (last) {
        if (last.auto > 0) add("memory", item("auto memory (last request)", last.auto))
        const base = categories.get("system")?.[0]?.characters ?? 0
        const extra = last.total - last.auto - base - (history?.initial.length ?? 0)
        if (extra > 0) add("other", item("added by plugins at the last request", extra))
      }

      // Messages from the latest compaction on.
      const messages = history?.messages ?? []
      if (history) {
        const sent = model
          ? SessionModelRequest.baseTranscript({
              agent: selection.agent.info,
              model,
              tools: selection.tools,
              initial: "",
              messages,
            }).messages
          : messages
        const characters = sent.reduce((sum, message) => sum + JSON.stringify(message).length, 0)
        if (characters > 0) add("messages", item(`${sent.length} ${sent.length === 1 ? "message" : "messages"}`, characters))
      }

      // MCP tools that a denied `execute` (Code Mode) keeps out of the request.
      let hiddenMcp: KeteContextRpc.Breakdown["hiddenMcp"]
      if (selection.tools.codeModeCatalog === undefined) {
        const permissions = Permission.merge(selection.agent.info.permissions, selection.session.permissions ?? [])
        // Allow `execute` last (the last matching rule wins); every other rule still applies.
        const snapshot = yield* registry.snapshot([...permissions, { action: "execute", resource: "*", effect: "allow" }])
        const count = snapshot.codeModeCatalog ? CodeModeCatalog.summarize(snapshot.codeModeCatalog).total : 0
        if (count > 0) hiddenMcp = { count, reason: "a permission rule denies `execute` (Code Mode), so MCP tools are not sent" }
      }

      const provider = usage(messages, model?.limit.context)

      const ordered = (Object.keys(LABELS) as KeteContextRpc.CategoryID[]).flatMap((categoryID): KeteContextRpc.Category[] => {
        const items = categories.get(categoryID)
        if (!items) return []
        const characters = items.reduce((sum, value) => sum + value.characters, 0)
        return [
          {
            id: categoryID,
            label: LABELS[categoryID],
            characters,
            tokens: estimate(characters),
            items: items.toSorted((left, right) => right.characters - left.characters).slice(0, KeteContextRpc.MAX_ITEMS),
          },
        ]
      })
      return {
        type: "breakdown" as const,
        categories: ordered,
        ...(hiddenMcp ? { hiddenMcp } : {}),
        ...(provider ? { provider } : {}),
        estimated: true as const,
      }
    })

    return Service.of({ get, observe })
  }),
)

const refused = (reason: string): KeteContextRpc.Output => ({ type: "refused", reason })

/**
 * The provider's count: the latest assistant step with usage after the last completed compaction, summed
 * the way the TUI's `contextUsage` does. Absent (not zero) when there is none.
 */
export function usage(messages: ReadonlyArray<SessionMessage.Info>, limit: number | undefined) {
  const compaction = messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  const last = messages.findLast((message, index) => message.type === "assistant" && message.tokens !== undefined && index > compaction)
  if (last?.type !== "assistant" || !last.tokens) return undefined
  const { input, output, reasoning, cache } = last.tokens
  const tokens = input + output + reasoning + cache.read + cache.write
  if (tokens <= 0) return undefined
  return {
    tokens,
    ...(limit && limit > 0 ? { contextLimit: limit, free: Math.max(0, limit - tokens) } : {}),
  }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SessionContext.node, Database.node, InstructionDiscovery.node, Location.node, Tool.node, SessionStore.node],
})

export const Plugin = define({
  id: "kete.context",
  effect: Effect.fn(function* (ctx) {
    const breakdown = yield* Service

    yield* ctx.rpc.register(KeteContextRpc.Definition, { get: (input) => breakdown.get(input.sessionID) }).pipe(Effect.orDie)

    // Registered last in `post`, so it sees what every other hook added. Read-only.
    // shortcut: a deleted session's record stays until MAX_SESSIONS pushes it out; add a session.deleted cleanup if that matters.
    yield* ctx.session.hook("context", (event) => breakdown.observe(event.sessionID, event.system))
  }),
})
