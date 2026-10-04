// Kete Code branding for the web UI's text (upstream's packages/app).
//
// Every translation, in every locale, passes through `brandDictionary` when the dictionary
// loads (runtime/i18n/language.tsx), so upstream's ~66 locale files stay untouched and never
// conflict on sync. Rules, applied to translated values only (never to keys):
// - The product name "OpenCode" (and "OpenCode V2") → "Kete Code".
// - CLI commands and config files: `opencode pair` → `kete pair`, opencode.json → kete.json,
//   .opencode/ → .kete/.
// - Worktree setup-script variables: $OPENCODE_WORKTREE_BASE / _PATH → $KETE_WORKTREE_BASE / _PATH.
//   The runtime passes both names (core/src/worktree.ts); the hints show Kete Code's.
// - Kept as they are, because they name something that really is OpenCode's: the hosted
//   services (OpenCode Zen, Go, Console, Free) and links to opencode.ai.
// - `overrides` replaces whole strings that a word swap would make false.

import { Brand } from "@opencode/util/kete/brand"

const hosted = /OpenCode(?= (?:Zen|Go|Console|Free|Black)\b)/g
const placeholder = "\u0000HOSTED\u0000"

/** Strings where replacing the name would state something untrue; used for every locale. */
export const overrides: Readonly<Record<string, string>> = {
  // Kete Code is built on OpenCode; OpenCode's trademark notice must not be rebranded.
  "settings.about.trademark": `${Brand.displayName} is built on OpenCode. OpenCode is a registered trademark of Anomaly Innovations, Inc.`,
  // Kete Code doesn't enable free hosted models by default (docs/adr/0003-hosted-services-opt-in.md).
  "sidebar.gettingStarted.line1": "Connect a model provider to start.",
}

export function brandText(value: string) {
  return value
    .replace(hosted, placeholder)
    .replace(/OpenCode V2\b/g, Brand.displayName)
    .replace(/OpenCode/g, Brand.displayName)
    .replaceAll(placeholder, "OpenCode")
    .replace(/\$OPENCODE_WORKTREE_(BASE|PATH)\b/g, `$${Brand.envPrefix}WORKTREE_$1`)
    .replace(/(^|[^\w.\/-])opencode(\.jsonc?)\b/g, `$1${Brand.configFiles[0].replace(/\.json$/, "")}$2`)
    .replace(/(^|[^\w.-])\.opencode\b/g, `$1${Brand.projectDirectory}`)
    .replace(/(^|[\s`'"(])opencode(?=[\s`'")]|$)/g, `$1${Brand.cliName}`)
}

export function brandDictionary<Dictionary extends Record<string, unknown>>(dictionary: Dictionary): Dictionary {
  return Object.fromEntries(
    Object.entries(dictionary).map(([key, value]) => [
      key,
      overrides[key] ?? (typeof value === "string" ? brandText(value) : value),
    ]),
    // Same keys, string values rewritten: the dictionary's shape is unchanged.
  ) as Dictionary
}
