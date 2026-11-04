// The Kete Code desktop app's identity (packages/desktop, docs/desktop.md): one place for the app IDs,
// product names, deep-link scheme and package names that upstream's Electron app hard-codes, so its
// build config, main process and updater read them from here instead of naming OpenCode.

export * as KeteDesktop from "./desktop.js"

import { cliName, displayName } from "./brand.js"

export type Channel = "dev" | "beta" | "prod"

/** Bundle / application IDs (macOS bundle identifier, Windows AppUserModelID, Linux desktop file). */
export const appIDs = {
  dev: "ai.ketecode.desktop.dev",
  beta: "ai.ketecode.desktop.beta",
  prod: "ai.ketecode.desktop",
} as const satisfies Record<Channel, string>

/** The app's name in the dock, the Start menu and window titles. */
export const productNames = {
  dev: `${displayName} Dev`,
  beta: `${displayName} Beta`,
  prod: displayName,
} as const satisfies Record<Channel, string>

/** Deep links (`kete://…`). */
export const scheme = cliName

/** Release file names: `kete-desktop-<os>-<arch>.<ext>`. */
export const artifactPrefix = `${cliName}-desktop`

/** deb and rpm package names. */
export const linuxPackages = {
  dev: `${cliName}-dev`,
  beta: `${cliName}-beta`,
  prod: cliName,
} as const satisfies Record<Channel, string>

/**
 * The electron-updater feed for each channel. None yet: Kete Code has no signed desktop update feed,
 * so a packaged app never checks for updates (it would otherwise ask OpenCode's servers). Set these
 * once desktop releases are signed and published.
 */
export const updateFeeds: Readonly<Record<Channel, string | undefined>> = {
  dev: undefined,
  beta: undefined,
  prod: undefined,
}

/** Whether a packaged app on `channel` checks for updates: only once that channel has a feed. */
export function updatesEnabled(channel: string): boolean {
  const feeds: Readonly<Record<string, string | undefined>> = updateFeeds
  return feeds[channel] !== undefined
}
