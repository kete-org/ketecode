import { describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { applySettings, configDirectory, httpUrl } from "../src/settings"

describe("applySettings", () => {
  test("creates the configuration when the file is empty", () => {
    const text = applySettings("", {
      gatewayUrl: "http://localhost:8787",
      platformUrl: "http://127.0.0.1:3000",
      sessionBudget: 5,
    })
    expect(parse(text)).toEqual({
      providers: {
        kete: { settings: { baseURL: "http://localhost:8787" } },
      },
      kete: { platform: { url: "http://127.0.0.1:3000" }, budget: { session: 5 } },
    })
  })

  test("keeps comments, other providers and unrelated keys", () => {
    const before = `{
  // my model
  "model": "kete/claude-sonnet-4-5",
  "providers": {
    "anthropic": { "settings": { "baseURL": "http://localhost:8787/anthropic/v1" } },
    "kete": { "settings": { "apiKey": "{file:~/.config/kete/gateway-key}" } }
  },
  "permissions": [{ "action": "budget", "resource": "*", "effect": "allow" }]
}
`
    const after = applySettings(before, { gatewayUrl: "http://gateway:8787", sessionBudget: 2.5 })
    expect(after).toContain("// my model")
    expect(parse(after)).toEqual({
      model: "kete/claude-sonnet-4-5",
      providers: {
        anthropic: { settings: { baseURL: "http://localhost:8787/anthropic/v1" } },
        kete: { settings: { apiKey: "{file:~/.config/kete/gateway-key}", baseURL: "http://gateway:8787" } },
      },
      permissions: [{ action: "budget", resource: "*", effect: "allow" }],
      kete: { budget: { session: 2.5 } },
    })
  })

  test("updates values in place and leaves the file alone for empty settings", () => {
    const before = applySettings("{}", { gatewayUrl: "http://old:8787" })
    const after = applySettings(before, { gatewayUrl: "http://new:8787" })
    expect(parse(after).providers.kete.settings.baseURL).toBe("http://new:8787")
    expect(applySettings(after, {})).toBe(after)
    expect(applySettings(after, { gatewayUrl: "", platformUrl: undefined })).toBe(after)
  })
})

describe("httpUrl", () => {
  test("accepts http(s) URLs and trims trailing slashes", () => {
    expect(httpUrl(" http://localhost:8787/ ")).toBe("http://localhost:8787")
    expect(httpUrl("https://gateway.example/kete/")).toBe("https://gateway.example/kete")
  })

  test("rejects empty and non-http values", () => {
    for (const value of [undefined, "", "   ", "localhost:8787", "file:///etc/passwd", "not a url"])
      expect(httpUrl(value)).toBeUndefined()
  })
})

describe("configDirectory", () => {
  test("reads the config line from `kete debug paths`", () => {
    const paths = "home       /Users/me\ndata       /Users/me/.local/share/kete\nconfig     /Users/me/.config/kete\n"
    expect(configDirectory(paths)).toBe("/Users/me/.config/kete")
    expect(configDirectory("nothing here")).toBeUndefined()
  })
})
