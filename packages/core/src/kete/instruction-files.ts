// Which AGENTS.md files may be loaded as instructions. An instruction file comes from the repository, and
// a repository can ship `AGENTS.md -> ../.ssh/id_rsa`: following that link would put the target into the
// model's context with no prompt. An AGENTS.md is loaded only when its real path is a non-secret `.md`
// file inside the repository (or, for a folder above the repository, inside that folder): the same rule
// kete/memory-files.ts applies to CLAUDE.md. The global AGENTS.md is the person's own and is not checked.

export * as KeteInstructionFiles from "./instruction-files.js"

import { dirname } from "path"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import { KeteMemoryImports } from "./memory-imports.js"

/** The real path of `file` (an AGENTS.md as found, possibly a symlink) when it may be loaded, else undefined. */
export const allowed = Effect.fn("KeteInstructionFiles.allowed")(function* (
  fs: FSUtil.Interface,
  file: string,
  root: string,
  homeDirectory: string,
) {
  const home = yield* fs.resolve(homeDirectory)
  const real = yield* fs.resolve(file)
  const folder = yield* fs.resolve(dirname(file))
  const top = yield* fs.resolve(root)
  const bound = FSUtil.contains(top, folder) ? top : folder
  if (KeteMemoryImports.memoryFileAllowed(real, bound, home)) return real
  yield* Effect.logWarning("instruction file skipped", { path: file, reason: "it links outside its folder or to a non-markdown file" })
  return undefined
})
