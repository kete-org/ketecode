// Secrets for MCP servers (CLAUDE.md §9: long-lived credentials live in the OS store, never in
// plaintext config). `kete mcp add harness` saves the API key with KeteSecretStore under an `mcp:`
// entry and writes only a reference into the server's `environment`:
//
//   "HARNESS_API_KEY": "{kete-secret:mcp:harness}"
//
// The runtime resolves the reference when it spawns the server (core/src/mcp/client.ts, marked), so
// the key exists only in the server process's environment: never in config, the config API, or logs.
// Only `mcp:` entries resolve, so a config can't name the Kete account key (or any other entry) and
// hand it to a process of its choosing.

import path from "node:path"
import { KeteSecretStore } from "./secret-store.js"

export const prefix = "mcp:"

const entryPattern = /^mcp:[A-Za-z0-9._-]{1,64}$/
const referencePattern = /^\{kete-secret:([^}]*)\}$/

/** The secret-store entry for a server's secret, e.g. `mcp:harness`. */
export function entry(server: string): string {
  const value = `${prefix}${server}`
  if (!entryPattern.test(value)) throw new Error(`Invalid MCP server name for a stored secret: ${server}`)
  return value
}

/** The config value that stands for the stored secret. */
export function reference(server: string): string {
  return `{kete-secret:${entry(server)}}`
}

export type Parsed = { readonly kind: "plain" } | { readonly kind: "secret"; readonly entry: string } | { readonly kind: "invalid"; readonly entry: string }

/** Whether a config value is a secret reference. Only whole-value references count. */
export function parse(value: string): Parsed {
  const match = referencePattern.exec(value)
  if (!match) return { kind: "plain" }
  const name = match[1] ?? ""
  return entryPattern.test(name) ? { kind: "secret", entry: name } : { kind: "invalid", entry: name }
}

export interface Stores {
  /** Tried in order: the OS store first, then the file fallback. */
  readonly candidates: readonly KeteSecretStore.Store[]
}

/** The OS store (when there is one) and the user-only fallback file under `data`. */
export function stores(data: string, native: KeteSecretStore.Store | undefined = KeteSecretStore.native()): Stores {
  return {
    candidates: [native, KeteSecretStore.file(path.join(data, "mcp-secrets"))].filter(
      (store): store is KeteSecretStore.Store => store !== undefined,
    ),
  }
}

/** Saves `secret` for `server`; returns the store used and why earlier ones were skipped. The secret never appears in errors. */
export async function save(stores: Stores, server: string, secret: string) {
  if (!storable(secret))
    throw new Error("The secret has characters Kete Code can't store (spaces, quotes, backslashes or non-ASCII)")
  return KeteSecretStore.save(stores.candidates, entry(server), secret).catch((error: unknown) => {
    // KeteSecretStore words its failures for the account key; its details never contain the secret.
    throw new Error(`Could not store the secret: ${message(error).replace(/^Could not store the account key: /, "")}`)
  })
}

/** The secret store's own rule: printable ASCII without spaces, quotes or backslashes. */
export function storable(secret: string): boolean {
  return /^[\x21-\x7e]+$/.test(secret) && !/["'\\]/.test(secret)
}

/** The stored secret, from the first store that has it. */
export async function read(stores: Stores, name: string): Promise<string | undefined> {
  const failures: string[] = []
  for (const store of stores.candidates) {
    const value = await store.get(name).catch((error: unknown) => {
      failures.push(`${store.description}: ${message(error)}`)
      return undefined
    })
    if (value !== undefined) return value
  }
  if (failures.length > 0 && failures.length === stores.candidates.length)
    throw new Error(`Could not read the stored secret ${name}: ${failures.join("; ")}`)
  return undefined
}

/**
 * Replaces every secret reference in a server's environment with the stored value. Fails, naming the
 * entry and never a value, when a reference is invalid or its secret is missing.
 */
export async function resolve(
  server: string,
  environment: Readonly<Record<string, string>> | undefined,
  lookup: (name: string) => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment ?? {})) {
    const parsed = parse(value)
    if (parsed.kind === "plain") {
      resolved[key] = value
      continue
    }
    if (parsed.kind === "invalid")
      throw new Error(
        `MCP server "${server}": ${key} refers to the stored secret "${parsed.entry}", but only "${prefix}<name>" entries can be used`,
      )
    const secret = await lookup(parsed.entry)
    if (secret === undefined)
      throw new Error(
        `MCP server "${server}": no stored secret "${parsed.entry}" for ${key}. Run \`kete mcp add ${parsed.entry.slice(prefix.length)}\` again to store it.`,
      )
    resolved[key] = secret
  }
  return resolved
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as KeteMcpSecret from "./mcp-secret.js"
