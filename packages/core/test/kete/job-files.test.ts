// KeteJobFiles over an in-memory kernel (job mode piece A3, AC1 unit level): every operation of
// plan.md table B maps to the local driver's error channels, refusals are `Failed` with a
// `KeteConfinedFs.Refused` cause, and all seven methods are overridden (execDefaults never runs).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { EnvironmentUnavailable } from "../../src/environment/unavailable"
import { Environment } from "../../src/environment/index"
import { KeteJobFiles } from "../../src/kete/job-files"
import { makeFake } from "../../../util/test/kete/fixture/fake-syscalls"

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "job-files-")))

function setup() {
  const fake = makeFake({ rootPath: base })
  fake.tree.file("README.md", "hello")
  fake.tree.dir("src")
  fake.tree.symlink("passwd", "/etc/passwd")
  fake.tree.symlink("linkdir", "/etc")
  fake.tree.magic("proc-root")
  const root = KeteConfinedFs.open(base, fake.sys, "linux")
  const driver = KeteJobFiles.driver(root, EnvironmentUnavailable.spawner)
  return { fake, files: Environment.makeFiles(driver), driver }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect))
const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined || error._tag !== "Fail") throw new Error("expected a typed failure")
  return error.error
}

describe("KeteJobFiles.driver", () => {
  test("overrides all seven FilesImpl methods", () => {
    const { driver } = setup()
    expect(Object.keys(driver.overrides ?? {}).sort()).toEqual(["list", "mkdir", "move", "read", "remove", "stat", "write"])
  })

  test("read: content, NotFound, WrongKind, refusal", async () => {
    const { files } = setup()
    const ok = await run(files.read(path.join(base, "README.md")))
    expect(Exit.isSuccess(ok) && new TextDecoder().decode(ok.value.bytes)).toBe("hello")
    expect(failure(await run(files.read("nope")))).toBeInstanceOf(Environment.NotFound)
    const wrong = failure(await run(files.read("src")))
    expect(wrong).toBeInstanceOf(Environment.WrongKind)
    expect((wrong as Environment.WrongKind).actual).toBe("directory")
    for (const value of ["passwd", "linkdir/passwd", "proc-root", "/etc/passwd", "../x"]) {
      const refused = failure(await run(files.read(value)))
      expect(refused).toBeInstanceOf(Environment.Failed)
      const cause = (refused as Environment.Failed).cause
      expect(cause).toBeInstanceOf(KeteConfinedFs.Refused)
      expect(String((cause as Error).message)).toStartWith("Job mode: refused to follow a symbolic link or leave the working tree")
      expect(String((cause as Error).message)).not.toContain("/etc")
    }
  })

  test("write/mkdir/remove fail only with Failed", async () => {
    const { files, fake } = setup()
    expect(Exit.isSuccess(await run(files.write("a/b.txt", new TextEncoder().encode("x"))))).toBe(true)
    expect(fake.tree.text("a/b.txt")).toBe("x")
    expect(failure(await run(files.write("passwd", new Uint8Array())))).toBeInstanceOf(Environment.Failed)
    expect(Exit.isSuccess(await run(files.mkdir("m/n")))).toBe(true)
    expect(failure(await run(files.mkdir("linkdir/x")))).toBeInstanceOf(Environment.Failed)
    expect(Exit.isSuccess(await run(files.remove("m")))).toBe(true)
    expect(Exit.isSuccess(await run(files.remove("missing")))).toBe(true)
    expect(failure(await run(files.remove(base)))).toBeInstanceOf(Environment.Failed)
  })

  test("stat: lstat semantics, NotFound, refused middle link", async () => {
    const { files } = setup()
    const link = await run(files.stat("passwd"))
    expect(Exit.isSuccess(link) && link.value.type).toBe("symlink")
    expect(failure(await run(files.stat("nope")))).toBeInstanceOf(Environment.NotFound)
    expect(failure(await run(files.stat("linkdir/x")))).toBeInstanceOf(Environment.Failed)
  })

  test("list: entries, WrongKind, NotFound, refused symlinked dir", async () => {
    const { files } = setup()
    const listed = await run(files.list("src"))
    expect(Exit.isSuccess(listed) && listed.value).toEqual([])
    expect(failure(await run(files.list("README.md")))).toBeInstanceOf(Environment.WrongKind)
    expect(failure(await run(files.list("nope")))).toBeInstanceOf(Environment.NotFound)
    expect(failure(await run(files.list("linkdir")))).toBeInstanceOf(Environment.Failed)
  })

  test("move: renames, NotFound for a missing source, refuses a link in the destination", async () => {
    const { files, fake } = setup()
    expect(Exit.isSuccess(await run(files.move("README.md", "src")))).toBe(true)
    expect(fake.tree.text("src/README.md")).toBe("hello")
    expect(failure(await run(files.move("nope", "x")))).toBeInstanceOf(Environment.NotFound)
    expect(failure(await run(files.move("src/README.md", "linkdir/R")))).toBeInstanceOf(Environment.Failed)
  })

  test("typeFollowing (glob/grep) on a symlink fails rather than following it", async () => {
    const { files } = setup()
    const exit = await run(Environment.typeFollowing(files, "passwd"))
    expect(failure(exit)).toBeInstanceOf(Environment.Failed)
    const file = await run(Environment.typeFollowing(files, "README.md"))
    expect(Exit.isSuccess(file) && file.value).toBe("file")
  })
})
