// Kete Code for VS Code.
// - Chat: the web UI served by the extension's own `kete serve` (server.ts), shown in a webview (the
//   activity-bar view or an editor panel); see chat.ts. The binary is bundled per platform
//   (binary.ts); the extension never runs `kete` from the PATH.
// - Editor: the chat opens changed files as diffs in the editor, and "Send Selection/File to Kete
//   Code" adds context to the chat's prompt.
// - Account: the status bar shows the server state and the signed-in Kete account (account.ts), with
//   "Sign in to Kete" / "Sign out" running the CLI's `kete login` / `kete logout`.
// - Attention: the server's event stream (events.ts) drives a badge on the chat for waiting
//   permission prompts, and notifications when the chat is hidden.
// - Editor context: the active file and selection follow the editor into the chat (editor-context.ts).
// - Terminal: the `kete` TUI beside the editor. Derived from upstream OpenCode's `sdks/vscode`,
//   adapted to the V2 CLI: file references are typed into the terminal.
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:net"
import { createServer as createHttpServer, type Server as HttpServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  commands,
  env,
  extensions,
  DiagnosticSeverity,
  languages,
  EventEmitter,
  ProgressLocation,
  ThemeIcon,
  TreeItem,
  StatusBarAlignment,
  ThemeColor,
  Uri,
  window,
  workspace,
  ViewColumn,
  type ExtensionContext,
  type LogOutputChannel,
  type StatusBarItem,
  type TextEditor,
  type TreeDataProvider,
  type Webview,
  type WebviewPanel,
  type WebviewView,
} from "vscode"
import { Brand } from "@opencode/util/kete/brand"
import { authorizeURL, parseWhoami } from "./account"
import { resolve } from "./binary"
import { chatHtml, fromFrame, pairingUrl } from "./chat"
import { editorContext, same, type EditorContext } from "./editor-context"
import { dismissCliHint, dismissNotice, loadPanelState } from "./panel"
import { basic, empty, EventStream, reduce, type Attention } from "./events"
import { registerMcpView } from "./mcp-view"
import { before as beforeContent } from "./review"
import { authorized, handle as handleMcp, SERVER_NAME, type Diagnostic } from "./editor-tools"
import { ago, isSessionID, parseSessions, sessionFromLink, sessionLink, type SessionItem } from "./sessions"
import { fileReference } from "./reference"
import { Server } from "./server"
import { applySettings, configDirectory, httpUrl, type KeteSettings } from "./settings"
import { insideWorkspace, statusBar, type AccountState, type PermissionMode } from "./status"

const run = promisify(execFile)

type State = {
  readonly context: ExtensionContext
  readonly output: LogOutputChannel
  readonly item: StatusBarItem
  readonly server: Server
  readonly webviews: Set<Webview>
  /** Chats whose web UI has said hello (its editor bridge is running), and context waiting for one. */
  readonly ready: Set<Webview>
  readonly queued: Array<Record<string, unknown>>
  /** Context items the web UI confirmed adding to a prompt (shown in the status API). */
  delivered: number
  /** When the account was last read. */
  checked: number
  account: AccountState
  /** Where each chat is shown, to know whether the user can see it and to badge the sidebar view. */
  readonly surfaces: Map<Webview, WebviewView | WebviewPanel>
  attention: Attention
  editor: EditorContext | undefined
  events: EventStream | undefined
  /** For the status API (end-to-end tests): the last editor file a chat showed, event-stream connections. */
  editorApplied: string | null
  eventConnections: number
  /** The VS Code theme kind and how many of its colours the web UI took (reported by the web UI). */
  theme: { kind: string; tokens: number } | undefined
  /** The session each chat has open (a chat on a new-chat page has none), and the "before" side of each file in the review. */
  readonly openSessions: Map<Webview, string>
  /** Each open session's permission mode, as the runtime has it ("default" or "ask"). */
  readonly modes: Map<string, PermissionMode>
  /** The mode the running server gives sessions without their own (the setting when it started). */
  serverMode: "default" | "ask" // from kete.chat.askBeforeEdits
  readonly before: Map<string, string>
  review: Array<{ file: string; status: string; left: string; right: string }>
  /** The session list view, refreshed (debounced) when sessions change. */
  readonly sessions: EventEmitter<void>
  sessionsTimer: ReturnType<typeof setTimeout> | undefined
  /** The editor's MCP server (diagnostics) and whether the running server has it registered. */
  editorTools: { server: HttpServer; port: number; token: string } | undefined
  /** The MCP Servers view (./mcp-view.ts). */
  mcp: { refresh: () => void; status: () => { items: number; waiting: number } }
  /** The runtime's status for the editor's MCP server ("connected", "failed", …), once registered. */
  editorToolsStatus: string | undefined
}

let active: State | undefined

