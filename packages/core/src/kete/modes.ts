// Mode profiles (./modes/*.jsonc): embedded in the binary, decoded strictly at module load. A bad
// profile is a startup error, never a default. Not user-editable. The Work profile's fields are enforced by work-mode.ts (WS1 1.3).

export * as KeteModes from "./modes.js"

import { KeteModesRpc } from "@opencode/schema/kete/modes"
import { Schema } from "effect"
import code from "./modes/code.jsonc"
import work from "./modes/work.jsonc"

const decode = Schema.decodeUnknownSync(KeteModesRpc.Profile, { errors: "all", onExcessProperty: "error" })

function load(file: KeteModesRpc.Id, raw: unknown): KeteModesRpc.Profile {
  try {
    const profile = decode(raw)
    if (profile.id !== file) throw new Error(`id "${profile.id}" does not match the file name`)
    return profile
  } catch (cause) {
    throw new Error(`mode profile ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

const profiles: readonly KeteModesRpc.Profile[] = [load("code", code), load("work", work)]

export function list(): readonly KeteModesRpc.Profile[] {
  return profiles
}

export function get(id: KeteModesRpc.Id): KeteModesRpc.Profile {
  const profile = profiles.find((item) => item.id === id)
  if (!profile) throw new Error(`mode profile ${id} is not loaded`)
  return profile
}

export function summaries(): KeteModesRpc.Summary[] {
  return profiles.map(({ id, name, description, agent, available }) => ({ id, name, description, agent, available }))
}

export function available(): KeteModesRpc.Id[] {
  return profiles.filter((item) => item.available).map((item) => item.id)
}
