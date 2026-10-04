// KeteConfinedFs against the real kernel (job mode piece A3, AC1): openat2 with RESOLVE_BENEATH |
// RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS refuses a symlink to /etc/passwd, a symlinked
// directory, `..`, an absolute path, a magic link and a symlink swapped in mid-operation; ordinary
// edits work. Linux only (CI runs it on x86_64; locally in an oven/bun container on arm64, glibc and
// musl). The bind-mounted /proc case needs root: CONFINED_FS_ROOT_TESTS=1 with --privileged.
import { afterAll, describe, expect, test } from "bun:test"
import fs, { constants, mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeteConfinedFs } from "../../src/kete/confined-fs.js"
import { KeteLinuxFfi } from "../../src/kete/linux-ffi.js"

const linux = process.platform === "linux"
const rootTests = linux && process.env.CONFINED_FS_ROOT_TESTS === "1"

describe.skipIf(!linux)("real openat2", () => {
  const base = linux ? realpathSync(mkdtempSync(path.join(os.tmpdir(), "confined-linux-"))) : ""
  const tree = path.join(base, "tree")
  const outside = path.join(base, "outside")
  afterAll(() => {
    if (rootTests) Bun.spawnSync(["umount", path.join(tree, "proc")])
    rmSync(base, { recursive: true, force: true })
  })

  const setup = () => {
    rmSync(tree, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    fs.mkdirSync(path.join(tree, "src"), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(tree, "README.md"), "hello")
    fs.writeFileSync(path.join(outside, "secret"), "do not read")
    fs.symlinkSync("/etc/passwd", path.join(tree, "passwd"))
    fs.symlinkSync(outside, path.join(tree, "linkdir"))
    fs.symlinkSync("/proc/self/root", path.join(tree, "proc-root"))
    fs.symlinkSync("README.md", path.join(tree, "inner-link"))
    const fifo = Bun.spawnSync(["mkfifo", path.join(tree, "pipe")])
    expect(fifo.exitCode).toBe(0)
    const sys = KeteLinuxFfi.linux()
    if ("unsupported" in sys) throw new Error(sys.unsupported)
    const root = KeteConfinedFs.open(tree, sys)
    return { root, ops: KeteConfinedFs.ops(root), sys }
  }

  test("the flag table matches fs.constants on this architecture", () => {
    const sys = KeteLinuxFfi.linux()
    if ("unsupported" in sys) throw new Error(sys.unsupported)
    for (const name of ["O_DIRECTORY", "O_NOFOLLOW", "O_CREAT", "O_TRUNC", "O_NOCTTY", "O_NONBLOCK", "O_WRONLY"] as const)
      expect({ name, value: sys.flags[name] }).toEqual({ name, value: (constants as Record<string, number>)[name]! })
  })

  test("ordinary edits work: write, read, stat, list, mkdir, move, remove", async () => {
    const { ops } = setup()
    expect(await ops.write(path.join(tree, "src", "new", "a.ts"), new TextEncoder().encode("a"))).toEqual({ kind: "ok", value: undefined })
    expect(fs.readFileSync(path.join(tree, "src", "new", "a.ts"), "utf8")).toBe("a")
    const read = await ops.read("README.md")
    expect(read.kind === "ok" && new TextDecoder().decode(read.value.bytes)).toBe("hello")
    const ranged = await ops.read("README.md", { offset: 1, length: 2 })
    expect(ranged.kind === "ok" && new TextDecoder().decode(ranged.value.bytes)).toBe("el")
    expect((await ops.stat("README.md")).kind).toBe("ok")
    const listed = await ops.list(".")
    expect(listed.kind).toBe("ok")
    if (listed.kind === "ok") {
      const types = Object.fromEntries(listed.value.map((entry) => [entry.name, entry.type]))
      expect(types["README.md"]).toBe("file")
      expect(types["src"]).toBe("directory")
      expect(types["passwd"]).toBe("symlink")
      expect(types["pipe"]).toBe("other")
    }
    expect(await ops.mkdir("d/e/f")).toEqual({ kind: "ok", value: undefined })
    expect(await ops.move("src/new/a.ts", "d/e")).toEqual({ kind: "ok", value: undefined })
    expect(fs.existsSync(path.join(tree, "d", "e", "a.ts"))).toBe(true)
    expect(await ops.remove("d")).toEqual({ kind: "ok", value: undefined })
    expect(fs.existsSync(path.join(tree, "d"))).toBe(false)
  })

  test("a symlink to /etc/passwd is refused for read and write; stat sees the link itself", async () => {
    const { ops } = setup()
    expect(await ops.read("passwd")).toEqual({ kind: "refused" })
    expect(await ops.write("passwd", new TextEncoder().encode("x"))).toEqual({ kind: "refused" })
    expect(await ops.read("inner-link")).toEqual({ kind: "refused" })
    const stat = await ops.stat("passwd")
    expect(stat.kind === "ok" && stat.value.type).toBe("symlink")
  })

  test("a symlinked directory is refused for read, write, list, mkdir and move", async () => {
    const { ops } = setup()
    expect(await ops.read("linkdir/secret")).toEqual({ kind: "refused" })
    expect(await ops.write("linkdir/planted", new TextEncoder().encode("x"))).toEqual({ kind: "refused" })
    expect(fs.existsSync(path.join(outside, "planted"))).toBe(false)
    expect(await ops.list("linkdir")).toEqual({ kind: "refused" })
    expect(await ops.mkdir("linkdir/x")).toEqual({ kind: "refused" })
    expect(await ops.move("README.md", "linkdir/README.md")).toEqual({ kind: "refused" })
    expect(await ops.remove("linkdir/secret")).toEqual({ kind: "refused" })
    expect(fs.existsSync(path.join(outside, "secret"))).toBe(true)
  })

  test("`..` and absolute paths are refused by the pre-check, and by the kernel when passed raw", async () => {
    const { ops, root, sys } = setup()
    expect(await ops.read("../outside/secret")).toEqual({ kind: "refused" })
    expect(await ops.read(path.join(outside, "secret"))).toEqual({ kind: "refused" })
    expect(await ops.read("/etc/passwd")).toEqual({ kind: "refused" })
    const flags = sys.flags.O_RDONLY | sys.flags.O_CLOEXEC
    const resolve = KeteLinuxFfi.RESOLVE_BENEATH | KeteLinuxFfi.RESOLVE_NO_SYMLINKS | KeteLinuxFfi.RESOLVE_NO_MAGICLINKS
    expect(sys.openat2(root.fd, "../outside/secret", flags, 0, resolve)).toEqual({ ok: false, errno: KeteLinuxFfi.errno.EXDEV })
    expect(sys.openat2(root.fd, "/etc/passwd", flags, 0, resolve)).toEqual({ ok: false, errno: KeteLinuxFfi.errno.EXDEV })
    expect(sys.openat2(root.fd, "passwd", flags, 0, resolve)).toEqual({ ok: false, errno: KeteLinuxFfi.errno.ELOOP })
  })

  test("a link to /proc/self/root (a magic link's path) is refused", async () => {
    const { ops } = setup()
    expect(await ops.read("proc-root/etc/passwd")).toEqual({ kind: "refused" })
    expect(await ops.list("proc-root")).toEqual({ kind: "refused" })
  })

  test("a FIFO doesn't block a read or a write", async () => {
    const { ops } = setup()
    expect(await ops.read("pipe")).toEqual({ kind: "wrongKind", actual: "other" })
    expect((await ops.write("pipe", new TextEncoder().encode("x"))).kind).toBe("failed")
  })

  test("a directory swapped for a symlink mid-operation never lets a write escape", async () => {
    const { ops } = setup()
    fs.mkdirSync(path.join(tree, "work"))
    fs.mkdirSync(path.join(base, "spare"))
    fs.symlinkSync(outside, path.join(base, "swap-link"))
    // A separate process flips tree/work between a real directory and a symlink to `outside`.
    const swapper = Bun.spawn([
      "sh",
      "-c",
      `while :; do mv -T "${path.join(tree, "work")}" "${path.join(base, "spare")}" 2>/dev/null; ` +
        `mv -T "${path.join(base, "swap-link")}" "${path.join(tree, "work")}" 2>/dev/null; ` +
        `mv -T "${path.join(tree, "work")}" "${path.join(base, "swap-link")}" 2>/dev/null; ` +
        `mv -T "${path.join(base, "spare")}" "${path.join(tree, "work")}" 2>/dev/null; done`,
    ])
    const kinds = new Set<string>()
    try {
      for (let index = 0; index < 400; index++) {
        const result = await ops.write(`work/f${index}`, new TextEncoder().encode("x"))
        kinds.add(result.kind)
        const read = await ops.read("work/secret")
        expect(read.kind === "ok").toBe(false)
      }
    } finally {
      swapper.kill()
      await swapper.exited
    }
    expect(fs.readdirSync(outside).filter((name) => name.startsWith("f"))).toEqual([])
    expect([...kinds].every((kind) => kind === "ok" || kind === "refused" || kind === "missing" || kind === "failed")).toBe(true)
  })

  test.skipIf(!rootTests)("a real magic link under a bind-mounted /proc is refused (root only)", async () => {
    const { ops } = setup()
    fs.mkdirSync(path.join(tree, "proc"))
    const mount = Bun.spawnSync(["mount", "--bind", "/proc", path.join(tree, "proc")])
    expect(mount.exitCode).toBe(0)
    try {
      expect(await ops.read(`proc/${process.pid}/root/etc/passwd`)).toEqual({ kind: "refused" })
      expect(await ops.read(`proc/${process.pid}/exe`)).toEqual({ kind: "refused" })
      expect(await ops.read("proc/self/status")).toEqual({ kind: "refused" })
      // An ordinary /proc file reached without a link is fine: the confinement is about links.
      expect((await ops.read(`proc/${process.pid}/status`)).kind).toBe("ok")
    } finally {
      Bun.spawnSync(["umount", path.join(tree, "proc")])
    }
  })
})
