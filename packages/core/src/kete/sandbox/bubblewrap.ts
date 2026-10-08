// Linux: bubblewrap (`bwrap`) arguments (ADR 0013). The command sees the whole file system read-only,
// with the writable roots bound back read-write and the protected paths bound read-only on top.
// New PID, IPC and (without network) network namespaces: it can't see or signal the runtime or read
// `/proc/<pid>/environ` of other processes, and without network it has only its own loopback.
//
// bwrap binds paths that exist. Missing protected paths (a `kete.jsonc` that isn't there yet) are
// created by the caller as empty, unreadable placeholders before the command and removed after it
// (resolve.ts); bwrap then binds them read-only (files: /dev/null, plus a copy of git's exclude list
// naming them, so `git add -A` skips them), so the command can't create the real file.
// Because bwrap takes arguments, not a profile, nothing in a path can be read as an option or rule:
// every path follows its option as a separate argument and is checked to be absolute.

export * as KeteBubblewrap from "./bubblewrap.js"

import { checkPath, type Policy } from "./policy.js"

export const name = "bwrap"

const depth = (value: string) => value.split("/").filter((part) => part !== "").length
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/")

/**
 * The arguments before the command. Mounts are applied parent first (by path depth), so a deeper rule
 * wins: a workspace inside Kete Code's data directory (a Kete worktree) is writable although the data
 * directory is hidden and read-only, and the workspace's `.git/config` is read-only again inside it.
 * bwrap takes every source from the host's file system, so binding below a tmpfs works.
 */
export function args(policy: Policy, cwd: string): string[] {
  // --new-session: no controlling terminal to inject keystrokes into (TIOCSTI), defence in depth.
  const out: string[] = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc"]
  if (!policy.network) out.push("--unshare-net")
  out.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc")

  type Mount = { readonly target: string; readonly rank: number; readonly args: string[] }
  const mounts: Mount[] = []
  const add = (target: string, rank: number, args: string[]) => mounts.push({ target: checkPath(target), rank, args })
  const hiddenDirectories = policy.hidden.filter((item) => item.directory).map((item) => item.path)
  // A read-only rule inside a hidden directory would bring its content back: hidden is read-only anyway.
  const hidden = (value: string) => hiddenDirectories.some((directory) => within(value, directory))
  for (const value of policy.tmpfs) add(value, 0, ["--tmpfs", value])
  for (const item of policy.hidden)
    if (item.directory) add(item.path, 0, ["--tmpfs", item.path])
    else add(item.path, 0, ["--ro-bind", "/dev/null", item.path])
  for (const value of policy.writable) add(value, 1, ["--bind", value, value])
  for (const value of policy.pinned) add(value, 2, ["--bind", value, value])
  for (const value of policy.readOnly) if (!hidden(value) || policy.writable.some((root) => within(value, root) && hidden(root))) add(value, 3, ["--ro-bind", value, value])
  for (const value of policy.masked) add(value, 4, ["--ro-bind", "/dev/null", value])
  for (const item of policy.overlays) add(item.target, 4, ["--ro-bind", checkPath(item.source), item.target])
  for (const value of policy.visible) add(value, 5, ["--ro-bind", value, value])
  mounts
    .map((mount, index) => ({ mount, index }))
    .sort((a, b) => depth(a.mount.target) - depth(b.mount.target) || a.mount.rank - b.mount.rank || a.index - b.index)
    .forEach(({ mount }) => out.push(...mount.args))
  // Last, so the binds inside them could still be created.
  for (const directory of hiddenDirectories) out.push("--remount-ro", directory)
  out.push("--chdir", checkPath(cwd))
  return out
}

/** `bwrap` arguments that run `file args…` under `policy` in `cwd`. */
export function command(executable: string, policy: Policy, cwd: string, file: string, args_: ReadonlyArray<string>) {
  return { file: executable, args: [...args(policy, cwd), "--", file, ...args_] }
}
