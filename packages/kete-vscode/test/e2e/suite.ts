// Runs inside a real VS Code window (script/e2e.ts). Drives the installed extension and records what
// happened in KETE_E2E_OUT; the runner asserts on it. Not part of `bun test`.
import { request } from "node:http"
import { writeFileSync } from "node:fs"
import { commands, extensions, Selection, window, workspace } from "vscode"

type Status = {
  server: { state: string; url?: string }
  account?: unknown
  chats: number
  ready: number
  contextDelivered: number
  editorContext: string | null
  eventConnections: number
  waiting: number
  theme?: { kind: string; tokens: number }
  session?: string
  editorTools?: string
  permissionMode?: string
  mcp?: { items: number; waiting: number }
}

export async function run() {
  const out = process.env.KETE_E2E_OUT ?? ""
  const results: Record<string, unknown> = {}
  const save = () => writeFileSync(out, JSON.stringify(results, null, 2))
  try {
    const extension = extensions.getExtension<{ status: () => Status; sessions: () => Promise<unknown[]> }>(
      "ketecode.kete-code",
    )
    if (!extension) throw new Error("extension not installed")
    const api = await extension.activate()
    await until(() => api.status().account !== undefined, 30_000)
    results.account = api.status().account
    results.serverBeforeChat = api.status().server.state

    await commands.executeCommand("kete.openChat")
    await until(() => api.status().server.state === "running", 90_000)
    const first = api.status().server.url ?? ""
    results.url = first
    results.noAuth = await status(first, {})
    results.rebindHost = await status(first, { host: `attacker.example:${new URL(first).port}` })
    results.crossOrigin = await status(first, { origin: "https://attacker.example" })

    // The web UI loads, pairs, and mounts its editor bridge once a composer is on screen.
    results.webUIConnected = await until(() => api.status().ready > 0, 45_000).then(
      () => true,
      () => false,
    )
    // The chat follows the editor: open a file, move the selection.
    results.eventStreamConnected = await until(() => api.status().eventConnections > 0, 30_000).then(
      () => true,
      () => false,
    )
    const file = workspace.workspaceFolders?.[0]
    if (file) {
      const document = await workspace.openTextDocument(`${file.uri.fsPath}/src/app.ts`)
      const editor = await window.showTextDocument(document)
      results.editorContextFollows = await until(() => api.status().editorContext === "src/app.ts", 15_000).then(
        () => true,
        () => false,
      )
      editor.selection = new Selection(1, 0, 3, 0)
      await commands.executeCommand("kete.sendSelection")
      results.sentSelection = true
    }
    // The web UI confirms each context item it added to the prompt.
    results.contextDelivered = await until(() => api.status().contextDelivered > 0, 30_000).then(
      () => true,
      () => false,
    )

    // The new commands exist and run.
    await commands.executeCommand("kete.focusChat")
    await commands.executeCommand("kete.newChat")
    results.newCommands = (await commands.getCommands(true)).filter((id) =>
      [
        "kete.focusChat",
        "kete.newChat",
        "kete.addToChat",
        "kete.moveChatToRight",
        "kete.reviewChanges",
        "kete.revertFile",
      ].includes(id),
    ).length
    // The web UI took VS Code's theme, and reports the session it opened.
    results.themeApplied = await until(() => (api.status().theme?.tokens ?? 0) > 10, 15_000).then(
      () => api.status().theme,
      () => api.status().theme ?? false,
    )
    // A new chat has no session until its first message; the review then finds nothing, and says so.
    results.session = api.status().session ?? null
    await commands.executeCommand("kete.reviewChanges")
    results.reviewRan = true
    // The Sessions view's list reads from the server, and a session link opens that session.
    results.sessionsListed = await api.sessions().then(
      (items) => items.length,
      (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    await commands.executeCommand("kete.openSession", "ses_e2e_existing")
    results.sessionOpened = await until(() => api.status().session === "ses_e2e_existing", 15_000).then(
      () => true,
      () => api.status().session ?? false,
    )
    // …and stays open (nothing navigates away from it afterwards).
    await sleep(3_000)
    results.sessionStayedOpen = api.status().session === "ses_e2e_existing" || (api.status().session ?? false)
    // "Ask before edits" for the open session: stored in the session, read back from the runtime.
    results.modeBefore = await until(() => api.status().permissionMode !== undefined, 15_000).then(
      () => api.status().permissionMode,
      () => "unknown",
    )
    await commands.executeCommand("kete.askBeforeEdits")
    results.modeAsk = await until(() => api.status().permissionMode === "ask", 15_000).then(
      () => true,
      () => api.status().permissionMode ?? false,
    )
    await commands.executeCommand("kete.stopAskingBeforeEdits")
    results.modeDefault = await until(() => api.status().permissionMode === "default", 15_000).then(
      () => true,
      () => api.status().permissionMode ?? false,
    )
    // The runtime connected to the editor's MCP server (diagnostics).
    results.editorTools = await until(() => api.status().editorTools === "connected", 30_000).then(
      () => "connected",
      () => api.status().editorTools ?? "not registered",
    )
    // The MCP Servers view: the organization's command-running server waits for approval.
    await commands.executeCommand("kete.mcp.focus")
    results.mcpView = await until(() => (api.status().mcp?.waiting ?? 0) > 0, 30_000).then(
      () => api.status().mcp,
      () => api.status().mcp ?? false,
    )
    results.waiting = api.status().waiting

    await commands.executeCommand("kete.restartServer")
    await until(() => api.status().server.state === "running" && api.status().server.url !== first, 90_000)
    results.restartedURL = api.status().server.url
    results.oldServerGone = await status(first, {}).then(
      (code) => code,
      () => "unreachable",
    )
    results.webUIConnectedAfterRestart = await until(() => api.status().ready > 0, 45_000).then(
      () => true,
      () => false,
    )
    results.ok = true
  } catch (error) {
    results.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  }
  save()
}

function status(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const target = new URL("/api/info", url)
    const req = request(
      { host: target.hostname, port: target.port, path: target.pathname, headers, setHost: !headers.host },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    req.end()
  })
}

async function until(check: () => boolean, timeout: number) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(200)
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
