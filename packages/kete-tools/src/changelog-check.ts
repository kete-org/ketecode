#!/usr/bin/env bun
// Refuses to release a stable version whose notes aren't in the root CHANGELOG.md: the binary embeds
// that section (`/release-notes`, shown once after an upgrade), so a stable tag without one would ship
// no notes. Pre-release tags (`kete-v0.3.0-rc.1`) pass: their builds fall back to `## Unreleased`.
// Called by `.github/workflows/kete-release.yml` before the build; runbook: docs/release.md.
//
//   bun run --cwd packages/kete-tools changelog:check kete-vX.Y.Z

import fs from "node:fs"
import path from "node:path"
import { KeteChangelog } from "@opencode/util/kete/changelog"
import { releaseVersion } from "./release"

export const changelogPath = path.resolve(import.meta.dir, "../../../CHANGELOG.md")

export type Result = { ok: true; message: string } | { ok: false; message: string }

/** Whether the release `tag` may be built with this CHANGELOG text (undefined: the file is missing). */
export function checkChangelog(tag: string, text: string | undefined): Result {
  const version = releaseVersion(tag)
  if (!version) return { ok: false, message: `${tag || "(empty)"} is not a kete-vX.Y.Z tag` }
  if (KeteChangelog.isPrerelease(version))
    return { ok: true, message: `${version} is a pre-release: its build uses the "## ${KeteChangelog.UNRELEASED}" notes` }
  if (text === undefined) return { ok: false, message: "CHANGELOG.md is missing" }
  const notes = KeteChangelog.section(text, version)
  if (notes === undefined)
    return {
      ok: false,
      message: `CHANGELOG.md has no "## ${version}" section. Rename "## ${KeteChangelog.UNRELEASED}" to "## ${version}" before tagging (docs/release.md).`,
    }
  if (notes === "") return { ok: false, message: `CHANGELOG.md's "## ${version}" section is empty` }
  return { ok: true, message: `CHANGELOG.md has notes for ${version}` }
}

if (import.meta.main) {
  const tag = process.argv[2] ?? ""
  const text = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : undefined
  const result = checkChangelog(tag, text)
  if (result.ok) console.log(`changelog: ${result.message}`)
  else {
    console.error(`changelog: ${result.message}`)
    process.exit(1)
  }
}
