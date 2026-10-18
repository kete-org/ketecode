// Where a path really leads once symbolic links are followed, including links whose target doesn't
// exist yet (a write creates it). Used by FileAccess.resolve, to decide inside/outside the workspace by
// the real path, and by KetePermissionMode.realTarget. Through `FSUtil` (wrapped in job mode,
// kete/job-fs-util.ts), never `fs` directly.

export * as KeteRealPath from "./real-path.js"

import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import path from "path"

/** What `follow` returns when a symlink chain can't be followed (a loop or too long). */
export const UNRESOLVED = ".kete/(unresolved symlink)"

/** Symlinks followed for one target before giving up. */
const MAX_LINKS = 32

/**
 * The real absolute path of `target` (absolute). The deepest existing ancestor is resolved with
 * `resolve` (realpath); the remaining components are then walked one at a time the way the kernel
 * does: a symlink among them (including a dangling one like `notes.json -> .kete/kete.jsonc`) is
 * replaced by its target's components, and `..` goes up from the real folder reached so far (never
 * by text: `lnk/../x` with `lnk -> ..` leaves the folder). `undefined` when nothing on the path
 * exists; `UNRESOLVED` after `MAX_LINKS` links.
 */
export const follow = Effect.fnUntraced(function* (
  files: Pick<FSUtil.Interface, "existsSafe" | "resolve" | "readLink">,
  target: string,
) {
  let existing = target
  const queue: string[] = []
  while (!(yield* files.existsSafe(existing))) {
    const parent = path.dirname(existing)
    if (parent === existing) return undefined
    queue.unshift(path.basename(existing))
    existing = parent
  }
  // `current` never contains a symlink, so going up from it by text is what the kernel does.
  let current = yield* files.resolve(existing)
  let links = 0
  while (queue.length > 0) {
    const part = queue.shift()!
    if (part === "" || part === ".") continue
    if (part === "..") {
      current = path.dirname(current)
      continue
    }
    const candidate = path.join(current, part)
    const link = yield* files.readLink(candidate).pipe(Effect.option)
    if (link._tag === "None") {
      current = candidate
      continue
    }
    if (++links > MAX_LINKS) return UNRESOLVED
    const root = path.parse(link.value).root
    if (root !== "") current = root
    queue.unshift(...link.value.slice(root.length).split(/[\\/]/))
  }
  return current
})

/** Whether `real` (a `follow` result) is inside one of `roots`, compared by the roots' real paths too. */
export const inside = Effect.fnUntraced(function* (
  files: Pick<FSUtil.Interface, "resolve">,
  real: string,
  roots: ReadonlyArray<string>,
) {
  for (const root of roots) {
    // A project at a file-system root must not make every path "inside".
    if (path.dirname(root) === root) continue
    if (FSUtil.contains(root, real) || FSUtil.contains(yield* files.resolve(root), real)) return true
  }
  return false
})
