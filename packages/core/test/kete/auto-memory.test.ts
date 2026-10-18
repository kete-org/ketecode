// Auto memory (core/src/kete/auto-memory.ts): the `memory` tool, the notes loaded into the system prompt,
// /remember and /memory, the `kete.memory.auto` switch, and no auto memory in job mode or an unattended run.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { KeteAutoMemory } from "@opencode/core/kete/auto-memory"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { Config } from "@opencode/core/config"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { tmpdir } from "../fixture/tmpdir"
import { host } from "../plugin/host"

type Tool = { name: string; execute: (input: unknown, context: unknown) => Effect.Effect<any, any> }
type Command = { name: string; execute: (input: any) => Effect.Effect<any, any> }

interface Options {
  /** `kete.memory` of each config document, in order. */
  readonly documents?: readonly Record<string, unknown>[]
  readonly projectID?: string
  readonly unattended?: boolean
  readonly env?: NodeJS.ProcessEnv
  readonly deny?: boolean
  /** Files to create under the memory folder before the plugin starts, relative to it. */
  readonly files?: Record<string, string>
}

const KEY = "sk-ant-abcdefghijklmnopqrstuvwx0123"
const context = (sessionID = "ses_1") => ({ sessionID, agent: "build", messageID: "msg_1", id: "call_1" })

/** An exit's text, error messages included (Error's message isn't enumerable, so JSON.stringify drops it). */
const describeExit = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : JSON.stringify(exit))

async function world<A>(options: Options, body: (w: Awaited<ReturnType<typeof start>>) => Promise<A>) {
  await using tmp = await tmpdir()
  const base = await fs.realpath(tmp.path)
  const state = path.join(base, "state")
  const w = await start(options, base, state)
  return await body(w)
}

async function start(options: Options, base: string, state: string) {
  const tools: Tool[] = []
  const commands: Command[] = []
  const hooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
  const asserted: { action: string; resources: readonly string[] }[] = []
  const prompts: { text: string }[] = []
  const projectID = options.projectID ?? "proj1"
  for (const [file, content] of Object.entries(options.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(state, "memory", file)), { recursive: true })
    await fs.writeFile(path.join(state, "memory", file), content)
  }
  const ctx = host({
    tool: {
      transform: (callback: any) =>
        Effect.sync(() => {
          callback({ add: (tool: Tool) => tools.push(tool) })
          return { dispose: Effect.void }
        }),
    } as any,
    command: {
      transform: (callback: any) =>
        Effect.sync(() => {
          callback({ add: (command: Command) => commands.push(command) })
          return { dispose: Effect.void }
        }),
    } as any,
    session: {
      hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(name, handler))) as any,
      prompt: ((input: { text: string }) => Effect.sync(() => void prompts.push(input))) as any,
    },
  })
  const layer = Layer.mergeAll(
    FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer)),
    Global.layerWith({ state, config: path.join(base, "config"), home: path.join(base, "home") }),
    Layer.succeed(Location.Service, { project: { id: projectID, directory: base }, directory: base } as never),
    Config.testLayer(
      (options.documents ?? [{}]).map(
        (memory, index) => ({ type: "document", path: path.join(base, `kete${index}.json`), info: { kete: { memory } } }) as never,
      ),
    ),
    Layer.succeed(InstructionDiscovery.Service, { project: true, global: true } as never),
    Layer.succeed(
      Permission.Service,
      Permission.Service.of({
        assert: (input: { action: string; resources: readonly string[] }) =>
          Effect.suspend(() => {
            asserted.push({ action: input.action, resources: input.resources })
            return options.deny ? Effect.fail(new Permission.DeclinedError() as any) : Effect.void
          }),
      } as any),
    ),
  )
  const plugin = KeteAutoMemory.make({
    env: options.env ?? {},
    unattended: () => Effect.succeed(options.unattended === true),
  })
  await Effect.runPromise(Effect.scoped(plugin.effect(ctx)).pipe(Effect.provide(layer)))
  const run = (input: unknown, id = "ses_1") => Effect.runPromiseExit(tools[0]!.execute(input, context(id)))
  const ok = async (input: unknown) => {
    const exit = await run(input)
    if (!Exit.isSuccess(exit)) throw new Error(`failed: ${JSON.stringify(exit)}`)
    return exit.value as { content: string; output: Record<string, unknown> }
  }
  const failure = async (input: unknown) => {
    const exit = await run(input)
    expect(Exit.isFailure(exit)).toBe(true)
    return describeExit(exit)
  }
  const dir = { project: path.join(state, "memory", projectID), user: path.join(state, "memory", "user") }
  const system = async (sessionID = "ses_1") => {
    const event = { sessionID, tools: { memory: {}, read: {} } as Record<string, unknown>, system: [] as { type: string; text: string }[] }
    await Effect.runPromise(hooks.get("context")!(event) as Effect.Effect<unknown>)
    return event
  }
  return { tools, commands, hooks, asserted, prompts, dir, ok, failure, system, state }
}

