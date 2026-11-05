// The Code | Work switch's logic, free of app contexts (view.tsx draws it, mode-switch.tsx connects it).
// The runtime lists its modes through `kete.modes`; any failure to get that list means Code only, so
// the switch never offers a mode the runtime did not confirm. The mode picked on the new-session screen
// reaches `session.create` through `choose`/`chosen` (new-session/composer-adapter.ts reads it).

export * as KeteModeSwitch from "./state.js"

import type { OpenCodeClient, SessionMetadata } from "@opencode/client/promise"
import { KeteModesRpc } from "@opencode/schema/kete/modes"
import { KeteSessionModes } from "@opencode/util/kete/session-mode"
import { Schema } from "effect"

export type Mode = KeteModesRpc.Summary

export const CODE_ONLY: readonly Mode[] = [
  { id: "code", name: "Code", description: "", agent: "build", available: true },
]

const decodeList = Schema.decodeUnknownOption(Schema.Array(KeteModesRpc.Summary))

/** The runtime's list, or Code only when it is garbage or has no available Code. */
export function decodeModes(output: unknown): readonly Mode[] {
  const list = decodeList(output)
  if (list._tag === "None" || !list.value.some((mode) => mode.id === "code" && mode.available)) return CODE_ONLY
  return list.value
}

export async function fetchModes(client: Pick<OpenCodeClient, "rpc">, signal?: AbortSignal): Promise<readonly Mode[]> {
  try {
    const response = await client.rpc.call(
      { rpcID: KeteModesRpc.ID, method: "list", input: {} },
      { signal: signal ?? AbortSignal.timeout(15_000) },
    )
    return decodeModes(response.output)
  } catch {
    // An older runtime without the RPC, a transport error or a timeout: the switch is advisory.
    return CODE_ONLY
  }
}

/** The saved mode if the runtime lists it as available, else Code. */
export function effective(saved: string | undefined, modes: readonly Mode[]): KeteSessionModes.Mode {
  const mode = KeteSessionModes.parse(saved)
  return mode && modes.some((item) => item.id === mode && item.available) ? mode : "code"
}

/** `session.create`'s `agent` and `metadata`. Code changes nothing; Work leaves the agent to the runtime. */
export function createFields<A extends string>(input: {
  agent: A | undefined
  metadata: SessionMetadata | undefined
  mode: string | undefined
}): { agent: A | undefined; metadata: SessionMetadata | undefined } {
  if (KeteSessionModes.parse(input.mode) !== "work") return { agent: input.agent, metadata: input.metadata }
  return { agent: undefined, metadata: { ...input.metadata, [KeteSessionModes.metadataKey]: "work" } }
}

/** The next (+1) or previous (-1) available mode after `current`, wrapping; `current` if there is none. */
export function step(modes: readonly Mode[], current: string, direction: 1 | -1): string {
  const start = modes.findIndex((mode) => mode.id === current)
  for (let i = 1; i < modes.length; i++) {
    const mode = modes[(start + direction * i + modes.length * i) % modes.length]
    if (mode?.available) return mode.id
  }
  return current
}

const chosenModes = new Map<string, string>()
const key = (server: string, directory: string) => `${server}\n${directory}`

export function choose(server: string, directory: string, mode: string) {
  chosenModes.set(key(server, directory), mode)
}

export function chosen(server: string, directory: string): string | undefined {
  return chosenModes.get(key(server, directory))
}
