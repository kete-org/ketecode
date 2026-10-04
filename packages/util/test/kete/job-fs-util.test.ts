// KeteJobFsUtil (job mode piece A3, N4): inside the working tree, reads and canonicalisation go
// through KeteConfinedFs (a symlinked AGENTS.md is skipped), mutations are refused, metadata
// passes through; outside it everything delegates. Exhaustiveness: every key of the real FSUtil
// service is classified exactly once, so an upstream-added method fails this test.
import { afterAll, describe, expect, test } from "bun:test"
import fs, { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Effect, Exit, Layer, Stream } from "effect"
import { FSUtil } from "../../src/fs-util.js"
import { KeteConfinedFs } from "../../src/kete/confined-fs.js"
import { KeteJobFsUtil } from "../../src/kete/job-fs-util.js"
import { makeFake } from "./fixture/fake-syscalls.js"

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "job-fs-util-")))
const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "job-fs-util-outside-")))
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const real = Effect.runSync(Effect.provide(Effect.gen(function* () { return yield* FSUtil.Service }), FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))

function setup() {
  const fake = makeFake({ rootPath: base })
  fake.tree.file("AGENTS.md", "# agents")
  fake.tree.file("data.json", '{"a":1}')
  fake.tree.dir("src")
  fake.tree.file("src/a.ts", "a")
  fake.tree.symlink("linked/AGENTS.md", "/var/lib/kete-job/kete/spec.json")
  fake.tree.symlink("passwd", "/etc/passwd")
  const root = KeteConfinedFs.open(base, fake.sys, "linux")
  return { fake, util: KeteJobFsUtil.wrap(real, root) }
}

const exit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect))
const reasonTag = <A, E>(result: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(result)) return "success"
  const fail = result.cause.reasons.find((reason) => reason._tag === "Fail")
  const error = fail?._tag === "Fail" ? (fail.error as { reason?: { _tag?: string } }) : undefined
  return error?.reason?._tag ?? "other"
}

describe("exhaustiveness", () => {
  test("every FSUtil key is in exactly one list", () => {
    const listed = [...KeteJobFsUtil.routed, ...KeteJobFsUtil.refused, ...KeteJobFsUtil.delegated]
    expect(new Set(listed).size).toBe(listed.length)
    // "~effect/platform/FileSystem" is the service's type id, not a method.
    expect(Object.keys(real).filter((key) => !key.startsWith("~")).sort()).toEqual([...listed].sort())
  })
})

describe("routed reads inside the working tree", () => {
  test("readFileString, readFile, readJson, readDirectory(Entries) go through the confined layer", async () => {
    const { util } = setup()
    expect(await Effect.runPromise(util.readFileString(path.join(base, "AGENTS.md")))).toBe("# agents")
    expect(new TextDecoder().decode(await Effect.runPromise(util.readFile(path.join(base, "src", "a.ts"))))).toBe("a")
    expect(await Effect.runPromise(util.readJson(path.join(base, "data.json")))).toEqual({ a: 1 })
    expect((await Effect.runPromise(util.readDirectory(path.join(base, "src"))))).toEqual(["a.ts"])
    expect(await Effect.runPromise(util.readDirectoryEntries(path.join(base, "src")))).toEqual([{ name: "a.ts", type: "file" }])
  })

  test("a symlinked AGENTS.md is skipped, never followed", async () => {
    const { util } = setup()
    expect(await Effect.runPromise(util.readFileStringSafe(path.join(base, "linked", "AGENTS.md")))).toBeUndefined()
    expect(reasonTag(await exit(util.readFileString(path.join(base, "passwd"))))).toBe("PermissionDenied")
    expect(reasonTag(await exit(util.readFile(path.join(base, "missing"))))).toBe("NotFound")
    expect(await Effect.runPromise(util.readFileStringSafe(path.join(base, "missing")))).toBeUndefined()
  })

  test("realPath and resolve canonicalise; a final link is refused; missing resolves lexically", async () => {
    const { util } = setup()
    expect(await Effect.runPromise(util.realPath(path.join(base, "src")))).toBe(path.join(base, "src"))
    expect(reasonTag(await exit(util.realPath(path.join(base, "passwd"))))).toBe("PermissionDenied")
    expect(await Effect.runPromise(util.resolve(path.join(base, "nope")))).toBe(path.join(base, "nope"))
    expect(await Effect.runPromise(util.resolve(path.join(base, "src")))).toBe(path.join(base, "src"))
  })

  test("recursive readDirectory and non-UTF-8 reads are refused", async () => {
    const { util } = setup()
    expect(reasonTag(await exit(util.readDirectory(base, { recursive: true })))).toBe("PermissionDenied")
    expect(reasonTag(await exit(util.readFileString(path.join(base, "AGENTS.md"), "latin1")))).toBe("PermissionDenied")
  })
})

