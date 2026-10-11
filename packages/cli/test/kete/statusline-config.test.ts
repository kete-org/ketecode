import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config"
import { tmpdir } from "../fixture/tmpdir"
import { parse, save } from "../../../tui/src/kete/statusline-config"

function run<A, E>(directory: string, effect: Effect.Effect<A, E, Config.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ config: directory, state: directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

test("a statusline update is written to cli.json, read back, and leaves other keys and comments alone", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "cli.json")
  await Bun.write(file, `{\n  // keep me\n  "animations": false\n}\n`)

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      yield* service.update(save(["context", "directory"], false))
      return yield* service.get()
    }),
  )

  expect(config.statusline).toEqual({ items: ["context", "directory"], colors: false })
  expect(config.animations).toBe(false)
  expect(await Bun.file(file).text()).toContain("// keep me")
})

test("a cli.json with an unknown status line item still decodes and keeps its other settings", async () => {
  await using directory = await tmpdir()
  await Bun.write(
    path.join(directory.path, "cli.json"),
    JSON.stringify({ animations: false, statusline: { items: ["mode", "nope"] } }),
  )

  const config = await run(
    directory.path,
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }),
  )

  expect(config.animations).toBe(false)
  expect(parse(config.statusline)).toEqual({ items: ["mode"], unknown: ["nope"], colors: true })
})
