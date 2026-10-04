// The Kete account `kete login` signs in to. Shared by the CLI (which writes it) and the gateway
// provider in core (which reads it), so it lives here: the CLI may not import core.
//
// Two pieces, kept apart on purpose:
// - `<config>/account.json`: non-secret details (platform and gateway URLs, organization, key id, and
//   which store holds the key). Written by `kete login`, never by hand; `kete.json` is left alone.
// - The key itself, in the OS credential store (see ./secret-store.ts), or in the user-only fallback
//   file under `<data>` when no OS store works.

import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Global } from "../global.js"
import { KeteSecretStore } from "./secret-store.js"

const Kind = Schema.Literals(["keychain", "secret-service", "credential-manager", "file"])

export const Account = Schema.Struct({
  version: Schema.Literal(1),
  platform_url: Schema.String,
  gateway_url: Schema.String,
  organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
  key_id: Schema.String,
  device_name: Schema.String,
  storage: Kind,
  created_at: Schema.String,
})
export type Account = typeof Account.Type
export type Details = Omit<Account, "version" | "storage" | "created_at">

export type Options = {
  /** Directory holding account.json. */
  readonly config: string
  /** Directory for the fallback key file. */
  readonly data: string
  /** The OS store to try first; `undefined` skips straight to the fallback file. */
  readonly native: KeteSecretStore.Store | undefined
}

export function defaults(): Options {
  return { config: Global.Path.config, data: Global.Path.data, native: KeteSecretStore.native() }
}

export function file(options: Pick<Options, "config">) {
  return path.join(options.config, "account.json")
}

/** The signed-in account, or `undefined` when nobody is signed in. Throws when account.json is unreadable. */
export async function read(options: Pick<Options, "config">) {
  const location = file(options)
  const text = await readFile(location, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Account))(text)
  if (decoded._tag === "None")
    throw new Error(`${location} is not a valid account file. Run \`kete logout\` and sign in again.`)
  return decoded.value
}

/** Stores the key, then records the account. Returns where the key went and why any OS store was skipped. */
export async function save(options: Options, details: Details, secret: string) {
  const candidates = [options.native, store(options, "file")].filter((item) => item !== undefined)
  const saved = await KeteSecretStore.save(candidates, entry(details), secret)
  const account = Account.make({
    version: 1,
    ...details,
    storage: saved.store.kind,
    created_at: new Date().toISOString(),
  })
  await mkdir(options.config, { recursive: true, mode: 0o700 })
  // Write-then-rename, so a reader never sees half a file.
  const location = file(options)
  const temporary = `${location}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(account, null, 2) + "\n", { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, location)
  return { account, store: saved.store, skipped: saved.skipped }
}

/** The account's key, or `undefined` when its store no longer has it. */
export function key(options: Options, account: Account) {
  return store(options, account.storage).get(entry(account))
}

/** Removes the account's key from its store (a missing key is not an error). */
export function removeKey(options: Options, account: Account) {
  return store(options, account.storage).remove(entry(account))
}

/** Removes the key and account.json. Both are attempted; any failures are returned, never thrown. */
export async function clear(options: Options, account: Account | undefined) {
  const location = file(options)
  return [
    ...(account
      ? await removeKey(options, account).then(
          () => [],
          (error: unknown) => [
            `the key could not be removed from ${store(options, account.storage).description}: ${message(error)}`,
          ],
        )
      : []),
    ...(await rm(location, { force: true }).then(
      () => [],
      (error: unknown) => [`${location} could not be removed: ${message(error)}`],
    )),
  ]
}

/** The store an account's key lives in. */
export function store(options: Options, kind: Account["storage"]) {
  if (kind === "file") return KeteSecretStore.file(options.data)
  if (options.native?.kind === kind) return options.native
  if (kind === "keychain") return KeteSecretStore.keychain()
  if (kind === "secret-service") return KeteSecretStore.secretService()
  return KeteSecretStore.credentialManager()
}

/** The credential entry name: one per platform host and key, so accounts on different platforms never collide. */
function entry(details: Pick<Details, "platform_url" | "key_id">) {
  return `${new URL(details.platform_url).host}/${details.key_id}`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as KeteAccount from "./account.js"
