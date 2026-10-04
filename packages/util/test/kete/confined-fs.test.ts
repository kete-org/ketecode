// KeteConfinedFs over an in-memory kernel (job mode piece A3, AC1 unit level and AC2): the shared
// pre-check, errno mapping, EAGAIN retry, fail-closed startup, and every descriptor closed.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeteConfinedFs } from "../../src/kete/confined-fs.js"
import { KeteLinuxFfi } from "../../src/kete/linux-ffi.js"
import { makeFake } from "./fixture/fake-syscalls.js"

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "confined-fs-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

function setup(options: Partial<Parameters<typeof makeFake>[0]> = {}) {
  const fake = makeFake({ rootPath: base, ...options })
  fake.tree.file("README.md", "hello")
  fake.tree.dir("src")
  fake.tree.file("src/a.ts", "export const a = 1\n")
  fake.tree.symlink("passwd", "/etc/passwd")
  fake.tree.symlink("linkdir", "/etc")
  fake.tree.magic("proc-root")
  fake.tree.fifo("pipe")
  fake.tree.socket("sock")
  const root = KeteConfinedFs.open(base, fake.sys, "linux")
  return { fake, root, ops: KeteConfinedFs.ops(root) }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe("startup (AC2: fail closed)", () => {
  test("ENOSYS refuses to start, naming openat2", () => {
    const fake = makeFake({ rootPath: base, enosys: true })
    expect(() => KeteConfinedFs.open(base, fake.sys, "linux")).toThrow(/openat2 unavailable: ENOSYS\); refusing to start/)
  })

  test("E2BIG and EINVAL from the probe refuse to start", () => {
    for (const errno of [KeteLinuxFfi.errno.E2BIG, KeteLinuxFfi.errno.EINVAL]) {
      const fake = makeFake({ rootPath: base, probeErrno: errno })
      expect(() => KeteConfinedFs.open(base, fake.sys, "linux")).toThrow(/refusing to start/)
      expect(fake.openCount()).toBe(0)
    }
  })

  test("non-Linux and unsupported syscalls refuse to start", () => {
    const fake = makeFake({ rootPath: base })
    expect(() => KeteConfinedFs.open(base, fake.sys, "darwin")).toThrow(/not Linux: darwin/)
    expect(() => KeteConfinedFs.open(base, { unsupported: "unsupported architecture (ia32)" }, "linux")).toThrow(/ia32/)
    expect(KeteLinuxFfi.linux("darwin")).toEqual({ unsupported: "not Linux (darwin)" })
    expect(KeteLinuxFfi.linux("linux", "ia32")).toEqual({ unsupported: "unsupported architecture (ia32)" })
  })

  test("a relative root refuses to start", () => {
    const fake = makeFake({ rootPath: base })
    expect(() => KeteConfinedFs.open("relative", fake.sys, "linux")).toThrow(/absolute/)
  })

  test("success keeps exactly the root descriptor open", () => {
    const { fake, root } = setup()
    expect(fake.openCount()).toBe(1)
    expect(root.real).toBe(base)
  })
})

describe("pre-check", () => {
  test("NUL, absolute outside and .. escapes are refused before any syscall", async () => {
    const { ops, fake } = setup()
    fake.onOpen(() => {
      throw new Error("no syscall expected")
    })
    for (const value of ["a\0b", "/etc/passwd", "../outside", path.join(base, "..", "x"), path.join(base, "src", "..", "..")]) {
      expect((await ops.read(value)).kind).toBe("refused")
      expect((await ops.write(value, new Uint8Array())).kind).toBe("refused")
      expect((await ops.stat(value)).kind).toBe("refused")
      expect((await ops.list(value)).kind).toBe("refused")
      expect((await ops.remove(value)).kind).toBe("refused")
      expect((await ops.mkdir(value)).kind).toBe("refused")
    }
    fake.onOpen(undefined)
  })

  test("relative paths resolve against the root; .. inside the root is fine", () => {
    expect(KeteConfinedFs.relative({ lexical: base, real: base }, "src/../README.md")).toEqual({ kind: "inside", relative: "README.md" })
    expect(KeteConfinedFs.relative({ lexical: base, real: base }, base)).toEqual({ kind: "inside", relative: "." })
    expect(KeteConfinedFs.relative({ lexical: "/link", real: base }, path.join(base, "x"))).toEqual({ kind: "inside", relative: "x" })
  })
})

