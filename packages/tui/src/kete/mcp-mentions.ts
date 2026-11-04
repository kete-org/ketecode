// `@` options for MCP resources (parity B6): picking one attaches it as a `kete-mcp:` file, which
// core/src/kete/mcp-mentions.ts reads from its server when the prompt is sent.

import type { Mcp } from "@opencode/schema/mcp"
import { KeteMcpMention } from "@opencode/util/kete/mcp-mention"
import type { AutocompleteOption } from "../component/prompt/autocomplete"

/** The mention text for a resource: `server:name`, whitespace replaced so the mention stays one word. */
export function label(resource: Pick<Mcp.Resource, "server" | "name">) {
  return `${resource.server}:${resource.name}`.replace(/\s+/g, "-")
}

export function options(
  resources: ReadonlyArray<Mcp.Resource>,
  insert: (text: string, file: { uri: string; name: string }) => void,
): AutocompleteOption[] {
  return resources.map((resource) => ({
    display: "@" + label(resource),
    kind: "reference",
    description: ` ${resource.description ?? resource.uri}`,
    onSelect: () =>
      // The server's name and description stay in the menu; core labels the content as the server's.
      insert(label(resource), { uri: KeteMcpMention.encode(resource.server, resource.uri), name: label(resource) }),
  }))
}

export * as KeteMcpMentionOptions from "./mcp-mentions.js"
