// tokens.css can't be imported into a test (its font url() resolves relative to Vite, not bun:test),
// so this reads the source text directly. Keeps tokens.css, the ui-package theme and the wordmark
// font in lockstep, and guards the "no remote resources" rule (AC6).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { brand } from "@opencode/ui/theme/kete/theme"
import { MARK_RECTS, MARK_VIEWBOX } from "./mark"

const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8")

describe("tokens.css", () => {
  test("the brand colour matches the web UI's theme", () => {
    const match = /:root\s*{[^}]*--kete-brand:\s*(#[0-9a-fA-F]{6});/.exec(css)
    expect(match?.[1]?.toLowerCase()).toBe(brand.light.toLowerCase())
  })

  test("the wordmark font is bundled, never loaded remotely", () => {
    const match = /@font-face\s*{[^}]*src:\s*url\("([^"]+)"\)/.exec(css)
    expect(match?.[1]).toBeDefined()
    const url = match![1]!
    expect(url).not.toMatch(/^https?:/)
    expect(url).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(url.endsWith(".woff2")).toBe(true)
  })
})

describe("MARK_RECTS", () => {
  test("eight bars inside the 512 viewBox", () => {
    expect(MARK_VIEWBOX).toBe("0 0 512 512")
    expect(MARK_RECTS).toHaveLength(8)
    for (const rect of MARK_RECTS) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(512)
      expect(rect.y + rect.height).toBeLessThanOrEqual(512)
      expect(["brand", "ink"]).toContain(rect.fill)
    }
  })
})
