import { describe, expect, test } from "bun:test"
import { approvalMessage, items, parseRuntime, parseSyncStatus } from "../src/mcp"

const sync = parseSyncStatus(
  JSON.stringify({
    signed_in: true,
    synced: true,
    organization: { id: "o", name: "Kete Labs" },
    servers: [
      { key: "jira", name: "Jira", transport: "stdio", command: "npx -y @acme/mcp-jira", enabled: false, needs: "approval", note: "…" },
      { key: "github", name: "GitHub", transport: "http", command: null, enabled: true, needs: "oauth", note: "…" },
      { key: "sentry", name: "Sentry", transport: "http", command: null, enabled: false, needs: "credential", note: "needs a key" },
      { key: "docs", name: "Docs", transport: "http", command: null, enabled: true, needs: null, note: null },
      { key: 7, name: "bad" },
    ],
  }),
)

describe("MCP view", () => {
  test("parses the runtime's list and ignores malformed entries", () => {
    expect(
      parseRuntime({
        data: [
          { name: "docs", status: { status: "connected" } },
          { name: "x", status: { status: "failed", error: "boom" } },
          { name: 1 },
        ],
      }),
    ).toEqual([
      { name: "docs", status: "connected" },
      { name: "x", status: "failed", error: "boom" },
    ])
    expect(parseRuntime(undefined)).toEqual([])
  })

  test("joins runtime and sync status, waiting-for-you first", () => {
    const runtime = parseRuntime({
      data: [
        { name: "github", status: { status: "needs_auth", error: "sign in" } },
        { name: "docs", status: { status: "connected" } },
        { name: "editor", status: { status: "connected" } },
        { name: "local-db", status: { status: "failed", error: "ECONNREFUSED" } },
      ],
    })
    const rows = items(runtime, sync)
    expect(rows.map((row) => [row.key, row.action, row.description])).toEqual([
      ["jira", "approve", "needs your approval"],
      ["github", "sign-in", "sign-in needed"],
      ["local-db", "connect", "failed"],
      ["sentry", "none", "unavailable"],
      ["docs", "disconnect", "connected"],
      ["editor", "disconnect", "connected"],
    ])
    expect(rows[0]!.command).toBe("npx -y @acme/mcp-jira")
    expect(rows[0]!.tooltip).toContain("managed by Kete Labs")
    expect(rows.find((row) => row.key === "editor")!.managed).toBe(false)
  })

  test("the approval shows the exact command and who asks", () => {
    const text = approvalMessage("Kete Labs", { label: "Jira", command: "npx -y @acme/mcp-jira" })
    expect(text.message).toBe("Let Jira run on this computer?")
    expect(text.detail).toContain("Kete Labs added the MCP server Jira")
    expect(text.detail).toContain("\n\nnpx -y @acme/mcp-jira\n\n")
  })
})