export function activate(context: ExtensionContext) {
  const output = window.createOutputChannel(Brand.displayName, { log: true })
  const item = window.createStatusBarItem("kete.status", StatusBarAlignment.Right, 100)
  item.name = Brand.displayName
  item.command = "kete.statusMenu"
  const state: State = {
    context,
    output,
    item,
    webviews: new Set(),
    ready: new Set(),
    queued: [],
    delivered: 0,
    checked: 0,
    account: undefined,
    surfaces: new Map(),
    attention: empty,
    editor: undefined,
    events: undefined,
    editorApplied: null,
    eventConnections: 0,
    theme: undefined,
    openSessions: new Map(),
    modes: new Map(),
    serverMode: "default",
    before: new Map(),
    review: [],
    sessions: new EventEmitter<void>(),
    sessionsTimer: undefined,
    editorTools: undefined,
    mcp: { refresh: () => undefined, status: () => ({ items: 0, waiting: 0 }) },
    editorToolsStatus: undefined,
    server: new Server({
      binary: () => binary(context),
      cwd: workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      env: () => serverEnvironment(state),
      log: (line) => output.info(line),
      onStatus: (status) => {
        output.info(`server: ${status.state}${"reason" in status ? ` (${status.reason})` : ""}`)
        render(state)
        // A restarted server has a new port and password: every chat must reconnect.
        if (status.state === "running") void Promise.all(Array.from(state.webviews, (webview) => show(state, webview)))
        if (status.state === "running") startEvents(state)
        if (status.state === "running") void registerEditorTools(state)
        if (status.state === "running") state.mcp.refresh()
        if (status.state !== "running") state.editorToolsStatus = undefined
        if (status.state === "stopped" || status.state === "failed") stopEvents(state)
        if (status.state === "failed") void notifyFailed(state, status.reason)
      },
    }),
  }
  active = state
  render(state)
  item.show()

  const track = (webview: Webview, surface: WebviewView | WebviewPanel) => {
    state.webviews.add(webview)
    state.surfaces.set(webview, surface)
    // Coming back into view: the editor chip may have been used by a sent message.
    const visibility = "onDidChangeVisibility" in surface ? surface.onDidChangeVisibility : surface.onDidChangeViewState
    visibility(() => {
      if (surface.visible) void post(state, webview, { type: "kete.editorContext", context: state.editor ?? null })
    })
    webview.onDidReceiveMessage((message: unknown) => receive(state, webview, message))
    return show(state, webview)
  }

  const mcpView = registerMcpView({
    output,
    connection: async () => (state.server.state.state === "running" ? state.server.connection() : undefined),
    binary: () => binary(context),
    reload: () => reloadServerConfig(state),
  })
  state.mcp = mcpView
  context.subscriptions.push(
    ...mcpView.disposables,
    output,
    item,
    state.sessions,
    window.registerTreeDataProvider("kete.sessions", sessionTree(state)),
    window.registerUriHandler({
      handleUri: (uri) => {
        const id = sessionFromLink(uri.path, uri.query)
        if (!id) {
          state.output.warn(`ignored a link that doesn't name a session: ${uri.path}`)
          return
        }
        void openSession(state, id)
      },
    }),
    commands.registerCommand("kete.openSession", (id?: unknown) =>
      isSessionID(id) ? openSession(state, id) : pickSession(state),
    ),
    commands.registerCommand("kete.askBeforeEdits", () => setMode(state, "ask")),
    commands.registerCommand("kete.stopAskingBeforeEdits", () => setMode(state, "default")),
    commands.registerCommand("kete.refreshSessions", () => state.sessions.fire()),
    commands.registerCommand("kete.copySessionLink", async (item?: unknown) => {
      const id = isSessionItem(item) ? item.id : activeSession(state)
      if (!id) return
      await env.clipboard.writeText(sessionLink(env.uriScheme, context.extension.id, id))
      window.showInformationMessage("Session link copied.")
    }),
    window.registerWebviewViewProvider(
      "kete.chat",
      {
        resolveWebviewView: (view) => {
          view.onDidDispose(() => forget(state, view.webview))
          return track(view.webview, view)
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    commands.registerCommand("kete.openChat", () => {
      const panel = window.createWebviewPanel("kete.chat.panel", Brand.displayName, ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
      })
      panel.iconPath = {
        light: Uri.joinPath(context.extensionUri, "media", "kete-tab-light.svg"),
        dark: Uri.joinPath(context.extensionUri, "media", "kete-tab-dark.svg"),
      }
      panel.onDidDispose(() => forget(state, panel.webview))
      return track(panel.webview, panel)
    }),
    commands.registerCommand("kete.reloadChat", () =>
      Promise.all(Array.from(state.webviews, (webview) => show(state, webview))),
    ),
    commands.registerCommand("kete.restartServer", () => state.server.restart().catch(() => undefined)),
    commands.registerCommand("kete.showLogs", () => output.show()),
    commands.registerCommand("kete.signIn", () => signIn(state)),
    commands.registerCommand("kete.signOut", () => signOut(state)),
    commands.registerCommand("kete.statusMenu", () => statusMenu(state)),
    commands.registerCommand("kete.sendSelection", () => sendContext(state, true)),
    commands.registerCommand("kete.sendFile", () => sendContext(state, false)),
    workspace.registerTextDocumentContentProvider(BEFORE, {
      provideTextDocumentContent: (uri) => state.before.get(uri.toString()) ?? "",
    }),
    commands.registerCommand("kete.reviewChanges", () => reviewChanges(state).then(() => undefined)),
    commands.registerCommand("kete.revertFile", () => revertFile(state)),
    commands.registerCommand("kete.focusChat", () => commands.executeCommand("kete.chat.focus")),
    commands.registerCommand("kete.newChat", async () => {
      await commands.executeCommand("kete.chat.focus")
      await deliver(state, { type: "kete.newSession" })
    }),
    // Alt+K: the selection when there is one, else the file.
    commands.registerCommand("kete.addToChat", () =>
      sendContext(state, window.activeTextEditor ? !window.activeTextEditor.selection.isEmpty : false),
    ),
    // VS Code's own "Move View" picker offers the Secondary Side Bar, in every VS Code version and fork.
    commands.registerCommand("kete.moveChatToRight", async () => {
      await commands.executeCommand("kete.chat.focus")
      await commands.executeCommand("workbench.action.moveFocusedView")
    }),
    window.onDidChangeActiveTextEditor(() => scheduleEditorContext(state)),
    window.onDidChangeTextEditorSelection(() => scheduleEditorContext(state)),
    workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("kete.chat.askBeforeEdits") && state.server.state.state === "running") {
        const choice = await window.showInformationMessage(
          `New ${Brand.displayName} sessions use this after the server restarts. Open sessions keep their own setting (the shield in the chat's title bar).`,
          "Restart Server",
          "Later",
        )
        if (choice === "Restart Server") await state.server.restart().catch(() => undefined)
      }
      if (event.affectsConfiguration("kete.cliPath")) {
        await refreshAccount(state)
        if (state.server.state.state !== "stopped") await state.server.restart().catch(() => undefined)
      }
      if (!event.affectsConfiguration("kete")) return
      if (await syncSettings(state)) await reloadServerConfig(state)
    }),
    // Picks up `kete login`/`logout` run in a terminal; at most every 30 s, since it runs the binary.
    window.onDidChangeWindowState((window) => {
      if (window.focused && Date.now() - state.checked > 30_000) void refreshAccount(state)
    }),
    commands.registerCommand("kete.openNewTerminal", () => openTerminal(state)),
    commands.registerCommand("kete.openTerminal", () => {
      const existing = findTerminal()
      if (existing) return existing.show()
      return openTerminal(state)
    }),
    commands.registerCommand("kete.addFilepathToTerminal", () => {
      const reference = activeFileReference()
      if (!reference) return
      const terminal = window.activeTerminal?.name === Brand.displayName ? window.activeTerminal : findTerminal()
      if (!terminal) return
      // The trailing space closes the TUI's @-mention autocomplete.
      terminal.sendText(`${reference} `, false)
      terminal.show()
    }),
  )
  void refreshAccount(state)
  void syncSettings(state)
  // Read-only status for the end-to-end tests (test/e2e) and other extensions. Never the password.
  return {
    /** The workspace's sessions, as the Sessions view lists them. */
    sessions: () => listSessions(state),
    status: () => ({
      server: state.server.state,
      account: state.account,
      chats: state.webviews.size,
      ready: state.ready.size,
      contextDelivered: state.delivered,
      editorContext: state.editorApplied,
      eventConnections: state.eventConnections,
      theme: state.theme,
      editorTools: state.editorToolsStatus,
      mcp: state.mcp.status(),
      permissionMode: (() => {
        const id = activeSession(state)
        return id ? state.modes.get(id) : undefined
      })(),
      session: activeSession(state),
      waiting: state.attention.pending.size,
    }),
  }
}

