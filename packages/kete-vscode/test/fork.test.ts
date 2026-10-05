// The extension runs in VS Code and its forks (Windsurf, Cursor, VSCodium) from the VS Code Marketplace
// and Open VSX. These tests keep it from assuming it is in Microsoft's VS Code.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { editorName, handle } from "../src/editor-tools"
import { sessionFromLink, sessionLink } from "../src/sessions"

const root = path.join(import.meta.dir, "..")
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  engines: { vscode: string }
  devDependencies: Record<string, string>
  enabledApiProposals?: unknown
  extensionDependencies?: unknown
  contributes: { keybindings: { command: string; key: string; mac?: string }[] }
}

/** Source code with comments removed, so prose about VS Code doesn't count. */
function code(file: string) {
  return readFileSync(path.join(root, "src", file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
}

describe("session links follow the host's URI scheme", () => {
  for (const scheme of ["vscode", "vscode-insiders", "windsurf", "cursor", "vscodium"])
    test(scheme, () => {
      const link = sessionLink(scheme, "ketecode.kete-code", "ses_123")
      expect(link).toBe(`${scheme}://ketecode.kete-code/session?id=ses_123`)
      const url = new URL(link)
      expect(url.protocol).toBe(`${scheme}:`)
      expect(sessionFromLink(url.pathname, url.search.slice(1))).toBe("ses_123")
    })

  test("rejects something that isn't a scheme", () => {
    for (const scheme of ["", "VS Code", "1code", "code://", "a".repeat(65)])
      expect(() => sessionLink(scheme, "ketecode.kete-code", "ses_123")).toThrow()
  })
})

describe("the host editor's name", () => {
  test("comes from the host", () => {
    expect(editorName("Windsurf")).toBe("Windsurf")
    expect(editorName("Cursor")).toBe("Cursor")
    expect(editorName("VSCodium")).toBe("VSCodium")
    expect(editorName("Visual Studio Code")).toBe("Visual Studio Code")
  })

  test("is cleaned and bounded, with a neutral fallback", () => {
    expect(editorName(undefined)).toBe("the editor")
    expect(editorName("  \u0000\n ")).toBe("the editor")
    expect(editorName("Wind\u0007surf\n")).toBe("Windsurf")
    expect(editorName("x".repeat(200))).toHaveLength(64)
  })

  test("names the host in the diagnostics tool the model sees", async () => {
    const tools = { diagnostics: async () => [], editor: "Windsurf" }
    const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tools)) as {
      result: { tools: { description: string }[] }
    }
    const description = list.result.tools[0]!.description
    expect(description).toContain("(Windsurf)")
    expect(description).not.toContain("VS Code")
  })
})

describe("no fork assumptions in the source", () => {
  const files = readdirSync(path.join(root, "src")).filter((file) => file.endsWith(".ts"))

  test("no hard-coded VS Code URI scheme, product name or Marketplace link", () => {
    for (const file of files) {
      const source = code(file)
      expect({ file, scheme: /\bvscode(-insiders)?:\/\//.test(source) }).toEqual({ file, scheme: false })
      expect({ file, name: /VS ?Code|Visual Studio Code/.test(source) }).toEqual({ file, name: false })
      expect({ file, marketplace: source.includes("marketplace.visualstudio.com") }).toEqual({ file, marketplace: false })
    }
  })

  test("the manifest needs no proposed API, other extension or Microsoft-only text", () => {
    expect(manifest.enabledApiProposals).toBeUndefined()
    expect(manifest.extensionDependencies).toBeUndefined()
    const contributes = JSON.stringify(manifest.contributes)
    expect(contributes).not.toMatch(/VS ?Code|Visual Studio Code|marketplace\.visualstudio\.com/)
  })

  test("the engine floor is the API version the code is typechecked against", () => {
    // @types/vscode pins the API surface; a floor above every fork's base keeps installs working there
    // (Windsurf/Devin Desktop 1.126, Cursor 1.128, VSCodium 1.135 in October 2026).
    expect(manifest.engines.vscode).toBe(`^${manifest.devDependencies["@types/vscode"]}`)
    const [, minor] = manifest.engines.vscode.replace("^", "").split(".").map(Number)
    expect(minor).toBeLessThanOrEqual(126)
  })

  test("default keybindings leave the forks' AI shortcuts alone", () => {
    // Cursor: inline edit, chat, agent, layout, settings, mode menu, model switch; Windsurf: Cascade,
    // inline command. Any of these as a default would shadow the fork's own feature.
    const taken = ["k", "l", "i", "e", "shift+k", "shift+j", "shift+l", "shift+i", ".", "/"]
    const reserved = new Set(taken.flatMap((key) => [`cmd+${key}`, `ctrl+${key}`]))
    for (const binding of manifest.contributes.keybindings)
      for (const key of [binding.key, binding.mac].filter((value): value is string => value !== undefined)) {
        const first = key.split(" ")[0]!
        expect({ command: binding.command, key, reserved: reserved.has(first) }).toEqual({
          command: binding.command,
          key,
          reserved: false,
        })
      }
  })
})
