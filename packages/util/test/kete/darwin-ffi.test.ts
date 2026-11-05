// KeteDarwinFfi: the pure errno table everywhere, the real libSystem syscalls on macOS only.
import { afterEach, describe, expect, test } from "bun:test"
import fs, { constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeteConfinedFs } from "../../src/kete/confined-fs.js"
import { KeteDarwinFfi } from "../../src/kete/darwin-ffi.js"
import { KeteLinuxFfi } from "../../src/kete/linux-ffi.js"

describe("errnoToLinux", () => {
  test("translates the numbers that differ and maps the unknown to EIO", () => {
    const table: Array<[number, number]> = [[62, 40], [35, 11], [66, 39], [78, 38], [63, 36], [45, 95], [102, 95], [2, 2], [11, 5], [999, 5]]
    for (const [from, to] of table) expect({ from, to: KeteDarwinFfi.errnoToLinux(from) }).toEqual({ from, to })
  })
})

test("darwin() is unsupported off macOS", () => {
  expect("unsupported" in KeteDarwinFfi.darwin("linux")).toBe(true)
})

describe.skipIf(process.platform !== "darwin")("real libSystem", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  const temp = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "darwin-ffi-")))
    dirs.push(dir)
    return dir
  }
  const setup = () => {
    const sys = KeteDarwinFfi.darwin()
    if ("unsupported" in sys) throw new Error(sys.unsupported)
    const F = sys.flags
    const opened = sys.openat2(KeteDarwinFfi.AT_FDCWD, "/", F.O_PATH | F.O_DIRECTORY | F.O_CLOEXEC, 0, KeteLinuxFfi.RESOLVE_NO_SYMLINKS)
    if (!opened.ok) throw new Error(`root: ${opened.errno}`)
    return { sys, F, ops: KeteConfinedFs.ops({ lexical: "/", real: "/", fd: opened.value, sys }) }
  }

  test("the flag table equals fs.constants", () => {
    const { F } = setup()
    for (const name of ["O_DIRECTORY", "O_NOFOLLOW", "O_CREAT", "O_EXCL", "O_TRUNC", "O_NOCTTY", "O_NONBLOCK", "O_WRONLY"] as const)
      expect({ name, value: F[name] }).toEqual({ name, value: (constants as Record<string, number>)[name]! })
  })

  test("create passes the mode through the padded variadic argument", () => {
    const { ops, sys } = setup()
    const file = path.join(temp(), "new.txt")
    const fd = ops.create(file, 0o640)
    expect(fd.kind).toBe("ok")
    if (fd.kind === "ok") sys.close(fd.value)
    expect(fs.statSync(file).mode & 0o777).toBe(0o640 & ~process.umask())
    expect(ops.create(file, 0o640)).toEqual({ kind: "failed", reason: "EEXIST" })
  })

  test("open with O_PATH|O_NOFOLLOW succeeds (O_NOFOLLOW is stripped)", () => {
    const { ops, sys, F } = setup()
    const file = path.join(temp(), "f")
    fs.writeFileSync(file, "x")
    const fd = ops.open(file, F.O_PATH | F.O_NOFOLLOW)
    expect(fd.kind).toBe("ok")
    if (fd.kind === "ok") sys.close(fd.value)
  })

  test("a parent swapped for a link to an outside folder is refused and the folder stays empty", () => {
    const { ops, F } = setup()
    const base = temp()
    const outside = path.join(base, "outside")
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(base, "swapped"))
    expect(ops.open(path.join(base, "swapped", "f"), F.O_RDONLY).kind).toBe("refused")
    expect(ops.create(path.join(base, "swapped", "f"), 0o600).kind).toBe("refused")
    expect(fs.readdirSync(outside)).toEqual([])
  })

  test("list reports kinds without . and .., and the directory descriptor survives", async () => {
    const { ops } = setup()
    const base = temp()
    fs.writeFileSync(path.join(base, "file"), "")
    fs.mkdirSync(path.join(base, "dir"))
    fs.symlinkSync("file", path.join(base, "link"))
    const listed = await ops.list(base)
    expect(listed.kind).toBe("ok")
    if (listed.kind === "ok") expect(Object.fromEntries(listed.value.map((e) => [e.name, e.type]))).toEqual({ file: "file", dir: "directory", link: "symlink" })
  })

  test("a FIFO opens with O_PATH without blocking", () => {
    const { ops, sys, F } = setup()
    const fifo = path.join(temp(), "pipe")
    expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0)
    const fd = ops.open(fifo, F.O_PATH)
    expect(fd.kind).toBe("ok")
    if (fd.kind === "ok") sys.close(fd.value)
  })

  test("unlinkat on a folder fails and the folder remains", () => {
    const { ops, sys, F } = setup()
    const base = temp()
    fs.mkdirSync(path.join(base, "folder"))
    const dirfd = ops.open(base, F.O_PATH | F.O_DIRECTORY)
    if (dirfd.kind !== "ok") throw new Error("open failed")
    expect(sys.unlinkat(dirfd.value, "folder", 0).ok).toBe(false)
    sys.close(dirfd.value)
    expect(fs.existsSync(path.join(base, "folder"))).toBe(true)
  })
})
