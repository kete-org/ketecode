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

const STACK_ONLY = new Set(["popd", "dirs", "pop-location"])

const root = (cwd: string) => path.parse(path.resolve(cwd)).root

/** A target word, as the tokenizer read it. */
export interface Target {
  readonly value: string
  /** `$name`, `${…}` or `$((…))` — unknown before the command runs. */
  readonly expands?: boolean
  /** Unquoted `{a,b}` — several targets. */
  readonly brace?: boolean
  /** Unquoted `*`, `?`, `[` — whatever matches. */
  readonly glob?: boolean
  /** Quoted or escaped somewhere: a quoted `~` is a literal directory name. */
  readonly quoted?: boolean
}

/**
 * Extra directories for one POSIX directory-change command (`words[0]` is the command name): home
 * for no target, the filesystem root ("anywhere") for one that can't be known — `-`, `+N`, `~+`,
 * `~user`, a variable, brace expansion, a glob, or any target when `CDPATH` is set for the command.
 */
export function implicit(words: ReadonlyArray<string | Target>, cwd: string, options: { readonly cdpath?: boolean } = {}): string[] {
  const all = words.map((word): Target => (typeof word === "string" ? { value: word } : word))
  const name = all[0]?.value ?? ""
  if (STACK_ONLY.has(name)) return []
  const args = all.slice(1).filter((word) => word.value !== "--" && !/^-[LPe@]+$/.test(word.value))
  const target = args[0]
  if (target === undefined) return [os.homedir()]
  const text = target.value.replace(/^(['"])(.*)\1$/, "$2")
  if (options.cdpath && !text.startsWith("/") && !text.startsWith(".")) return [root(cwd)]
  if (text === "") return []
  if (target.expands || target.brace || target.glob) return [root(cwd)]
  if (text === "-" || /^[+-]\d+$/.test(text) || text.includes("$") || text.includes("`")) return [root(cwd)]
  // `~` and `~/x` are expanded by the parser; `~+`, `~-`, `~user` aren't.
  if (!target.quoted && text.startsWith("~") && text !== "~" && !text.startsWith("~/")) return [root(cwd)]
  return []
}

/** `implicit` for a command's source text (the tree-sitter parts drop number-only words like `123`). */
export function implicitText(text: string, cwd: string): string[] {
  const parsed = KeteShellRisk.tokenize(text, { posix: true })
  if (!parsed.ok) return [root(cwd)]
  const words = parsed.segments[0]?.words ?? []
  const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value))
  const cdpath = words.slice(0, start === -1 ? words.length : start).some((word) => /^CDPATH=/.test(word.value))
  return implicit(start === -1 ? [] : words.slice(start), cwd, { cdpath })
}

/** PowerShell `Set-Location`/`cd`/`sl`/`chdir`/`Push-Location`: no path or `-`/`+` (history) → anywhere. */
export function implicitPowerShell(words: ReadonlyArray<string>, cwd: string): string[] {
  const name = (words[0] ?? "").toLowerCase()
  if (STACK_ONLY.has(name)) return []
  const rest = words.slice(1)
  const positional = rest.filter((word) => !(word.startsWith("-") && word !== "-"))
  const explicit = rest.some((word) => /^-(literal)?path(:|$)/i.test(word))
  if (!explicit && positional.length === 0) return [root(cwd)]
  if (positional.some((word) => word === "-" || word === "+")) return [root(cwd)]
  return []
}
