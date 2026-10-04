import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { wordmarkSvg } from "@opencode/util/kete/wordmark"
import { OauthCallbackPage } from "../../src/oauth/page"

describe("OAuth callback page branding", () => {
  const pages = {
    success: OauthCallbackPage.success({ provider: "xAI" }),
    error: OauthCallbackPage.error("denied", { provider: "xAI" }),
    bootstrap: OauthCallbackPage.bootstrap({ provider: "xAI", tokenPath: "/token" }),
  }

  test("every page shows the Kete Code wordmark and name, never OpenCode's", () => {
    for (const html of Object.values(pages)) {
      expect(html).toContain('<svg class="wordmark"')
      expect(html).toContain('aria-label="Kete Code"')
      expect(html).toContain("· Kete Code</title>")
      expect(html).not.toMatch(/opencode/i)
    }
  })

  test("the status text names Kete Code", () => {
    expect(pages.success).toContain("Kete Code is now connected to xAI.")
    expect(pages.error).toContain("Kete Code couldn't finish connecting to xAI.")
  })

  test("the card's top edge is Kete Code's violet in both colour schemes; the logo is the mark and name", () => {
    for (const html of Object.values(pages)) {
      expect(html).toContain("--oc-brand: #6e47f5;")
      expect(html).toContain("--oc-brand: #a38cfa;")
      expect(html).toContain("border-top: 4px solid var(--oc-brand)")
      expect(html).toContain(">Kete Code</text>")
    }
  })

  test("the logo's mark has exactly the web UI mark's bars (packages/app/src/kete/mark.tsx)", () => {
    const source = readFileSync(fileURLToPath(new URL("../../../app/src/kete/mark.tsx", import.meta.url)), "utf8")
    const block = source.slice(source.indexOf("export const MARK_RECTS"), source.indexOf("]\n", source.indexOf("export const MARK_RECTS")))
    const expected = [...block.matchAll(/{ x: (\d+), y: (\d+), width: (\d+), height: (\d+), rx: (\d+), fill: "(brand|ink)" }/g)].map(
      (m) => `${m[1]},${m[2]},${m[3]},${m[4]},${m[5]},${m[6] === "brand" ? "#6e47f5" : "currentColor"}`,
    )
    const actual = [...wordmarkSvg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)" fill="([^"]+)"\/>/g)].map(
      (m) => `${m[1]},${m[2]},${m[3]},${m[4]},${m[5]},${m[6]}`,
    )
    expect(expected).toHaveLength(8)
    expect(actual).toEqual(expected)
  })
})
