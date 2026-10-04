import { describe, expect, test } from "bun:test"
import { dict as en } from "@/runtime/i18n/en"
import { brandDictionary, brandText } from "./brand-text"

describe("brandText", () => {
  test("rebrands the product name", () => {
    expect(brandText("OpenCode is ready.")).toBe("Kete Code is ready.")
    expect(brandText("Please report this error to the OpenCode team")).toBe(
      "Please report this error to the Kete Code team",
    )
    expect(brandText("Upgrade it to OpenCode V2 to continue.")).toBe("Upgrade it to Kete Code to continue.")
    expect(brandText("OpenCode Desktop")).toBe("Kete Code Desktop")
  })

  test("rebrands commands and config files", () => {
    expect(brandText("Run opencode pair.")).toBe("Run kete pair.")
    expect(brandText("Edit `opencode.json` or opencode.jsonc")).toBe("Edit `kete.json` or kete.jsonc")
    expect(brandText("Project config in .opencode/")).toBe("Project config in .kete/")
  })

  test("names the worktree setup-script variables with Kete Code's prefix", () => {
    expect(brandText("Use $OPENCODE_WORKTREE_PATH for the new worktree.")).toBe(
      "Use $KETE_WORKTREE_PATH for the new worktree.",
    )
    expect(brandText("استخدم $OPENCODE_WORKTREE_BASE لشجرة العمل الأساسية.")).toBe(
      "استخدم $KETE_WORKTREE_BASE لشجرة العمل الأساسية.",
    )
  })

  test("keeps what really is OpenCode's", () => {
    for (const value of [
      "Sign in to OpenCode Go, OpenCode Console, or another model provider",
      "OpenCode Zen gives you access to a curated set of models.",
      "OpenCode Free",
      "Visit opencode.ai/zen",
      "https://opencode.ai/docs",
    ])
      expect(brandText(value)).toBe(value)
  })
})

describe("brandDictionary", () => {
  const branded = brandDictionary(en as Record<string, string>)

  test("leaves no product-name OpenCode in the English UI", () => {
    const leftover = Object.values(branded).filter((value) =>
      /OpenCode(?! (?:Zen|Go|Console|Free|Black)\b)/.test(value.replace(/built on OpenCode\. OpenCode is/, "")),
    )
    expect(leftover).toEqual([])
  })

  test("replaces statements a word swap would make false", () => {
    expect(branded["settings.about.trademark"]).toBe(
      "Kete Code is built on OpenCode. OpenCode is a registered trademark of Anomaly Innovations, Inc.",
    )
    expect(branded["sidebar.gettingStarted.line1"]).toBe("Connect a model provider to start.")
  })

  test("keeps keys and non-string values", () => {
    expect(Object.keys(branded)).toEqual(Object.keys(en))
    expect(brandDictionary({ "a.opencode.b": "OpenCode", n: 1 } as Record<string, unknown>)).toEqual({
      "a.opencode.b": "Kete Code",
      n: 1,
    })
  })
})
