import { expect } from "bun:test"
import { LLMClient, LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instructions } from "@opencode/core/instructions/index"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Location } from "@opencode/core/location"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Model } from "@opencode/core/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionContext } from "@opencode/core/session/context"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "../lib/effect"

// A Session created without a model (`kete run --agent <name>`) runs its agent's model, not the
// server default: a managed agent's gateway calls must name the agent's model (ADR 0008).

const requested: Array<Model.Ref | undefined> = []
const language = LanguageModel.make({ id: "any", provider: "test", route: OpenAIChat.route })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) =>
    Effect.sync(() => {
      requested.push(session.model)
      return SessionRunnerModel.resolved(language, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      })
    }),
})
const empty = () => Effect.succeed(Instructions.empty)

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
    ]),
    [
      llmClient.replace(Layer.mock(LLMClient.Service)({ stream: () => Stream.die(new Error("unused")) })),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(Layer.mock(InstructionBuiltIns.Service, { load: empty })),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, { project: true, global: true, load: empty }),
      ),
      SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: empty })),
      ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, { load: empty })),
      McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: empty })),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: () => Effect.succeed({ definitions: [], execute: () => Effect.die(new Error("unused")) }),
        }),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const agentModel = Model.Ref.make({ providerID: Provider.ID.make("kete"), id: Model.ID.make("glm-5-2-260617") })
const sessionModel = Model.Ref.make({ providerID: Provider.ID.make("anthropic"), id: Model.ID.make("claude-sonnet-4-5") })

/** Loads the turn context of a fresh Session on the `managed` agent and returns the model it asked for. */
const load = (input: { id: string; agent?: Model.Ref; session?: Model.Ref }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const agents = yield* Agent.Service
    const projects = yield* Project.Service
    const context = yield* SessionContext.Service
    const sessionID = SessionSchema.ID.make(input.id)
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("managed"), (agent) => {
        agent.mode = "primary"
        agent.model = input.agent
      }),
    )
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
        slug: input.id,
        directory: "/project",
        title: input.id,
        version: "test",
        agent: Agent.ID.make("managed"),
        ...(input.session ? { model: { providerID: input.session.providerID, id: input.session.id } } : {}),
      })
      .run()
      .pipe(Effect.orDie)
    requested.length = 0
    // Only the model is under test; history assembly after it needs a full Session fixture.
    yield* Effect.exit(context.load(yield* context.select(sessionID)))
    expect(requested).toHaveLength(1)
    return requested[0]
  })

it.effect("a Session without a model runs its agent's model", () =>
  Effect.gen(function* () {
    expect(yield* load({ id: "ses_agent_model", agent: agentModel })).toEqual(agentModel)
  }),
)

it.effect("the Session's own model wins over the agent's", () =>
  Effect.gen(function* () {
    expect(yield* load({ id: "ses_session_model", agent: agentModel, session: sessionModel })).toMatchObject({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    })
  }),
)

it.effect("without either, the server default applies (no model is asked for)", () =>
  Effect.gen(function* () {
    expect(yield* load({ id: "ses_no_model" })).toBeUndefined()
  }),
)
