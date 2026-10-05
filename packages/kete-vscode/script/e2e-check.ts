// What `bun script/e2e.ts --assert` requires of a run (CI runs it against VS Code and VSCodium).
// Kept apart from the runner so it unit-tests without an editor.

export type Report = {
  readonly exit: number | null
  readonly results: Readonly<Record<string, unknown>>
  readonly leftoverServers: number
}

/** Every requirement the run missed, as one line each; empty when the run passed. */
export function failures(report: Report): string[] {
  const r = report.results
  const problems: string[] = []
  const expect = (ok: boolean, what: string, got: unknown) => {
    if (!ok) problems.push(`${what} (got ${JSON.stringify(got)})`)
  }
  const rejected = (value: unknown) => typeof value === "number" && value >= 400 && value < 500
  expect(report.exit === 0, "the editor exits cleanly", report.exit)
  expect(r.ok === true, "the suite finishes without an error", r.error ?? r.ok)
  expect(typeof r.account === "object" && r.account !== null, "the extension reads the signed-in account", r.account)
  expect(r.noAuth === 401, "the server refuses a request without the password", r.noAuth)
  expect(rejected(r.rebindHost), "the server refuses a rebound Host", r.rebindHost)
  expect(rejected(r.crossOrigin), "the server refuses a cross-origin request", r.crossOrigin)
  for (const key of [
    "webUIConnected",
    "eventStreamConnected",
    "editorContextFollows",
    "contextDelivered",
    "sessionOpened",
    "sessionStayedOpen",
    "modeAsk",
    "modeDefault",
    "webUIConnectedAfterRestart",
  ])
    expect(r[key] === true, key, r[key])
  expect(r.newCommands === 6, "every chat command is registered", r.newCommands)
  expect(typeof r.sessionsListed === "number" && r.sessionsListed >= 1, "the Sessions view lists the session", r.sessionsListed)
  expect(r.editorTools === "connected", "the runtime connects to the editor tools", r.editorTools)
  const mcp = r.mcpView as { waiting?: unknown } | undefined
  expect(typeof mcp?.waiting === "number" && mcp.waiting > 0, "the MCP view shows the server waiting for approval", r.mcpView)
  expect(typeof r.restartedURL === "string" && r.restartedURL !== r.url, "a restart starts a new server", r.restartedURL)
  expect(r.oldServerGone === "unreachable", "the old server is gone after a restart", r.oldServerGone)
  expect(report.leftoverServers === 0, "no server outlives the editor", report.leftoverServers)
  return problems
}