describe("auto memory: scopes", () => {
  test("write, append, view and delete in both scopes, on disk under the state folder", async () =>
    world({}, async (w) => {
      expect(w.tools.map((tool) => tool.name)).toEqual(["memory"])
      await w.ok({ action: "write", scope: "project", name: "MEMORY.md", text: "- tests: see testing.md" })
      await w.ok({ action: "append", scope: "project", text: "- use bun" })
      expect(await fs.readFile(path.join(w.dir.project, "MEMORY.md"), "utf8")).toBe("- tests: see testing.md\n- use bun")
      await w.ok({ action: "write", scope: "user", name: "style.md", text: "tabs" })
      expect(await fs.readFile(path.join(w.dir.user, "style.md"), "utf8")).toBe("tabs")
      expect((await w.ok({ action: "view", scope: "project" })).content).toContain("MEMORY.md")
      expect((await w.ok({ action: "view", scope: "user", name: "style.md" })).content).toBe("tabs")
      await w.ok({ action: "delete", scope: "user", name: "style.md" })
      expect(await w.failure({ action: "view", scope: "user", name: "style.md" })).toContain("No such memory file")
      expect(await w.failure({ action: "delete", scope: "project", name: "MEMORY.md" })).toContain("index")
      expect(w.asserted.every((item) => item.action === "memory")).toBe(true)
      expect(w.asserted[0]!.resources).toEqual(["project/MEMORY.md"])
    }))

  test("a project without a stable id has user memory only", async () =>
    world({ projectID: "global" }, async (w) => {
      expect(await w.failure({ action: "write", scope: "project", text: "x" })).toContain("no project memory")
      await w.ok({ action: "write", scope: "user", text: "x" })
    }))
})

describe("auto memory: names and caps", () => {
  test("refuses names that are paths or not lowercase markdown", async () =>
    world({}, async (w) => {
      for (const name of ["a/b.md", "../x.md", "a\\b.md", "x.txt", ".x.md", "a..md", "Upper.md", "memory.md"])
        expect(await w.failure({ action: "write", scope: "user", name, text: "x" })).toContain("Invalid file name")
      expect(KeteAutoMemory.validName("MEMORY.md")).toBe(true)
      expect(KeteAutoMemory.validName("testing.md")).toBe(true)
      expect(await fs.readdir(w.state).catch(() => [])).toEqual([])
    }))

  test("a file is capped at 25 KiB, a write at 64 KiB, a folder at 200 files", async () =>
    world({}, async (w) => {
      await w.ok({ action: "write", scope: "user", name: "big.md", text: "x".repeat(KeteAutoMemory.FILE_BYTES) })
      expect(await w.failure({ action: "append", scope: "user", name: "big.md", text: "y" })).toContain("over 25 KiB")
      expect(await w.failure({ action: "write", scope: "user", name: "huge.md", text: "x".repeat(KeteAutoMemory.WRITE_BYTES + 1) })).toContain("over 64 KiB")
      for (let i = 1; i < KeteAutoMemory.MAX_FILES; i++) await w.ok({ action: "write", scope: "user", name: `f${i}.md`, text: "x" })
      expect(await w.failure({ action: "write", scope: "user", name: "one-more.md", text: "x" })).toContain("already has 200 files")
      // An existing file can still be rewritten at the cap.
      await w.ok({ action: "write", scope: "user", name: "f1.md", text: "again" })
    }))
})

describe("auto memory: redact", () => {
  test("a secret never reaches the disk and the result says so", async () =>
    world({}, async (w) => {
      const result = await w.ok({ action: "write", scope: "project", text: `- key ${KEY}` })
      expect(result.content).toContain("Secrets in the text were redacted before saving.")
      const saved = await fs.readFile(path.join(w.dir.project, "MEMORY.md"), "utf8")
      expect(saved).not.toContain(KEY)
      expect(saved).toContain("[REDACTED]")
    }))

  test("a hand-edited index is redacted again when loaded", async () =>
    world({ files: { "proj1/MEMORY.md": `- token ${KEY}` } }, async (w) => {
      const event = await w.system()
      expect(JSON.stringify(event.system)).not.toContain(KEY)
    }))
})

