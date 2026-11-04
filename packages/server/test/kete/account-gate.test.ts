import { describe, expect, test } from "bun:test"
import { KeteAccountGate } from "../../src/kete/account-gate"

const local = { hostname: "127.0.0.1", remoteURLs: [], environment: {} }
const login = { path: "/api/rpc/kete.account/login" }

describe("KeteAccountGate", () => {
  test("allows every method on a loopback server", () => {
    for (const hostname of ["127.0.0.1", "::1", "[::1]", "localhost"])
      for (const method of ["status", "login", "cancel", "logout"])
        expect(KeteAccountGate.check({ path: `/api/rpc/kete.account/${method}` }, { ...local, hostname }).ok).toBe(true)
  })

  test("refuses credential methods when the server is not local-only", () => {
    const refused = [
      { ...local, hostname: "0.0.0.0" },
      { ...local, hostname: "192.168.1.10" },
      { ...local, hostname: "devbox.local" },
      { ...local, socket: "/tmp/kete.sock" },
      { ...local, remoteURLs: ["https://tunnel.example"] },
      ...["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CODESPACES", "REMOTE_CONTAINERS"].map((name) => ({
        ...local,
        environment: { [name]: "1" },
      })),
    ]
    for (const server of refused) expect(KeteAccountGate.check(login, server).ok).toBe(false)
  })

  test("status always passes, and other RPCs are untouched", () => {
    const remote = { ...local, hostname: "0.0.0.0" }
    expect(KeteAccountGate.check({ path: "/api/rpc/kete.account/status" }, remote).ok).toBe(true)
    expect(KeteAccountGate.check({ path: "/api/rpc/kete.todo/get" }, remote).ok).toBe(true)
    expect(KeteAccountGate.check({ path: "/api/session" }, remote).ok).toBe(true)
  })

  test("a percent-encoded id or method is still gated", () => {
    const remote = { ...local, hostname: "0.0.0.0" }
    expect(KeteAccountGate.check({ path: "/api/rpc/kete%2Eaccount/login" }, remote).ok).toBe(false)
    expect(KeteAccountGate.check({ path: "/api/rpc/kete.account/%6Cogin" }, remote).ok).toBe(false)
    expect(KeteAccountGate.check({ path: "/api/rpc/kete.account" }, remote).ok).toBe(false)
    expect(KeteAccountGate.check({ path: "/api/rpc/kete.account/status/extra" }, remote).ok).toBe(false)
  })
})
