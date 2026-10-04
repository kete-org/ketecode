// KeteJobFsUtil's directory walks against the real kernel (job mode piece A3): a symlinked
// directory in the working tree pointing outside it (to a directory of known names, and to `/`)
// never makes `scan`, `globUp` or `glob` return a name from outside the tree — whether the walk is
// rooted in the tree or above it, and even when the caller asks to follow symlinks. Linux only.
import { afterAll, describe, expect, test } from "bun:test"
import fs, { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Effect, Layer } from "effect"
import { FSUtil } from "../../src/fs-util.js"
import { KeteConfinedFs } from "../../src/kete/confined-fs.js"
import { KeteJobFsUtil } from "../../src/kete/job-fs-util.js"
import { KeteLinuxFfi } from "../../src/kete/linux-ffi.js"

const linux = process.platform === "linux"

describe.skipIf(!linux)("confined walks with real symlinks", () => {
  const base = linux ? realpathSync(mkdtempSync(path.join(os.tmpdir(), "job-fs-util-linux-"))) : ""
  const tree = path.join(base, "tree")
  const outside = path.join(base, "outside")
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  const setup = () => {
    rmSync(tree, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    fs.mkdirSync(path.join(tree, ".kete", "skills", "ok"), { recursive: true })
    fs.mkdirSync(path.join(outside, "secret-dir"), { recursive: true })
    fs.writeFileSync(path.join(tree, ".kete", "skills", "ok", "SKILL.md"), "ok")
    fs.writeFileSync(path.join(tree, "README.md"), "hello")
    fs.writeFileSync(path.join(outside, "OUTSIDE-NAME.md"), "x")
    fs.writeFileSync(path.join(outside, "secret-dir", "SKILL.md"), "x")
    fs.symlinkSync(outside, path.join(tree, ".kete", "skills", "evil"))
    fs.symlinkSync(outside, path.join(tree, "linkdir"))
    fs.symlinkSync("/", path.join(tree, "rootlink"))
    const real = Effect.runSync(
      Effect.provide(
        Effect.gen(function* () {
          return yield* FSUtil.Service
        }),
        FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer)),
      ),
    )
    const root = KeteConfinedFs.open(tree, KeteLinuxFfi.linux())
    return KeteJobFsUtil.wrap(real, root)
  }

  const noOutside = (results: ReadonlyArray<string>) => {
    for (const result of results) {
      expect(result).not.toContain("OUTSIDE-NAME")
      expect(result).not.toContain("secret-dir")
      expect(result).not.toContain("rootlink")
      expect(result).not.toContain("/evil")
      expect(result).not.toContain("linkdir")
    }
  }

  test("scan rooted in the tree, following symlinks requested", async () => {
    const util = setup()
    const found = await Effect.runPromise(
      util.scan("{*.md,**/SKILL.md}", { cwd: path.join(tree, ".kete", "skills"), absolute: true, include: "file", symlink: true, dot: true }),
    )
    expect(found).toEqual([path.join(tree, ".kete", "skills", "ok", "SKILL.md")])
    const all = await Effect.runPromise(util.scan("**/*", { cwd: tree, include: "all", dot: true, symlink: true }))
    expect(all).toContain("README.md")
    noOutside(all)
  })

  test("scan rooted above the tree drops anything reached through a link in it", async () => {
    const util = setup()
    const found = await Effect.runPromise(util.scan("tree/**/*", { cwd: base, include: "all", dot: true, symlink: true }))
    expect(found).toContain("tree/README.md")
    noOutside(found)
    const explicit = await Effect.runPromise(util.scan("tree/linkdir/*", { cwd: base, dot: true }))
    expect(explicit).toEqual([])
    const absolute = await Effect.runPromise(util.scan(path.join(tree, "linkdir", "*"), { dot: true }))
    expect(absolute).toEqual([])
  })

  test("globUp and glob", async () => {
    const util = setup()
    noOutside(await Effect.runPromise(util.globUp("**/*.md", path.join(tree, ".kete"), tree)))
    const globbed = await Effect.runPromise(util.glob("linkdir/*", { root: tree }))
    expect(globbed).toEqual([])
  })
})
