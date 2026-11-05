// emulateOpenat2 (the per-component openat2 fallback) and the choice to use it; platform-independent via a stub.
import { describe, expect, test } from "bun:test"
import { KeteLinuxFfi } from "../../src/kete/linux-ffi.js"

const F = KeteLinuxFfi.flagsByArch.x64
const NO = KeteLinuxFfi.RESOLVE_NO_SYMLINKS | KeteLinuxFfi.RESOLVE_BENEATH
const E = KeteLinuxFfi.errno

const recorded = (kinds: Record<string, KeteLinuxFfi.Kind> = {}) => {
  const calls: Array<{ dirfd: number; path: string; flags: number }> = []
  const closed: number[] = []
  const names = new Map<number, string>()
  let next = 10
  const sys = {
    flags: F,
    openat: (dirfd: number, p: string, flags: number) => {
      calls.push({ dirfd, path: p, flags })
      const fd = next++
      names.set(fd, p)
      return { ok: true, value: fd } as const
    },
    close: (fd: number) => (closed.push(fd), { ok: true, value: undefined } as const),
    kind: (fd: number) => ({ ok: true, value: kinds[names.get(fd) ?? ""] ?? "directory" }) as const,
  }
  return { sys, calls, closed }
}

describe("emulateOpenat2", () => {
  test("opens intermediates O_PATH|O_NOFOLLOW, the leaf O_NOFOLLOW, and closes intermediate descriptors", () => {
    const { sys, calls, closed } = recorded()
    expect(KeteLinuxFfi.emulateOpenat2(sys, 3, "a/b/c", F.O_RDONLY, 0, NO)).toEqual({ ok: true, value: 12 })
    expect(calls.map((c) => [c.dirfd, c.path])).toEqual([[3, "a"], [10, "b"], [11, "c"]])
    expect(calls[0]!.flags & (F.O_PATH | F.O_NOFOLLOW)).toBe(F.O_PATH | F.O_NOFOLLOW)
    expect(calls[2]!.flags & F.O_NOFOLLOW).toBe(F.O_NOFOLLOW)
    expect(closed).toEqual([10, 11])
  })

  test("a symlink intermediate is ELOOP and a file intermediate is ENOTDIR, each descriptor closed", () => {
    const link = recorded({ link: "symlink" })
    expect(KeteLinuxFfi.emulateOpenat2(link.sys, 3, "a/link/c", F.O_RDONLY, 0, NO)).toEqual({ ok: false, errno: E.ELOOP })
    expect(link.closed).toEqual([10, 11])
    const file = recorded({ f: "file" })
    expect(KeteLinuxFfi.emulateOpenat2(file.sys, 3, "f/c", F.O_RDONLY, 0, NO)).toEqual({ ok: false, errno: E.ENOTDIR })
  })

  test("with BENEATH an absolute path or .. is EXDEV; without NO_SYMLINKS it is EINVAL", () => {
    const { sys } = recorded()
    expect(KeteLinuxFfi.emulateOpenat2(sys, 3, "/etc", F.O_RDONLY, 0, NO)).toEqual({ ok: false, errno: E.EXDEV })
    expect(KeteLinuxFfi.emulateOpenat2(sys, 3, "a/../b", F.O_RDONLY, 0, NO)).toEqual({ ok: false, errno: E.EXDEV })
    expect(KeteLinuxFfi.emulateOpenat2(sys, 3, "a", F.O_RDONLY, 0, 0)).toEqual({ ok: false, errno: E.EINVAL })
  })

  test("an absolute path without BENEATH starts from an fd for / opened via AT_FDCWD, not from dirfd or .", () => {
    const { sys, calls, closed } = recorded()
    const resolve = KeteLinuxFfi.RESOLVE_NO_SYMLINKS
    expect(KeteLinuxFfi.emulateOpenat2(sys, 3, "/a/b", F.O_RDONLY, 0, resolve)).toEqual({ ok: true, value: 12 })
    expect(calls[0]).toMatchObject({ dirfd: KeteLinuxFfi.AT_FDCWD, path: "/" })
    expect(calls[0]!.flags & (F.O_PATH | F.O_DIRECTORY | F.O_NOFOLLOW)).toBe(F.O_PATH | F.O_DIRECTORY | F.O_NOFOLLOW)
    expect(calls.slice(1).map((c) => [c.dirfd, c.path])).toEqual([[10, "a"], [11, "b"]])
    expect(closed).toEqual([10, 11])
  })

  test("/ alone opens the root, never the cwd", () => {
    const { sys, calls } = recorded()
    expect(KeteLinuxFfi.emulateOpenat2(sys, KeteLinuxFfi.AT_FDCWD, "/", F.O_RDONLY, 0, KeteLinuxFfi.RESOLVE_NO_SYMLINKS).ok).toBe(true)
    expect(calls[0]).toMatchObject({ dirfd: KeteLinuxFfi.AT_FDCWD, path: "/" })
    expect(calls[1]).toMatchObject({ dirfd: 10, path: "." })
  })
})

describe("shouldEmulate", () => {
  test("ENOSYS and EPERM fall back only when fallback is on", () => {
    expect([E.ENOSYS, E.EPERM].map((e) => KeteLinuxFfi.shouldEmulate(e, true))).toEqual([true, true])
    expect([E.ENOSYS, E.EPERM].map((e) => KeteLinuxFfi.shouldEmulate(e, false))).toEqual([false, false])
  })

  test("other errors never fall back", () => {
    expect([E.ENOENT, E.ELOOP, E.EXDEV, E.EACCES].map((e) => KeteLinuxFfi.shouldEmulate(e, true))).toEqual([false, false, false, false])
  })
})
