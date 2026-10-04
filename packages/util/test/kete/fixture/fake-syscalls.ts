// An in-memory kernel for KeteConfinedFs tests (job mode piece A3): a tree of directories, files,
// symlinks, FIFOs, sockets and "magic links" (like /proc/self/root), with `openat2`'s RESOLVE_*
// rules implemented the way openat2(2) documents them, EAGAIN injection, an ENOSYS mode, and a
// count of open descriptors so tests can assert every descriptor was closed.

import { KeteLinuxFfi } from "../../../src/kete/linux-ffi.js"

type Node =
  | { kind: "dir"; parent: Dir | undefined; children: Map<string, Node>; mtimeMs: number }
  | { kind: "file"; parent: Dir | undefined; data: Uint8Array; mtimeMs: number }
  | { kind: "symlink"; parent: Dir | undefined; target: string; mtimeMs: number }
  | { kind: "magic"; parent: Dir | undefined; mtimeMs: number }
  | { kind: "fifo"; parent: Dir | undefined; mtimeMs: number }
  | { kind: "socket"; parent: Dir | undefined; mtimeMs: number }
type Dir = Extract<Node, { kind: "dir" }>

type Open = { node: Node; path: boolean; offset: number; cursor: number }

const E = KeteLinuxFfi.errno
const F = KeteLinuxFfi.flagsByArch.x64
const fail = (errno: number) => ({ ok: false as const, errno })
const ok = <A>(value: A) => ({ ok: true as const, value })

export interface FakeOptions {
  /** The absolute path `openat2(AT_FDCWD, …)` resolves to the tree's root. */
  readonly rootPath: string
  /** Every openat2 call fails with ENOSYS. */
  readonly enosys?: boolean
  /** The probe (the second openat2 call) fails with this errno. */
  readonly probeErrno?: number
  /** getdents64 reports DT_UNKNOWN for every entry. */
  readonly unknownTypes?: boolean
}