export function deactivate() {
  const state = active
  active = undefined
  if (state) stopEvents(state)
  state?.editorTools?.server.close()
  return state?.server.stop()
}

// ---------------------------------------------------------------------------------------------------
// Binary and server

async function binary(context: ExtensionContext) {
  const resolved = await resolve({
    extensionPath: context.extensionPath,
    setting: workspace.getConfiguration("kete").get<string>("cliPath"),
  })
  if (!resolved.ok) throw new Error(resolved.error)
  return resolved.path
}

/** In Codespaces the chat reaches the server through GitHub's forwarded host; allow that name. */
function serverEnvironment(state: State): Record<string, string> {
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
  // New sessions' permission mode (core/src/kete/permission-mode.ts); each session can change its own.
  const mode = workspace.getConfiguration("kete").get<boolean>("chat.askBeforeEdits", false) ? "ask" : "default"
  state.serverMode = mode
  state.modes.clear()
  return {
    KETE_PERMISSION_MODE: mode,
    ...(process.env.CODESPACES === "true" && domain ? { KETE_SERVER_ALLOWED_HOSTS: `.${domain}` } : {}),
  }
}

function render(state: State) {
  const active = activeSession(state)
  const mode = active === undefined ? undefined : state.modes.get(active)
  void commands.executeCommand("setContext", "kete.askBeforeEdits", mode === "ask")
  const bar = statusBar(state.server.state, state.account, state.attention.pending.size, mode)
  state.item.text = bar.text
  state.item.tooltip = bar.tooltip
  state.item.backgroundColor = bar.error ? new ThemeColor("statusBarItem.errorBackground") : undefined
}

async function notifyFailed(state: State, reason: string) {
  const choice = await window.showErrorMessage(`${Brand.displayName} server stopped: ${reason}`, "Restart", "Show Logs")
  if (choice === "Restart") await state.server.restart().catch(() => undefined)
  if (choice === "Show Logs") state.output.show()
}

/** Asks the running server to reload its configuration (after sign-in, sign-out or a settings change). */
async function reloadServerConfig(state: State) {
  if (state.server.state.state !== "running") return
  const connection = await state.server.connection()
  const response = await fetch(`${connection.url}/api/location/reload`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => error)
  if (response instanceof Response && response.ok) return
  state.output.warn(`reloading the server configuration failed: ${response instanceof Response ? response.status : String(response)}`)
}

// ---------------------------------------------------------------------------------------------------
// Chat

function forget(state: State, webview: Webview) {
  state.webviews.delete(webview)
  state.ready.delete(webview)
  state.surfaces.delete(webview)
  state.openSessions.delete(webview)
}

/** The session in the chat the user is looking at: an active editor-tab chat, else a visible one, else any. */
function activeSession(state: State) {
  const entries = Array.from(state.openSessions).map(([webview, session]) => ({ surface: state.surfaces.get(webview), session }))
  return (
    entries.find((entry) => entry.surface && "active" in entry.surface && entry.surface.active)?.session ??
    entries.find((entry) => entry.surface?.visible)?.session ??
    entries[0]?.session
  )
}

/** Sends to one chat if its web UI is ready (else the hello handler sends the current state). */
function post(state: State, webview: Webview, message: Record<string, unknown>) {
  return state.ready.has(webview) ? webview.postMessage(message) : Promise.resolve(false)
}

/** The chat panel's notices, CLI hint and platform/default-mode, from this workspace's persisted
 *  dismissals (context.globalState). */
function panelState(state: State) {
  return loadPanelState(state.context.globalState, {
    platform: process.platform === "darwin" ? "mac" : "other",
    defaultMode: state.serverMode,
  })
}

async function sendPanelState(state: State, webview: Webview) {
  await webview.postMessage({ type: "kete.panel", ...panelState(state) })
}

/** After a dismissal changes, every open chat (not just the one that sent it) sees the new list. */
async function broadcastPanelState(state: State) {
  await Promise.all(Array.from(state.ready, (webview) => sendPanelState(state, webview)))
}

/** Sends to every ready chat, or opens one and delivers when its web UI is ready. */
async function deliver(state: State, message: Record<string, unknown>) {
  if (state.ready.size > 0) {
    await Promise.all(Array.from(state.ready, (webview) => webview.postMessage(message)))
    return
  }
  state.queued.push(message)
  await commands.executeCommand("kete.chat.focus")
}

function chatVisible(state: State) {
  return Array.from(state.surfaces.values()).some((surface) => surface.visible)
}

// ---------------------------------------------------------------------------------------------------
// Editor context

const editorTimer: { current?: ReturnType<typeof setTimeout> } = {}

/** The active editor's file and selection, debounced, sent to every chat when it changes. */
function scheduleEditorContext(state: State) {
  if (editorTimer.current) clearTimeout(editorTimer.current)
  editorTimer.current = setTimeout(() => {
    const next = currentEditorContext(window.activeTextEditor)
    if (same(next, state.editor)) return
    state.editor = next
    for (const webview of state.ready) void webview.postMessage({ type: "kete.editorContext", context: next ?? null })
  }, 150)
}

function currentEditorContext(editor: TextEditor | undefined) {
  if (!editor || !workspace.getConfiguration("kete").get<boolean>("chat.shareEditorContext", true)) return undefined
  const folder = workspace.getWorkspaceFolder(editor.document.uri)
  const excluded = workspace.getConfiguration("files", editor.document.uri).get<Record<string, unknown>>("exclude") ?? {}
  return editorContext({
    scheme: editor.document.uri.scheme,
    relative: folder ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join("/") : undefined,
    exclude: Object.entries(excluded)
      .filter(([, on]) => on === true)
      .map(([pattern]) => pattern),
    selection: {
      start: editor.selection.start.line,
      end: editor.selection.end.line,
      endCharacter: editor.selection.end.character,
      empty: editor.selection.isEmpty,
    },
  })
}

// ---------------------------------------------------------------------------------------------------
// Attention: waiting permission prompts and finished sessions, from the server's event stream

