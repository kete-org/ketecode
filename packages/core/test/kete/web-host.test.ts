import { describe, expect, test } from "bun:test"
import { KeteWebHost } from "@opencode/core/kete/web-host"
import { Wildcard } from "@opencode/core/util/wildcard"

describe("KeteWebHost.savePatterns", () => {
  test("saves the origin and everything under it", () => {
    expect(KeteWebHost.savePatterns("https://Docs.Example.com:8443/a/b?q=1")).toEqual([
      "https://docs.example.com:8443",
      "https://docs.example.com:8443/*",
    ])
  })
  test("a saved host doesn't match a longer host name", () => {
    const [, under] = KeteWebHost.savePatterns("https://example.com/x")
    expect(Wildcard.match("https://example.com/docs", under!)).toBe(true)
    expect(Wildcard.match("https://example.com.evil.test/docs", under!)).toBe(false)
  })
  test("nothing is saved for an unparseable URL", () => {
    expect(KeteWebHost.savePatterns("not a url")).toEqual([])
  })
})
