// The MCP Servers view: what the runtime reports for each server (`GET /api/mcp`), joined with what
// the organization's sync says a managed server still needs (`kete sync --status --format json`).
// Kept free of the `vscode` module so it can be unit-tested.

export type Runtime = { readonly name: string; readonly status: string; readonly error?: string }

export type Synced = {
  readonly key: string
  readonly name: string
  readonly transport: string
  readonly command: string | null
  readonly enabled: boolean
  readonly needs: "approval" | "oauth" | "credential" | "invalid" | null
  readonly note: string | null
}

export type SyncStatus = { readonly organization?: string; readonly servers: readonly Synced[] }

export type Item = {
  readonly key: string
  readonly label: string
  readonly description: string
  readonly tooltip: string
  readonly icon: string
  /** What the user can do: drives the view's inline actions. */
  readonly action: "approve" | "sign-in" | "disconnect" | "connect" | "none"
  /** Managed by the organization (synced), rather than configured on this machine. */
  readonly managed: boolean
  /** stdio servers: the exact command an approval covers. */
  readonly command?: string
}

export function parseRuntime(body: unknown): Runtime[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : []
  return data.flatMap((item: unknown): Runtime[] => {
    if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.status)) return []
    const status = typeof item.status.status === "string" ? item.status.status : "unknown"
    const error = typeof item.status.error === "string" ? item.status.error : undefined
    return [{ name: item.name, status, ...(error ? { error } : {}) }]
  })
}

const NEEDS = ["approval", "oauth", "credential", "invalid"] as const

export function parseSyncStatus(stdout: string): SyncStatus {
  const value: unknown = JSON.parse(stdout)
  if (!isRecord(value) || !Array.isArray(value.servers)) return { servers: [] }
  const organization = isRecord(value.organization) && typeof value.organization.name === "string" ? value.organization.name : undefined
  const servers = value.servers.flatMap((item: unknown): Synced[] => {
    if (!isRecord(item) || typeof item.key !== "string" || typeof item.name !== "string") return []
    return [
      {
        key: item.key,
        name: item.name,
        transport: typeof item.transport === "string" ? item.transport : "",
        command: typeof item.command === "string" ? item.command : null,
        enabled: item.enabled === true,
        needs: NEEDS.find((need) => need === item.needs) ?? null,
        note: typeof item.note === "string" ? item.note : null,
      },
    ]
  })
  return { ...(organization ? { organization } : {}), servers }
}

/** One row per server the runtime knows or the organization syncs; waiting-for-you rows first. */
export function items(runtime: readonly Runtime[], sync: SyncStatus): Item[] {
  const synced = new Map(sync.servers.map((server) => [server.key, server]))
  const names = [...new Set([...sync.servers.map((server) => server.key), ...runtime.map((server) => server.name)])]
  const rows = names.map((key): Item => {
    const managed = synced.get(key)
    const live = runtime.find((server) => server.name === key)
    const label = managed?.name ?? key
    const from = managed ? ` · managed by ${sync.organization ?? "your organization"}` : ""
    if (managed?.needs === "approval" && managed.command)
      return {
        key,
        label,
        description: "needs your approval",
        tooltip: `Runs on this computer: ${managed.command}${from}`,
        icon: "shield",
        action: "approve",
        managed: true,
        command: managed.command,
      }
    if (managed && (managed.needs === "credential" || managed.needs === "invalid"))
      return { key, label, description: "unavailable", tooltip: `${managed.note ?? "Can't run yet"}${from}`, icon: "circle-slash", action: "none", managed: true }
    if (live?.status === "needs_auth" || (managed?.needs === "oauth" && live?.status !== "connected"))
      return { key, label, description: "sign-in needed", tooltip: `Sign in to use ${label}${from}`, icon: "key", action: "sign-in", managed: managed !== undefined }
    if (live?.status === "connected")
      return { key, label, description: "connected", tooltip: `${label} is connected${from}`, icon: "pass", action: "disconnect", managed: managed !== undefined }
    if (live?.status === "failed")
      return { key, label, description: "failed", tooltip: `${live.error ?? "Couldn't connect"}${from}`, icon: "error", action: "connect", managed: managed !== undefined }
    if (live?.status === "pending")
      return { key, label, description: "connecting…", tooltip: `Connecting to ${label}${from}`, icon: "loading~spin", action: "none", managed: managed !== undefined }
    return { key, label, description: "off", tooltip: `${label} is off${from}`, icon: "circle-outline", action: "connect", managed: managed !== undefined }
  })
  const order = { approve: 0, "sign-in": 1, connect: 2, none: 3, disconnect: 4 }
  return rows.sort((a, b) => order[a.action] - order[b.action] || a.label.localeCompare(b.label))
}

export function approvalMessage(organization: string | undefined, item: Pick<Item, "label" | "command">) {
  return {
    message: `Let ${item.label} run on this computer?`,
    detail: `${organization ?? "Your organization"} added the MCP server ${item.label}. Approving lets Kete Code start it with exactly this command, with your user's access to this computer:\n\n${item.command}\n\nOnly approve a command you recognise and trust. If it changes, you'll be asked again.`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
