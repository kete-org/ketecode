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

/** The arguments before the command. */
export function args(policy: Policy, cwd: string): string[] {
  const out: string[] = ["--die-with-parent", "--unshare-pid", "--unshare-ipc"]
  if (!policy.network) out.push("--unshare-net")
  out.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc")
  const bind = (option: string, value: string) => out.push(option, checkPath(value), value)
  for (const value of policy.writable) bind("--bind", value)
  for (const value of policy.pinned) bind("--bind", value)
  for (const value of policy.readOnly) bind("--ro-bind", value)
  for (const value of policy.masked) out.push("--ro-bind", "/dev/null", checkPath(value))
  for (const item of policy.overlays) out.push("--ro-bind", checkPath(item.source), checkPath(item.target))
  const files = policy.hidden.filter((item) => !item.directory)
  const directories = policy.hidden.filter((item) => item.directory)
  for (const item of files) out.push("--ro-bind", "/dev/null", checkPath(item.path))
  for (const item of directories) out.push("--tmpfs", checkPath(item.path))
  // Exceptions are bound into the (still writable) tmpfs before it is made read-only.
  for (const value of policy.visible) bind("--ro-bind", value)
  for (const item of directories) out.push("--remount-ro", item.path)
  out.push("--chdir", checkPath(cwd))
  return out
}

/** `bwrap` arguments that run `file args…` under `policy` in `cwd`. */
export function command(executable: string, policy: Policy, cwd: string, file: string, args_: ReadonlyArray<string>) {
  return { file: executable, args: [...args(policy, cwd), "--", file, ...args_] }
}
