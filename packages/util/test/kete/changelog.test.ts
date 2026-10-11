import { describe, expect, test } from "bun:test"
import { KeteChangelog } from "../../src/kete/changelog.js"

const changelog = `# Changelog

## Unreleased

- Upcoming thing.

## 0.2.6

- Safer defaults.
- Sandbox.

## 0.2.4

- Local models.
`

describe("section", () => {
  test("returns the body up to the next section, trimmed", () => {
    expect(KeteChangelog.section(changelog, "0.2.6")).toBe("- Safer defaults.\n- Sandbox.")
    expect(KeteChangelog.section(changelog, "0.2.4")).toBe("- Local models.")
    expect(KeteChangelog.section(changelog, "Unreleased")).toBe("- Upcoming thing.")
  })

  test("is undefined for a missing heading and matches whole names only", () => {
    expect(KeteChangelog.section(changelog, "0.2.5")).toBeUndefined()
    expect(KeteChangelog.section(changelog, "0.2")).toBeUndefined()
    expect(KeteChangelog.section("### 0.2.6\n- x", "0.2.6")).toBeUndefined()
  })

  test("handles CRLF line endings", () => {
    expect(KeteChangelog.section(changelog.replaceAll("\n", "\r\n"), "0.2.6")).toBe("- Safer defaults.\n- Sandbox.")
  })
})

describe("notesFor", () => {
  test("a stable build embeds exactly its own section", () => {
    expect(KeteChangelog.notesFor(changelog, "0.2.6", false)).toBe("- Safer defaults.\n- Sandbox.")
  })

  test("a stable build without a section embeds nothing, never Unreleased", () => {
    expect(KeteChangelog.notesFor(changelog, "0.2.7", false)).toBe("")
  })

  test("previews and pre-releases fall back to Unreleased", () => {
    expect(KeteChangelog.notesFor(changelog, "0.0.0-main-202610110900", true)).toBe("- Upcoming thing.")
    expect(KeteChangelog.notesFor(changelog, "0.3.0-rc.1", false)).toBe("- Upcoming thing.")
  })

  test("no changelog or no Unreleased section embeds nothing", () => {
    expect(KeteChangelog.notesFor(undefined, "0.2.6", false)).toBe("")
    expect(KeteChangelog.notesFor("# Changelog\n", "0.0.0-x-1", true)).toBe("")
  })
})

describe("cap", () => {
  test("leaves short notes alone", () => {
    expect(KeteChangelog.cap("- a\n- b", 100)).toBe("- a\n- b")
  })

  test("cuts at a line boundary within the byte limit and marks the cut", () => {
    const notes = Array.from({ length: 1000 }, (_, i) => `- line ${i} ✓`).join("\n")
    const capped = KeteChangelog.cap(notes)
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(KeteChangelog.MAX_BYTES)
    expect(capped.endsWith("\n…")).toBe(true)
    expect(capped.split("\n").slice(0, -1).every((line) => /^- line \d+ ✓$/.test(line))).toBe(true)
  })
})

describe("compareVersions", () => {
  test("orders versions semantically", () => {
    expect(KeteChangelog.compareVersions("0.2.7", "0.2.6")).toBe(1)
    expect(KeteChangelog.compareVersions("0.2.6", "0.2.6")).toBe(0)
    expect(KeteChangelog.compareVersions("0.10.0", "0.9.9")).toBe(1)
    expect(KeteChangelog.compareVersions("0.3.0-rc.1", "0.3.0")).toBe(-1)
    expect(KeteChangelog.compareVersions("0.3.0-rc.2", "0.3.0-rc.10")).toBe(-1)
    expect(KeteChangelog.compareVersions("0.3.0-rc.1", "0.2.6")).toBe(1)
  })

  test("is undefined for something that isn't a version", () => {
    expect(KeteChangelog.compareVersions("local", "0.2.6")).toBeUndefined()
    expect(KeteChangelog.compareVersions("0.2.6", "")).toBeUndefined()
  })
})
