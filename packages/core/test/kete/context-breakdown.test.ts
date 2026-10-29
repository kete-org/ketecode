// The `kete.context` breakdown (kete/context-breakdown.ts): every part of a session's request is sized
// from the same sources the runner uses, tokens come from one estimate, hidden MCP tools are counted
// when `execute` is denied, a session of another folder is refused, and nothing but sizes and names
// leaves the service.
import { describe, expect, test } from "bun:test"
import { LLMClient, LanguageModel, ToolDefinition } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { CHARACTERS_PER_TOKEN, CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { KeteAutoMemory } from "@opencode/core/kete/auto-memory"
import { KeteContextBreakdown } from "@opencode/core/kete/context-breakdown"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Project } from "@opencode/core/project"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionContext } from "@opencode/core/session/context"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import type { KeteContextRpc } from "@opencode/schema/kete/context"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const source = (key: string, text: string) =>
  Instructions.make({
    key: Instructions.Key.make(key),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(text),
    render: { initial: String, changed: (_previous, current) => current },
  })

const SECRET = "SECRET-TOKEN-123"
const ENV = "environment text"
const SKILLS = "skill guidance text for the model"
const MCP = "mcp guidance text"
const FILE = { path: "/project/AGENTS.md", content: `rules ${SECRET}` }
const FILE_CHARACTERS = `Instructions from: ${FILE.path}\n${FILE.content}`.length

const catalog = {
  tools: [1, 2, 3].map((index) => ({
    type: "tool" as const,
    name: `server.tool${index}`,
    description: "An MCP tool",
    signature: `tools.server.tool${index}(): Promise<string>`,
  })),
}
const direct = [
  ToolDefinition.make({ name: "alpha", description: `Alpha ${SECRET}`, inputSchema: { type: "object" } }),
  ToolDefinition.make({ name: "beta", description: "Beta", inputSchema: { type: "object" } }),
]
const execute = ToolDefinition.make({ name: "execute", description: "Run code", inputSchema: { type: "object" } })


const language = LanguageModel.make({ id: "any", provider: "test", route: OpenAIChat.route })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(language, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})

const tools = Layer.mock(Tool.Service, {
  snapshot: (permissions) =>
    Effect.sync(() => {
      const rules = permissions ?? []
      // The registry's own rule: the last rule that matches `execute` decides.
      const denied = rules.findLast((rule) => rule.action === "execute")?.effect === "deny"
      return {
        ...(denied ? {} : { codeModeCatalog: catalog }),
        definitions: denied ? direct : [...direct, execute],
        execute: () => Effect.die(new Error("unused")),
      }
    }),
  transform: () => Effect.die(new Error("unused")),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionBuiltIns.node,
      SessionContext.node,
      PluginHooks.node,
      llmClient,
      KeteContextBreakdown.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(Layer.mock(LLMClient.Service)({})),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(
        Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(source("core/environment", ENV)) }),
      ),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, {
          project: true,
          global: true,
          list: () => Effect.succeed([FILE]),
          load: () =>
            Effect.succeed(source("core/instructions", `Instructions from: ${FILE.path}\n${FILE.content}`)),
        }),
      ),
      SkillInstructions.node.replace(
        Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(source("core/skill-guidance", SKILLS)) }),
      ),
      ReferenceInstructions.node.replace(
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      McpInstructions.node.replace(
        Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(source("core/mcp-guidance", MCP)) }),
      ),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(tools),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const setup = (input: { id: string; directory?: string; deny?: boolean; message?: boolean }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const agents = yield* Agent.Service
    const projects = yield* Project.Service
    const sessionID = SessionSchema.ID.make(input.id)
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
        if (input.deny) agent.permissions = [{ action: "execute", resource: "*", effect: "deny" }]
      }),
    )
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
        slug: input.id,
        directory: input.directory ?? "/project",
        title: input.id,
        version: "test",
        agent: Agent.ID.make("build"),
      })
      .run()
      .pipe(Effect.orDie)
    if (input.message) {
      const inboxID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID,
        item: { type: "user", payload: { text: "hello there" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID })
    }
    return sessionID
  })

const breakdown = (sessionID: string) =>
  Effect.gen(function* () {
    const service = yield* KeteContextBreakdown.Service
    return yield* service.get(sessionID)
  })

const only = (output: KeteContextRpc.Output) => {
  if (output.type !== "breakdown") throw new Error(`refused: ${output.reason}`)
  return output
}
const category = (output: KeteContextRpc.Breakdown, id: KeteContextRpc.CategoryID) =>
  output.categories.find((value) => value.id === id)

