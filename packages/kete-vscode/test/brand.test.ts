// One source of truth for the Kete mark's geometry: packages/app/src/kete/mark.tsx's MARK_RECTS.
// This keeps the extension's assets (the activity-bar icon, the Marketplace icon) and manifest in
// lockstep with it and with assets/brand/, so nobody edits one copy and forgets the others.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import packageJson from "../package.json"

const markSource = readFileSync(fileURLToPath(new URL("../../app/src/kete/mark.tsx", import.meta.url)), "utf8")
const svg = readFileSync(fileURLToPath(new URL("../media/kete.svg", import.meta.url)), "utf8")

function markRects(source: string) {
  const block = source.slice(source.indexOf("export const MARK_RECTS"), source.indexOf("]\n", source.indexOf("export const MARK_RECTS")))
  return [...block.matchAll(/{ x: (\d+), y: (\d+), width: (\d+), height: (\d+), rx: (\d+), fill: "(brand|ink)" }/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
    rx: Number(match[5]),
    fill: match[6] as "brand" | "ink",
  }))
}

function svgRects(source: string) {
  return [...source.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)" fill="currentColor"\/>/g)].map(
    (match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
      rx: Number(match[5]),
    }),
  )
}

/** Parses a two-tone SVG (the chat tab icon) into rects with their literal fill color. */
function twoToneRects(source: string) {
  return [...source.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)" fill="(#[0-9A-Fa-f]{6})"\/>/g)].map(
    (match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
      rx: Number(match[5]),
      color: match[6],
    }),
  )
}

describe("the activity-bar mark matches the web UI's mark geometry", () => {
  test("same eight rects, in the same order", () => {
    const app = markRects(markSource)
    expect(app).toHaveLength(8)
    expect(svgRects(svg)).toEqual(app.map(({ fill: _fill, ...rect }) => rect))
  })

  test("every bar is currentColor, no var() (VS Code masks activity-bar icons to one colour)", () => {
    expect(svg).not.toContain("var(")
    expect(svg.match(/fill="currentColor"/g)).toHaveLength(8)
  })

  test("the same 512 viewBox", () => {
    expect(svg).toContain('viewBox="0 0 512 512"')
  })
})

describe("the Marketplace icon is assets/brand/'s, not a separate copy", () => {
  test("byte-identical to assets/brand/kete-logo-512.png", () => {
    const icon = readFileSync(fileURLToPath(new URL("../media/icon.png", import.meta.url)))
    const brand = readFileSync(fileURLToPath(new URL("../../../assets/brand/kete-logo-512.png", import.meta.url)))
    expect(icon.equals(brand)).toBe(true)
  })
})

describe("the manifest's gallery banner is the brand colour", () => {
  test("#6E47F5", () => {
    expect(packageJson.galleryBanner.color).toBe("#6E47F5")
  })
})

describe("the kete-mark product icon", () => {
  test("contributes.icons declares it, pointing at media/kete-mark.woff", () => {
    const icon = (packageJson.contributes as { icons?: Record<string, unknown> }).icons?.["kete-mark"] as
      | { description?: unknown; default?: { fontPath?: unknown; fontCharacter?: unknown } }
      | undefined
    expect(icon).toBeDefined()
    expect(typeof icon?.description).toBe("string")
    expect(icon?.default?.fontPath).toBe("media/kete-mark.woff")
    // A backslash followed by hex digits (VS Code's fontCharacter format), not a JS \u escape.
    expect(icon?.default?.fontCharacter).toMatch(/^\\[0-9a-f]+$/)
  })

  test("media/kete-mark.woff exists and is a WOFF font", () => {
    const woff = readFileSync(fileURLToPath(new URL("../media/kete-mark.woff", import.meta.url)))
    expect(woff.subarray(0, 4).toString("ascii")).toBe("wOFF")
  })
})

describe("every command icon in package.json is the Kete mark", () => {
  test("no command uses a built-in codicon anymore", () => {
    const commands = packageJson.contributes.commands as ReadonlyArray<{ command: string; icon?: string }>
    const withIcons = commands.filter((c) => c.icon !== undefined)
    expect(withIcons.length).toBeGreaterThan(0)
    for (const command of withIcons) expect(command.icon).toBe("$(kete-mark)")
  })
})

describe("the chat tab icon matches the web UI's mark geometry, two-tone", () => {
  const app = markRects(markSource)

  test("light variant: brand bars in the brand colour, ink bars in ink-on-paper", () => {
    const light = readFileSync(fileURLToPath(new URL("../media/kete-tab-light.svg", import.meta.url)), "utf8")
    const rects = twoToneRects(light)
    expect(rects).toHaveLength(8)
    expect(rects.map(({ color: _color, ...rect }) => rect)).toEqual(app.map(({ fill: _fill, ...rect }) => rect))
    for (const [i, rect] of rects.entries()) expect(rect.color).toBe(app[i]!.fill === "brand" ? "#6E47F5" : "#16141D")
  })

  test("dark variant: brand bars in the brand colour, ink bars in paper-on-ink", () => {
    const dark = readFileSync(fileURLToPath(new URL("../media/kete-tab-dark.svg", import.meta.url)), "utf8")
    const rects = twoToneRects(dark)
    expect(rects).toHaveLength(8)
    expect(rects.map(({ color: _color, ...rect }) => rect)).toEqual(app.map(({ fill: _fill, ...rect }) => rect))
    for (const [i, rect] of rects.entries()) expect(rect.color).toBe(app[i]!.fill === "brand" ? "#6E47F5" : "#F1EFF6")
  })
})