function startEvents(state: State) {
  stopEvents(state)
  state.attention = empty
  state.events = new EventStream({
    connection: () =>
      state.server.state.state === "running" ? state.server.connection() : Promise.resolve(undefined),
    log: (line) => state.output.warn(line),
    // Prompts asked while disconnected: read the list again.
    onConnect: async (connection) => {
      state.eventConnections++
      refreshSessions(state)
      const folder = workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!folder) return
      const response = await fetch(`${connection.url}/api/permission/request?directory=${encodeURIComponent(folder)}`, {
        headers: { authorization: basic(connection.password) },
      }).catch(() => undefined)
      const body: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
      const list: unknown[] = typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data) ? body.data : []
      const pending = new Map<string, string>()
      for (const item of list)
        if (typeof item === "object" && item !== null && "id" in item && "sessionID" in item)
          if (typeof item.id === "string" && typeof item.sessionID === "string") pending.set(item.id, item.sessionID)
      state.attention = { ...state.attention, pending }
      renderAttention(state)
    },
    onEvent: (event) => {
      if (event.type.startsWith("mcp.") || event.type.startsWith("integration.")) state.mcp.refresh()
      const next = reduce(state.attention, event)
      if (event.type === "session.metadata.updated" && isSessionMetadataEvent(event.data) && state.modes.has(event.data.sessionID))
        void loadMode(state, event.data.sessionID)
      // The list shows which sessions are working or waiting, so it follows those changes too.
      if (SESSION_EVENTS.has(event.type) || next.state !== state.attention) refreshSessions(state)
      state.attention = next.state
      renderAttention(state)
      if (next.change) void notify(state, next.change)
    },
  })
  state.events.start()
}

function stopEvents(state: State) {
  state.events?.stop()
  state.events = undefined
  state.attention = empty
  renderAttention(state)
}

function renderAttention(state: State) {
  const waiting = state.attention.pending.size
  for (const surface of state.surfaces.values())
    if ("badge" in surface)
      surface.badge = waiting > 0 ? { value: waiting, tooltip: `${waiting} waiting for your approval` } : undefined
  render(state)
}

async function notify(state: State, change: NonNullable<ReturnType<typeof reduce>["change"]>) {
  if (chatVisible(state) || !workspace.getConfiguration("kete").get<boolean>("chat.notifications", true)) return
  const message =
    change.kind === "asked"
      ? `${Brand.displayName} needs your approval${change.action ? ` (${change.action})` : ""}.`
      : `${Brand.displayName} finished: ${(await sessionTitle(state, change.sessionID)) ?? "your session"}.`
  const choice =
    change.kind === "asked"
      ? await window.showWarningMessage(message, "Open Chat")
      : await window.showInformationMessage(message, "Open Chat", "Review Changes")
  if (choice === "Open Chat") await commands.executeCommand("kete.chat.focus")
  if (choice === "Review Changes") await reviewChanges(state, undefined, change.sessionID)
}

