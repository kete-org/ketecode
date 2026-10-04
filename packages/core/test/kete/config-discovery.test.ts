import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Credential } from "@opencode/core/credential"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { WellKnown } from "@opencode/core/wellknown"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

function testLayer(directory: string, globalDirectory: string) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const built = AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
  return Layer.mergeAll(built, Watcher.testLayer)
}

async function write(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value))
}

// Loads config for `project` with `global` as the global config directory and
// returns the effective `shell` value (each fixture file sets a distinct one).
function shell(project: string, global: string) {
  return Effect.gen(function* () {
    const config = yield* Config.Service
    return Config.latest(yield* config.entries(), "shell")
  }).pipe(Effect.provide(testLayer(project, global)))
}

const withTmp = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireDisposable(Effect.promise(() => tmpdir("kete-config-"))).pipe(Effect.flatMap((tmp) => body(tmp.path)))

describe("kete project config discovery", () => {
  it.live("only kete.json / kete.jsonc are config filenames", () =>
    Effect.sync(() => expect(ConfigDiscovery.names).toEqual(["kete.json", "kete.jsonc"])),
  )

  it.live("loads kete.json from the project and .kete/kete.jsonc with higher priority", () =>
    withTmp((root) => {
      const global = path.join(root, "global")
      const project = path.join(root, "project")
      return Effect.promise(async () => {
        await fs.mkdir(global, { recursive: true })
        await write(path.join(project, "kete.json"), { shell: "kete-root" })
      }).pipe(
        Effect.andThen(shell(project, global)),
        Effect.tap((value) => Effect.sync(() => expect(value).toBe("kete-root"))),
        Effect.andThen(Effect.promise(() => write(path.join(project, ".kete", "kete.jsonc"), { shell: "kete-dir" }))),
        Effect.andThen(shell(project, global)),
        Effect.tap((value) => Effect.sync(() => expect(value).toBe("kete-dir"))),
      )
    }),
  )

  it.live("discovers .kete/ in ancestor directories", () =>
    withTmp((root) => {
      const global = path.join(root, "global")
      const nested = path.join(root, "repo", "packages", "app")
      return Effect.promise(async () => {
        await fs.mkdir(global, { recursive: true })
        await fs.mkdir(nested, { recursive: true })
        await write(path.join(root, "repo", ".kete", "kete.json"), { shell: "kete-ancestor" })
      }).pipe(
        Effect.andThen(shell(nested, global)),
        Effect.tap((value) => Effect.sync(() => expect(value).toBe("kete-ancestor"))),
      )
    }),
  )

  it.live("ignores .opencode/ directories and opencode.json files", () =>
    withTmp((root) => {
      const global = path.join(root, "global")
      const project = path.join(root, "project")
      return Effect.promise(async () => {
        await fs.mkdir(global, { recursive: true })
        await write(path.join(project, "opencode.json"), { shell: "opencode-root" })
        await write(path.join(project, "opencode.jsonc"), { shell: "opencode-root-jsonc" })
        await write(path.join(project, ".opencode", "opencode.json"), { shell: "opencode-dir" })
        await write(path.join(project, ".opencode", "opencode.jsonc"), { shell: "opencode-dir-jsonc" })
        await write(path.join(global, "opencode.json"), { shell: "opencode-global" })
      }).pipe(
        Effect.andThen(shell(project, global)),
        Effect.tap((value) => Effect.sync(() => expect(value).toBeUndefined())),
      )
    }),
  )

  it.live("loads kete.json from the global config directory", () =>
    withTmp((root) => {
      const global = path.join(root, "global")
      const project = path.join(root, "project")
      return Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        await write(path.join(global, "kete.json"), { shell: "kete-global" })
      }).pipe(
        Effect.andThen(shell(project, global)),
        Effect.tap((value) => Effect.sync(() => expect(value).toBe("kete-global"))),
      )
    }),
  )
})
