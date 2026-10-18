// FileAccess.resolve decides inside/outside the workspace by where a symlink really leads
// (kete/real-path.ts): a file or folder link inside the workspace that points outside it asks the
// `external_directory` question for the real folder; a link that stays inside doesn't; a link loop asks.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { FileAccess } from "@opencode/core/file-access"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempLocationLayer } from "../fixture/location"
import { it } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { toolIdentity } from "../lib/tool"

const invocation = { ...toolIdentity, sessionID: Session.ID.make("ses_file_access_link"), id: Tool.CallID.make("call-read") }
const slash = (file: string) => file.replaceAll("\\", "/")

function provide(requests: Permission.AssertInput[]) {
  return Effect.provide(
    AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node]), [
      Location.node.replace(tempLocationLayer),
      Permission.node.replace(permissionLayer({ assert: (input) => Effect.sync(() => void requests.push(input)) })),
    ]),
  )
}

/** A real folder outside the workspace holding `secret`. */
const outside = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-outside-")))
    await fs.writeFile(path.join(dir, "secret"), "KEY")
    return dir
  }),
  (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
)

const external = (requests: Permission.AssertInput[]) => requests.filter((request) => request.action === "external_directory")

describe.skipIf(process.platform === "win32")("FileAccess and symlinks", () => {
  it.live("a file link inside the workspace to a file outside asks for the real folder (read and write)", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const location = yield* Location.Service
      const dir = yield* outside
      yield* Effect.promise(() => fs.symlink(path.join(dir, "secret"), path.join(location.directory, "notes.txt")))
      yield* access.authorizeRead("notes.txt", invocation)
      expect(external(requests).map((request) => request.resources)).toEqual([[slash(path.join(dir, "*"))]])
      const write = yield* access.resolve({ path: "notes.txt", kind: "file" })
      expect(write.externalDirectory?.resource).toBe(slash(path.join(dir, "*")))
    }).pipe(Effect.scoped, provide(requests))
  })

  it.live("a folder link inside the workspace to a folder outside asks, also for a new file in it", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const location = yield* Location.Service
      const dir = yield* outside
      yield* Effect.promise(() => fs.symlink(dir, path.join(location.directory, "linked")))
      const target = yield* access.resolve({ path: "linked/new.sh", kind: "file" })
      expect(target.externalDirectory?.resource).toBe(slash(path.join(dir, "*")))
      // glob and grep resolve the folder itself
      const folder = yield* access.resolve({ path: "linked", kind: "directory" })
      expect(folder.externalDirectory?.resource).toBe(slash(path.join(dir, "*")))
    }).pipe(Effect.scoped, provide(requests))
  })

  it.live("a dangling link to a path outside asks before a write creates it", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const location = yield* Location.Service
      const dir = yield* outside
      yield* Effect.promise(() => fs.symlink(path.join(dir, "later.rc"), path.join(location.directory, "setup.rc")))
      const target = yield* access.resolve({ path: "setup.rc", kind: "file" })
      expect(target.externalDirectory?.resource).toBe(slash(path.join(dir, "*")))
    }).pipe(Effect.scoped, provide(requests))
  })

  it.live("a link that stays inside the workspace is still inside; a link loop asks", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const location = yield* Location.Service
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(location.directory, "real.txt"), "x")
        await fs.symlink("real.txt", path.join(location.directory, "alias.txt"))
        await fs.symlink("loop-b", path.join(location.directory, "loop-a"))
        await fs.symlink("loop-a", path.join(location.directory, "loop-b"))
      })
      const alias = yield* access.authorizeRead("alias.txt", invocation)
      expect(alias.externalDirectory).toBeUndefined()
      expect(alias.resource).toBe("alias.txt")
      expect(external(requests)).toEqual([])
      const loop = yield* access.resolve({ path: "loop-a", kind: "file" })
      expect(loop.externalDirectory).toBeDefined()
    }).pipe(Effect.scoped, provide(requests))
  })
})

describe.skipIf(process.platform === "win32")("FileAccess and symlinks: kernel order", () => {
  it.live("a dangling link with .. after a folder link is followed as the kernel does (not by text)", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const location = yield* Location.Service
      const dir = yield* outside
      // workspace/lnk -> <outside>/inner, workspace/a -> lnk/../planted: the kernel writes <outside>/planted
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(dir, "inner"))
        await fs.symlink(path.join(dir, "inner"), path.join(location.directory, "lnk"))
        await fs.symlink("lnk/../planted", path.join(location.directory, "a"))
      })
      const target = yield* access.resolve({ path: "a", kind: "file" })
      expect(target.externalDirectory?.resource).toBe(slash(path.join(dir, "*")))
    }).pipe(Effect.scoped, provide(requests))
  })

  it.live("outside as written, a link in the folder part or the file asks for the real folder (rules match by text)", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const dir = yield* outside
      const other = yield* outside
      yield* Effect.promise(async () => {
        await fs.symlink(dir, path.join(other, "alias"))
        await fs.symlink(path.join(dir, "secret"), path.join(other, "leaf"))
      })
      const prefix = yield* access.resolve({ path: path.join(other, "alias", "secret"), kind: "file" })
      expect(prefix.externalDirectory?.resource).toBe(slash(path.join(dir, "*")))
      const leaf = yield* access.resolve({ path: path.join(other, "leaf"), kind: "file" })
      expect(leaf.externalDirectory?.resource).toBe(slash(path.join(dir, "*")))
    }).pipe(Effect.scoped, provide(requests))
  })
})

describe.skipIf(process.platform === "win32")("FileAccess and symlinks: job mode", () => {
  it.live("in job mode the written path decides; the job's file system refuses the link itself", () => {
    const requests: Permission.AssertInput[] = []
    return Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const location = yield* Location.Service
      const dir = yield* outside
      yield* Effect.promise(() => fs.symlink(path.join(dir, "secret"), path.join(location.directory, "leak.txt")))
      process.env.OPENCODE_JOB_MODE = "1"
      const target = yield* access.resolve({ path: "leak.txt", kind: "file" }).pipe(
        Effect.ensuring(Effect.sync(() => void delete process.env.OPENCODE_JOB_MODE)),
      )
      expect(target.externalDirectory).toBeUndefined()
      expect(target.resource).toBe("leak.txt")
    }).pipe(Effect.scoped, provide(requests))
  })
})
