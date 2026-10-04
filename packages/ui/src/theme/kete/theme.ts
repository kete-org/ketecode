// The web UI's default theme in Kete Code's brand colour, violet #6E47F5. It is upstream's default
// theme ("oc-2", themes/oc-2.json) with violet as its primary and interactive colour: the brand
// surfaces and, through the interactive ramp, links, focus rings and accents. It keeps the "oc-2"
// id so everything upstream does for the default theme (no cached CSS, the system light/dark
// switch, the preload script) still applies; default-themes.ts registers it in oc-2's place.
//
// oc-2 pins its v2 primitive ramps, so the v2 accent tokens (accent backgrounds, links, accent
// icons, focus rings) are set to violet directly. The blue ramp itself stays: it also means "info"
// (state colours, the build agent's badge). Syntax colours (text-code-accent) are unchanged.
//
// Same brand colour as the chat panel's `--kete-brand`/`--kete-brand-soft` (kete/tokens.css); kept
// in lockstep by kete/tokens.test.ts.

import type { DesktopTheme, HexColor } from "../types"
import oc2ThemeJson from "../themes/oc-2.json"

const oc2 = oc2ThemeJson as DesktopTheme

/** Violet on light backgrounds; its lighter tint on dark ones, where #6E47F5 is too dark to read. */
export const brand: { readonly light: HexColor; readonly dark: HexColor } = { light: "#6E47F5", dark: "#A38CFA" }

// Text colours meet WCAG AA on the theme's backgrounds: #6E47F5 on light (~5.4:1), #A38CFA on dark
// (~7:1). White text on the #6E47F5 accent background is ~5.4:1.
const accents = {
  light: {
    "v2-background-bg-accent": "#6e47f5ff",
    "v2-text-text-accent": "#6e47f5ff",
    "v2-text-text-accent-hover": "#5a34e6ff",
    "v2-icon-icon-accent": "#6e47f5ff",
    "v2-icon-icon-accent-hover": "#5a34e6ff",
    "v2-border-border-focus": "#6e47f5ff",
  },
  dark: {
    "v2-background-bg-accent": "#6e47f5ff",
    "v2-text-text-accent": "#a38cfaff",
    "v2-text-text-accent-hover": "#b5a3fbff",
    "v2-icon-icon-accent": "#a38cfaff",
    "v2-icon-icon-accent-hover": "#b5a3fbff",
    "v2-border-border-focus": "#6e47f5ff",
  },
} as const

function violet(variant: DesktopTheme["light"], mode: "light" | "dark"): DesktopTheme["light"] {
  if (!("palette" in variant) || !variant.palette) return variant
  return {
    ...variant,
    palette: { ...variant.palette, primary: brand[mode], interactive: brand.light },
    v2Overrides: { ...variant.v2Overrides, ...accents[mode] },
  }
}

export const keteTheme: DesktopTheme = {
  ...oc2,
  name: "Kete Code",
  light: violet(oc2.light, "light"),
  dark: violet(oc2.dark, "dark"),
}
