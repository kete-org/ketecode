// Pure rules for `@path` imports in memory files (AGENTS.md, CLAUDE.md): which tokens are imports and
// which resolved paths may be read into model context. No services; memory-files.ts does the I/O.
//
// An import reads a file into the model's context, so it is a way to leak secrets. A path is read only
// when its realpath is inside an allowed root and names no credential file. Inside `~/.claude/` and the
// global config folder only `*.md` files can be imported: those folders also hold kete.json (MCP headers,
// secrets), settings.json and session transcripts.

export * as KeteMemoryImports from "./memory-imports.js"

import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import { KeteShellRisk } from "./shell-risk.js"

export const MAX_DEPTH = 5
export const MAX_FILE = 64 * 1024
export const MAX_TOTAL = 256 * 1024

export type Skip = "outside" | "secret" | "not-markdown" | "too-large" | "total" | "not-file"

const REASON: Record<Skip, string> = {
  outside: "outside the allowed folders",
  secret: "looks like a secret or credential file",
  "not-markdown": "only .md files can be imported from here",
  "too-large": `larger than ${MAX_FILE / 1024} KiB`,
  total: `the imports of this memory file would exceed ${MAX_TOTAL / 1024} KiB`,
  "not-file": "not a regular file",
}

export const note = (token: string, reason: Skip) => `(import of ${token} skipped: ${REASON[reason]})`

export interface Root {
  readonly path: string
  /** Only `*.md` files may be imported from this root. */
  readonly markdownOnly: boolean
}

/** The `@path` tokens of a memory file, in order. Code fences and inline code spans don't count. */
export function importTokens(text: string): string[] {
  const tokens: string[] = []
  let fence: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1]
    if (marker) {
      if (fence === undefined) fence = marker
      else if (fence === marker) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    for (const match of line.replace(/`[^`]*`/g, "").matchAll(/(?:^|\s)@(\S+)/g)) {
      const token = match[1]!.replace(/[.,;:)\]]+$/, "")
      if (/^(~\/|[\w./])/.test(token)) tokens.push(token)
    }
  }
  return tokens
}

/** The absolute path a token names, before realpath resolution. */
export function target(token: string, importerDir: string, home: string) {
  return token.startsWith("~/") ? path.join(home, token.slice(2)) : path.resolve(importerDir, token)
}

const SECRET_NAME = [/^\.env/i, /\.(pem|key)$/i, /^id_/i, /credentials/i, /^\.(npmrc|netrc)$/i]

/** Why the realpath `real` may not be imported, or undefined when it may. */
export function denied(real: string, roots: readonly Root[], home: string): Skip | undefined {
  const inside = roots.filter((item) => FSUtil.contains(item.path, real))
  // The most specific root, so a project that sits in the home folder still checks `.claude` on its own.
  const root = inside.reduce<Root | undefined>((best, item) => (!best || item.path.length > best.path.length ? item : best), undefined)
  if (!root) return "outside"
  if ([".ssh", ".aws", ".gnupg"].some((dir) => FSUtil.contains(path.join(home, dir), real))) return "secret"
  // Relative to the root: the matcher's `.config/kete` pattern would reject every global-config import.
  if (KeteShellRisk.credential(path.relative(root.path, real))) return "secret"
  if (SECRET_NAME.some((pattern) => pattern.test(path.basename(real)))) return "secret"
  if (inside.some((item) => item.markdownOnly) && !/\.md$/i.test(real)) return "not-markdown"
  return undefined
}
