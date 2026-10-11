// The release notes a build embeds (`KETE_RELEASE_NOTES`, packages/cli/script/build.ts): the root
// CHANGELOG.md section for the version being built, or `## Unreleased` for a preview build. A missing
// file or section embeds nothing; it never fails the build (docs/release.md; the release workflow
// checks stable tags separately with `changelog:check`).

import { readFileSync } from "node:fs"
import path from "node:path"
import { KeteChangelog } from "@opencode/util/kete/changelog"

export const changelogPath = path.resolve(import.meta.dirname, "../../../CHANGELOG.md")

export function releaseNotesFor(file: string, version: string, preview: boolean) {
  const text = (() => {
    try {
      return readFileSync(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  })()
  return KeteChangelog.notesFor(text, version, preview)
}