describe("sizes", () => {
  it.effect("sizes every category from its own source (AC1)", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_all", message: true })
      const result = only(yield* breakdown(id))
      expect(result.categories.map((value) => value.id)).toEqual([
        "system",
        "tools",
        "codemode",
        "mcp",
        "memory",
        "skills",
        "messages",
      ])
      for (const value of result.categories) expect(value.characters).toBeGreaterThan(0)

      const toolSize = (definition: ToolDefinition) =>
        JSON.stringify({
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
        }).length
      expect(category(result, "tools")?.items.map((value) => [value.name, value.characters])).toEqual(
        [...direct]
          .sort((a, b) => toolSize(b) - toolSize(a))
          .map((definition) => [definition.name, toolSize(definition)]),
      )
      const catalogText = CodeModeInstructions.render(CodeModeCatalog.summarize(catalog)).length
      const codemode = category(result, "codemode")
      expect(codemode?.characters).toBe(catalogText + toolSize(execute))
      expect(codemode?.items.find((value) => value.name.startsWith("tool catalog (3 tools"))?.characters).toBe(catalogText)
      expect(category(result, "mcp")?.characters).toBe(MCP.length)
      expect(category(result, "skills")?.characters).toBe(SKILLS.length)
      expect(category(result, "memory")?.items).toEqual([
        { name: FILE.path, characters: FILE_CHARACTERS, tokens: Math.ceil(FILE_CHARACTERS / CHARACTERS_PER_TOKEN) },
      ])
      expect(category(result, "system")?.items.find((value) => value.name === "environment")?.characters).toBe(ENV.length)
      expect(category(result, "system")?.items.find((value) => value.name === "system prompt")?.characters).toBe(
        SessionSystemPrompt.make([...direct, execute].map((definition) => definition.name)).length,
      )
      expect(category(result, "messages")?.items[0]?.name).toBe("1 message")
    }),
  { timeout: 15_000 })

  it.effect("every token count is the one estimate of its characters (AC2)", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_tokens", message: true })
      const result = only(yield* breakdown(id))
      for (const value of result.categories) {
        expect(value.tokens).toBe(Math.ceil(value.characters / CHARACTERS_PER_TOKEN))
        for (const entry of value.items) expect(entry.tokens).toBe(Math.ceil(entry.characters / CHARACTERS_PER_TOKEN))
      }
      expect(result.estimated).toBe(true)
    }),
  { timeout: 15_000 })

  it.effect("the provider's count is absent, not zero, without an assistant step with usage (AC3)", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_noprovider", message: true })
      const result = only(yield* breakdown(id))
      expect("provider" in result).toBe(false)
    }),
  { timeout: 15_000 })

  it.effect("text other plugins added at the last request is reported, with auto memory named", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_observed" })
      const service = yield* KeteContextBreakdown.Service
      yield* service.observe(id, [{ text: `${KeteAutoMemory.HEADER} notes` }, { text: "x".repeat(10_000) }])
      const result = only(yield* service.get(id))
      expect(category(result, "memory")?.items.some((value) => value.name === "auto memory (last request)")).toBe(true)
      expect(category(result, "other")?.items[0]?.name).toBe("added by plugins at the last request")
    }),
  { timeout: 15_000 })
})

describe("hidden MCP tools", () => {
  it.effect("a denied `execute` reports how many MCP tools it keeps out (AC4)", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_denied", deny: true })
      const result = only(yield* breakdown(id))
      expect(result.hiddenMcp?.count).toBe(3)
      expect(result.hiddenMcp?.reason).toContain("`execute`")
    }),
  { timeout: 15_000 })

  it.effect("an allowed `execute` reports none", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_allowed" })
      expect("hiddenMcp" in only(yield* breakdown(id))).toBe(false)
    }),
  { timeout: 15_000 })
})

describe("scope and secrets", () => {
  it.effect("a session of another folder is refused (AC6)", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_other", directory: "/elsewhere" })
      expect((yield* breakdown(id)).type).toBe("refused")
    }),
  { timeout: 15_000 })

  it.effect("a missing session is refused", () =>
    Effect.gen(function* () {
      expect((yield* breakdown("ses_ctx_missing")).type).toBe("refused")
    }),
  { timeout: 15_000 })

  it.effect("the answer holds names and sizes only: no file contents, headers or env (AC8)", () =>
    Effect.gen(function* () {
      const id = yield* setup({ id: "ses_ctx_secret", message: true })
      const json = JSON.stringify(yield* breakdown(id))
      expect(json).not.toContain(SECRET)
      expect(json).not.toContain('"headers"')
      expect(json).not.toContain('"env"')
    }),
  { timeout: 15_000 })
})

describe("usage", () => {
  // Only the fields `usage` reads.
  const assistant = (input: number) =>
    ({
      type: "assistant",
      tokens: { input, output: 10, reasoning: 5, cache: { read: 1, write: 2 } },
    }) as unknown as SessionMessage.Info
  const compaction = { type: "compaction", status: "completed" } as unknown as SessionMessage.Info

  test("sums the latest assistant step and leaves out a window it can't compute", () => {
    expect(KeteContextBreakdown.usage([assistant(100)], 1000)).toEqual({ tokens: 118, contextLimit: 1000, free: 882 })
    expect(KeteContextBreakdown.usage([assistant(100)], undefined)).toEqual({ tokens: 118 })
    expect(KeteContextBreakdown.usage([], 1000)).toBeUndefined()
  })

  test("ignores steps before the last completed compaction (AC5)", () => {
    expect(KeteContextBreakdown.usage([assistant(100), compaction], 1000)).toBeUndefined()
    expect(KeteContextBreakdown.usage([assistant(100), compaction, assistant(7)], 1000)?.tokens).toBe(25)
  })
})
