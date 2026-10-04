// What each synced MCP server needs before it can run, and stdio command splitting. Pure, so the CLI
// (`kete sync`) and the runtime (core/src/kete/sync/mcp.ts, which builds the server configuration)
// agree. See core/src/kete/sync/mcp.ts for the rules.

import { KeteSyncApprovals } from "./approvals.js"
import type { SyncedMcpServer } from "./contract.js"

export type Status = {
  readonly key: string
  /** Whether the runtime may start or connect to it now. */
  readonly enabled: boolean
  readonly needs?: "approval" | "oauth" | "credential" | "invalid"
  /** For logs and `kete sync`; undefined when it just works. */
  readonly note?: string
  /** stdio: the arguments to run, when the command parses. */
  readonly command?: string[]
}

export function status(server: SyncedMcpServer, approvals: Readonly<Record<string, string>>): Status {
  const credential = credentialNote(server)
  if (server.transport === "stdio") {
    const command = server.command ? split(server.command) : undefined
    if (!server.command || !command || command.length === 0)
      return { key: server.key, enabled: false, needs: "invalid", note: "its command can't be parsed" }
    if (credential) return { key: server.key, enabled: false, needs: "credential", note: credential, command }
    if (!KeteSyncApprovals.approved(approvals, server.key, server.command))
      return {
        key: server.key,
        enabled: false,
        needs: "approval",
        note: `runs \`${server.command}\` on this machine; approve it with \`kete sync --approve ${server.key}\``,
        command,
      }
    return { key: server.key, enabled: true, command }
  }
  const url = server.url && URL.canParse(server.url) ? new URL(server.url) : undefined
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
    return { key: server.key, enabled: false, needs: "invalid", note: "it has no valid http(s) URL" }
  if (credential) return { key: server.key, enabled: false, needs: "credential", note: credential }
  if (server.credential.type === "oauth")
    return { key: server.key, enabled: true, needs: "oauth", note: `sign in with \`kete mcp auth ${server.key}\`` }
  if (server.transport === "sse")
    return { key: server.key, enabled: true, note: "it uses SSE, which works only if the server also speaks Streamable HTTP" }
  return { key: server.key, enabled: true }
}

function credentialNote(server: SyncedMcpServer) {
  if (server.credential.type !== "api_key" && server.credential.type !== "service_account") return undefined
  return `it needs a ${server.credential.type === "api_key" ? "key" : "service account"}${server.credential.ref ? ` (${server.credential.ref})` : ""}, which Kete Code can't supply yet`
}

/**
 * Splits a command line into arguments like a POSIX shell's word splitting, without running a
 * shell: whitespace separates words; '…' is literal; "…" allows \" and \\; a backslash outside
 * quotes escapes the next character. Undefined for an unterminated quote or a trailing backslash.
 */
export function split(command: string) {
  const words: string[] = []
  const state = { word: "", started: false, quote: undefined as "'" | '"' | undefined }
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!
    if (state.quote === "'") {
      if (character === "'") state.quote = undefined
      else state.word += character
      continue
    }
    if (state.quote === '"') {
      if (character === '"') state.quote = undefined
      else if (character === "\\" && (command[index + 1] === '"' || command[index + 1] === "\\")) state.word += command[++index]
      else state.word += character
      continue
    }
    if (/\s/.test(character)) {
      if (state.started) words.push(state.word)
      state.word = ""
      state.started = false
      continue
    }
    state.started = true
    if (character === "'" || character === '"') state.quote = character
    else if (character === "\\") {
      if (index + 1 >= command.length) return undefined
      state.word += command[++index]
    } else state.word += character
  }
  if (state.quote) return undefined
  if (state.started) words.push(state.word)
  return words
}

export * as KeteSyncMcpStatus from "./mcp-status.js"
