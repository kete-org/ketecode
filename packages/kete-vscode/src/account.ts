// The Kete account the CLI is signed in to, read with `kete whoami --format json` (local state only,
// never the key), and the `kete login` output the extension needs to drive sign-in from VS Code.
// Running the CLI rather than reading its files keeps one owner of the account format and works on a
// remote host, where the extension runs next to the CLI. Kept free of the `vscode` module.

export type Account =
  | { readonly signedIn: false; readonly handConfigured: readonly string[] }
  | {
      readonly signedIn: true
      readonly organization: string
      readonly platformURL: string
      readonly gatewayURL: string
      readonly storage: string
      readonly handConfigured: readonly string[]
    }

/** Parses `kete whoami --format json`. Throws on anything unexpected rather than guessing. */
export function parseWhoami(stdout: string): Account {
  const value: unknown = JSON.parse(stdout.trim())
  if (!isRecord(value) || typeof value.signed_in !== "boolean") throw new Error("Unexpected output from kete whoami")
  const handConfigured = Array.isArray(value.hand_configured)
    ? value.hand_configured.filter((item): item is string => typeof item === "string")
    : []
  if (!value.signed_in) return { signedIn: false, handConfigured }
  const organization = isRecord(value.organization) ? value.organization.name : undefined
  if (
    typeof organization !== "string" ||
    typeof value.platform_url !== "string" ||
    typeof value.gateway_url !== "string" ||
    typeof value.storage_description !== "string"
  )
    throw new Error("Unexpected output from kete whoami")
  return {
    signedIn: true,
    organization,
    platformURL: value.platform_url,
    gatewayURL: value.gateway_url,
    storage: value.storage_description,
    handConfigured,
  }
}

/** The authorize URL `kete login` prints on its own indented line. Only http(s) URLs to /cli/authorize. */
export function authorizeURL(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => {
      if (!URL.canParse(line)) return false
      const url = new URL(line)
      return (url.protocol === "https:" || url.protocol === "http:") && url.pathname.endsWith("/cli/authorize")
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
