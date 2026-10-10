/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { KeteWordmark, logoLayout } from "../../src/kete/mark"

test("the logo shows the mark and wordmark, then the wordmark alone, then upstream's compact logo", () => {
  expect(logoLayout(80, 20)).toBe("mark")
  expect(logoLayout(56, 12)).toBe("mark")
  expect(logoLayout(55, 12)).toBe("wordmark")
  expect(logoLayout(44, 12)).toBe("wordmark")
  expect(logoLayout(43, 12)).toBe("compact")
  expect(logoLayout(80, 11)).toBe("compact")
})

test("the wordmark renders Kete and Code side by side", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const app = await testRender(
    () => <KeteWordmark text={color} muted={color} background={RGBA.fromInts(0, 0, 0)} />,
    { width: 44, height: 4 },
  )
  await app.renderOnce()
  try {
    const text = app.captureCharFrame()
    expect(text).toContain("█ ▄▀ █▀▀█ ▄█▄▄ █▀▀█  █    █▀▀█ █▀▀█ █▀▀█")
    expect(text).toContain("▀  ▀ ▀▀▀▀  ▀▀▀ ▀▀▀▀  ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀")
  } finally {
    app.renderer.destroy()
  }
})
