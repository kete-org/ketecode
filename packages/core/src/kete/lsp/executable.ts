// Finds a language server's program without letting the repository choose it.
//
// The generic `which` (core/src/util/which.ts, the `which` package) searches the current directory
// first on Windows and resolves relative PATH entries against the current directory, so a repository
// could plant `gopls.exe` or `typescript-language-server.cmd` and have it run. This lookup:
// - accepts a command with a path only when it is absolute (from the global config);
// - searches only absolute PATH entries (empty and relative entries are skipped; never the current
//   directory), with PATHEXT on Windows;
// - rejects a result whose real path is inside the workspace.

export * as KeteLspExecutable from "./executable.js"

import fs from "fs/promises"
import path from "path"

export interface Options {
  readonly env: Record<string, string | undefined>
  /** The workspace's real path: programs inside it are never used. */
  readonly workspace: string
  readonly platform?: NodeJS.Platform
}

function inside(file: string, directory: string, pathModule: typeof path.posix) {
  const relative = pathModule.relative(directory, file)
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative))
}

async function usable(file: string, windows: boolean) {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat?.isFile()) return false
  if (windows) return true
  return fs.access(file, fs.constants.X_OK).then(
    () => true,
    () => false,
  )
}

/** The PATH entries searched: absolute ones only, in order, without duplicates. */
export function entries(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform) {
  const windows = platform === "win32"
  const pathModule = windows ? path.win32 : path.posix
  const raw = env.PATH ?? env.Path ?? (windows ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : undefined) ?? ""
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of raw.split(windows ? ";" : ":")) {
    const trimmed = windows ? entry.trim().replace(/^"(.*)"$/, "$1") : entry
    if (trimmed === "" || !pathModule.isAbsolute(trimmed)) continue
    if (windows && !/^([a-zA-Z]:[\\/]|\\\\)/.test(trimmed)) continue // drive-relative ("\\dir") isn't absolute enough
    const key = windows ? trimmed.toLowerCase() : trimmed
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

/** Candidate file names for a command (PATHEXT on Windows when it has no extension). */
export function names(command: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return [command]
  if (path.win32.extname(command) !== "") return [command]
  const pathext = (env.PATHEXT ?? env.PathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.startsWith("."))
  return pathext.map((ext) => command + ext.toLowerCase())
}

/** The program's absolute path, or undefined when there is none we may use. */
export async function find(command: string, options: Options): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  const windows = platform === "win32"
  const pathModule = windows ? path.win32 : path.posix
  const workspace = await fs.realpath(options.workspace).catch(() => pathModule.resolve(options.workspace))
  const accept = async (candidate: string) => {
    if (!(await usable(candidate, windows))) return undefined
    const real = await fs.realpath(candidate).catch(() => undefined)
    if (real === undefined || inside(real, workspace, pathModule)) return undefined
    return candidate
  }
  if (command.includes("/") || (windows && command.includes("\\"))) {
    if (!pathModule.isAbsolute(command)) return undefined
    for (const name of names(command, options.env, platform)) {
      const found = await accept(name)
      if (found) return found
    }
    return undefined
  }
  for (const directory of entries(options.env, platform))
    for (const name of names(command, options.env, platform)) {
      const found = await accept(pathModule.join(directory, name))
      if (found) return found
    }
  return undefined
}