describe("operations", () => {
  test("read, ranged read and info", async () => {
    const { ops } = setup()
    const whole = await ops.read(path.join(base, "README.md"))
    expect(whole.kind).toBe("ok")
    if (whole.kind === "ok") {
      expect(text(whole.value.bytes)).toBe("hello")
      expect(whole.value.info).toEqual({ type: "file", size: 5, mtimeMs: 2 })
    }
    const ranged = await ops.read("README.md", { offset: 1, length: 3 })
    expect(ranged.kind === "ok" && text(ranged.value.bytes)).toBe("ell")
    const empty = await ops.read("README.md", { offset: 0, length: 0 })
    expect(empty.kind === "ok" && empty.value.bytes.byteLength).toBe(0)
  })

  test("read refuses symlinks and magic links, reports kinds and missing", async () => {
    const { ops } = setup()
    expect(await ops.read("passwd")).toEqual({ kind: "refused" })
    expect(await ops.read("linkdir/passwd")).toEqual({ kind: "refused" })
    expect(await ops.read("proc-root")).toEqual({ kind: "refused" })
    expect(await ops.read("src")).toEqual({ kind: "wrongKind", actual: "directory" })
    expect(await ops.read("pipe")).toEqual({ kind: "wrongKind", actual: "other" })
    expect(await ops.read("sock")).toEqual({ kind: "wrongKind", actual: "other" })
    expect(await ops.read("nope")).toEqual({ kind: "missing" })
    expect(await ops.read("README.md/x")).toEqual({ kind: "missing" })
  })

  test("write creates parents, truncates, refuses a final or middle symlink", async () => {
    const { ops, fake } = setup()
    expect(await ops.write("new/deep/file.txt", new TextEncoder().encode("x"))).toEqual({ kind: "ok", value: undefined })
    expect(fake.tree.text("new/deep/file.txt")).toBe("x")
    expect(await ops.write("README.md", new TextEncoder().encode("bye"))).toEqual({ kind: "ok", value: undefined })
    expect(fake.tree.text("README.md")).toBe("bye")
    expect(await ops.write("passwd", new TextEncoder().encode("x"))).toEqual({ kind: "refused" })
    expect(await ops.write("linkdir/x", new TextEncoder().encode("x"))).toEqual({ kind: "refused" })
    expect((await ops.write("README.md/x", new TextEncoder().encode("x"))).kind).toBe("failed")
    expect((await ops.write("pipe", new TextEncoder().encode("x"))).kind).toBe("failed")
  })

  test("stat has lstat semantics for a final link, refuses a middle one", async () => {
    const { ops } = setup()
    expect(await ops.stat("passwd")).toEqual({ kind: "ok", value: { type: "symlink", size: 0, mtimeMs: 3 } })
    expect(await ops.stat("linkdir/passwd")).toEqual({ kind: "refused" })
    expect((await ops.stat(".")).kind).toBe("ok")
    expect(await ops.stat("missing")).toEqual({ kind: "missing" })
  })

  test("list types entries, refuses a symlinked directory, reports wrong kind", async () => {
    const { ops } = setup()
    const listed = await ops.list(".")
    expect(listed.kind).toBe("ok")
    if (listed.kind === "ok")
      expect(Object.fromEntries(listed.value.map((entry) => [entry.name, entry.type]))).toEqual({
        "README.md": "file",
        src: "directory",
        passwd: "symlink",
        linkdir: "symlink",
        "proc-root": "symlink",
        pipe: "other",
        sock: "other",
      })
    expect(await ops.list("linkdir")).toEqual({ kind: "refused" })
    expect(await ops.list("README.md")).toEqual({ kind: "wrongKind", actual: "file" })
    expect(await ops.list("nope")).toEqual({ kind: "missing" })
  })

  test("list resolves DT_UNKNOWN entries with a per-entry stat", async () => {
    const { ops } = setup({ unknownTypes: true })
    const listed = await ops.list("src")
    expect(listed).toEqual({ kind: "ok", value: [{ name: "a.ts", type: "file" }] })
  })

  test("remove deletes trees, removes a link not its target, never the root", async () => {
    const { ops, fake } = setup()
    fake.tree.file("tree/a/b/c.txt", "x")
    expect(await ops.remove("tree")).toEqual({ kind: "ok", value: undefined })
    expect(fake.tree.at("tree")).toBeUndefined()
    expect(await ops.remove("passwd")).toEqual({ kind: "ok", value: undefined })
    expect(fake.tree.at("passwd")).toBeUndefined()
    expect(await ops.remove("missing/also")).toEqual({ kind: "ok", value: undefined })
    expect((await ops.remove(".")).kind).toBe("failed")
    expect(await ops.remove("linkdir/x")).toEqual({ kind: "refused" })
  })

  test("move renames, into a directory, and refuses a link in the destination path", async () => {
    const { ops, fake } = setup()
    expect(await ops.move("README.md", "README.txt")).toEqual({ kind: "ok", value: undefined })
    expect(fake.tree.text("README.txt")).toBe("hello")
    expect(await ops.move("README.txt", "src")).toEqual({ kind: "ok", value: undefined })
    expect(fake.tree.text("src/README.txt")).toBe("hello")
    expect(await ops.move("nope", "x")).toEqual({ kind: "missing" })
    expect(await ops.move("src/a.ts", "linkdir/a.ts")).toEqual({ kind: "refused" })
  })

  test("mkdir is recursive and refuses a symlinked component", async () => {
    const { ops, fake } = setup()
    expect(await ops.mkdir("x/y/z")).toEqual({ kind: "ok", value: undefined })
    expect(fake.tree.at("x/y/z")?.kind).toBe("dir")
    expect(await ops.mkdir("src")).toEqual({ kind: "ok", value: undefined })
    expect(await ops.mkdir("linkdir/x")).toEqual({ kind: "refused" })
    expect((await ops.mkdir("README.md/x")).kind).toBe("failed")
  })

  test("realPath canonicalises inside the root and refuses a final symlink", async () => {
    const { ops } = setup()
    expect(await ops.realPath("src/a.ts")).toEqual({ kind: "ok", value: path.join(base, "src", "a.ts") })
    expect(await ops.realPath(base)).toEqual({ kind: "ok", value: base })
    expect(await ops.realPath("passwd")).toEqual({ kind: "refused" })
    expect(await ops.realPath("nope")).toEqual({ kind: "missing" })
  })

  test("a symlink swapped in mid-operation is refused", async () => {
    const { ops, fake } = setup()
    fake.tree.dir("work")
    let swapped = false
    fake.onOpen((_dirfd, value) => {
      if (!swapped && value === "work") {
        swapped = true
        fake.tree.remove("work")
        fake.tree.symlink("work", "/etc")
      }
    })
    expect(await ops.write("work/file", new TextEncoder().encode("x"))).toEqual({ kind: "refused" })
    fake.onOpen(undefined)
  })
})

