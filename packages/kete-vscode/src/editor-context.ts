// What the chat is told about the editor: the active file and selection, shared automatically as one
// context item in the prompt (like the "current file" in other editor chats). Only workspace files
// are shared; secrets and anything `files.exclude` hides are never shared. Kept free of `vscode`.

export type EditorContext = { readonly path: string; readonly startLine?: number; readonly endLine?: number }

/** Names that usually hold secrets: never shared automatically (they can still be sent explicitly). */
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc)$/i

export function editorContext(input: {
  /** The document's URI scheme; only real files are shared. */
  readonly scheme: string
  /** Workspace-relative path with forward slashes, or undefined outside the workspace. */
  readonly relative: string | undefined
  /** `files.exclude` patterns that are on. */
  readonly exclude: readonly string[]
  /** Zero-based selection lines; `empty` when nothing is selected. */
  readonly selection: { readonly start: number; readonly end: number; readonly endCharacter: number; readonly empty: boolean }
}): EditorContext | undefined {
  if (input.scheme !== "file" || !input.relative) return undefined
  if (SECRET.test(input.relative)) return undefined
  if (input.exclude.some((pattern) => glob(pattern).test(input.relative!))) return undefined
  if (input.selection.empty) return { path: input.relative }
  // A selection ending at column 0 of a later line doesn't include that line.
  const end =
    input.selection.endCharacter === 0 && input.selection.end > input.selection.start ? input.selection.end : input.selection.end + 1
  return { path: input.relative, startLine: input.selection.start + 1, endLine: end }
}

export function same(a: EditorContext | undefined, b: EditorContext | undefined) {
  return a?.path === b?.path && a?.startLine === b?.startLine && a?.endLine === b?.endLine
}

/** A VS Code glob (`**`, `*`, `?`, `{a,b}`) as a regular expression over a whole relative path. */
export function glob(pattern: string) {
  const source = pattern.replace(/^\.\//, "").replace(/\/$/, "")
  let regex = ""
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (character === "*" && source[index + 1] === "*") {
      const slash = source[index + 2] === "/"
      regex += slash ? "(?:.*/)?" : ".*"
      index += slash ? 2 : 1
    } else if (character === "*") regex += "[^/]*"
    else if (character === "?") regex += "[^/]"
    else if (character === "{") {
      const close = source.indexOf("}", index)
      if (close === -1) regex += "\\{"
      else {
        regex += `(?:${source
          .slice(index + 1, close)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"))
          .join("|")})`
        index = close
      }
    } else regex += character.replace(/[.+^$()|[\]\\]/g, "\\$&")
  }
  // A pattern matching a folder also covers everything inside it.
  return new RegExp(`^${regex}(?:/.*)?$`)
}
