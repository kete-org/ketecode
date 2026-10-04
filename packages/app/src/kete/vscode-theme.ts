// VS Code's theme → the web UI's design tokens, when the web UI runs inside the Kete Code extension.
// The extension's webview reads VS Code's CSS variables (the web UI's frame can't: it is a separate
// document) and posts them here with the theme kind. Tokens without a VS Code value keep the web
// UI's own; nothing here is used outside the extension.

/** The VS Code variables the webview reads (packages/kete-vscode/src/chat.ts sends these). */
export const VSCODE_VARIABLES = [
  "--vscode-editor-background",
  "--vscode-sideBar-background",
  "--vscode-panel-background",
  "--vscode-editorWidget-background",
  "--vscode-input-background",
  "--vscode-list-hoverBackground",
  "--vscode-list-activeSelectionBackground",
  "--vscode-foreground",
  "--vscode-descriptionForeground",
  "--vscode-disabledForeground",
  "--vscode-textLink-foreground",
  "--vscode-textLink-activeForeground",
  "--vscode-panel-border",
  "--vscode-widget-border",
  "--vscode-input-border",
  "--vscode-contrastBorder",
  "--vscode-focusBorder",
  "--vscode-icon-foreground",
  "--vscode-button-background",
  "--vscode-button-foreground",
  "--vscode-font-family",
  "--vscode-editor-font-family",
  "--vscode-font-size",
] as const

/** Each web UI token and the VS Code variables it takes, in order of preference. */
const MAPPING: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["--v2-background-bg-base", ["--vscode-sideBar-background", "--vscode-editor-background"]],
  ["--v2-background-bg-deep", ["--vscode-panel-background", "--vscode-sideBar-background", "--vscode-editor-background"]],
  ["--v2-background-bg-layer-01", ["--vscode-editor-background"]],
  ["--v2-background-bg-layer-02", ["--vscode-input-background", "--vscode-editorWidget-background"]],
  ["--v2-background-bg-layer-03", ["--vscode-list-hoverBackground", "--vscode-editorWidget-background"]],
  ["--v2-background-bg-layer-04", ["--vscode-list-activeSelectionBackground", "--vscode-list-hoverBackground"]],
  ["--v2-background-bg-accent", ["--vscode-button-background"]],
  ["--v2-text-text-base", ["--vscode-foreground"]],
  ["--v2-text-text-muted", ["--vscode-descriptionForeground", "--vscode-foreground"]],
  ["--v2-text-text-faint", ["--vscode-disabledForeground", "--vscode-descriptionForeground"]],
  ["--v2-text-text-accent", ["--vscode-textLink-foreground"]],
  ["--v2-text-text-accent-hover", ["--vscode-textLink-activeForeground", "--vscode-textLink-foreground"]],
  ["--v2-border-border-base", ["--vscode-panel-border", "--vscode-widget-border", "--vscode-contrastBorder"]],
  ["--v2-border-border-muted", ["--vscode-widget-border", "--vscode-panel-border", "--vscode-contrastBorder"]],
  ["--v2-border-border-strong", ["--vscode-input-border", "--vscode-contrastBorder", "--vscode-panel-border"]],
  ["--v2-border-border-focus", ["--vscode-focusBorder"]],
  ["--v2-icon-icon-base", ["--vscode-icon-foreground", "--vscode-foreground"]],
  ["--v2-icon-icon-muted", ["--vscode-descriptionForeground"]],
  ["--v2-icon-icon-accent", ["--vscode-textLink-foreground"]],
  ["--font-family-sans", ["--vscode-font-family"]],
  ["--font-family-mono", ["--vscode-editor-font-family"]],
  ["--font-size-base", ["--vscode-font-size"]],
]

const KINDS = ["light", "dark", "high-contrast", "high-contrast-light"] as const

export type VSCodeTheme = { readonly kind: (typeof KINDS)[number]; readonly variables: Readonly<Record<string, string>> }

/** Web UI token → value, for the tokens VS Code has a value for. Values are CSS the webview computed. */
export function tokens(theme: VSCodeTheme): Record<string, string> {
  return Object.fromEntries(
    MAPPING.flatMap(([token, sources]) => {
      const value = sources.map((source) => theme.variables[source]?.trim()).find((item) => item && safe(item))
      return value ? [[token, value]] : []
    }),
  )
}

export function mode(theme: VSCodeTheme): "light" | "dark" {
  return theme.kind === "light" || theme.kind === "high-contrast-light" ? "light" : "dark"
}

export function themeMessage(data: unknown): VSCodeTheme | undefined {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "kete.theme") return undefined
  const kind = KINDS.find((item) => "kind" in data && item === data.kind)
  if (!kind) return undefined
  if (!("variables" in data) || typeof data.variables !== "object" || data.variables === null) return undefined
  const variables = Object.fromEntries(
    Object.entries(data.variables).filter(
      (entry): entry is [string, string] => (VSCODE_VARIABLES as readonly string[]).includes(entry[0]) && typeof entry[1] === "string",
    ),
  )
  return { kind, variables }
}

/** A CSS value the webview computed: colours, lengths and font lists only; never url(), expressions or braces. */
function safe(value: string) {
  return value.length <= 300 && !/[;{}<>\\]|url\(|expression\(/i.test(value)
}

export * as KeteVSCodeTheme from "./vscode-theme"
