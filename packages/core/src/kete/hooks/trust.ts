// Which repositories' hooks the user trusts (kete/hooks.ts): one file in Kete Code's state
// directory, mapping a repository's real path to the fingerprint of the project hooks the user
// accepted (settings.ts `fingerprint`). Any change to those hooks gives a new fingerprint, so the user
// is asked again. Written atomically (temp file + rename, mode 0600), at most 500 repositories (oldest
// dropped); a file that can't be read or doesn't match the schema counts as "nothing trusted". The
// store itself is util/src/kete/trust-store.ts, shared with folder trust (folder-trust-store.ts).

export * as KeteHooksTrust from "./trust.js"

import { KeteTrustStore } from "@opencode/util/kete/trust-store"

export const FILE = "hooks-trust.json"
export const MAX_ENTRIES = 500

export function make(stateDirectory: string) {
  const store = KeteTrustStore.hooks(stateDirectory)

  return {
    file: store.file,
    async trusted(repository: string, fingerprint: string): Promise<boolean> {
      return (await store.get(repository))?.fingerprint === fingerprint
    },
    trust(repository: string, fingerprint: string, commands: ReadonlyArray<string>): Promise<void> {
      return store.set(repository, { fingerprint, commands: [...commands], trusted: Date.now() })
    },
    /** Forgets a repository (`kete trust remove`). */
    remove(repository: string): Promise<void> {
      return store.remove(repository)
    },
  }
}

export type Trust = ReturnType<typeof make>
