import { describe, expect, test } from "bun:test"
import { KeteMcpMention } from "@opencode/util/kete/mcp-mention"
import { KeteMcpMentionOptions } from "../../src/kete/mcp-mentions"

describe("KeteMcpMentionOptions", () => {
  test("each resource becomes an @server:name option that attaches a kete-mcp: file", () => {
    const inserted: Array<{ text: string; file: unknown }> = []
    const options = KeteMcpMentionOptions.options(
      [
        { server: "docs", name: "Getting started", uri: "docs://start", description: "The guide" },
        { server: "db", name: "users", uri: "postgres://h/db/users" },
      ],
      (text, file) => inserted.push({ text, file }),
    )
    expect(options.map((option) => option.display)).toEqual(["@docs:Getting-started", "@db:users"])
    expect(options[1]!.description).toBe(" postgres://h/db/users")
    options[0]!.onSelect!()
    expect(inserted).toEqual([
      {
        text: "docs:Getting-started",
        file: { uri: KeteMcpMention.encode("docs", "docs://start"), name: "docs:Getting-started" },
      },
    ])
  })
})
