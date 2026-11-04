import { describe, expect, test } from "bun:test"
import { KeteDesktop } from "../../src/kete/desktop"

describe("KeteDesktop", () => {
  test("no channel checks for updates until it has a feed", () => {
    for (const channel of ["dev", "beta", "prod", "local", "unknown"]) expect(KeteDesktop.updatesEnabled(channel)).toBe(false)
  })

  test("the app's identity is Kete Code's, never OpenCode's", () => {
    const values = [
      ...Object.values(KeteDesktop.appIDs),
      ...Object.values(KeteDesktop.productNames),
      ...Object.values(KeteDesktop.linuxPackages),
      KeteDesktop.scheme,
      KeteDesktop.artifactPrefix,
    ]
    for (const value of values) expect(value.toLowerCase()).not.toContain("opencode")
    expect(KeteDesktop.appIDs.prod).toBe("ai.ketecode.desktop")
    expect(KeteDesktop.scheme).toBe("kete")
  })
})
