// AC3/AC4: KeteJobPlugin disables every MCP server and removes every non-`kete` model when job mode
// (KETE_JOB_MODE) is on, and does nothing when it's off.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { KeteJobPlugin } from "@opencode/core/kete/job-plugin"
import { registries } from "./sync-fixture"
import { host } from "../plugin/host"

type ModelEditor = Parameters<Parameters<Plugin.Context["model"]["transform"]>[0]>[0]
type ModelRecord = { providerID: string; id: string; [key: string]: unknown }

function modelRegistry(initial: ModelRecord[]) {
  const key = (providerID: string, id: string) => `${providerID}/${id}`
  const models = new Map<string, ModelRecord>()
  const transforms: Array<(editor: ModelEditor) => void> = []
  const editor = {
    list: (providerID?: string) => [...models.values()].filter((model) => providerID === undefined || model.providerID === providerID),
    get: (providerID: string, id: string) => models.get(key(providerID, id)),
    update: (providerID: string, id: string, update: (model: ModelRecord) => void) => {
      const current = models.get(key(providerID, id))
      if (current) update(current)
    },
    remove: (providerID: string, id: string) => void models.delete(key(providerID, id)),
    default: { get: () => undefined, set: () => {} },
    provider: { list: () => [], get: () => undefined },
  } as unknown as ModelEditor
  const rebuild = () => {
    models.clear()
    for (const model of initial) models.set(key(model.providerID, model.id), { ...model })
    for (const transform of transforms) transform(editor)
  }
  const registration = { dispose: Effect.void }
  return {
    models,
    host: {
      list: () => Effect.die("unused model.list"),
      default: () => Effect.die("unused model.default"),
      transform: (callback: (editor: ModelEditor) => void) =>
        Effect.sync(() => {
          transforms.push(callback)
          rebuild()
          return registration
        }),
      reload: () => Effect.sync(rebuild),
    } as unknown as Plugin.Context["model"],
  }
}

const setup = () => {
  const mcp = registries({ servers: { synced: { type: "local", command: ["synced"] } as never } })
  const models = modelRegistry([
    { providerID: "kete", id: "sonnet" },
    { providerID: "anthropic", id: "sonnet-direct" },
    { providerID: "openai", id: "gpt" },
  ])
  // Populate before the plugin runs, so "job mode off" (which never calls transform) still starts
  // from the configured servers/models, the way a client would after a real reload.
  Effect.runSync(mcp.host.mcp.reload())
  Effect.runSync(models.host.reload())
  return { mcp, models, ctx: host({ mcp: mcp.host.mcp, model: models.host }) }
}

const previous = process.env.OPENCODE_JOB_MODE
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_JOB_MODE
  else process.env.OPENCODE_JOB_MODE = previous
})

describe("KeteJobPlugin.Plugin", () => {
  test("job mode on: disables every MCP server and removes every non-kete model", async () => {
    process.env.OPENCODE_JOB_MODE = "1"
    const { mcp, models, ctx } = setup()
    await Effect.runPromise(Effect.scoped(KeteJobPlugin.Plugin.effect(ctx)))
    expect([...mcp.servers.values()].every((server) => server.disabled === true)).toBe(true)
    expect([...models.models.keys()]).toEqual(["kete/sonnet"])
  })

  test("job mode off: nothing changes", async () => {
    delete process.env.OPENCODE_JOB_MODE
    const { mcp, models, ctx } = setup()
    await Effect.runPromise(Effect.scoped(KeteJobPlugin.Plugin.effect(ctx)))
    expect([...mcp.servers.values()].some((server) => server.disabled === true)).toBe(false)
    expect([...models.models.keys()].sort()).toEqual(["anthropic/sonnet-direct", "kete/sonnet", "openai/gpt"])
  })

  test("an invalid KETE_JOB_MODE fails closed like \"1\"", async () => {
    process.env.OPENCODE_JOB_MODE = "maybe"
    const { mcp, ctx } = setup()
    await Effect.runPromise(Effect.scoped(KeteJobPlugin.Plugin.effect(ctx)))
    expect([...mcp.servers.values()].every((server) => server.disabled === true)).toBe(true)
  })
})
