import { describe, expect, test } from "bun:test"
import { KeteMcpMention } from "../../src/kete/mcp-mention.js"

describe("KeteMcpMention", () => {
  test("round-trips server names and URIs with slashes, colons and spaces", () => {
    const value = KeteMcpMention.encode("my db/prod", "postgres://host/db?table=a b")
    expect(value.startsWith("kete-mcp:")).toBe(true)
    expect(KeteMcpMention.decode(value)).toEqual({ server: "my db/prod", uri: "postgres://host/db?table=a b" })
  })

  test("refuses other URIs and malformed mentions", () => {
    for (const value of ["file:///a", "kete-mcp:", "kete-mcp:/x", "kete-mcp:srv/", "kete-mcp:%E0%A4%A/x", "kete-mcp:srv"])
      expect(KeteMcpMention.decode(value)).toBeUndefined()
  })
})
