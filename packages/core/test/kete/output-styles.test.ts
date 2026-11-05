import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { ConfigKete } from "@opencode/schema/config/kete"
import { KeteOutputStyles } from "@opencode/core/kete/output-styles"
import { Config } from "@opencode/core/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdir } from "../fixture/tmpdir"
import { host } from "../plugin/host"

async function setup(base: string, options: { style?: string; subagents?: string[]; env?: Record<string, string> } = {}) {
  const hooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
  const ctx = host({
    session: { hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(name, handler))) as any },
  })
  const layer = Layer.mergeAll(
    FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer)),
    Global.layerWith({ state: path.join(base, "state"), config: path.join(base, "config"), home: path.join(base, "home") }),
    Config.testLayer(
      options.style === undefined
        ? []
        : [{ type: "document", path: path.join(base, "kete.json"), info: { kete: { outputStyle: options.style } } } as never],
    ),
  )
  const plugin = KeteOutputStyles.make({
    env: options.env ?? {},
    subagent: (sessionID) => Effect.succeed(options.subagents?.includes(sessionID) ?? false),
  })
  await Effect.runPromise(Effect.scoped(plugin.effect(ctx)).pipe(Effect.provide(layer)))
  const context = async (sessionID = "ses_1") => {
    const event: any = { sessionID, system: [{ type: "text", text: "agent prompt" }], tools: {} }
    await Effect.runPromise(hooks.get("context")!(event))
    return (event.system as Array<{ text: string }>).map((part) => part.text)
  }
  return { hooks, context }
}

describe("KeteOutputStyles", () => {
  test("no style or the default style leaves the system prompt alone", async () => {
    await using dir = await tmpdir()
    expect(await (await setup(dir.path)).context()).toEqual(["agent prompt"])
    expect(await (await setup(dir.path, { style: "default" })).context()).toEqual(["agent prompt"])
  })

  test("a built-in style is added after the agent's prompt", async () => {
    await using dir = await tmpdir()
    const system = await (await setup(dir.path, { style: "reviewer" })).context()
    expect(system).toHaveLength(2)
    expect(system[0]).toBe("agent prompt")
    expect(system[1]).toStartWith("Output style: reviewer.\n")
    for (const name of ["explanatory", "learning"]) expect((await (await setup(dir.path, { style: name })).context())[1]).toStartWith(`Output style: ${name}.`)
  })

  test("a custom style comes from the global config's output-styles folder; a missing one adds nothing", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "config", "output-styles"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "config", "output-styles", "terse.md"), "\nAnswer in one line.\n")
    expect(await (await setup(dir.path, { style: "terse" })).context()).toEqual(["agent prompt", "Output style: terse.\nAnswer in one line."])
    expect(await (await setup(dir.path, { style: "absent" })).context()).toEqual(["agent prompt"])
  })

  test("a long custom style is cut", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "config", "output-styles"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "config", "output-styles", "long.md"), "x".repeat(KeteOutputStyles.MAX_CUSTOM + 100))
    const added = (await (await setup(dir.path, { style: "long" })).context())[1]!
    expect(added.length).toBe("Output style: long.\n".length + KeteOutputStyles.MAX_CUSTOM)
    await fs.writeFile(path.join(dir.path, "config", "output-styles", "emoji.md"), "😀".repeat(KeteOutputStyles.MAX_CUSTOM + 1))
    const emoji = (await (await setup(dir.path, { style: "emoji" })).context())[1]!
    expect(Array.from(emoji.slice("Output style: emoji.\n".length)).every((char) => char === "😀")).toBe(true)
  })

  test("subagents and job mode get no style", async () => {
    await using dir = await tmpdir()
    expect(await (await setup(dir.path, { style: "reviewer", subagents: ["ses_sub"] })).context("ses_sub")).toEqual(["agent prompt"])
    const job = await setup(dir.path, { style: "reviewer", env: { OPENCODE_JOB_MODE: "1" } })
    expect(job.hooks.has("context")).toBe(false)
  })

  test("an invalid name adds nothing and can't reach outside the folder; it doesn't discard other kete settings", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "config", "output-styles"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "secret.md"), "stolen")
    for (const bad of ["../secret", "a/b", "Reviewer", ".hidden", "__proto__"])
      expect(await (await setup(dir.path, { style: bad })).context()).toEqual(["agent prompt"])
    const decoded = Schema.decodeUnknownSync(ConfigKete.Info)({ outputStyle: "Reviewer", offline: true })
    expect(decoded).toMatchObject({ outputStyle: "Reviewer", offline: true })
  })

  test("a style named like an object property is a custom style read from its file", async () => {
    await using dir = await tmpdir()
    expect(await (await setup(dir.path, { style: "constructor" })).context()).toEqual(["agent prompt"])
    await fs.mkdir(path.join(dir.path, "config", "output-styles"), { recursive: true })
    await fs.writeFile(path.join(dir.path, "config", "output-styles", "constructor.md"), "Mine.")
    expect(await (await setup(dir.path, { style: "constructor" })).context()).toEqual(["agent prompt", "Output style: constructor.\nMine."])
  })
})
