// Tools the editor gives the agent, over MCP: the editor's diagnostics (errors and warnings from the
// language servers the user already runs). The extension serves them on 127.0.0.1 with a random
// token and registers the server with its own `kete serve` (`PUT /api/experimental/mcp/editor`).
// This file is the protocol and the formatting; kept free of the `vscode` module for tests.

import { timingSafeEqual } from "node:crypto"

export const SERVER_NAME = "editor"
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
const MAX_DIAGNOSTICS = 200

export type Severity = "error" | "warning" | "info" | "hint"
export type Diagnostic = {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly severity: Severity
  readonly source?: string
  readonly message: string
}

export type Tools = {
  /** Diagnostics for one workspace-relative file, or the whole workspace. Undefined: not in the workspace. */
  readonly diagnostics: (path: string | undefined) => Promise<Diagnostic[] | undefined>
  /** The host editor's name (`vscode.env.appName`: "Visual Studio Code", "Windsurf", "Cursor", "VSCodium", …). */
  readonly editor?: string
}

/**
 * The host editor's name as the model sees it. The extension runs in VS Code and its forks, so the name
 * comes from the host, never a hard-coded "VS Code"; control characters are dropped and the length is
 * bounded, since it ends up in a tool description.
 */
export function editorName(appName: string | undefined) {
  const name = (appName ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64)
  return name || "the editor"
}

const toolList = (editor: string | undefined) => [
  {
    name: "diagnostics",
    description: `Errors and warnings the user's editor (${editorName(editor)}) reports from its language servers, linters and type checkers. Pass \`path\` (relative to the workspace) for one file; omit it for the whole workspace. Use after editing to check your changes compile and lint cleanly.`,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative file path. Omit for all files." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown }

/** The JSON-RPC response for one message; undefined for notifications. */
export async function handle(message: unknown, tools: Tools): Promise<Record<string, unknown> | undefined> {
  if (!isRequest(message)) return error(null, -32600, "invalid request")
  if (message.id === undefined) return undefined
  const id = message.id
  const params = isRecord(message.params) ? message.params : {}
  if (message.method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : ""
    return result(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: "1" },
      instructions: "Diagnostics from the editor the user is working in.",
    })
  }
  if (message.method === "ping") return result(id, {})
  if (message.method === "tools/list") return result(id, { tools: toolList(tools.editor) })
  if (message.method === "tools/call") {
    const args = isRecord(params.arguments) ? params.arguments : {}
    if (params.name !== "diagnostics") return error(id, -32602, `unknown tool: ${String(params.name)}`)
    if (args.path !== undefined && typeof args.path !== "string") return error(id, -32602, "path must be a string")
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined
    const found = await tools.diagnostics(path)
    if (!found) return result(id, text(`${path} is not a file in this workspace.`, true))
    return result(id, text(formatDiagnostics(found, path)))
  }
  return error(id, -32601, `method not found: ${message.method}`)
}

/** Errors first, then warnings, info and hints; at most 200 lines. */
export function formatDiagnostics(items: readonly Diagnostic[], path?: string) {
  if (items.length === 0) return path ? `No problems in ${path}.` : "No problems in the workspace."
  const order: Severity[] = ["error", "warning", "info", "hint"]
  const sorted = [...items].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.path.localeCompare(b.path) || a.line - b.line,
  )
  const counts = order.map((severity) => [severity, items.filter((item) => item.severity === severity).length] as const)
  const summary = counts
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}${count === 1 ? "" : "s"}`)
    .join(", ")
  const lines = sorted
    .slice(0, MAX_DIAGNOSTICS)
    .map(
      (item) =>
        `${item.path}:${item.line}:${item.column} ${item.severity}${item.source ? ` [${item.source}]` : ""}: ${item.message.replaceAll("\n", " ")}`,
    )
  const more = sorted.length > MAX_DIAGNOSTICS ? [`… and ${sorted.length - MAX_DIAGNOSTICS} more`] : []
  return [summary, ...lines, ...more].join("\n")
}

/**
 * Only the runtime this extension started may call: the exact bearer token, to the loopback address
 * (not a rebound name), and never from a web page (browsers always send Origin).
 */
export function authorized(headers: Readonly<Record<string, string | string[] | undefined>>, token: string, port: number) {
  if (headers.origin !== undefined) return false
  if (headers.host !== `127.0.0.1:${port}`) return false
  const auth = headers.authorization
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return false
  const given = Buffer.from(auth.slice(7))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function text(value: string, isError = false) {
  return { content: [{ type: "text", text: value }], isError }
}

function result(id: Request["id"], value: unknown) {
  return { jsonrpc: "2.0", id, result: value }
}

function error(id: Request["id"] | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function isRequest(value: unknown): value is Request {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.method === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
