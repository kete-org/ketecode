// KeteJobFiles against the real kernel (job mode piece A3, AC1/AC5 parity). The shared Environment
// conformance suite — the one the local, memory and GNU-exec drivers pass — runs against the job
// driver on a real temp tree without symlinks, so the two drivers behave the same for every
// operation the tools use; then every symlink and escape case is refused by the job driver, where
// the local driver would follow it. Linux only.
import fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { KeteLinuxFfi } from "@opencode/util/kete/linux-ffi"
import { EnvironmentUnavailable } from "../../src/environment/unavailable"
import { Environment } from "../../src/environment/index"
import { KeteJobFiles } from "../../src/kete/job-files"
import { tmpdir } from "../fixture/tmpdir"
import { environmentConformance } from "../lib/environment-conformance"

const linux = process.platform === "linux"

const openRoot = (directory: string) => {
  const sys = KeteLinuxFfi.linux()
  return KeteConfinedFs.open(realpathSync(directory), sys)
}

environmentConformance(
  "job environment (openat2)",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir("kete-job-environment-"))
      const root = openRoot(tmp.path)
      return {
        files: Environment.makeFiles(KeteJobFiles.driver(root, EnvironmentUnavailable.spawner)),
        root: root.real,
        // No `symlink`: the job driver refuses links by design (below), so the follow-a-link checks
        // don't apply.
        dispose: Effect.promise(async () => {
          root.sys.close(root.fd)
          await tmp[Symbol.asyncDispose]()
        }),
      }
    }),
  !linux,
)

describe.skipIf(!linux)("job driver refuses what the local driver follows", () => {
  test("symlinked file, symlinked directory, magic-link path, `..` and absolute paths", async () => {
    await using tmp = await tmpdir("kete-job-refusal-")
    const tree = path.join(realpathSync(tmp.path), "tree")
    const outside = path.join(realpathSync(tmp.path), "outside")
    await fs.mkdir(tree)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, "secret"), "secret")
    await fs.symlink("/etc/passwd", path.join(tree, "passwd"))
    await fs.symlink(outside, path.join(tree, "linkdir"))
    await fs.symlink("/proc/self/root", path.join(tree, "proc-root"))
    const root = openRoot(tree)
    const files = Environment.makeFiles(KeteJobFiles.driver(root, EnvironmentUnavailable.spawner))
    const refused = async <A, E>(effect: Effect.Effect<A, E>) => {
      const exit = await Effect.runPromise(Effect.exit(effect))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const reason = exit.cause.reasons.find((item) => item._tag === "Fail")
      expect(reason?._tag === "Fail" && reason.error instanceof Environment.Failed).toBe(true)
      if (reason?._tag === "Fail") expect((reason.error as Environment.Failed).cause).toBeInstanceOf(KeteConfinedFs.Refused)
    }
    await refused(files.read(path.join(tree, "passwd")))
    await refused(files.read(path.join(tree, "linkdir", "secret")))
    await refused(files.read(path.join(tree, "proc-root", "etc", "passwd")))
    await refused(files.read(path.join(tree, "..", "outside", "secret")))
    await refused(files.read(path.join(outside, "secret")))
    await refused(files.write(path.join(tree, "passwd"), new TextEncoder().encode("x")))
    await refused(files.write(path.join(tree, "linkdir", "planted"), new TextEncoder().encode("x")))
    await refused(files.list(path.join(tree, "linkdir")))
    await refused(files.mkdir(path.join(tree, "linkdir", "x")))
    await refused(files.remove(path.join(tree, "linkdir", "secret")))
    await refused(files.move(path.join(tree, "passwd"), path.join(tree, "linkdir", "p")))
    await refused(Environment.typeFollowing(files, path.join(tree, "passwd")))
    expect(await fs.readdir(outside)).toEqual(["secret"])
    expect(await fs.readFile("/etc/passwd", "utf8")).not.toBe("x")
    // An ordinary edit still works.
    const write = await Effect.runPromise(Effect.exit(files.write(path.join(tree, "ok.txt"), new TextEncoder().encode("ok"))))
    expect(Exit.isSuccess(write)).toBe(true)
    expect(await fs.readFile(path.join(tree, "ok.txt"), "utf8")).toBe("ok")
    root.sys.close(root.fd)
  })
})
