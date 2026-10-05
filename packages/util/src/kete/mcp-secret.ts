// Secrets for MCP servers (CLAUDE.md §9: long-lived credentials live in the OS store, never in
// plaintext config). `kete mcp add harness` saves the API key with KeteSecretStore under an `mcp:`
// entry and writes only a reference into the server's `environment`:
//
//   "HARNESS_API_KEY": "{kete-secret:mcp:harness}"
//
// The runtime resolves the reference when it spawns the server (core/src/mcp/client.ts, marked), so
// the key exists only in the server process's environment: never in config, the config API, or logs.
//
// Binding (security review, docs/tasks/2026-10-05-mcp-presets): config can come from an untrusted
// repository's `.kete/`, so a reference alone must not release the secret. Next to the secret the
// store keeps a fingerprint (SHA-256 over canonical JSON) of the exact server definition it was
// stored for: name, type `local`, command, working directory and every environment entry except the
// reference's value. `resolve` releases the secret only to a local server whose name owns the entry
// (`mcp:<that server>`) and whose current definition has the stored fingerprint; anything else
// (another server, a changed command, a changed or added environment variable) refuses to start the
// server. The fingerprint lives in the secret store, which project config can't write. The config
// layer doesn't tell the spawn which file a server came from, so the fingerprint is the guarantee.
// Only `mcp:` entries resolve, so a config can't name the Kete account key (or any other entry).

import { createHash } from "node:crypto"
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

/** The parts of a local server definition a stored secret is bound to (upstream's `Mcp.LocalConfig`). */
export interface LocalDefinition {
  readonly type: "local"
  readonly command: readonly string[]
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string>>
}

/**
 * SHA-256 (hex) over a canonical JSON of the definition a secret is stored for: the server name, type,
 * command, working directory, every environment entry that isn't a secret reference (keys and values,
 * sorted), and the keys that hold secret references. The reference values themselves are left out.
 */
export function fingerprint(server: string, definition: LocalDefinition): string {
  const entries = Object.entries(definition.environment ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const canonical = JSON.stringify({
    version: 1,
    name: server,
    type: definition.type,
    command: [...definition.command],
    cwd: definition.cwd ?? null,
    environment: entries.filter(([, value]) => parse(value).kind === "plain"),
    secrets: entries.filter(([, value]) => parse(value).kind !== "plain").map(([key]) => key),
  })
  return createHash("sha256").update(canonical).digest("hex")
}

/** A stored secret and the fingerprint of the definition it was stored for. */
export interface Stored {
  readonly secret: string
  /** `undefined` for a value stored without one (before binding existed): never released. */
  readonly fingerprint: string | undefined
}

const recordPattern = /^kete-mcp-v1:([0-9a-f]{64}):(.+)$/s

/** The single store value holding both, so they are written and read together. */
export function encode(stored: { readonly secret: string; readonly fingerprint: string }): string {
  if (!/^[0-9a-f]{64}$/.test(stored.fingerprint)) throw new Error("Invalid MCP secret fingerprint")
  return `kete-mcp-v1:${stored.fingerprint}:${stored.secret}`
}

export function decode(value: string): Stored {
  const match = recordPattern.exec(value)
  return match ? { fingerprint: match[1], secret: match[2] ?? "" } : { fingerprint: undefined, secret: value }
}

/**
 * Saves `secret` for `server`, bound to `definition` (the server entry being written to config);
 * returns the store used and why earlier ones were skipped. The secret never appears in errors.
 */
export async function save(stores: Stores, server: string, secret: string, definition: LocalDefinition) {
  if (!storable(secret))
    throw new Error("The secret has characters Kete Code can't store (spaces, quotes, backslashes or non-ASCII)")
  const value = encode({ secret, fingerprint: fingerprint(server, definition) })
  return KeteSecretStore.save(stores.candidates, entry(server), value).catch((error: unknown) => {
    // KeteSecretStore words its failures for the account key; its details never contain the secret.
    throw new Error(`Could not store the secret: ${message(error).replace(/^Could not store the account key: /, "")}`)
  })
}

/** The secret store's own rule: printable ASCII without spaces, quotes or backslashes. */
export function storable(secret: string): boolean {
  return /^[\x21-\x7e]+$/.test(secret) && !/["'\\]/.test(secret)
}

/** The stored secret and its fingerprint for an entry, from the first store that has it. */
export async function read(stores: Stores, name: string): Promise<Stored | undefined> {
  const value = await readRaw(stores, name)
  return value === undefined ? undefined : decode(value)
}

async function readRaw(stores: Stores, name: string): Promise<string | undefined> {
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
 * The environment to spawn `server` with: plain values as they are, and a secret reference replaced
 * with the stored value only when the reference is exactly `mcp:<server>`, the server is local, and
 * the definition's fingerprint equals the one stored with the secret. Otherwise fails, naming the
 * server and the entry, never a value. The store is only read when there is a reference.
 */
export async function resolve(
  server: string,
  definition: { readonly type: string; readonly command?: readonly string[]; readonly cwd?: string; readonly environment?: Readonly<Record<string, string>> },
  lookup: (name: string) => Promise<Stored | undefined>,
): Promise<Record<string, string>> {
  const environment = definition.environment ?? {}
  const references: Array<{ key: string; entry: string }> = []
  for (const [key, value] of Object.entries(environment)) {
    const parsed = parse(value)
    if (parsed.kind === "plain") continue
    if (parsed.kind === "invalid")
      throw new Error(
        `MCP server "${server}": ${key} refers to the stored secret "${parsed.entry}", but only "${prefix}<name>" entries can be used`,
      )
    references.push({ key, entry: parsed.entry })
  }
  if (references.length === 0) return { ...environment }

  const own = ownEntry(server)
  for (const reference of references) {
    if (reference.entry !== own)
      throw new Error(
        `MCP server "${server}": ${reference.key} refers to the stored secret "${reference.entry}", which belongs to another server; a server can only use its own stored secret ("${prefix}${server}"). The server was not started.`,
      )
  }
  if (definition.type !== "local" || definition.command === undefined)
    throw new Error(`MCP server "${server}": stored secrets are only passed to local servers. The server was not started.`)
  const name = references[0]?.entry ?? own
  const stored = await lookup(name)
  if (stored === undefined)
    throw new Error(
      `MCP server "${server}": no stored secret "${name}" for ${references.map((item) => item.key).join(", ")}. Run \`kete mcp add ${server}\` again to store it.`,
    )
  const current = fingerprint(server, {
    type: "local",
    command: definition.command,
    cwd: definition.cwd,
    environment,
  })
  if (stored.fingerprint === undefined || stored.fingerprint !== current)
    throw new Error(
      `MCP server "${server}": its definition (command, working directory or environment) is not the one the stored secret "${name}" was saved for, so the secret was not released and the server was not started. If you changed it intentionally, run \`kete mcp add ${server}\` again.`,
    )
  const resolved: Record<string, string> = { ...environment }
  for (const reference of references) resolved[reference.key] = stored.secret
  return resolved
}

/** `mcp:<server>`, or `undefined` when the name can't own a stored secret. */
function ownEntry(server: string): string | undefined {
  const value = `${prefix}${server}`
  return entryPattern.test(value) ? value : undefined
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as KeteMcpSecret from "./mcp-secret.js"
