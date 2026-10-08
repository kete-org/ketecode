// What a sandboxed command may do (ADR 0013): the platform-neutral description that seatbelt.ts
// (macOS) and bubblewrap.ts (Linux) turn into a profile or an argument list. Every path here is
// absolute and already resolved (symlinks followed): sandbox-exec matches real paths, and bwrap
// binds what exists.

export * as KeteSandboxPolicy from "./policy.js"

export interface Hidden {
  readonly path: string
  /** bwrap hides a directory under an empty tmpfs and a file behind /dev/null. */
  readonly directory: boolean
}

export interface Policy {
  /** The workspace root (the project's worktree): writable, its git internals protected at any depth. */
  readonly workspace: string
  /** Writable roots: the workspace, temp directories, caches, `allowWrite`, an external git directory. */
  readonly writable: ReadonlyArray<string>
  /** Paths that stay read-only inside writable roots: Kete Code's own directories, git internals,
   * the hooks path, `denyWrite`, and (Linux) Kete configuration names in the config search path. */
  readonly readOnly: ReadonlyArray<string>
  /** Git directories outside the workspace (a linked worktree's) whose internals are protected. */
  readonly gitDirectories: ReadonlyArray<string>
  /** Linux: directories bound onto themselves so they can't be renamed or replaced (`.git`). */
  readonly pinned: ReadonlyArray<string>
  /** Linux: placeholders for missing protected files, covered with /dev/null. A character device is
   * invisible to `git status` and `git add -A`; a read-only regular file there would make them fail. */
  readonly masked: ReadonlyArray<string>
  /** Linux: files bound read-only over others (git's exclude list with the placeholders added). */
  readonly overlays: ReadonlyArray<{ readonly source: string; readonly target: string }>
  /** Credential paths that can't be read. */
  readonly hidden: ReadonlyArray<Hidden>
  /** Exceptions inside hidden paths (e.g. `~/.ssh/known_hosts`). */
  readonly visible: ReadonlyArray<string>
  /** Whether the command may use the network. Without it, only this machine (macOS: loopback and
   * Unix sockets in `sockets`; Linux: the sandbox's own loopback) is reachable. */
  readonly network: boolean
  /** macOS without network: where Unix sockets may still be connected (workspace, temp). */
  readonly sockets: ReadonlyArray<string>
}

/** A path sandbox-exec or bwrap can't be given safely (control characters, relative). */
export class UnsafePathError extends Error {
  constructor(readonly value: string) {
    super(`The sandbox can't use this path: ${JSON.stringify(value.length > 120 ? value.slice(0, 120) + "…" : value)}`)
    this.name = "KeteSandbox.UnsafePathError"
  }
}

/** Absolute, and no control characters (a newline or NUL has no safe meaning in a profile or bind). */
export function checkPath(value: string) {
  if (!value.startsWith("/") || /[\u0000-\u001f\u007f]/.test(value)) throw new UnsafePathError(value)
  return value
}
