// Synced MCP servers → the runtime's MCP server configuration (@opencode/schema/mcp).
// - http, sse → remote. The runtime's MCP client speaks Streamable HTTP only; an `sse` server works
//   only if it also speaks that, so it is registered with a warning.
// - stdio → local, split into arguments without a shell, and disabled until the developer approves
//   the exact command (`kete sync --approve <key>`; approvals.ts). A changed command is disabled again.
// - Credentials: `none` as is; `oauth` through the runtime's MCP OAuth (`kete mcp auth <key>`);
//   `api_key` and `service_account` are disabled, since the contract doesn't yet say how a key is
//   sent, and a guess could send it where it doesn't belong.
// What each server needs is decided in @opencode/util/kete/sync/mcp-status, shared with the CLI.

import { Mcp } from "@opencode/schema/mcp"
import type { SyncedMcpServer } from "@opencode/util/kete/sync/contract"
import { KeteSyncMcpStatus } from "@opencode/util/kete/sync/mcp-status"

export type Mapped = KeteSyncMcpStatus.Status & { readonly config: Mcp.ServerConfig }

export const split = KeteSyncMcpStatus.split

export function map(server: SyncedMcpServer, approvals: Readonly<Record<string, string>>): Mapped {
  const status = KeteSyncMcpStatus.status(server, approvals)
  if (server.transport === "stdio")
    return {
      ...status,
      config: new Mcp.LocalConfig({ type: "local", command: status.command ?? ["false"], disabled: !status.enabled }),
    }
  return {
    ...status,
    config: new Mcp.RemoteConfig({
      type: "remote",
      url: server.url && URL.canParse(server.url) ? new URL(server.url).href : (server.url ?? ""),
      // OAuth servers use the runtime's MCP OAuth; the others must not start an OAuth flow.
      ...(server.credential.type === "oauth" ? {} : { oauth: false as const }),
      disabled: !status.enabled,
    }),
  }
}

export * as KeteSyncMcp from "./mcp.js"