async function sessionTitle(state: State, sessionID: string) {
  if (state.server.state.state !== "running") return undefined
  const connection = await state.server.connection()
  const response = await fetch(`${connection.url}/api/session/${encodeURIComponent(sessionID)}`, {
    headers: { authorization: basic(connection.password) },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
  const body: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
  if (typeof body !== "object" || body === null || !("data" in body)) return undefined
  const data = body.data
  return typeof data === "object" && data !== null && "title" in data && typeof data.title === "string" ? data.title : undefined
}

async function show(state: State, webview: Webview) {
  state.ready.delete(webview)
  webview.options = { enableScripts: true }
  webview.html = chatHtml({ loading: `Starting ${Brand.displayName}…` })
  const started = await state.server.connection().then(
    (connection) => ({ connection }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  )
  if ("error" in started) {
    webview.html = chatHtml({
      error: started.error,
      hint: `Use "${Brand.displayName}: Restart Server" to try again, or "${Brand.displayName}: Show Logs" to see why.`,
    })
    return
  }
  // Resolved on every show, never cached: on a remote host this maps the port to one the local chat can reach.
  const external = await env.asExternalUri(Uri.parse(started.connection.url))
  webview.html = chatHtml({
    url: pairingUrl(external.toString(true), started.connection.password),
    nonce: randomBytes(16).toString("base64"),
  })
}

async function receive(state: State, webview: Webview, message: unknown) {
  if (typeof message !== "object" || message === null || !("type" in message)) return
  if (!fromFrame.some((type) => type === message.type)) return
  if (message.type === "kete.hello") {
    // The web UI loaded: tell it which folder this window is about, then deliver queued context.
    state.ready.add(webview)
    const folder = workspace.workspaceFolders?.[0]
    state.editor ??= currentEditorContext(window.activeTextEditor)
    await webview.postMessage({ type: "kete.editorContext", context: state.editor ?? null })
    // A session to open goes first, so the chat doesn't open a new one for the workspace instead.
    const queued = state.queued.splice(0)
    const open = queued.filter((item) => item.type === "kete.openSession").slice(-1)
    await Promise.all(open.map((item) => webview.postMessage(item)))
    if (folder) await webview.postMessage({ type: "kete.workspace", directory: folder.uri.fsPath })
    await Promise.all(queued.filter((item) => item.type !== "kete.openSession").map((item) => webview.postMessage(item)))
    await sendPanelState(state, webview)
    return
  }
  if (message.type === "kete.dismissNotice") {
    if ("id" in message && typeof message.id === "string") await dismissNotice(state.context.globalState, message.id)
    await broadcastPanelState(state)
    return
  }
  if (message.type === "kete.dismissCliHint") {
    await dismissCliHint(state.context.globalState)
    await broadcastPanelState(state)
    return
  }
  if (message.type === "kete.themeApplied") {
    const kind = "kind" in message && typeof message.kind === "string" ? message.kind : "unknown"
    const tokens = "tokens" in message && typeof message.tokens === "number" ? message.tokens : 0
    state.theme = { kind, tokens }
    return
  }
  if (message.type === "kete.session") {
    if ("sessionID" in message && isSessionID(message.sessionID)) {
      state.openSessions.set(webview, message.sessionID)
      void loadMode(state, message.sessionID)
    } else state.openSessions.delete(webview)
    render(state)
    return
  }
  if (message.type === "kete.editorContextApplied") {
    state.editorApplied = "path" in message && typeof message.path === "string" ? message.path : null
    return
  }
  if (message.type === "kete.contextAdded") {
    state.delivered++
    return
  }
  if (message.type !== "kete.openDiff" || !("path" in message) || typeof message.path !== "string") return
  const folder = workspace.workspaceFolders?.[0]
  const file = folder && insideWorkspace(folder.uri.fsPath, message.path)
  if (!folder || !file) {
    state.output.warn(`ignored a request to open a path outside the workspace: ${message.path}`)
    return
  }
  // The file's change in this session's latest turn, else its diff against the last commit.
  const relative = path.relative(folder.uri.fsPath, file).split(path.sep).join("/")
  const session = state.openSessions.get(webview)
  if (session && (await reviewChanges(state, relative, session))) return
  await openDiff(Uri.file(file))
}

// ---------------------------------------------------------------------------------------------------
// Review: a turn's changes as VS Code diffs

const BEFORE = "kete-before"

/**
 * Opens the latest turn's changes in the chat's session: every file in VS Code's multi-file diff
 * editor, or just `only`. The left side is the file before the turn; the right side is the file on
 * disk, so the diff editor's own "revert block" arrows reject single changes. Returns whether it
 * showed anything.
 */
async function reviewChanges(state: State, only?: string, session = activeSession(state)) {
  const folder = workspace.workspaceFolders?.[0]
  if (!session || !folder || state.server.state.state !== "running") {
    if (!only) window.showInformationMessage(`Open a session in the ${Brand.displayName} chat to review its changes.`)
    return false
  }
  const connection = await state.server.connection()
  const response = await fetch(`${connection.url}/api/session/${encodeURIComponent(session)}/diff`, {
    headers: { authorization: basic(connection.password) },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined)
  const body: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
  const diffs = (typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data) ? body.data : [])
    .filter(
      (item: unknown): item is { file: string; patch: string; status: string } =>
        typeof item === "object" && item !== null && "file" in item && "patch" in item && "status" in item &&
        typeof item.file === "string" && typeof item.patch === "string" && typeof item.status === "string",
    )
    .filter((item) => !only || item.file === only)
  if (diffs.length === 0) {
    if (!only) window.showInformationMessage(`${Brand.displayName} changed no files in the last turn.`)
    return false
  }
  const entries: Array<[Uri, Uri, Uri]> = []
  state.review = []
  for (const diff of diffs) {
    const target = insideWorkspace(folder.uri.fsPath, diff.file)
    if (!target) continue
    const uri = Uri.file(target)
    const current = await workspace.fs.readFile(uri).then(
      (bytes) => Buffer.from(bytes).toString("utf8"),
      () => undefined,
    )
    const left = Uri.from({ scheme: BEFORE, path: `/${diff.file}`, query: session })
    try {
      state.before.set(left.toString(), beforeContent(diff.patch, current))
    } catch (error) {
      state.output.warn(`can't show ${diff.file} before the turn: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    // A file the turn deleted has nothing on disk: its right side is an empty document.
    const right = current === undefined ? Uri.from({ scheme: BEFORE, path: `/${diff.file}`, query: `${session}:after` }) : uri
    if (current === undefined) state.before.set(right.toString(), "")
    state.review.push({ file: diff.file, status: current === undefined ? "deleted" : diff.status, left: left.toString(), right: right.toString() })
    entries.push([uri, left, right])
  }
  if (entries.length === 0) return false
  await commands.executeCommand("setContext", "kete.reviewing", true)
  if (entries.length === 1) {
    const [uri, left, right] = entries[0]!
    await commands.executeCommand("vscode.diff", left, right, `${path.basename(uri.fsPath)} (before ↔ after ${Brand.displayName})`, { preview: true })
    return true
  }
  await commands.executeCommand("vscode.changes", `${Brand.displayName}: changes in the last turn`, entries)
  return true
}

/** Puts the active file back as it was before the turn (after asking). */
async function revertFile(state: State) {
  const folder = workspace.workspaceFolders?.[0]
  const active = window.activeTextEditor?.document.uri
  if (!folder || !active) return
  const entry = state.review.find((item) => item.right === active.toString() || item.left === active.toString())
  const content = entry && state.before.get(entry.left)
  const target = entry && insideWorkspace(folder.uri.fsPath, entry.file)
  if (!entry || content === undefined || !target) {
    window.showInformationMessage(`This file isn't in the current ${Brand.displayName} review.`)
    return
  }
  const file = entry.file
  const uri = Uri.file(target)
  const action = entry.status === "added" ? "Delete" : entry.status === "deleted" ? "Restore" : "Revert"
  const choice = await window.showWarningMessage(
    entry.status === "added"
      ? `Delete ${file}? ${Brand.displayName} created it in this turn.`
      : entry.status === "deleted"
        ? `Restore ${file}? ${Brand.displayName} deleted it in this turn.`
        : `Revert ${file} to how it was before this turn? Your edits since then are lost too.`,
    { modal: true },
    action,
  )
  if (choice !== action) return
  if (entry.status === "added") await workspace.fs.delete(uri)
  else await workspace.fs.writeFile(uri, Buffer.from(content, "utf8"))
  window.showInformationMessage(`${file} ${entry.status === "added" ? "deleted" : entry.status === "deleted" ? "restored" : "reverted"}.`)
}

/** The file's diff against HEAD when the Git extension knows it, else the file itself. */
async function openDiff(uri: Uri) {
  const exists = await workspace.fs.stat(uri).then(
    () => true,
    () => false,
  )
  const git = extensions.getExtension<{ getAPI(version: 1): { toGitUri(uri: Uri, ref: string): Uri } }>("vscode.git")
  const api = git?.isActive ? git.exports.getAPI(1) : undefined
  if (api && exists) {
    const title = `${path.basename(uri.fsPath)} (HEAD ↔ Working Tree)`
    return commands.executeCommand("vscode.diff", api.toGitUri(uri, "HEAD"), uri, title, { preview: true })
  }
  if (exists) return window.showTextDocument(uri, { preview: true, viewColumn: ViewColumn.One })
  window.showInformationMessage(`${path.basename(uri.fsPath)} was deleted.`)
}

/** Adds the active file (and, with `selection`, the selected lines) to the chat's prompt context. */
async function sendContext(state: State, selection: boolean) {
  const editor = window.activeTextEditor
  const folder = editor && workspace.getWorkspaceFolder(editor.document.uri)
  if (!editor || !folder) {
    window.showInformationMessage(`Open a file from the workspace to send it to ${Brand.displayName}.`)
    return
  }
  const lines =
    selection && !editor.selection.isEmpty
      ? {
          startLine: editor.selection.start.line + 1,
          // A selection ending at column 0 doesn't include that line.
          endLine:
            editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line
              ? editor.selection.end.line
              : editor.selection.end.line + 1,
        }
      : {}
  await deliver(state, { type: "kete.addContext", path: workspace.asRelativePath(editor.document.uri, false), ...lines })
}

// ---------------------------------------------------------------------------------------------------
// Account

async function refreshAccount(state: State) {
  state.checked = Date.now()
  const next = await binary(state.context)
    .then((file) => run(file, ["whoami", "--format", "json"], { timeout: 15_000 }))
    .then((result): AccountState => parseWhoami(result.stdout))
    .catch((error: unknown): AccountState => ({ error: error instanceof Error ? error.message : String(error) }))
  state.account = next
  void commands.executeCommand("setContext", "kete.signedIn", next !== undefined && !("error" in next) && next.signedIn)
  render(state)
}

async function signIn(state: State) {
  const file = await binary(state.context).catch((error: unknown) => error)
  if (file instanceof Error || typeof file !== "string") {
    window.showErrorMessage(file instanceof Error ? file.message : String(file))
    return
  }
  // On a remote host the platform redirects the local browser to 127.0.0.1:<port>: forward that port
  // under the same number, so the callback reaches `kete login` on the remote side.
  const port = env.remoteName ? await freePort() : undefined
  if (port !== undefined) {
    const forwarded = await env.asExternalUri(Uri.parse(`http://127.0.0.1:${port}`))
    if (Number(new URL(forwarded.toString(true)).port) !== port)
      state.output.warn(`the sign-in callback port ${port} was forwarded as ${forwarded.toString(true)}; the browser may not reach it`)
  }
  const code = await window.withProgress(
    { location: ProgressLocation.Notification, title: `Signing in to ${Brand.displayName}`, cancellable: true },
    (progress, token) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(file, ["login", "--no-browser", ...(port ? ["--port", String(port)] : [])], {
          cwd: os.homedir(),
          windowsHide: true,
        })
        const text = { out: "", err: "", opened: false }
        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => {
          text.out += chunk
          const url = authorizeURL(text.out)
          if (!url || text.opened) return
          text.opened = true
          progress.report({ message: "Approve the sign-in in your browser…" })
          void env.openExternal(Uri.parse(url))
        })
        child.stderr.on("data", (chunk: string) => (text.err += chunk))
        token.onCancellationRequested(() => child.kill())
        child.on("error", (error) => {
          state.output.error(`kete login: ${error.message}`)
          resolve(null)
        })
        child.on("close", (exit) => {
          // `kete login` never prints the key; its output is safe to log.
          state.output.info(`kete login exited with ${exit}\n${text.out}${text.err}`)
          if (exit !== 0 && !token.isCancellationRequested)
            window.showErrorMessage(`Sign-in failed: ${lastLine(text.err) || lastLine(text.out) || `exit code ${exit}`}`)
          resolve(exit)
        })
      }),
  )
  if (code !== 0) return
  await refreshAccount(state)
  await reloadServerConfig(state)
  const account = state.account
  if (account && !("error" in account) && account.signedIn)
    window.showInformationMessage(`Signed in to ${account.organization}.`)
}

async function signOut(state: State) {
  const file = await binary(state.context).catch((error: unknown) => error)
  if (typeof file !== "string") return
  const result = await run(file, ["logout"], { timeout: 60_000 }).then(
    (output) => ({ ok: true as const, text: `${output.stdout}${output.stderr}` }),
    (error: { stdout?: string; stderr?: string; message: string }) => ({
      ok: false as const,
      text: `${error.stdout ?? ""}${error.stderr ?? ""}` || error.message,
    }),
  )
  state.output.info(`kete logout\n${result.text}`)
  // Logout always clears the local key; a warning means the platform couldn't revoke it.
  const warning = result.text.split(/\r?\n/).find((line) => line.startsWith("Warning:"))
  if (!result.ok) window.showErrorMessage(`Sign-out failed: ${lastLine(result.text)}`)
  else if (warning) window.showWarningMessage(warning.replace(/^Warning:\s*/, ""))
  else window.showInformationMessage(`Signed out of ${Brand.displayName}.`)
  await refreshAccount(state)
  await reloadServerConfig(state)
}

async function statusMenu(state: State) {
  const account = state.account
  const signedIn = account !== undefined && !("error" in account) && account.signedIn
  const items = [
    { label: "$(comment-discussion) Open Chat", command: "kete.openChat" },
    signedIn
      ? { label: "$(sign-out) Sign Out", command: "kete.signOut" }
      : { label: `$(sign-in) Sign in to ${Brand.displayName}`, command: "kete.signIn" },
    { label: "$(debug-restart) Restart Server", command: "kete.restartServer" },
    { label: "$(output) Show Logs", command: "kete.showLogs" },
  ]
  const choice = await window.showQuickPick(items, { title: statusBar(state.server.state, account).tooltip.split("\n")[0] })
  if (choice) await commands.executeCommand(choice.command)
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function lastLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[│■└\s]+/, "").trim())
    .filter((line) => line !== "" && line !== "Failed")
    .at(-1)
}