describe("refused mutations inside the working tree", () => {
  test("writes, mkdir, remove, rename, copy, symlink, temp files and streams are refused", async () => {
    const { util, fake } = setup()
    const inside = path.join(base, "x.txt")
    for (const effect of [
      util.writeFileString(inside, "x"),
      util.writeFile(inside, new Uint8Array()),
      util.writeWithDirs(inside, "x"),
      util.writeJson(inside, {}),
      util.ensureDir(path.join(base, "d")),
      util.makeDirectory(path.join(base, "d")),
      util.remove(path.join(base, "src")),
      util.rename(path.join(base, "AGENTS.md"), path.join(outside, "stolen")),
      util.rename(path.join(outside, "x"), inside),
      util.copy(path.join(base, "src"), path.join(outside, "copy")),
      util.copyFile(path.join(base, "AGENTS.md"), path.join(outside, "copy")),
      util.symlink("/etc/passwd", path.join(base, "planted")),
      util.chmod(inside, 0o777),
      util.truncate(inside),
      util.utimes(inside, 0, 0),
      util.makeTempFile({ directory: base }),
      util.makeTempDirectory({ directory: base }),
    ] as Effect.Effect<unknown, unknown>[])
      expect(reasonTag(await exit(effect))).toBe("PermissionDenied")
    expect(reasonTag(await exit(Stream.runDrain(util.stream(path.join(base, "AGENTS.md")))))).toBe("PermissionDenied")
    expect(reasonTag(await exit(Effect.scoped(util.open(path.join(base, "AGENTS.md")))))).toBe("PermissionDenied")
    expect(fake.tree.at("x.txt")).toBeUndefined()
    expect(fs.existsSync(path.join(outside, "stolen"))).toBe(false)
  })
})

describe("confined directory walks (scan, globUp)", () => {
  test("a walk rooted in the tree never enters or reports a symlinked directory", async () => {
    const { util, fake } = setup()
    fake.tree.file(".kete/skills/ok/SKILL.md", "ok")
    fake.tree.symlink(".kete/skills/evil", "/var/lib/kete-job/kete")
    fake.tree.symlink(".kete/skills/root", "/")
    const found = await Effect.runPromise(
      util.scan("{*.md,**/SKILL.md}", { cwd: path.join(base, ".kete", "skills"), absolute: true, include: "file", symlink: true, dot: true }),
    )
    expect(found).toEqual([path.join(base, ".kete", "skills", "ok", "SKILL.md")])
    const all = await Effect.runPromise(util.scan("**/*", { cwd: base, include: "all", dot: true }))
    expect(all).toContain("src/a.ts")
    expect(all).toContain("src")
    // Every symlink (and anything behind one) is absent; the real directory `linked` is fine.
    for (const link of [".kete/skills/evil", ".kete/skills/root", "passwd", "linked/AGENTS.md"])
      expect(all.filter((item) => item === link || item.startsWith(`${link}/`))).toEqual([])
  })

  test("dot handling, pruning and a missing start", async () => {
    const { util, fake } = setup()
    fake.tree.file(".hidden/x.md", "x")
    expect(await Effect.runPromise(util.scan("**/*.md", { cwd: base }))).toEqual(["AGENTS.md"])
    expect(await Effect.runPromise(util.scan("**/*.md", { cwd: base, dot: true }))).toEqual([".hidden/x.md", "AGENTS.md"])
    expect(await Effect.runPromise(util.scan("*", { cwd: path.join(base, "missing") }))).toEqual([])
  })

  test("globUp walks the tree through the confined scan", async () => {
    const { util, fake } = setup()
    fake.tree.file("src/deep/AGENTS.md", "deep")
    fake.tree.symlink("src/deep/x.md", "/etc/passwd")
    const found = await Effect.runPromise(util.globUp("*.md", path.join(base, "src", "deep"), base))
    expect(found).toEqual([path.join(base, "src", "deep", "AGENTS.md"), path.join(base, "AGENTS.md")])
  })
})

describe("delegation", () => {
  test("paths outside the working tree use the real FSUtil", async () => {
    const { util } = setup()
    const file = path.join(outside, "note.txt")
    await Effect.runPromise(util.writeWithDirs(file, "hello"))
    expect(await Effect.runPromise(util.readFileString(file))).toBe("hello")
    expect(await Effect.runPromise(util.existsSafe(file))).toBe(true)
  })

  test("metadata calls pass through (they never return content)", async () => {
    const { util } = setup()
    // The fake tree isn't on disk: the delegated stat sees the real (empty) directory.
    expect(await Effect.runPromise(util.isDir(base))).toBe(true)
    expect(await Effect.runPromise(util.existsSafe(path.join(base, "AGENTS.md")))).toBe(false)
  })
})
