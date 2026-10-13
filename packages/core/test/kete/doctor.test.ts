// The `kete.doctor` RPC (kete/doctor.ts): every config file the loader read is checked the way the
// loader checks it, so a file it drops whole shows up; and the folder trust decision comes back.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Form } from "@opencode/core/form"
import { KeteDoctor } from "@opencode/core/kete/doctor"
import { KeteFolderTrust } from "@opencode/core/kete/folder-trust"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import type { KeteDoctorRpc } from "@opencode/schema/kete/doctor"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)

describe("checkText", () => {
  test("a valid file is ok", () => {
    expect(KeteDoctor.checkText(`{ "username": "a" }`)).toEqual({ state: "ok", messages: [] })
  })
  test("comments and trailing commas are JSONC, so ok", () => {
    expect(KeteDoctor.checkText(`{\n  // a comment\n  "username": "a",\n}`).state).toBe("ok")
  })
  test("broken JSON is invalid, with the line", () => {
    const result = KeteDoctor.checkText(`{\n  "username": "a"\n  "theme": "b"\n}`)
    expect(result.state).toBe("invalid")
    expect(result.messages[0]).toMatch(/^line 3: /)
  })
  test("valid JSON that isn't an object is rejected", () => {
    expect(KeteDoctor.checkText(`[1, 2]`).state).toBe("rejected")
  })
  test("a value of the wrong type is skipped, and said so", () => {
    const result = KeteDoctor.checkText(`{ "username": 42 }`)
    expect(result.state).toBe("warnings")
    expect(result.messages.join(" ")).toContain("username")
  })
  test("an unsupported key is a warning", () => {
    const result = KeteDoctor.checkText(`{ "logLevel": "DEBUG" }`)
    expect(result.state).toBe("warnings")
    expect(result.messages.join(" ")).toContain("logLevel")
  })
  test("messages are bounded and safe: no control, C1 or bidi characters from a key name", () => {
    const providers = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`p${index}\u009b31m\u202e\u001b]0;x\u0007`, { whitelist: ["a"] }]),
    )
    const result = KeteDoctor.checkText(JSON.stringify({ provider: providers }))
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages.length).toBeLessThanOrEqual(10)
    for (const message of result.messages) {
      expect(message.length).toBeLessThanOrEqual(300)
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    }
    expect(result.messages.join(" ")).toContain("p0")
  })
})

describe("trustOf", () => {
  test("held items are capped and counted", () => {
    const held = Array.from({ length: 30 }, (_, index) => `item ${index}`)
    const trust = KeteDoctor.trustOf({ kind: "untrusted", held, refusal: "it's your home folder" })
    expect(trust).toMatchObject({ state: "untrusted", heldCount: 30, refusal: "it's your home folder" })
    expect(trust.held).toHaveLength(20)
  })
  test("trusted keeps its reason", () => {
    expect(KeteDoctor.trustOf({ kind: "trusted", reason: "run" })).toEqual({ state: "trusted", reason: "run", held: [], heldCount: 0 })
  })
})

async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

describe("the kete.doctor RPC", () => {
  it.live("reports a project file the loader dropped, the global file, and that the folder isn't trusted", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir("kete-doctor-"))).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => fs.realpath(tmp.path))
          const repo = path.join(root, "repo")
          const global = path.join(root, "global")
          const home = path.join(root, "home")
          const state = path.join(root, "state")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(repo, ".git"), { recursive: true })
            await fs.mkdir(home, { recursive: true })
            // Valid only once {env:…} is substituted, as the loader does for the machine's own files.
            await write(path.join(global, "kete.json"), `{ "username": {env:KETE_DOCTOR_TEST_NAME} }`)
            // Exists but can't be read: the loader skips a .kete/ file without a word.
            await write(path.join(repo, ".kete", "kete.json"), `{}`)
            if (process.platform !== "win32") await fs.chmod(path.join(repo, ".kete", "kete.json"), 0o000)
            // Broken: a missing comma. The loader drops it whole.
            await write(path.join(repo, "kete.json"), `{\n  "username": "a"\n  "mcp": {}\n}`)
            // Valid, with a setting trust holds back.
            await write(
              path.join(repo, ".kete", "kete.jsonc"),
              JSON.stringify({ mcp: { servers: { tools: { type: "local", command: ["node", "./mcp.js"] } } } }),
            )
          })
          const locationLayer = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(repo) }, { projectDirectory: AbsolutePath.make(repo) })),
          )
          const graph = Layer.mergeAll(
            AppNodeBuilder.build(
              LayerNode.group([Config.node, ConfigPluginSource.node, KeteFolderTrust.node, Form.node, Bus.node, Agent.node, FSUtil.node, Global.node]),
              [
                Location.node.replace(locationLayer),
                Global.node.replace(Global.layerWith({ config: global, home, state })),
                Credential.node.replace(emptyCredentialNode),
                WellKnown.node.replace(emptyWellknownNode),
                Watcher.node.replace(Watcher.testLayer),
                KeteFolderTrust.node.replace(KeteFolderTrust.configured({ env: {}, ppid: 0 })),
              ],
            ),
            Watcher.testLayer,
          )
          process.env.KETE_DOCTOR_TEST_NAME = `"me"`
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              delete process.env.KETE_DOCTOR_TEST_NAME
              await fs.chmod(path.join(repo, ".kete", "kete.json"), 0o600).catch(() => undefined)
            }),
          )
          const report = yield* Effect.gen(function* () {
            let handlers: Record<string, (input: unknown) => Effect.Effect<KeteDoctorRpc.Report>> = {}
            yield* KeteDoctor.Plugin.effect(
              host({
                rpc: Object.assign(() => Effect.die("unused"), {
                  register: (_definition: unknown, given: typeof handlers) =>
                    Effect.sync(() => {
                      handlers = given
                      return { dispose: Effect.void, events: { emit: () => Effect.void } }
                    }),
                }) as never,
              }),
            )
            return yield* handlers.check!({})
          }).pipe(Effect.provide(graph), Effect.scoped)

          const byPath = new Map(report.files.map((file) => [file.path, file]))
          expect(byPath.get(path.join(global, "kete.json"))).toMatchObject({ scope: "global", state: "ok" })
          if (process.platform !== "win32" && process.getuid?.() !== 0)
            expect(byPath.get(path.join(repo, ".kete", "kete.json"))).toMatchObject({ scope: "project", state: "unreadable" })
          expect(byPath.get(path.join(repo, "kete.json"))).toMatchObject({ scope: "project", state: "invalid" })
          expect(byPath.get(path.join(repo, ".kete", "kete.jsonc"))).toMatchObject({ scope: "project", state: "ok" })
          expect(report.trust.state).toBe("untrusted")
          expect(report.trust.heldCount).toBeGreaterThan(0)
        }),
      ),
    ),
  )
})