// ---------------------------------------------------------------------------------------------------
// Settings (from #18): VS Code settings → Kete Code's global configuration

/** Writes the extension's settings into Kete Code's configuration. Returns whether anything changed. */
async function syncSettings(state: State) {
  const config = workspace.getConfiguration("kete")
  const gateway = config.get<string>("gateway.url")
  const platform = config.get<string>("platform.url")
  const budget = config.get<number | null>("budget.session")
  const invalid = [
    ["kete.gateway.url", gateway],
    ["kete.platform.url", platform],
  ].filter(([, value]) => value?.trim() && !httpUrl(value))
  if (invalid.length)
    window.showWarningMessage(
      `${invalid.map(([name]) => name).join(" and ")} must be an http(s) URL, e.g. http://localhost:8787. Not applied.`,
    )
  const settings = {
    gatewayUrl: httpUrl(gateway),
    platformUrl: httpUrl(platform),
    sessionBudget: typeof budget === "number" && budget > 0 ? budget : undefined,
  }
  if (!settings.gatewayUrl && !settings.platformUrl && settings.sessionBudget === undefined) return false
  const directory = await keteConfigDirectory(state)
  return directory ? writeConfig(directory, settings) : false
}

async function keteConfigDirectory(state: State) {
  const paths = await binary(state.context)
    .then((file) => run(file, ["debug", "paths"], { timeout: 30_000 }))
    .catch((error: unknown) => {
      state.output.error(`kete debug paths: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
  const directory = paths && configDirectory(paths.stdout)
  if (!directory)
    window.showErrorMessage(`Couldn't find the ${Brand.displayName} configuration directory. See "${Brand.displayName}: Show Logs".`)
  return directory
}

/** Edits the highest-precedence global config file (kete.jsonc over kete.json). */
async function writeConfig(directory: string, settings: KeteSettings) {
  const jsonc = path.join(directory, "kete.jsonc")
  const file = await fs
    .access(jsonc)
    .then(() => jsonc)
    .catch(() => path.join(directory, "kete.json"))
  const before = await fs.readFile(file, "utf8").catch(() => "")
  const after = applySettings(before, settings)
  if (after === before) return false
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(file, after.endsWith("\n") ? after : `${after}\n`)
  return true
}

// ---------------------------------------------------------------------------------------------------
// Terminal

async function openTerminal(state: State) {
  const file = await binary(state.context).catch((error: unknown) => error)
  if (typeof file !== "string") {
    window.showErrorMessage(file instanceof Error ? file.message : String(file))
    return
  }
  // The TUI is the terminal's process, so no shell, PATH lookup or quoting is involved.
  const terminal = window.createTerminal({
    name: Brand.displayName,
    shellPath: file,
    cwd: workspace.workspaceFolders?.[0]?.uri,
    location: { viewColumn: ViewColumn.Beside, preserveFocus: false },
    iconPath: new ThemeIcon("kete-mark"),
  })
  terminal.show()
}

function findTerminal() {
  return window.terminals.find((terminal) => terminal.name === Brand.displayName)
}

function activeFileReference() {
  const editor = window.activeTextEditor
  if (!editor || !workspace.getWorkspaceFolder(editor.document.uri)) return
  return fileReference(workspace.asRelativePath(editor.document.uri), editor.selection)
}


// ---------------------------------------------------------------------------------------------------
// Sessions: the workspace's sessions as a native list, and `vscode://` links to them

const SESSION_EVENTS = new Set([
  "session.created",
  "session.renamed",
  "session.deleted",
  "session.moved",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

function isSessionItem(value: unknown): value is SessionItem {
  return typeof value === "object" && value !== null && "id" in value && isSessionID(value.id)
}

function refreshSessions(state: State) {
  clearTimeout(state.sessionsTimer)
  state.sessionsTimer = setTimeout(() => state.sessions.fire(), 500)
}

async function listSessions(state: State): Promise<SessionItem[]> {
  const folder = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!folder || state.server.state.state !== "running") return []
  const connection = await state.server.connection()
  const response = await fetch(`${connection.url}/api/session?directory=${encodeURIComponent(folder)}`, {
    headers: { authorization: basic(connection.password) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`listing sessions failed: HTTP ${response.status}`)
  return parseSessions(await response.json())
}

function sessionTree(state: State): TreeDataProvider<SessionItem> {
  return {
    onDidChangeTreeData: state.sessions.event,
    getChildren: async (parent) => {
      if (parent) return []
      return listSessions(state).catch((error: unknown) => {
        state.output.warn(error instanceof Error ? error.message : String(error))
        return []
      })
    },
    getTreeItem: (session) => {
      const item = new TreeItem(session.title)
      const waiting = Array.from(state.attention.pending.values()).includes(session.id)
      item.id = session.id
      item.description = waiting ? "needs approval" : state.attention.busy.has(session.id) ? "working…" : ago(session.updated, Date.now())
      item.iconPath = new ThemeIcon(waiting ? "bell-dot" : state.attention.busy.has(session.id) ? "loading~spin" : "comment-discussion")
      item.tooltip = `${session.title}\nUpdated ${new Date(session.updated).toLocaleString()}`
      item.contextValue = "session"
      item.command = { command: "kete.openSession", title: "Open Session", arguments: [session.id] }
      return item
    },
  }
}

async function openSession(state: State, id: string) {
  await commands.executeCommand("kete.chat.focus")
  const message = { type: "kete.openSession", sessionID: id }
  // A chat still loading (the side bar chat, just focused for the first time) opens it once ready.
  if (state.ready.size < state.webviews.size || state.ready.size === 0) state.queued.push(message)
  await Promise.all(Array.from(state.ready, (webview) => webview.postMessage(message)))
}

async function pickSession(state: State) {
  const sessions = await listSessions(state).catch(() => [])
  if (sessions.length === 0) {
    window.showInformationMessage(`No ${Brand.displayName} sessions in this workspace yet.`)
    return
  }
  const now = Date.now()
  const picked = await window.showQuickPick(
    sessions.map((session) => ({ label: session.title, description: ago(session.updated, now), id: session.id })),
    { placeHolder: "Open a session" },
  )
  if (picked) await openSession(state, picked.id)
}

// ---------------------------------------------------------------------------------------------------
// Editor tools: the host editor's diagnostics for the agent, as an MCP server the runtime connects to

const MAX_MCP_BODY = 1_000_000

/** Starts the loopback MCP server once, and registers it with the (re)started runtime. */
async function registerEditorTools(state: State) {
  const folder = workspace.workspaceFolders?.[0]
  if (!folder || !workspace.getConfiguration("kete").get<boolean>("editorTools.enabled", true)) return
  try {
    state.editorTools ??= await startEditorTools(state)
    const connection = await state.server.connection()
    const response = await fetch(
      `${connection.url}/api/experimental/mcp/${SERVER_NAME}?directory=${encodeURIComponent(folder.uri.fsPath)}`,
      {
        method: "PUT",
        headers: { authorization: basic(connection.password), "content-type": "application/json" },
        body: JSON.stringify({
          config: {
            type: "remote",
            url: `http://127.0.0.1:${state.editorTools.port}/mcp`,
            headers: { Authorization: `Bearer ${state.editorTools.token}` },
            oauth: false,
            codemode: false,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    // Adding starts connecting it: wait (up to 15 s) for what the runtime makes of it.
    const entry = await editorToolsEntry(connection, folder.uri.fsPath)
    state.editorToolsStatus = entry?.status.status ?? "unknown"
    if (entry?.status.status === "connected") state.output.info("editor tools (diagnostics) connected to the runtime")
    else state.output.warn(`editor tools: the runtime reports ${state.editorToolsStatus}${entry && typeof entry.status.error === "string" ? `: ${entry.status.error}` : ""}`)
  } catch (error) {
    state.editorToolsStatus = "failed"
    state.output.warn(`editor tools unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function editorToolsEntry(connection: { url: string; password: string }, directory: string) {
  for (let attempt = 0; ; attempt++) {
    const list = await fetch(`${connection.url}/api/mcp?directory=${encodeURIComponent(directory)}`, {
      headers: { authorization: basic(connection.password) },
      signal: AbortSignal.timeout(15_000),
    })
    const body: unknown = list.ok ? await list.json().catch(() => undefined) : undefined
    const servers: unknown[] = typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data) ? body.data : []
    const entry = servers.find(
      (item): item is { name: string; status: { status: string; error?: unknown } } =>
        typeof item === "object" && item !== null && "name" in item && item.name === SERVER_NAME &&
        "status" in item && typeof item.status === "object" && item.status !== null && "status" in item.status &&
        typeof item.status.status === "string",
    )
    if (entry?.status.status !== "pending" || attempt >= 30) return entry
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function startEditorTools(state: State) {
  const token = randomBytes(32).toString("base64url")
  const tools = {
    diagnostics: (file: string | undefined) => Promise.resolve(workspaceDiagnostics(file)),
    editor: env.appName,
  }
  const server = createHttpServer((request, response) => {
    const port = state.editorTools?.port ?? 0
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
      response.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (!authorized(request.headers, token, port)) return send(401)
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") return send(404)
    // Streamable HTTP without a server-to-client stream: GET is refused, DELETE ends nothing.
    if (request.method === "DELETE") return send(200)
    if (request.method !== "POST") return send(405)
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_MCP_BODY) request.destroy()
      else chunks.push(chunk)
    })
    request.on("end", () => {
      void (async () => {
        const parsed: unknown = (() => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8"))
          } catch {
            return undefined
          }
        })()
        if (parsed === undefined) return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
        const messages = Array.isArray(parsed) ? parsed : [parsed]
        const replies = (await Promise.all(messages.map((message) => handleMcp(message, tools)))).filter(
          (reply) => reply !== undefined,
        )
        if (replies.length === 0) return send(202)
        send(200, Array.isArray(parsed) ? replies : replies[0])
      })().catch((error: unknown) => {
        state.output.warn(`editor tools: ${error instanceof Error ? error.message : String(error)}`)
        if (!response.headersSent) send(500)
      })
    })
  })
  return new Promise<{ server: HttpServer; port: number; token: string }>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) return reject(new Error("no port"))
      resolve({ server, port: address.port, token })
    })
  })
}

/** Read when diagnostics are requested, never at load: the module must load without VS Code's enums. */
function severity(value: DiagnosticSeverity): Diagnostic["severity"] {
  if (value === DiagnosticSeverity.Error) return "error"
  if (value === DiagnosticSeverity.Warning) return "warning"
  if (value === DiagnosticSeverity.Information) return "info"
  return "hint"
}

/**
 * Diagnostics for one workspace file, or every workspace file; undefined when `file` isn't in the
 * workspace. Files the chat never shares automatically (secrets, `files.exclude`) are left out.
 */
function workspaceDiagnostics(file: string | undefined): Diagnostic[] | undefined {
  const folder = workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  const target = file === undefined ? undefined : insideWorkspace(folder.uri.fsPath, file)
  if (file !== undefined && !target) return undefined
  const entries = target ? [[Uri.file(target), languages.getDiagnostics(Uri.file(target))] as const] : languages.getDiagnostics()
  const excluded = Object.entries(workspace.getConfiguration("files").get<Record<string, unknown>>("exclude") ?? {})
    .filter(([, on]) => on === true)
    .map(([pattern]) => pattern)
  return entries.flatMap(([uri, diagnostics]) => {
    if (uri.scheme !== "file") return []
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/")
    if (!insideWorkspace(folder.uri.fsPath, relative)) return []
    const shared = editorContext({
      scheme: uri.scheme,
      relative,
      exclude: excluded,
      selection: { start: 0, end: 0, endCharacter: 0, empty: true },
    })
    if (!shared) return []
    return diagnostics.map((item) => ({
      path: relative,
      line: item.range.start.line + 1,
      column: item.range.start.character + 1,
      severity: severity(item.severity),
      source: item.source,
      message: item.message,
    }))
  })
}

// ---------------------------------------------------------------------------------------------------
// Permission mode for the chat's session (core/src/kete/permission-mode.ts). The title-bar shield
// switches between Ask and Default; the composer's toggle (packages/app/src/kete/mode.ts) offers
// Default, Auto, Ask and Plan. Both write the same metadata key.

const MODES: readonly PermissionMode[] = ["default", "accept-edits", "auto", "ask", "plan"]
const MODE_KEY = "kete.permissionMode"

function isSessionMetadataEvent(data: unknown): data is { sessionID: string } {
  return typeof data === "object" && data !== null && "sessionID" in data && typeof data.sessionID === "string"
}

async function getSession(state: State, id: string) {
  const connection = await state.server.connection()
  const response = await fetch(`${connection.url}/api/session/${encodeURIComponent(id)}`, {
    headers: { authorization: basic(connection.password) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`reading the session failed: HTTP ${response.status}`)
  const body: unknown = await response.json()
  const data = typeof body === "object" && body !== null && "data" in body ? body.data : undefined
  const metadata: Record<string, unknown> =
    typeof data === "object" && data !== null && "metadata" in data && typeof data.metadata === "object" && data.metadata !== null
      ? Object.fromEntries(Object.entries(data.metadata))
      : {}
  return { connection, metadata }
}

/** A session without its own mode uses the default the server was started with. */
function modeOf(state: State, metadata: Record<string, unknown>): PermissionMode {
  const value = metadata[MODE_KEY]
  return MODES.find((mode) => mode === value) ?? state.serverMode
}

async function loadMode(state: State, id: string) {
  if (state.server.state.state !== "running") return
  try {
    const { metadata } = await getSession(state, id)
    state.modes.set(id, modeOf(state, metadata))
  } catch (error) {
    // A new chat's session may not exist yet: it gets a mode when the chat reports it again.
    state.output.warn(error instanceof Error ? error.message : String(error))
  }
  render(state)
}

async function setMode(state: State, mode: PermissionMode) {
  const id = activeSession(state)
  if (!id || state.server.state.state !== "running") {
    const choice = await window.showInformationMessage(
      `Send a message first: this applies to the chat's session. For new sessions, use the "Ask Before Edits" setting.`,
      "Open Setting",
    )
    if (choice === "Open Setting") await commands.executeCommand("workbench.action.openSettings", "kete.chat.askBeforeEdits")
    return
  }
  try {
    // Metadata is replaced as a whole: keep what other clients stored.
    const { connection, metadata } = await getSession(state, id)
    const response = await fetch(`${connection.url}/api/session/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { authorization: basic(connection.password), "content-type": "application/json" },
      body: JSON.stringify({ metadata: { ...metadata, [MODE_KEY]: mode } }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    // Read back what the runtime stored, so the shield shows the real state.
    await loadMode(state, id)
    window.setStatusBarMessage(
      mode === "ask"
        ? "$(shield) Kete Code asks before edits, commands and web fetches in this chat"
        : "$(unlock) Kete Code edits without asking in this chat, and asks before commands that can change things and high-risk ones",
      4_000,
    )
  } catch (error) {
    window.showErrorMessage(`Couldn't change the chat's permission mode: ${error instanceof Error ? error.message : String(error)}`)
  }
}
