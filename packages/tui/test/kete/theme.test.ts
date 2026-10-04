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
