// The MCP Servers view: every MCP server the runtime knows, joined with what the organization's sync
// says a managed server still needs (./mcp.ts). From here the developer approves a synced server's
// command (after seeing it exactly), signs in to an OAuth server, and connects or disconnects one.
// Approving goes through the CLI (`kete sync --approve <key> --command <exact>`), which refuses if the
// command changed since it was shown; nothing here writes approvals itself.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  commands,
  EventEmitter,
  ThemeIcon,
  TreeItem,
  window,
  workspace,
  type Disposable,
  type LogOutputChannel,
  type TreeDataProvider,
  type TreeView,
} from "vscode"
import { Brand } from "@opencode/util/kete/brand"
import { basic } from "./events"
import { approvalMessage, items, parseRuntime, parseSyncStatus, type Item, type SyncStatus } from "./mcp"

const run = promisify(execFile)

export type McpViewDeps = {
  readonly output: LogOutputChannel
  /** The running server, or undefined when it isn't running. */
  readonly connection: () => Promise<{ url: string; password: string } | undefined>
  /** The bundled `kete` binary. */
  readonly binary: () => Promise<string>
  /** Asks the running server to reload its configuration (after an approval). */
  readonly reload: () => Promise<void>
}

export function registerMcpView(deps: McpViewDeps): { disposables: Disposable[]; refresh: () => void; status: () => { items: number; waiting: number } } {
  const changed = new EventEmitter<void>()
  const state = { items: [] as Item[], organization: undefined as string | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined, notified: new Set<string>() }

  const load = async (): Promise<Item[]> => {
    const [runtime, sync] = await Promise.all([runtimeServers(deps), syncStatus(deps)])
    state.organization = sync.organization
    state.items = items(runtime, sync)
    render()
    void announce()
    return state.items
  }

  const provider: TreeDataProvider<Item> = {
    onDidChangeTreeData: changed.event,
    getChildren: (parent) => (parent ? [] : load().catch((error: unknown) => {
      deps.output.warn(`MCP servers: ${error instanceof Error ? error.message : String(error)}`)
      return []
    })),
    getTreeItem: (item) => {
      const tree = new TreeItem(item.label)
      tree.id = item.key
      tree.description = item.description
      tree.tooltip = item.tooltip
      tree.iconPath = new ThemeIcon(item.icon)
      tree.contextValue = `mcp-${item.action}`
      if (item.action === "approve") tree.command = { command: "kete.mcp.approve", title: "Review and Approve…", arguments: [item] }
      return tree
    },
  }
  const view: TreeView<Item> = window.createTreeView("kete.mcp", { treeDataProvider: provider })

  const render = () => {
    const waiting = state.items.filter((item) => item.action === "approve" || item.action === "sign-in").length
    view.badge = waiting > 0 ? { value: waiting, tooltip: `${waiting} MCP server${waiting === 1 ? "" : "s"} waiting for you` } : undefined
  }

  /** Once per server and command: a managed server that runs a command asks for a look. */
  const announce = async () => {
    for (const item of state.items.filter((entry) => entry.action === "approve")) {
      const key = `${item.key}\n${item.command}`
      if (state.notified.has(key)) continue
      state.notified.add(key)
      const choice = await window.showInformationMessage(
        `${state.organization ?? "Your organization"} added the MCP server ${item.label}, which runs a command on this computer. It stays off until you approve it.`,
        "Review",
      )
      if (choice === "Review") await approve(item)
    }
  }

  const refresh = () => {
    clearTimeout(state.timer)
    state.timer = setTimeout(() => changed.fire(), 300)
  }

  const approve = async (item: Item | undefined) => {
    if (!item || item.action !== "approve" || !item.command) return
    const text = approvalMessage(state.organization, item)
    const choice = await window.showWarningMessage(text.message, { modal: true, detail: text.detail }, "Approve")
    if (choice !== "Approve") return
    try {
      const file = await deps.binary()
      await run(file, ["sync", "--approve", item.key, "--command", item.command], { timeout: 30_000 })
      await deps.reload()
      window.showInformationMessage(`${item.label} is approved and starts with ${Brand.displayName}.`)
    } catch (error) {
      window.showErrorMessage(`Couldn't approve ${item.label}: ${cliError(error)}`)
    }
    refresh()
  }

  const signIn = async (item: Item | undefined) => {
    if (!item) return
    const file = await deps.binary().catch(() => undefined)
    if (!file) return
    // The CLI runs the OAuth browser flow; a terminal shows its prompts and result.
    const terminal = window.createTerminal({
      name: `${Brand.displayName}: sign in to ${item.label}`,
      shellPath: file,
      shellArgs: ["mcp", "auth", item.key],
      cwd: workspace.workspaceFolders?.[0]?.uri,
      iconPath: new ThemeIcon("kete-mark"),
    })
    terminal.show()
    const closed = window.onDidCloseTerminal(async (done) => {
      if (done !== terminal) return
      closed.dispose()
      await deps.reload().catch(() => undefined)
      refresh()
    })
  }

  const toggle = async (item: Item | undefined, action: "connect" | "disconnect") => {
    if (!item) return
    const connection = await deps.connection()
    const folder = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!connection || !folder) return
    const response = await fetch(
      `${connection.url}/api/experimental/mcp/${encodeURIComponent(item.key)}/${action}?directory=${encodeURIComponent(folder)}`,
      { method: "POST", headers: { authorization: basic(connection.password) }, signal: AbortSignal.timeout(30_000) },
    ).catch(() => undefined)
    if (!response?.ok) window.showErrorMessage(`Couldn't ${action} ${item.label}${response ? ` (HTTP ${response.status})` : ""}.`)
    refresh()
  }

  return {
    refresh,
    status: () => ({ items: state.items.length, waiting: state.items.filter((item) => item.action === "approve").length }),
    disposables: [
      changed,
      view,
      commands.registerCommand("kete.mcp.refresh", refresh),
      commands.registerCommand("kete.mcp.approve", (item?: Item) => approve(item ?? state.items.find((entry) => entry.action === "approve"))),
      commands.registerCommand("kete.mcp.signIn", (item?: Item) => signIn(item)),
      commands.registerCommand("kete.mcp.connect", (item?: Item) => toggle(item, "connect")),
      commands.registerCommand("kete.mcp.disconnect", (item?: Item) => toggle(item, "disconnect")),
    ],
  }
}

async function runtimeServers(deps: McpViewDeps) {
  const connection = await deps.connection()
  const folder = workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!connection || !folder) return []
  const response = await fetch(`${connection.url}/api/mcp?directory=${encodeURIComponent(folder)}`, {
    headers: { authorization: basic(connection.password) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`listing MCP servers failed: HTTP ${response.status}`)
  return parseRuntime(await response.json())
}

async function syncStatus(deps: McpViewDeps): Promise<SyncStatus> {
  const file = await deps.binary()
  const result = await run(file, ["sync", "--status", "--format", "json"], { timeout: 15_000 })
  return parseSyncStatus(result.stdout)
}

function cliError(error: unknown) {
  if (typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim())
    return error.stderr.trim().split("\n").at(-1) ?? "failed"
  return error instanceof Error ? error.message : String(error)
}
