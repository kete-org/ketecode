// Which folders the person trusts (folder trust, ./folder-trust.ts): `folder-trust.json` in Kete
// Code's state directory, mapping a trust root's store key (its real path, lowercased on Windows) to
// the fingerprint of the guarded settings that were reviewed, the names of what was held back, and
// when. A changed fingerprint isn't trusted. At most 500 folders; the store fails closed
// (./trust-store.ts).

export * as KeteFolderTrustStore from "./folder-trust-store.js"

import { Schema } from "effect"
import { KeteTrustStore } from "./trust-store.js"

export const FILE = "folder-trust.json"
export const MAX_ENTRIES = 500
/** Names of held-back items stored per folder, each at most this long. */
const MAX_HELD = 200
const MAX_HELD_LENGTH = 300

export const Entry = Schema.Struct({
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  held: Schema.Array(Schema.String),
  trusted: Schema.Number,
})
export type Entry = typeof Entry.Type

export function make(stateDirectory: string) {
  const store = KeteTrustStore.make<Entry>({ stateDirectory, file: FILE, collection: "folders", entry: Entry, max: MAX_ENTRIES })
  return {
    file: store.file,
    /** Whether `key` is trusted for exactly this fingerprint. */
    trusted: async (key: string, fingerprint: string) => (await store.get(key))?.fingerprint === fingerprint,
    get: store.get,
    trust: (key: string, fingerprint: string, held: ReadonlyArray<string>) =>
      store.set(key, {
        fingerprint,
        held: held.slice(0, MAX_HELD).map((item) => (item.length > MAX_HELD_LENGTH ? `${item.slice(0, MAX_HELD_LENGTH)}…` : item)),
        trusted: Date.now(),
      }),
    remove: store.remove,
    list: store.list,
  }
}

export type Store = ReturnType<typeof make>
