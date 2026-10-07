// Kete Code's permission modes, shared by the runtime (core/src/kete/permission-mode.ts, which
// enforces them), the CLI (`--permission-mode`), and the TUI. A session's mode lives in its
// metadata under `metadataKey`; the web UI (packages/app/src/kete/mode.ts) and the VS Code and
// JetBrains extensions write the same key and values.

export * as KetePermissionModes from "./permission-mode.js"

export const metadataKey = "kete.permissionMode"

export const modes = ["default", "accept-edits", "auto", "ask", "plan"] as const
export type Mode = (typeof modes)[number]

export function parse(value: unknown): Mode | undefined {
  return modes.find((mode) => mode === value)
}

/** Short labels for status lines and toggles. */
export const label: Readonly<Record<Mode, string>> = {
  default: "Default",
  "accept-edits": "Accept edits",
  auto: "Auto",
  ask: "Ask",
  plan: "Plan",
}

/** One honest sentence per mode, for help text and tooltips. */
export const description: Readonly<Record<Mode, string>> = {
  default: "Edits and read-only or test/build commands run; other commands, high-risk commands and web requests ask first.",
  "accept-edits": "Same as Default: edits run without asking; commands and web requests follow Default.",
  auto: "Edits, commands and web requests run without asking; high-risk commands (push, deletes, installs, deploys, databases, sudo, credentials) still ask.",
  ask: "Asks before every edit, command and web request.",
  plan: "Read-only: edits and commands that change anything are blocked.",
}

/** The order clients cycle through. Accept edits is left out while it equals Default. */
export const cycle: ReadonlyArray<Mode> = ["default", "auto", "ask", "plan"]

export function next(mode: Mode): Mode {
  const index = cycle.indexOf(mode)
  return cycle[(index + 1) % cycle.length]!
}
