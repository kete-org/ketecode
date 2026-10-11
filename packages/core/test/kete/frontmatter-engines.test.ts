import { describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"

// GHSA-m7hc-g593-r9wg: front matter in a repository's agent, command or skill markdown must never run code.
describe("front matter is YAML only", () => {
  const marker = "kete-frontmatter-engines-test"
  const ran = () => (globalThis as Record<string, unknown>)[marker] === true

  for (const opener of ["---js", "---javascript", "--- js", "---JS", "﻿---js", "---coffee"]) {
    test(`${JSON.stringify(opener)} front matter is refused and not evaluated`, () => {
      delete (globalThis as Record<string, unknown>)[marker]
      const content = `${opener}\n({ description: (globalThis["${marker}"] = true, "x") })\n---\nbody\n`
      expect(() => ConfigMarkdown.parse(content)).toThrow()
      expect(ConfigMarkdown.parseOption(content)).toBeUndefined()
      expect(ran()).toBe(false)
    })
  }

  test("YAML front matter still parses", () => {
    for (const opener of ["---", "---yaml", "---yml"]) {
      const parsed = ConfigMarkdown.parse(`${opener}\ndescription: hello\nmode: subagent\n---\nbody\n`)
      expect(parsed.data).toEqual({ description: "hello", mode: "subagent" })
      expect(parsed.content.trim()).toBe("body")
    }
  })

  test("unquoted colons still get the sanitize retry", () => {
    const parsed = ConfigMarkdown.parse("---\ndescription: Use when: things happen\n---\nbody\n")
    expect(parsed.data.description).toBe("Use when: things happen")
  })

  test("markdown without front matter is unchanged", () => {
    expect(ConfigMarkdown.parse("just text\n").content).toBe("just text\n")
  })

  test("the language detector reads the opener only", () => {
    expect(ConfigMarkdown.frontMatterLanguage("---\na: 1\n---\n")).toBe("")
    expect(ConfigMarkdown.frontMatterLanguage("---js\n1\n---\n")).toBe("js")
    expect(ConfigMarkdown.frontMatterLanguage("text\n---js\n")).toBe("")
  })
})
