import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config"
import { tmpdir } from "../fixture/tmpdir"

function load(directory: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Config.Service
      return yield* service.get()
    }).pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ config: directory, state: directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

test("\"tips\": false in cli.json loads, and the other keys survive", async () => {
  await using directory = await tmpdir()
  await Bun.write(
    path.join(directory.path, "cli.json"),
    JSON.stringify({ tips: false, animations: false, statusline: { items: ["mode"] } }),
  )
  const config = await load(directory.path)
  expect(config.tips).toBe(false)
  expect(config.animations).toBe(false)
  expect(config.statusline).toEqual({ items: ["mode"] })
})

test("a cli.json without tips leaves it unset (tips default on)", async () => {
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "cli.json"), JSON.stringify({ animations: false }))
  const config = await load(directory.path)
  expect(config.tips).toBeUndefined()
  expect(config.animations).toBe(false)
})
