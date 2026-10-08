// The status bar item: the extension's server state and the signed-in account, in one place.
// Kept free of the `vscode` module so it can be unit-tested with Bun.

import path from "node:path"
import type { Account } from "./account"
import type { Status } from "./server"

export type AccountState = Account | { readonly error: string } | undefined

/** A chat's permission mode (core/src/kete/permission-mode.ts); "default" shows nothing. */
export type PermissionMode = "default" | "accept-edits" | "auto" | "ask" | "plan"

const MODE_TEXT: Readonly<Record<PermissionMode, { readonly text: string; readonly tooltip: string } | undefined>> = {
  default: undefined,
  "accept-edits": { text: "$(edit) Accept edits", tooltip: "This chat edits files without asking; commands and web requests follow the defaults" },
  auto: {
    text: "$(zap) Auto",
    tooltip: "This chat runs edits and commands without asking; high-risk commands (push, deletes, installs, deploys, databases, sudo) still ask. Scripts it runs can do anything you can.",
  },
  ask: { text: "$(shield) Ask", tooltip: "This chat asks before every edit, command and web fetch" },
  plan: { text: "$(eye) Plan", tooltip: "This chat is read-only: edits and commands that change anything are blocked" },
}

export function statusBar(server: Status, account: AccountState, waiting = 0, permissionMode: PermissionMode = "default") {
  const icon = {
    stopped: "$(circle-outline)",
    starting: "$(sync~spin)",
    running: "$(check)",
    restarting: "$(sync~spin)",
    failed: "$(error)",
  }[server.state]
  const who =
    account === undefined ? "" : "error" in account ? "" : account.signedIn ? ` · ${account.organization}` : " · Signed out"
  const approvals = waiting > 0 ? ` · $(bell-dot) ${waiting}` : ""
  const shown = MODE_TEXT[permissionMode]
  const mode = shown ? ` · ${shown.text}` : ""
  return {
    text: `${icon} $(kete-mark) Kete${who}${approvals}${mode}`,
    tooltip: [
      serverLine(server),
      accountLine(account),
      ...(shown ? [shown.tooltip] : []),
      ...(waiting > 0 ? [`${waiting} waiting for your approval in the chat`] : []),
    ].join("\n"),
    error: server.state === "failed",
  }
}

function serverLine(server: Status) {
  if (server.state === "stopped") return "Server: not started (starts when you open the chat)"
  if (server.state === "starting") return "Server: starting…"
  if (server.state === "running") return `Server: running on ${server.url}`
  if (server.state === "restarting")
    return `Server: restarting in ${Math.round(server.delay / 1000)} s (attempt ${server.attempt}): ${server.reason}`
  return `Server: stopped after repeated failures: ${server.reason}`
}

function accountLine(account: AccountState) {
  if (account === undefined) return "Account: checking…"
  if ("error" in account) return `Account: unknown (${account.error})`
  if (!account.signedIn)
    return account.handConfigured.length > 0
      ? `Account: not signed in; gateway configured by hand (${account.handConfigured.join(", ")})`
      : "Account: not signed in"
  return `Account: ${account.organization} on ${account.platformURL}\nKey stored in ${account.storage}`
}

/**
 * The absolute path of a workspace-relative path from the web UI, or undefined when it would leave
 * the workspace folder (absolute paths, `..`, or a different drive).
 */
export function insideWorkspace(folder: string, relative: string) {
  if (relative === "" || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return undefined
  const resolved = path.resolve(folder, relative)
  const from = path.relative(folder, resolved)
  if (from === "" || from.startsWith("..") || path.isAbsolute(from)) return undefined
  return resolved
}
