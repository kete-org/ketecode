// The URI a prompt attachment carries for an `@`-mentioned MCP resource: `kete-mcp:<server>/<uri>`,
// both parts percent-encoded. The TUI writes it; core/src/kete/mcp-mentions.ts reads the resource and
// replaces it with the content before the prompt is stored.

export const SCHEME = "kete-mcp:"

export function encode(server: string, uri: string) {
  return `${SCHEME}${encodeURIComponent(server)}/${encodeURIComponent(uri)}`
}

/** The server and resource URI of a mention URI, or undefined for any other URI. */
export function decode(value: string): { server: string; uri: string } | undefined {
  if (!value.startsWith(SCHEME)) return undefined
  const rest = value.slice(SCHEME.length)
  const slash = rest.indexOf("/")
  if (slash <= 0 || slash === rest.length - 1) return undefined
  try {
    return { server: decodeURIComponent(rest.slice(0, slash)), uri: decodeURIComponent(rest.slice(slash + 1)) }
  } catch {
    return undefined
  }
}

export * as KeteMcpMention from "./mcp-mention.js"
