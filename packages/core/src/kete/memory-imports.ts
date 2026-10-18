// Pure rules for `@path` imports in memory files (AGENTS.md, CLAUDE.md): which tokens are imports and
// which resolved paths may be read into model context. No services; memory-files.ts does the I/O.
//
// An import reads a file into the model's context, so it is a way to leak secrets. A path is read only
// when its realpath is inside an allowed root and names no credential file. Inside `~/.claude/` and the
// global config folder only `*.md` files can be imported: those folders also hold kete.json (MCP headers,
// secrets), settings.json and session transcripts.

export * as KeteMemoryImports from "./memory-imports.js"

import path, { join } from "path"
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
  total: `the imports would exceed ${MAX_TOTAL / 1024} KiB in total`,
  "not-file": "not a regular file",
}

export const note = (token: string, reason: Skip) => `(import of ${token} skipped: ${REASON[reason]})`

export interface Root {
  readonly path: string
  /** Only `*.md` files may be imported from this root (when it is the most specific root holding the file). */
  readonly markdownOnly: boolean
  /** Holds credentials beside markdown (~/.claude, the global config): markdown only, whichever root is more specific. */
  readonly sensitive?: boolean
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

const SECRET_NAME = [
  /^\.env/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_/i,
  /credentials/i,
  /^secrets?([._-]|$)/i,
  /\.tfstate/i,
  /\.tfvars$/i,
  /^\.dev\.vars$/i,
  /history$/i,
  /^\.(npmrc|netrc|pgpass|htpasswd|vault-token|terraformrc|git-credentials|claude\.json)$/i,
  /^kubeconfig$/i,
]
/** Folders that hold credentials: in the home folder, and `.git` anywhere (remote URLs can carry tokens). */
const SECRET_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", join(".config", "gh"), join(".config", "gcloud")]

/**
 * A root that may serve imports: not the home folder or a folder above it, and not a file system root. A
 * project "root" is the cwd when there is no repository, so running in `~` must not make all of home readable.
 */
export const usableRoot = (root: string, home: string) => !FSUtil.contains(root, home) && path.dirname(root) !== root

/** Whether a memory file's real path (a CLAUDE.md, possibly a symlink) may be loaded: a `.md` file inside `bound`, not a secret. */
export const memoryFileAllowed = (real: string, bound: string, home: string) =>
  denied(real, [{ path: bound, markdownOnly: true }], home) === undefined

/** Why the realpath `real` may not be imported, or undefined when it may. */
export function denied(real: string, roots: readonly Root[], home: string): Skip | undefined {
  const inside = roots.filter((item) => FSUtil.contains(item.path, real))
  // The most specific root, so a project that sits in the home folder still checks `.claude` on its own.
  const root = inside.reduce<Root | undefined>((best, item) => (!best || item.path.length > best.path.length ? item : best), undefined)
  if (!root) return "outside"
  if (SECRET_HOME_DIRS.some((dir) => FSUtil.contains(path.join(home, dir), real))) return "secret"
  if (path.relative(root.path, real).split(path.sep).includes(".git")) return "secret"
  // Relative to the root: the matcher's `.config/kete` pattern would reject every global-config import.
  if (KeteShellRisk.credential(path.relative(root.path, real))) return "secret"
  if (SECRET_NAME.some((pattern) => pattern.test(path.basename(real)))) return "secret"
  if ((root.markdownOnly || inside.some((item) => item.sensitive)) && !/\.md$/i.test(real)) return "not-markdown"
  return undefined
}