export function makeFake(options: FakeOptions) {
  const root: Dir = { kind: "dir", parent: undefined, children: new Map(), mtimeMs: 1 }
  const fds = new Map<number, Open>()
  let nextFd = 100
  let eagain = 0
  let calls = 0
  let beforeOpen: ((dirfd: number, path: string) => void) | undefined

  const parts = (value: string) => value.split("/").filter((part) => part !== "" && part !== ".")

  /** Test helper: the node at a root-relative path (no symlink following). */
  const at = (rel: string): Node | undefined => {
    let node: Node = root
    for (const part of parts(rel)) {
      if (node.kind !== "dir") return undefined
      const next = node.children.get(part)
      if (next === undefined) return undefined
      node = next
    }
    return node
  }

  const ensureDir = (rel: string): Dir => {
    let node: Dir = root
    for (const part of parts(rel)) {
      let next = node.children.get(part)
      if (next === undefined) {
        next = { kind: "dir", parent: node, children: new Map(), mtimeMs: 1 }
        node.children.set(part, next)
      }
      if (next.kind !== "dir") throw new Error(`${rel}: not a directory`)
      node = next
    }
    return node
  }

  const place = (rel: string, make: (parent: Dir) => Node) => {
    const all = parts(rel)
    const name = all.pop()!
    const parent = ensureDir(all.join("/"))
    parent.children.set(name, make(parent))
  }

  const tree = {
    dir: (rel: string) => void ensureDir(rel),
    file: (rel: string, content: string | Uint8Array = "") =>
      place(rel, (parent) => ({ kind: "file", parent, data: typeof content === "string" ? new TextEncoder().encode(content) : content, mtimeMs: 2 })),
    symlink: (rel: string, target: string) => place(rel, (parent) => ({ kind: "symlink", parent, target, mtimeMs: 3 })),
    magic: (rel: string) => place(rel, (parent) => ({ kind: "magic", parent, mtimeMs: 4 })),
    fifo: (rel: string) => place(rel, (parent) => ({ kind: "fifo", parent, mtimeMs: 5 })),
    socket: (rel: string) => place(rel, (parent) => ({ kind: "socket", parent, mtimeMs: 6 })),
    remove: (rel: string) => {
      const all = parts(rel)
      const name = all.pop()!
      const parent = at(all.join("/"))
      if (parent?.kind === "dir") parent.children.delete(name)
    },
    at,
    text: (rel: string) => {
      const node = at(rel)
      return node?.kind === "file" ? new TextDecoder().decode(node.data) : undefined
    },
  }

  const allocate = (node: Node, path: boolean) => {
    const fd = nextFd++
    fds.set(fd, { node, path, offset: 0, cursor: 0 })
    return fd
  }

  const kindOf = (node: Node): KeteLinuxFfi.Kind =>
    node.kind === "dir" ? "directory" : node.kind === "file" ? "file" : node.kind === "symlink" ? "symlink" : "other"

  const openat2: KeteLinuxFfi.Syscalls["openat2"] = (dirfd, path, flags, mode, resolve) => {
    calls++
    if (options.enosys) return fail(E.ENOSYS)
    if (calls === 2 && options.probeErrno !== undefined) return fail(options.probeErrno)
    if (mode !== 0 && (flags & F.O_CREAT) === 0) return fail(E.EINVAL)
    beforeOpen?.(dirfd, path)
    if (eagain > 0) {
      eagain--
      return fail(E.EAGAIN)
    }
    const beneath = (resolve & KeteLinuxFfi.RESOLVE_BENEATH) !== 0
    const noSymlinks = (resolve & KeteLinuxFfi.RESOLVE_NO_SYMLINKS) !== 0
    const noMagic = noSymlinks || (resolve & KeteLinuxFfi.RESOLVE_NO_MAGICLINKS) !== 0

    let start: Node
    let rest = path
    if (dirfd === KeteLinuxFfi.AT_FDCWD) {
      if (!path.startsWith("/")) return fail(E.EINVAL)
      if (path !== options.rootPath) return fail(E.ENOENT)
      start = root
      rest = "."
    } else {
      const open = fds.get(dirfd)
      if (open === undefined) return fail(E.EBADF)
      if (open.node.kind !== "dir") return fail(E.ENOTDIR)
      if (path.startsWith("/")) return beneath ? fail(E.EXDEV) : fail(E.EINVAL)
      start = open.node
    }

    const components = rest.split("/").filter((part) => part !== "" && part !== ".")
    let node: Node = start
    let depth = 0
    for (let index = 0; index < components.length; index++) {
      const part = components[index]!
      const final = index === components.length - 1
      if (node.kind !== "dir") return fail(E.ENOTDIR)
      if (part === "..") {
        if (beneath && depth === 0) return fail(E.EXDEV)
        node = node.parent ?? node
        depth = Math.max(0, depth - 1)
        continue
      }
      const child: Node | undefined = node.children.get(part)
      if (child === undefined) {
        if (final && (flags & F.O_CREAT) !== 0) {
          const created: Node = { kind: "file", parent: node, data: new Uint8Array(0), mtimeMs: 7 }
          node.children.set(part, created)
          return ok(allocate(created, false))
        }
        return fail(E.ENOENT)
      }
      if (child.kind === "magic") {
        if (noMagic) return fail(E.ELOOP)
        return fail(E.EXDEV)
      }
      if (child.kind === "symlink") {
        if (final && (flags & F.O_PATH) !== 0 && (flags & F.O_NOFOLLOW) !== 0) return ok(allocate(child, true))
        if (noSymlinks || (final && (flags & F.O_NOFOLLOW) !== 0)) return fail(E.ELOOP)
        return fail(E.EINVAL) // the fake never follows links
      }
      node = child
      depth++
    }
    if ((flags & F.O_DIRECTORY) !== 0 && node.kind !== "dir") return fail(E.ENOTDIR)
    const isPath = (flags & F.O_PATH) !== 0
    if (!isPath && node.kind === "socket") return fail(E.ENXIO)
    if (!isPath && node.kind === "dir" && (flags & 3) !== F.O_RDONLY) return fail(E.EISDIR)
    if (!isPath && node.kind === "fifo" && (flags & 3) === F.O_WRONLY && (flags & F.O_NONBLOCK) !== 0) return fail(E.ENXIO)
    if (!isPath && node.kind === "file" && (flags & F.O_TRUNC) !== 0) node.data = new Uint8Array(0)
    return ok(allocate(node, isPath))
  }

  const sys: KeteLinuxFfi.Syscalls = {
    flags: F,
    openat2,
    getdents64: (fd, buffer) => {
      const open = fds.get(fd)
      if (open === undefined) return fail(E.EBADF)
      if (open.path) return fail(E.EBADF)
      if (open.node.kind !== "dir") return fail(E.ENOTDIR)
      const entries: Array<[string, Node]> = [
        [".", open.node],
        ["..", open.node.parent ?? open.node],
        ...open.node.children.entries(),
      ]
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      let offset = 0
      while (open.cursor < entries.length) {
        const [name, node] = entries[open.cursor]!
        const bytes = new TextEncoder().encode(name)
        const reclen = Math.ceil((19 + bytes.length + 1) / 8) * 8
        if (offset + reclen > buffer.byteLength) break
        buffer.fill(0, offset, offset + reclen)
        view.setBigUint64(offset, 1n, true)
        view.setBigInt64(offset + 8, BigInt(open.cursor + 1), true)
        view.setUint16(offset + 16, reclen, true)
        const DT = KeteLinuxFfi.DT
        const type = options.unknownTypes
          ? DT.UNKNOWN
          : node.kind === "dir"
            ? DT.DIR
            : node.kind === "file"
              ? DT.REG
              : node.kind === "symlink" || node.kind === "magic"
                ? DT.LNK
                : node.kind === "fifo"
                  ? DT.FIFO
                  : DT.SOCK
        view.setUint8(offset + 18, type)
        buffer.set(bytes, offset + 19)
        offset += reclen
        open.cursor++
      }
      return ok(offset)
    },
    mkdirat: (dirfd, name, _mode) => {
      const open = fds.get(dirfd)
      if (open === undefined) return fail(E.EBADF)
      if (open.node.kind !== "dir") return fail(E.ENOTDIR)
      if (open.node.children.has(name)) return fail(E.EEXIST)
      open.node.children.set(name, { kind: "dir", parent: open.node, children: new Map(), mtimeMs: 8 })
      return ok(undefined)
    },
    unlinkat: (dirfd, name, flags) => {
      const open = fds.get(dirfd)
      if (open === undefined) return fail(E.EBADF)
      if (open.node.kind !== "dir") return fail(E.ENOTDIR)
      const child = open.node.children.get(name)
      if (child === undefined) return fail(E.ENOENT)
      if ((flags & KeteLinuxFfi.AT_REMOVEDIR) !== 0) {
        if (child.kind !== "dir") return fail(E.ENOTDIR)
        if (child.children.size > 0) return fail(E.ENOTEMPTY)
      } else if (child.kind === "dir") return fail(E.EISDIR)
      open.node.children.delete(name)
      return ok(undefined)
    },
    renameat: (fromDirfd, fromName, toDirfd, toName) => {
      const from = fds.get(fromDirfd)
      const to = fds.get(toDirfd)
      if (from === undefined || to === undefined) return fail(E.EBADF)
      if (from.node.kind !== "dir" || to.node.kind !== "dir") return fail(E.ENOTDIR)
      const child = from.node.children.get(fromName)
      if (child === undefined) return fail(E.ENOENT)
      from.node.children.delete(fromName)
      child.parent = to.node
      to.node.children.set(toName, child)
      return ok(undefined)
    },
    setCloexec: (fd) => (fds.has(fd) ? ok(undefined) : fail(E.EBADF)),
    fstat: async (fd) => {
      const open = fds.get(fd)
      if (open === undefined) return fail(E.EBADF)
      const node = open.node
      return ok({ type: kindOf(node), size: node.kind === "file" ? node.data.byteLength : 0, mtimeMs: node.mtimeMs })
    },
    pread: async (fd, buffer, position) => {
      const open = fds.get(fd)
      if (open === undefined || open.path) return fail(E.EBADF)
      if (open.node.kind === "dir") return fail(E.EISDIR)
      if (open.node.kind !== "file") return ok(0)
      const from = position ?? open.offset
      const slice = open.node.data.subarray(from, from + buffer.byteLength)
      buffer.set(slice)
      if (position === null) open.offset += slice.byteLength
      return ok(slice.byteLength)
    },
    writeAll: async (fd, bytes) => {
      const open = fds.get(fd)
      if (open === undefined || open.path) return fail(E.EBADF)
      if (open.node.kind !== "file") return fail(E.EINVAL)
      const next = new Uint8Array(open.node.data.byteLength + bytes.byteLength)
      next.set(open.node.data)
      next.set(bytes, open.node.data.byteLength)
      open.node.data = next
      return ok(undefined)
    },
    close: (fd) => (fds.delete(fd) ? ok(undefined) : fail(E.EBADF)),
  }

  return {
    sys,
    tree,
    /** Descriptors currently open (the root's own included, once opened). */
    openCount: () => fds.size,
    /** The next `count` openat2 calls fail with EAGAIN. */
    injectEagain: (count: number) => {
      eagain = count
    },
    /** Runs before every openat2 resolution (to swap a link in mid-operation). */
    onOpen: (hook: ((dirfd: number, path: string) => void) | undefined) => {
      beforeOpen = hook
    },
  }
}