describe("retries and descriptors", () => {
  test("EAGAIN is retried up to the bound, then fails", async () => {
    const { ops, fake } = setup()
    fake.injectEagain(KeteConfinedFs.MAX_RETRIES)
    expect((await ops.read("README.md")).kind).toBe("ok")
    fake.injectEagain(KeteConfinedFs.MAX_RETRIES + 1)
    expect(await ops.read("README.md")).toEqual({ kind: "failed", reason: "EAGAIN" })
  })

  test("every operation closes the descriptors it opened, success or failure", async () => {
    const { ops, fake } = setup()
    const before = fake.openCount()
    await ops.read("README.md")
    await ops.read("passwd")
    await ops.read("src")
    await ops.write("a/b.txt", new Uint8Array([1]))
    await ops.write("linkdir/x", new Uint8Array([1]))
    await ops.stat("passwd")
    await ops.list(".")
    await ops.list("linkdir")
    await ops.mkdir("m/n")
    await ops.move("a/b.txt", "m")
    await ops.remove("m")
    await ops.realPath("src")
    expect(fake.openCount()).toBe(before)
  })
})

describe("FFI tables", () => {
  test("open_how is 24 little-endian bytes", () => {
    const how = KeteLinuxFfi.openHow(0o2000000, 0o666, 0x0e)
    expect(how.byteLength).toBe(24)
    const view = new DataView(how.buffer)
    expect(view.getBigUint64(0, true)).toBe(0o2000000n)
    expect(view.getBigUint64(8, true)).toBe(0o666n)
    expect(view.getBigUint64(16, true)).toBe(0x0en)
  })

  test("per-arch flag and syscall tables", () => {
    expect(KeteLinuxFfi.flagsByArch.x64.O_DIRECTORY).toBe(0o200000)
    expect(KeteLinuxFfi.flagsByArch.arm64.O_DIRECTORY).toBe(0o40000)
    expect(KeteLinuxFfi.flagsByArch.x64.O_NOFOLLOW).toBe(0o400000)
    expect(KeteLinuxFfi.flagsByArch.arm64.O_NOFOLLOW).toBe(0o100000)
    expect(KeteLinuxFfi.syscallNumbers.x64).toEqual({ openat2: 437, getdents64: 217 })
    expect(KeteLinuxFfi.syscallNumbers.arm64).toEqual({ openat2: 437, getdents64: 61 })
  })
})
