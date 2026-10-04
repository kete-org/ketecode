import { describe, expect, test } from "bun:test"
import { DEFAULT_THEMES } from "../default-themes"
import { resolveThemeVariant } from "../resolve"
import { resolveThemeVariantV2 } from "../v2/resolve"
import oc2ThemeJson from "../themes/oc-2.json"
import type { DesktopTheme } from "../types"
import { brand, keteTheme } from "./theme"

const oc2 = oc2ThemeJson as DesktopTheme

function palette(variant: DesktopTheme["light"]) {
  if (!("palette" in variant) || !variant.palette) throw new Error("oc-2 is expected to define a palette")
  return variant.palette
}

describe("the web UI's default theme is Kete Code's violet", () => {
  test("it replaces upstream's default under the same id", () => {
    expect(DEFAULT_THEMES["oc-2"]).toBe(keteTheme)
    expect(keteTheme.id).toBe("oc-2")
    expect(keteTheme.name).toBe("Kete Code")
  })

  test("violet is the primary and interactive colour in both modes", () => {
    expect(palette(keteTheme.light).primary).toBe(brand.light)
    expect(palette(keteTheme.dark).primary).toBe(brand.dark)
    expect(palette(keteTheme.light).interactive).toBe(brand.light)
    expect(palette(keteTheme.dark).interactive).toBe(brand.light)
  })

  test("everything else is upstream's default theme", () => {
    const { primary: _p, interactive: _i, ...rest } = palette(keteTheme.dark)
    const { primary: _up, interactive: _ui, ...upstream } = palette(oc2.dark)
    expect(rest).toEqual(upstream)
    expect(keteTheme.dark.overrides).toEqual(oc2.dark.overrides)
    expect(keteTheme.dark.v2Overrides?.["v2-blue-600"]).toBe(oc2.dark.v2Overrides?.["v2-blue-600"])
  })

  test("the accent tokens resolve to violet, not upstream's blue", () => {
    for (const [variant, dark] of [
      [keteTheme.light, false],
      [keteTheme.dark, true],
    ] as const) {
      const v1 = resolveThemeVariant(variant, dark)
      const upstream = resolveThemeVariant(dark ? oc2.dark : oc2.light, dark)
      expect(v1["surface-brand-base"]).not.toBe(upstream["surface-brand-base"])
      expect(v1["text-interactive-base"]).not.toBe(upstream["text-interactive-base"])
      const v2 = resolveThemeVariantV2(variant, dark)
      expect(v2["v2-background-bg-accent"]).toBe("#6e47f5ff")
      expect(v2["v2-text-text-accent"]).toBe(dark ? "#a38cfaff" : "#6e47f5ff")
      expect(v2["v2-border-border-focus"]).toBe("#6e47f5ff")
      // Blue still means "info".
      expect(v2["v2-state-fg-info"]).toBe(resolveThemeVariantV2(dark ? oc2.dark : oc2.light, dark)["v2-state-fg-info"])
    }
  })
})
