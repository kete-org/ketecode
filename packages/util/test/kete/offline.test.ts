import { describe, expect, test } from "bun:test"
import { KeteOffline } from "../../src/kete/offline.js"

describe("KeteOffline.read / enabled", () => {
  test("unset or empty is off", () => {
    expect(KeteOffline.read({})).toEqual({ kind: "off" })
    expect(KeteOffline.read({ OPENCODE_OFFLINE: "" })).toEqual({ kind: "off" })
    expect(KeteOffline.enabled({})).toBe(false)
  })

  test('"1" and "true" are on', () => {
    expect(KeteOffline.read({ OPENCODE_OFFLINE: "1" })).toEqual({ kind: "on" })
    expect(KeteOffline.read({ OPENCODE_OFFLINE: "TRUE" })).toEqual({ kind: "on" })
    expect(KeteOffline.enabled({ OPENCODE_OFFLINE: "1" })).toBe(true)
  })

  test("anything else is invalid and counts as on (fail closed)", () => {
    expect(KeteOffline.read({ OPENCODE_OFFLINE: "yes" })).toEqual({ kind: "invalid", value: "yes" })
    expect(KeteOffline.enabled({ OPENCODE_OFFLINE: "0" })).toBe(true)
    expect(KeteOffline.enabled({ OPENCODE_OFFLINE: "no" })).toBe(true)
    const long = KeteOffline.read({ OPENCODE_OFFLINE: "x".repeat(80) })
    expect(long.kind === "invalid" && long.value.length).toBe(51)
  })

  test("public name and refusal wording", () => {
    expect(KeteOffline.publicName).toBe("KETE_OFFLINE")
    expect(KeteOffline.refuse("kete login")).toBe(
      "Offline mode is on (--offline, KETE_OFFLINE or kete.offline): `kete login` needs the network.",
    )
  })
})

describe("KeteOffline.isLocalHost", () => {
  test.each([
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "[::1]",
    "localhost",
    "LOCALHOST",
    "ollama.localhost",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "fc00::1",
    "fd12:3456::7",
    "fe80::1",
    "[fe80::1%en0]",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.20",
    "::ffff:c0a8:114",
  ])("%s is local", (host) => {
    expect(KeteOffline.isLocalHost(host)).toBe(true)
  })

  test.each([
    "169.254.169.254",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "8.8.8.8",
    "0.0.0.0",
    "::",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "gpu.lan",
    "example.com",
    "localhost.example.com",
    "notlocalhost",
    "999.1.1.1",
    "",
  ])("%s is not local", (host) => {
    expect(KeteOffline.isLocalHost(host)).toBe(false)
  })
})

describe("KeteOffline.isLoopbackHost", () => {
  test("loopback only, not the rest of the private ranges", () => {
    for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", "a.localhost", "::ffff:127.0.0.1"])
      expect(KeteOffline.isLoopbackHost(host)).toBe(true)
    for (const host of ["192.168.1.20", "10.0.0.1", "fe80::1", "example.com", "::ffff:10.0.0.1"])
      expect(KeteOffline.isLoopbackHost(host)).toBe(false)
  })
})

describe("KeteOffline.isLocalURL", () => {
  test("accepts http(s) URLs with local hosts", () => {
    expect(KeteOffline.isLocalURL("http://127.0.0.1:11434/v1")).toBe(true)
    expect(KeteOffline.isLocalURL("https://192.168.1.20:8443")).toBe(true)
    expect(KeteOffline.isLocalURL("http://[::1]:8000/v1")).toBe(true)
    expect(KeteOffline.isLocalURL("http://[::ffff:127.0.0.1]:8000/v1")).toBe(true)
  })

  test("rejects public hosts, other schemes and garbage", () => {
    expect(KeteOffline.isLocalURL("https://api.openai.com/v1")).toBe(false)
    expect(KeteOffline.isLocalURL("http://169.254.169.254/latest")).toBe(false)
    expect(KeteOffline.isLocalURL("ftp://127.0.0.1")).toBe(false)
    expect(KeteOffline.isLocalURL("not a url")).toBe(false)
  })
})
