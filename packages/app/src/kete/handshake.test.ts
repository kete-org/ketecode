import { describe, expect, test } from "bun:test"
import { KeteHandshakeRpc } from "@opencode/schema/kete/handshake"
import { checkServerHealth } from "@/runtime/server/health"

const server = { url: "http://localhost:4096" }
const handshakePath = "/api/rpc/kete.handshake/get"

const info = () => Response.json({ version: "1.2.3", pid: 1, urls: [server.url], paths: { tmp: "/tmp/x" } })

function fakeFetch(onHandshake: () => Response | Promise<Response>) {
  const calls = { handshake: 0 }
  const fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
    if (url.pathname !== handshakePath) return info()
    calls.handshake++
    return onHandshake()
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const answer = (protocol: number) => () =>
  Response.json({ output: { protocol, runtime: "1.2.3", modes: ["code"] } })

describe("handshake in checkServerHealth", () => {
  test("a server on the same protocol is healthy", async () => {
    const { fetch } = fakeFetch(answer(KeteHandshakeRpc.PROTOCOL))
    expect(await checkServerHealth(server, fetch)).toEqual({ healthy: true, version: "1.2.3" })
  })

  test("a server on another protocol is incompatible", async () => {
    const { fetch } = fakeFetch(answer(KeteHandshakeRpc.PROTOCOL + 1))
    expect(await checkServerHealth(server, fetch)).toEqual({ healthy: false, incompatible: true, version: "1.2.3" })
  })

  test("a result that does not decode is incompatible", async () => {
    const { fetch } = fakeFetch(() => Response.json({ output: { nope: true } }))
    expect(await checkServerHealth(server, fetch)).toMatchObject({ healthy: false, incompatible: true })
  })

  test("a server without the RPC is incompatible", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "no such rpc" }, { status: 400 }),
    )
    expect(await checkServerHealth(server, fetch)).toMatchObject({ healthy: false, incompatible: true })
  })

  test("a transport failure on the handshake is retried and is not incompatible", async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new TypeError("fetch failed")
    })
    const result = await checkServerHealth(server, fetch, { retryDelayMs: 0 })
    expect(result).toEqual({ healthy: false })
    expect(calls.handshake).toBe(3)
  })

  test("rejected credentials on the handshake are reported once", async () => {
    const { fetch, calls } = fakeFetch(() =>
      Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 }),
    )
    expect(await checkServerHealth(server, fetch)).toEqual({ healthy: false, unauthorized: true })
    expect(calls.handshake).toBe(1)
  })
})
