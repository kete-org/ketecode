// Messages the VS Code extension sends to the web UI (see ./vscode-host.tsx). Validated here, since
// they arrive through postMessage.

export function contextMessage(data: unknown) {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "kete.addContext") return undefined
  if (!("path" in data) || typeof data.path !== "string" || data.path === "") return undefined
  const line = (input: unknown) => (typeof input === "number" && Number.isInteger(input) && input > 0 ? input : undefined)
  const startLine = line("startLine" in data ? data.startLine : undefined)
  const endLine = line("endLine" in data ? data.endLine : undefined)
  return {
    path: data.path,
    startLine,
    endLine: startLine === undefined ? undefined : Math.max(endLine ?? startLine, startLine),
  }
}

export type ContextMessage = NonNullable<ReturnType<typeof contextMessage>>

/** The VS Code workspace folder (an absolute path), which the chat opens instead of Home. */
export function workspaceMessage(data: unknown) {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "kete.workspace") return undefined
  if (!("directory" in data) || typeof data.directory !== "string" || data.directory === "") return undefined
  return data.directory
}

/**
 * The active editor's file and selection (`kete.editorContext`), or null when there is nothing to
 * share. Undefined when the message is something else.
 */
export function editorContextMessage(data: unknown): ContextMessage | null | undefined {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "kete.editorContext") return undefined
  if (!("context" in data) || data.context === null) return null
  return contextMessage({ ...(typeof data.context === "object" ? data.context : {}), type: "kete.addContext" }) ?? null
}

/** A session to show (`kete.openSession`), from the extension's session list or a link. */
export function openSessionMessage(data: unknown) {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "kete.openSession") return undefined
  if (!("sessionID" in data) || typeof data.sessionID !== "string") return undefined
  return /^[A-Za-z0-9_-]{1,128}$/.test(data.sessionID) ? data.sessionID : undefined
}

export function isNewSessionMessage(data: unknown) {
  return typeof data === "object" && data !== null && "type" in data && data.type === "kete.newSession"
}

export type PanelNotice = {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly isNew?: boolean
}

export type PanelMessage = {
  readonly platform: "mac" | "other"
  readonly defaultMode: "default" | "ask"
  readonly cliHint: boolean
  readonly notices: readonly PanelNotice[]
}

const NOTICE_ID = /^[a-z0-9-]{1,64}$/

function panelNotice(data: unknown): PanelNotice | undefined {
  if (typeof data !== "object" || data === null) return undefined
  if (!("id" in data) || typeof data.id !== "string" || !NOTICE_ID.test(data.id)) return undefined
  if (!("title" in data) || typeof data.title !== "string" || data.title.length === 0 || data.title.length > 120) return undefined
  if (!("body" in data) || typeof data.body !== "string" || data.body.length === 0 || data.body.length > 600) return undefined
  const isNew = "isNew" in data && data.isNew === true ? true : undefined
  return { id: data.id, title: data.title, body: data.body, isNew }
}

/** The extension's notices, CLI-hint and platform/default-mode for the chat panel's empty state
 *  (`kete.panel`); anything malformed drops the whole message rather than rendering it partially. */
export function panelMessage(data: unknown): PanelMessage | undefined {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "kete.panel") return undefined
  if (!("platform" in data) || (data.platform !== "mac" && data.platform !== "other")) return undefined
  if (!("defaultMode" in data) || (data.defaultMode !== "default" && data.defaultMode !== "ask")) return undefined
  if (!("cliHint" in data) || typeof data.cliHint !== "boolean") return undefined
  if (!("notices" in data) || !Array.isArray(data.notices) || data.notices.length > 10) return undefined
  const notices: PanelNotice[] = []
  for (const item of data.notices) {
    const notice = panelNotice(item)
    if (!notice) return undefined
    notices.push(notice)
  }
  return { platform: data.platform, defaultMode: data.defaultMode, cliHint: data.cliHint, notices }
}
