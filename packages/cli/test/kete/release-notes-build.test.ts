import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { changelogPath, releaseNotesFor } from "../../script/kete-release-notes"
import { tmpdir } from "../fixture/tmpdir"

const fixture = `# Changelog

## Unreleased

- Coming soon.

## 1.2.3

- Fixed the thing.
- Added the other thing.

## 1.2.2

- Older.
`

async function withChangelog<T>(text: string | undefined, run: (file: string) => T) {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "CHANGELOG.md")
  if (text !== undefined) await writeFile(file, text)
  return run(file)
}

test("a build of version X embeds exactly CHANGELOG's ## X section", async () => {
  expect(await withChangelog(fixture, (file) => releaseNotesFor(file, "1.2.3", false))).toBe(
    "- Fixed the thing.\n- Added the other thing.",
  )
  expect(await withChangelog(fixture, (file) => releaseNotesFor(file, "1.2.2", false))).toBe("- Older.")
})

test("a preview build embeds Unreleased", async () => {
  expect(await withChangelog(fixture, (file) => releaseNotesFor(file, "0.0.0-feature-x-202610110900", true))).toBe(
    "- Coming soon.",
  )
})

test("a missing section or file embeds nothing and doesn't throw", async () => {
  expect(await withChangelog(fixture, (file) => releaseNotesFor(file, "9.9.9", false))).toBe("")
  expect(await withChangelog(undefined, (file) => releaseNotesFor(file, "1.2.3", false))).toBe("")
  expect(await withChangelog(undefined, (file) => releaseNotesFor(file, "0.0.0-x-1", true))).toBe("")
})

test("the build reads the repository's root CHANGELOG.md and defines KETE_RELEASE_NOTES", async () => {
  expect(changelogPath).toBe(path.resolve(import.meta.dirname, "../../../../CHANGELOG.md"))
  const build = await readFile(path.join(import.meta.dirname, "../../script/build.ts"), "utf8")
  expect(build).toContain("releaseNotesFor(changelogPath, Script.version, Script.preview)")
  expect(build).toContain("KETE_RELEASE_NOTES: JSON.stringify(releaseNotes)")
})
