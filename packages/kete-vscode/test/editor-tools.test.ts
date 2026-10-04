import { describe, expect, test } from "bun:test"
import { authorized, formatDiagnostics, handle, type Diagnostic, type Tools } from "../src/editor-tools"

const sample: Diagnostic[] = [
  { path: "src/b.ts", line: 4, column: 2, severity: "warning", source: "eslint", message: "unused" },
  { path: "src/a.ts", line: 10, column: 1, severity: "error", source: "ts", message: "Type 'string'\nis not number" },
]
const tools: Tools = {
  diagnostics: async (path) => (path === "outside.ts" ? undefined : sample.filter((item) => !path || item.path === path)),
}

describe("editor MCP server", () => {
  test("initialize negotiates a known protocol version", async () => {
    const known = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, tools)
    expect(known).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } })
    const unknown = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999" } }, tools)
    expect(unknown).toMatchObject({ result: { protocolVersion: "2025-11-25" } })
  })

  test("notifications get no response; unknown methods and bad messages get errors", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, tools)).toBeUndefined()
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }, tools)).toMatchObject({ error: { code: -32601 } })
    expect(await handle({ id: 4 }, tools)).toMatchObject({ error: { code: -32600 } })
  })

  test("lists and calls the diagnostics tool", async () => {
    const list = await handle({ jsonrpc: "2.0", id: 5, method: "tools/list" }, tools)
    expect(list).toMatchObject({ result: { tools: [{ name: "diagnostics" }] } })
    const all = await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "diagnostics", arguments: {} } }, tools)
    expect(all).toMatchObject({ result: { isError: false } })
    const text = (all as { result: { content: { text: string }[] } }).result.content[0]!.text
    expect(text.split("\n")).toEqual([
      "1 error, 1 warning",
      "src/a.ts:10:1 error [ts]: Type 'string' is not number",
      "src/b.ts:4:2 warning [eslint]: unused",
    ])
    const outside = await handle(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "diagnostics", arguments: { path: "outside.ts" } } },
      tools,
    )
    expect(outside).toMatchObject({ result: { isError: true } })
    const bad = await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "diagnostics", arguments: { path: 1 } } }, tools)
    expect(bad).toMatchObject({ error: { code: -32602 } })
  })

  test("formats empty and long results", () => {
    expect(formatDiagnostics([], "src/a.ts")).toBe("No problems in src/a.ts.")
    const many = Array.from({ length: 250 }, (_, index) => ({ ...sample[0]!, line: index + 1 }))
    const lines = formatDiagnostics(many).split("\n")
    expect(lines).toHaveLength(202)
    expect(lines.at(-1)).toBe("… and 50 more")
  })
})

describe("editor MCP authorization", () => {
  const good = { host: "127.0.0.1:4000", authorization: "Bearer secret-token" }
  test("accepts only the token, the loopback host, and no Origin", () => {
    expect(authorized(good, "secret-token", 4000)).toBe(true)
    expect(authorized({ ...good, authorization: "Bearer wrong-token!" }, "secret-token", 4000)).toBe(false)
    expect(authorized({ ...good, authorization: undefined }, "secret-token", 4000)).toBe(false)
    expect(authorized({ ...good, host: "attacker.example:4000" }, "secret-token", 4000)).toBe(false)
    expect(authorized({ ...good, origin: "https://attacker.example" }, "secret-token", 4000)).toBe(false)
  })
})
