// The write tool checks a path, asks permission, then opens it. A symlink swapped in between (here, from the
// permission callback, which runs after the check and before the open) must not make it write outside the
// workspace: the open is verified (kete/verified-open.ts) and the tool fails with a clear message.
import fs from "fs/promises"
import os from "os"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FileMutation } from "@opencode/core/file-mutation"
import { Formatter } from "@opencode/core/formatter"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { location } from "../fixture/location"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { toolIdentity, executeTool, registerToolPlugin } from "../lib/tool"

const writeToolNode = makeLocationNode({
  name: "test/verified-open-write-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(WriteTool.Plugin)),
  deps: [Tool.node, FileAccess.node, FileMutation.node, Environment.node, Formatter.node, Permission.node],
})

const sessionID = Session.ID.make("ses_verified_open_tool_test")

const withWriteTool = <A, E, R>(
  directory: string,
  onEdit: () => Promise<void>,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, writeToolNode]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
        Permission.node.replace(
          permissionLayer({
            assert: (input) => (input.action === "edit" ? Effect.promise(onEdit) : Effect.void),
          }),
        ),
      ]),
    ),
  )

const it = testEffect(Layer.empty)

describe.skipIf(process.platform === "win32")("file tools verify the opened file", () => {
  it.live("write refuses a file swapped for a symlink to an outside file after the check", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const outside = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "kete-outside-")))
        const secret = path.join(outside, "secret")
        const notes = path.join(tmp.path, "notes.txt")
        yield* Effect.promise(() => Promise.all([fs.writeFile(secret, "KEY"), fs.writeFile(notes, "inside")]))
        const swap = async () => {
          await fs.rm(notes)
          await fs.symlink(secret, notes)
        }
        const settled = yield* withWriteTool(tmp.path, swap, (registry) =>
          executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call" as const, id: "call-write", name: "write", input: { path: "notes.txt", content: "OVERWRITTEN" } },
          }),
        )
        expect(settled.status).toBe("error")
        expect(JSON.stringify(settled)).toContain("changed while it was being opened")
        expect(yield* Effect.promise(() => fs.readFile(secret, "utf8"))).toBe("KEY")
        yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }))
      }),
    ),
  )
})
