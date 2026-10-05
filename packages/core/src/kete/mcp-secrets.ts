// Resolves `{kete-secret:mcp:<name>}` references in a local MCP server's environment when the server
// is spawned (core/src/mcp/client.ts, marked `kete_change`). The value comes from the OS secret store
// (or its user-only fallback file) and goes only into the child's environment; errors name the entry,
// never the value. See util/src/kete/mcp-secret.ts and docs/integrations/harness.md.

export * as KeteMcpSecrets from "./mcp-secrets.js"

import { Global } from "@opencode/util/global"
import { KeteMcpSecret } from "@opencode/util/kete/mcp-secret"
import { Effect } from "effect"

export type Lookup = (name: string) => Promise<string | undefined>

const stored: Lookup = (name) => KeteMcpSecret.read(KeteMcpSecret.stores(Global.Path.data), name)

/** The environment with every secret reference replaced; fails when a reference can't be resolved. */
export const resolve = (
  server: string,
  environment: Readonly<Record<string, string>> | undefined,
  lookup: Lookup = stored,
): Effect.Effect<Record<string, string>, Error> =>
  Effect.tryPromise({
    try: () => KeteMcpSecret.resolve(server, environment, lookup),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
