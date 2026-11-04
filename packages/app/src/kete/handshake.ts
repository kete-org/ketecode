// Whether a server speaks the protocol this app does (`kete.handshake`, schema/src/kete/handshake.ts).
// Called by `checkServerHealth` once `server.info` answers. The result is external input, so it is
// decoded; a server with an older runtime has no such RPC and counts as incompatible.

import { isRpcError, type OpenCodeClient } from "@opencode/client/promise"
import { KeteHandshakeRpc } from "@opencode/schema/kete/handshake"
import { Option, Schema } from "effect"

const decodeResult = Schema.decodeUnknownOption(KeteHandshakeRpc.Result)

/** The RPC error types a server answers when it doesn't have the RPC. */
const missing = new Set(["rpc.unavailable", "rpc.method_not_found"])

/** Rejects with the original error for anything other than "no such RPC" (unauthorized, transport, abort). */
export async function check(
  client: Pick<OpenCodeClient, "rpc">,
  signal: AbortSignal | undefined,
): Promise<"compatible" | "incompatible"> {
  const response = await client.rpc
    .call({ rpcID: KeteHandshakeRpc.ID, method: "get", input: {} }, { signal })
    .catch((error: unknown) => {
      if (isRpcError(error) && missing.has(error.type)) return undefined
      throw error
    })

  if (!response) return "incompatible"

  const result = decodeResult(response.output)

  return Option.isSome(result) && result.value.protocol === KeteHandshakeRpc.PROTOCOL ? "compatible" : "incompatible"
}