describe("auto memory: load", () => {
  test("both indexes join the system prompt under the context-not-instructions header", async () =>
    world({ files: { "proj1/MEMORY.md": "- project note", "user/MEMORY.md": "- user note" } }, async (w) => {
      const event = await w.system()
      expect(event.system).toHaveLength(2)
      for (const part of event.system) expect(part.text).toContain(KeteAutoMemory.HEADER)
      expect(event.system[0]!.text).toContain("Project memory")
      expect(event.system[0]!.text).toContain("- project note")
      expect(event.system[1]!.text).toContain("User memory")
      expect("memory" in event.tools).toBe(true)
    }))

  test("an index loads its first 200 lines only; missing files add nothing", async () =>
    world({ files: { "proj1/MEMORY.md": Array.from({ length: 300 }, (_, i) => `- line ${i + 1}`).join("\n") } }, async (w) => {
      const event = await w.system()
      expect(event.system).toHaveLength(1)
      expect(event.system[0]!.text).toContain("- line 200")
      expect(event.system[0]!.text).not.toContain("- line 201")
      expect(event.system[0]!.text).toContain("(truncated")
    }))

  test("a write to the index shows in the next request", async () =>
    world({}, async (w) => {
      expect((await w.system()).system).toHaveLength(0)
      await w.ok({ action: "write", scope: "user", text: "- fresh" })
      expect((await w.system()).system[0]!.text).toContain("- fresh")
    }))
})

describe("auto memory: commands", () => {
  test("/remember and /memory are registered; /remember sends a prompt with the note", async () =>
    world({}, async (w) => {
      expect(w.commands.map((command) => command.name)).toEqual(["remember", "memory"])
      const input = (text: string) => ({ sessionID: "ses_1", prompt: { text }, delivery: "immediate" })
      await Effect.runPromise(w.commands[0]!.execute(input("we use $& bun")))
      expect(w.prompts[0]!.text).toContain("we use $& bun")
      expect(w.prompts[0]!.text).toContain("memory tool")
      await Effect.runPromise(w.commands[1]!.execute(input("")))
      expect(w.prompts).toHaveLength(2)
    }))

  test("/remember with no note reports its usage and sends nothing", async () =>
    world({}, async (w) => {
      const exit = await Effect.runPromiseExit(w.commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "  " }, delivery: "immediate" }))
      expect(describeExit(exit)).toContain("Usage: /remember <note>")
      expect(w.prompts).toHaveLength(0)
    }))
})

describe("auto memory: off", () => {
  test("kete.memory.auto false in any one document turns everything off", async () =>
    world({ documents: [{}, { auto: false }], files: { "proj1/MEMORY.md": "- note" } }, async (w) => {
      const event = await w.system()
      expect("memory" in event.tools).toBe(false)
      expect(event.system).toHaveLength(0)
      for (const hook of ["compaction", "generate"]) {
        const copy = { sessionID: "ses_1", tools: { memory: {} } as Record<string, unknown> }
        await Effect.runPromise(w.hooks.get(hook)!(copy) as Effect.Effect<unknown>)
        expect("memory" in copy.tools).toBe(false)
      }
      expect(await w.failure({ action: "write", scope: "user", text: "x" })).toContain("Auto memory is off")
      const exit = await Effect.runPromiseExit(w.commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "x" }, delivery: "immediate" }))
      expect(describeExit(exit)).toContain("Auto memory is off")
      expect(w.prompts).toHaveLength(0)
      await expect(fs.readdir(w.dir.user)).rejects.toThrow()
    }))

  test("an unattended session has no tool, no notes, no commands and cannot write", async () =>
    world({ unattended: true, files: { "proj1/MEMORY.md": "- note" } }, async (w) => {
      const event = await w.system()
      expect("memory" in event.tools).toBe(false)
      expect(event.system).toHaveLength(0)
      expect(await w.failure({ action: "write", scope: "user", text: "x" })).toContain("unattended")
      const exit = await Effect.runPromiseExit(w.commands[0]!.execute({ sessionID: "ses_1", prompt: { text: "x" }, delivery: "immediate" }))
      expect(describeExit(exit)).toContain("unattended")
      expect(w.prompts).toHaveLength(0)
      expect(w.asserted).toEqual([])
      await expect(fs.readdir(w.dir.user)).rejects.toThrow()
    }))

  test("job mode registers nothing", async () =>
    world({ env: { OPENCODE_JOB_MODE: "1" } as NodeJS.ProcessEnv }, async (w) => {
      expect(w.tools).toEqual([])
      expect(w.commands).toEqual([])
      expect(w.hooks.size).toBe(0)
    }))
})

describe("auto memory: permission", () => {
  test("a denied memory permission writes nothing", async () =>
    world({ deny: true }, async (w) => {
      expect(await w.failure({ action: "write", scope: "user", text: "x" })).toContain("Permission denied: memory")
      expect(w.asserted).toEqual([{ action: "memory", resources: ["user/MEMORY.md"] }])
      await expect(fs.readdir(w.dir.user)).rejects.toThrow()
    }))

  test("Plan mode allows the memory tool", () => {
    expect(KetePermissionMode.planAllowed.has("memory")).toBe(true)
  })
})
