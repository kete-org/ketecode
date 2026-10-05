// Resolves `{kete-secret:mcp:<name>}` references in a local MCP server's environment when the server
// is spawned (core/src/mcp/client.ts, marked `kete_change`). The value comes from the OS secret store
// (or its user-only fallback file) and goes only into the child's environment; errors name the server
// and entry, never the value. See util/src/kete/mcp-secret.ts and docs/integrations/harness.md.
//
// The secret is released only to the exact definition it was stored for (name, command, cwd and
// environment fingerprint, util/src/kete/mcp-secret.ts `resolve`). A server that receives a stored
// secret also runs in a Kete-owned working directory instead of the project: `npx` reads the working
// directory's `.npmrc` and `node_modules`, and many servers load a `.env` from it, so an untrusted
// repository could otherwise redirect the genuine, pinned command (another registry, a planted
// package, `HARNESS_BASE_URL` in `.env`) and receive the key.

export * as KeteMcpSecrets from "./mcp-secrets.js"

import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Global } from "@opencode/util/global"
import { KeteMcpSecret } from "@opencode/util/kete/mcp-secret"
import { Effect } from "effect"

export type Lookup = (name: string) => Promise<KeteMcpSecret.Stored | undefined>

const stored: Lookup = (name) => KeteMcpSecret.read(KeteMcpSecret.stores(Global.Path.data), name)

export interface Definition {
  readonly type: string
  readonly command?: readonly string[]
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string>>
}

/** The environment with every secret reference replaced; fails when a reference can't be released. */
export const resolve = (
  server: string,
  definition: Definition,
  lookup: Lookup = stored,
): Effect.Effect<Record<string, string>, Error> =>
  Effect.tryPromise({
    try: () => KeteMcpSecret.resolve(server, definition, lookup),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

/** Whether the definition's environment refers to a stored secret. */
export function usesSecret(definition: Definition): boolean {
  return Object.values(definition.environment ?? {}).some((value) => KeteMcpSecret.parse(value).kind !== "plain")
}

/** The Kete-owned working directory for a server that receives a stored secret. */
export function isolatedDirectory(server: string, data: string = Global.Path.data): string {
  return path.join(data, "mcp-servers", KeteMcpSecret.entry(server).slice(KeteMcpSecret.prefix.length))
}

/**
 * What to spawn a local server with: `cwd` is the project-relative directory upstream computed, kept
 * for servers without a stored secret and replaced by `isolatedDirectory` for servers that get one.
 */
export const prepare = (
  server: string,
  definition: Definition,
  cwd: string,
  options: { readonly lookup?: Lookup; readonly data?: string } = {},
): Effect.Effect<{ readonly cwd: string; readonly environment: Record<string, string> }, Error> =>
  Effect.gen(function* () {
    const environment = yield* resolve(server, definition, options.lookup)
    if (!usesSecret(definition)) return { cwd, environment }
    const isolated = isolatedDirectory(server, options.data)
    yield* Effect.tryPromise({
      try: () => mkdir(isolated, { recursive: true, mode: 0o700 }),
      catch: (error) =>
        new Error(
          `MCP server "${server}": could not create its working directory ${isolated}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })
    return { cwd: isolated, environment }
  })
