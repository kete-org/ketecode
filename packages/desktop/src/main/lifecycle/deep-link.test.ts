import { KeteDesktop } from "@opencode/util/kete/desktop" // kete_change
import { describe, expect, test } from "bun:test"
import { consoleReturnWindow } from "./deep-link"

describe("Console return deep links", () => {
  test("reads the originating Desktop window", () => {
    expect(consoleReturnWindow(`${KeteDesktop.scheme}://console/authorized?window=window-a`)).toBe("window-a") // kete_change
    expect(consoleReturnWindow("opencode://console/authorized?window=window-a")).toBeUndefined() // kete_change: not Kete Code's scheme
    expect(consoleReturnWindow(`${KeteDesktop.scheme}://console/authorized?window=window%20b`)).toBe("window b") // kete_change
  })

  test("rejects unrelated and malformed links", () => {
    expect(consoleReturnWindow(`${KeteDesktop.scheme}://console/other?window=window-a`)).toBeUndefined() // kete_change
    expect(consoleReturnWindow(`${KeteDesktop.scheme}://other/authorized?window=window-a`)).toBeUndefined() // kete_change
    expect(consoleReturnWindow("https://console/authorized?window=window-a")).toBeUndefined()
    expect(consoleReturnWindow("not a url")).toBeUndefined()
    expect(consoleReturnWindow(`${KeteDesktop.scheme}://console/authorized`)).toBeUndefined() // kete_change
  })
})
