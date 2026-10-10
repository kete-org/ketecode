import { describe, expect, test } from "bun:test"
import { allThemes, getOpenCodeTheme, hasTheme } from "../../src/theme"
import { settings } from "../../src/component/dialog-config"
import { KeteTheme } from "../../src/kete/theme"

describe("the default theme is presented as kete", () => {
  test("kete and the opencode alias are the same built-in theme", () => {
    expect(hasTheme("kete")).toBe(true)
    expect(allThemes().kete).toBe(getOpenCodeTheme())
    expect(allThemes().opencode).toBe(allThemes().kete)
  })

  test("a configured or saved \"opencode\" keeps working as kete", () => {
    expect(KeteTheme.canonicalTheme("opencode", allThemes())).toBe("kete")
    expect(KeteTheme.canonicalTheme("kete", allThemes())).toBe("kete")
    expect(KeteTheme.canonicalTheme("tokyonight", allThemes())).toBe("tokyonight")
  })

  test("a custom theme named opencode is still that theme", () => {
    const themes = { ...allThemes(), opencode: { theme: {} } }
    expect(KeteTheme.canonicalTheme("opencode", themes)).toBe("opencode")
    expect(KeteTheme.pickerThemes(themes)).toContain("opencode")
  })

  test("the picker lists kete, not the alias", () => {
    const names = KeteTheme.pickerThemes(allThemes())
    expect(names).toContain("kete")
    expect(names).not.toContain("opencode")
    expect(names).toContain("tokyonight")
  })

  test("the settings dialog defaults to kete", () => {
    expect(settings.find((setting) => setting.path.join(".") === "theme.name")?.default).toBe("kete")
  })
})

describe("the kete theme uses the current brand violet", () => {
  test("violet 200, the interactive step, is #6E47F5 in light mode and #A38CFA in dark", async () => {
    const theme = (await import("../../src/kete/theme.json")).default
    expect(theme.light.hue.interactive).toBe("$hue.violet")
    expect(theme.dark.hue.interactive).toBe("$hue.violet")
    expect(theme.light.hue.violet["200"]).toBe("#6e47f5")
    expect(theme.dark.hue.violet["200"]).toBe("#a38cfa")
    expect(JSON.stringify(theme)).not.toMatch(/7c3aed/i)
  })

  test("the first agent's colour, and the prompt's bar, is the brand violet in both modes", async () => {
    const theme = (await import("../../src/kete/theme.json")).default
    expect(theme.base.categorical[0]).toBe("violet")
    expect(theme.light.categorical[0]).toBe("violet")
    expect(theme.dark.hue.accent).not.toBe("$hue.blue")
  })
})
