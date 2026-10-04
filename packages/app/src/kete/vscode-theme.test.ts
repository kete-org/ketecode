import { describe, expect, test } from "bun:test"
import { mode, themeMessage, tokens } from "./vscode-theme"

const dark = {
  kind: "dark" as const,
  variables: {
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-sideBar-background": "#252526",
    "--vscode-foreground": "#cccccc",
    "--vscode-focusBorder": "#007fd4",
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
    "--vscode-font-size": "13px",
  },
}

describe("VS Code theme", () => {
  test("maps VS Code's values onto the web UI's tokens, with fallbacks", () => {
    const values = tokens(dark)
    expect(values["--v2-background-bg-base"]).toBe("#252526")
    expect(values["--v2-background-bg-layer-01"]).toBe("#1e1e1e")
    // No panel background: falls back to the side bar's.
    expect(values["--v2-background-bg-deep"]).toBe("#252526")
    expect(values["--v2-text-text-base"]).toBe("#cccccc")
    expect(values["--v2-text-text-muted"]).toBe("#cccccc")
    expect(values["--v2-border-border-focus"]).toBe("#007fd4")
    expect(values["--font-family-sans"]).toBe("-apple-system, BlinkMacSystemFont, sans-serif")
    expect(values["--font-size-base"]).toBe("13px")
    // Tokens VS Code has no value for keep the web UI's.
    expect("--v2-text-text-accent" in values).toBe(false)
  })

  test("light and dark", () => {
    expect(mode({ ...dark, kind: "light" })).toBe("light")
    expect(mode({ ...dark, kind: "high-contrast-light" })).toBe("light")
    expect(mode({ ...dark, kind: "high-contrast" })).toBe("dark")
  })

  test("only computed colours, lengths and font lists get through", () => {
    const values = tokens({
      kind: "dark",
      variables: {
        "--vscode-foreground": "red; background: url(https://attacker.example)",
        "--vscode-editor-background": "url(x)",
        "--vscode-focusBorder": "  #fff  ",
      },
    })
    expect(values["--v2-text-text-base"]).toBeUndefined()
    expect(values["--v2-background-bg-layer-01"]).toBeUndefined()
    expect(values["--v2-border-border-focus"]).toBe("#fff")
  })

  test("the message is validated", () => {
    expect(themeMessage({ type: "kete.theme", kind: "dark", variables: { "--vscode-foreground": "#fff", "--other": "x", "--vscode-font-size": 3 } })).toEqual({
      kind: "dark",
      variables: { "--vscode-foreground": "#fff" },
    })
    expect(themeMessage({ type: "kete.theme", kind: "sepia", variables: {} })).toBeUndefined()
    expect(themeMessage({ type: "kete.theme", kind: "dark" })).toBeUndefined()
    expect(themeMessage({ type: "other" })).toBeUndefined()
  })
})
