import { describe, expect, test } from "bun:test"
import { authorizeURL, parseWhoami } from "../src/account"

describe("parseWhoami", () => {
  test("a signed-in account", () => {
    const stdout = JSON.stringify({
      signed_in: true,
      organization: { id: "o", name: "Acme" },
      platform_url: "https://platform.example",
      gateway_url: "https://gateway.example",
      device_name: "laptop",
      key_id: "k",
      storage: "keychain",
      storage_description: "macOS Keychain",
      signed_in_at: "2026-09-25T00:00:00.000Z",
      hand_configured: ["KETE_GATEWAY_URL"],
    })
    expect(parseWhoami(`${stdout}\n`)).toEqual({
      signedIn: true,
      organization: "Acme",
      platformURL: "https://platform.example",
      gatewayURL: "https://gateway.example",
      storage: "macOS Keychain",
      handConfigured: ["KETE_GATEWAY_URL"],
    })
  })

  test("not signed in", () => {
    expect(parseWhoami('{"signed_in":false,"hand_configured":[]}')).toEqual({ signedIn: false, handConfigured: [] })
  })

  test("rejects unexpected output instead of guessing", () => {
    for (const stdout of ["Not signed in.", "{}", '{"signed_in":true}', "[]"]) expect(() => parseWhoami(stdout)).toThrow()
  })
})

describe("authorizeURL", () => {
  test("finds the URL kete login prints", () => {
    const output = [
      "Signing in to Kete Code at https://platform.example",
      "",
      "Open this URL in your browser to approve the sign-in:",
      "  https://platform.example/cli/authorize?port=49152&state=s&code_challenge=c",
      "",
    ].join("\n")
    expect(authorizeURL(output)).toBe("https://platform.example/cli/authorize?port=49152&state=s&code_challenge=c")
  })

  test("ignores other URLs and schemes", () => {
    expect(authorizeURL("Signing in to Kete Code at https://platform.example\n")).toBeUndefined()
    expect(authorizeURL("  javascript:alert(1)//cli/authorize\n")).toBeUndefined()
    expect(authorizeURL("  file:///cli/authorize\n")).toBeUndefined()
  })
})
