// Directory changes the shell parser can't resolve (PR #20 review). Upstream's `shell/parse.ts` turns
// `cd <dir>` into a directory the shell tool checks with `external_directory`, but `cd` with no
// argument (home), `cd -` / `pushd +1` (an earlier directory) and `cd $X` (unknown) gave no directory,
// so `cd; cat Documents/x` read outside the workspace without asking. These return a directory that
// stands for where the shell may end up — home, or the filesystem root when it can't be known — so
// the existing `external_directory` check asks.

export * as KeteShellDirectory from "./shell-directory.js"

import os from "os"
import path from "path"
import { KeteShellRisk } from "./shell-risk.js"

const STACK_ONLY = new Set(["popd", "dirs"])

/** Extra directories for one POSIX directory-change command (`words[0]` is the command name). */
export function implicit(words: ReadonlyArray<string>, cwd: string): string[] {
  const name = words[0] ?? ""
  if (STACK_ONLY.has(name)) return []
  const args = words.slice(1).filter((word) => word !== "--" && !/^-[LPe@]+$/.test(word))
  const target = args[0]
  if (target === undefined) return [os.homedir()]
  const text = target.replace(/^(['"])(.*)\1$/, "$2")
  if (text === "") return []
  if (text === "-" || /^[+-]\d+$/.test(text) || /^~[+-]/.test(text) || text.includes("$") || text.includes("`"))
    return [path.parse(path.resolve(cwd)).root]
  return []
}

/** `implicit` for a command's source text (the tree-sitter parts drop number-only words like `123`). */
export function implicitText(text: string, cwd: string): string[] {
  const parsed = KeteShellRisk.tokenize(text, { posix: true })
  if (!parsed.ok) return [path.parse(path.resolve(cwd)).root]
  const words = parsed.segments[0]?.words.map((word) => (word.expands ? "$" : word.value)) ?? []
  const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  return implicit(start === -1 ? [] : words.slice(start), cwd)
}
