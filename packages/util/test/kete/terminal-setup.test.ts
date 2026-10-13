import { describe, expect, test } from "bun:test"
import path from "node:path"
import { KeteTerminalSetup } from "@opencode/util/kete/terminal-setup"

describe("detect", () => {
  const cases: Array<[KeteTerminalSetup.Environment, string, KeteTerminalSetup.Terminal["kind"], string?]> = [
    [{ TERM_PROGRAM: "vscode" }, "darwin", "editor"],
    [{ KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" }, "linux", "native", "kitty"],
    [{ TERM_PROGRAM: "WezTerm" }, "linux", "native", "WezTerm"],
    [{ TERM_PROGRAM: "ghostty" }, "darwin", "native", "Ghostty"],
    [{ ALACRITTY_WINDOW_ID: "1" }, "linux", "native", "Alacritty"],
    [{ TERM: "foot" }, "linux", "native", "foot"],
    [{ TERM_PROGRAM: "iTerm.app" }, "darwin", "iterm"],
    [{ TERM_PROGRAM: "Apple_Terminal" }, "darwin", "apple"],
    [{ WT_SESSION: "x" }, "win32", "windows-terminal"],
    [{ TERM: "xterm-256color" }, "linux", "unknown"],
  ]
  for (const [env, platform, kind, name] of cases)
    test(`${JSON.stringify(env)} on ${platform} is ${kind}`, () => {
      const terminal = KeteTerminalSetup.detect(env, platform)
      expect(terminal.kind).toBe(kind)
      if (name && terminal.kind === "native") expect(terminal.name).toBe(name)
    })

  test("the VS Code family is told apart by what each editor sets", () => {
    expect(KeteTerminalSetup.editorOf({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" })).toBe("cursor")
    expect(KeteTerminalSetup.editorOf({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.exafunction.windsurf" })).toBe("windsurf")
    expect(KeteTerminalSetup.editorOf({ TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_MAIN: "/opt/VSCodium/resources/app/askpass" })).toBe("vscodium")
    expect(KeteTerminalSetup.editorOf({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.99.0-insider" })).toBe("insiders")
    expect(KeteTerminalSetup.editorOf({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.microsoft.VSCode" })).toBe("code")
  })
})

describe("keybindingsPath", () => {
  test("macOS, Linux (XDG) and Windows (APPDATA)", () => {
    expect(KeteTerminalSetup.keybindingsPath("code", "darwin", {}, "/Users/a", path.posix.join)).toBe(
      "/Users/a/Library/Application Support/Code/User/keybindings.json",
    )
    expect(KeteTerminalSetup.keybindingsPath("cursor", "linux", { XDG_CONFIG_HOME: "/x" }, "/home/a", path.posix.join)).toBe("/x/Cursor/User/keybindings.json")
    expect(KeteTerminalSetup.keybindingsPath("vscodium", "linux", {}, "/home/a", path.posix.join)).toBe("/home/a/.config/VSCodium/User/keybindings.json")
    expect(KeteTerminalSetup.keybindingsPath("windsurf", "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a", path.win32.join)).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\Windsurf\\User\\keybindings.json",
    )
  })
})

describe("hasKeybinding", () => {
  test("only the same key, command and sequence count", () => {
    expect(KeteTerminalSetup.hasKeybinding([KeteTerminalSetup.KEYBINDING])).toBe(true)
    expect(KeteTerminalSetup.hasKeybinding([{ ...KeteTerminalSetup.KEYBINDING, key: "Shift + Enter" }])).toBe(true)
    expect(KeteTerminalSetup.hasKeybinding([{ ...KeteTerminalSetup.KEYBINDING, args: { text: "\n" } }])).toBe(false)
    expect(KeteTerminalSetup.hasKeybinding({})).toBe(false)
  })
})

describe("guidance", () => {
  test("a native terminal needs nothing; Ctrl+J is always mentioned", () => {
    const guide = KeteTerminalSetup.guidance({ kind: "native", name: "kitty" }, {})
    expect(guide.applicable).toBe(false)
    expect(guide.lines[0]).toContain("already inserts a newline")
    expect(guide.lines.at(-1)).toBe(KeteTerminalSetup.CTRL_J)
  })
  test("a known editor can be set up by the CLI; an unknown one is told the flag", () => {
    expect(KeteTerminalSetup.guidance({ kind: "editor", editor: "cursor" }, {}).applicable).toBe(true)
    const unknown = KeteTerminalSetup.guidance({ kind: "editor", editor: undefined }, {})
    expect(unknown.applicable).toBe(false)
    expect(unknown.lines.join("\n")).toContain("--editor")
  })
  test("tmux adds the extended-keys lines; screen gets the fallback", () => {
    expect(KeteTerminalSetup.guidance({ kind: "native", name: "kitty" }, { TMUX: "1" }).lines.join("\n")).toContain("set -s extended-keys on")
    expect(KeteTerminalSetup.guidance({ kind: "apple" }, { STY: "1" }).lines.join("\n")).toContain("screen doesn't pass Shift+Enter")
  })
  test("iTerm2, Apple Terminal and Windows Terminal get steps", () => {
    expect(KeteTerminalSetup.guidance({ kind: "iterm" }, {}).lines.join("\n")).toContain("CSI u")
    expect(KeteTerminalSetup.guidance({ kind: "apple" }, {}).lines.join("\n")).toContain("Use Option as Meta key")
    expect(KeteTerminalSetup.guidance({ kind: "windows-terminal" }, {}).lines.join("\n")).toContain('"sendInput"')
  })
})
