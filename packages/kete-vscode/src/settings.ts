// VS Code settings → Kete Code's global configuration file (kete.json / kete.jsonc).
//
// The extension writes only the keys it owns and edits the file in place, so comments,
// formatting and everything else the user configured stay as they are. An empty setting
// leaves its key alone rather than deleting what the user may have set by hand.
// Kept free of the `vscode` module so it can be unit-tested with Bun.

// The ESM build: the package's default (UMD) entry requires its own files at runtime, which the
// bundle can't resolve, so the extension would fail to activate (see test/bundle.test.ts).
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js"

export type KeteSettings = {
  /** Kete Model Gateway root, e.g. http://localhost:8787 → providers.kete.settings.baseURL */
  readonly gatewayUrl?: string
  /** Kete platform (portal) URL → kete.platform.url */
  readonly platformUrl?: string
  /** Session budget in USD → kete.budget.session */
  readonly sessionBudget?: number
}

export function applySettings(text: string, settings: KeteSettings) {
  const edits: Array<{ path: readonly string[]; value: string | number | undefined }> = [
    { path: ["providers", "kete", "settings", "baseURL"], value: settings.gatewayUrl },
    { path: ["kete", "platform", "url"], value: settings.platformUrl },
    { path: ["kete", "budget", "session"], value: settings.sessionBudget },
  ]
  return edits
    .filter((edit) => edit.value !== undefined && edit.value !== "")
    .reduce(
      (current, edit) =>
        applyEdits(
          current,
          modify(current, [...edit.path], edit.value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
        ),
      text.trim() ? text : "{}",
    )
}

/** An http(s) URL without a trailing slash, or undefined when the setting is empty or invalid. */
export function httpUrl(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || !URL.canParse(trimmed)) return
  const url = new URL(trimmed)
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/** The `config` directory from `kete debug paths`. */
export function configDirectory(paths: string) {
  return paths.match(/^config\s+(.+)$/m)?.[1]?.trim()
}

/**
 * Settings a repository must never set: the program the extension runs and the URLs its account and
 * gateway traffic go to. They are machine-scoped in package.json; this reads only the user-level value as
 * well, in case an editor (some VS Code forks) applies workspace or folder values anyway
 * (GHSA-43vv-qhh9-p4cv).
 */
export const machineSettings = ["cliPath", "gateway.url", "platform.url"] as const
export type MachineSetting = (typeof machineSettings)[number]

/** The part of `WorkspaceConfiguration.inspect` this needs (kept free of the `vscode` module). */
export type Inspectable = {
  inspect<T>(section: string): { globalValue?: T; defaultValue?: T } | undefined
}

/** A machine setting's value from user settings only (else its default); workspace values are ignored. */
export function machineSetting<T>(config: Inspectable, key: MachineSetting): T | undefined {
  const inspected = config.inspect<T>(key)
  return inspected?.globalValue ?? inspected?.defaultValue
}

