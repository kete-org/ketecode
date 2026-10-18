import { describe, expect, test } from "bun:test"
import { KeteSetup } from "../../src/kete/setup.js"

describe("KeteSetup", () => {
  test("shows only when nothing is set up", () => {
    expect(KeteSetup.shouldShow({ done: false, connected: false, hasModel: false })).toBe(true)
    expect(KeteSetup.shouldShow({ done: true, connected: false, hasModel: false })).toBe(false)
    expect(KeteSetup.shouldShow({ done: false, connected: true, hasModel: false })).toBe(false)
    expect(KeteSetup.shouldShow({ done: false, connected: false, hasModel: true })).toBe(false)
  })

  test("hides sign-in offline", () => {
    expect(KeteSetup.rows({ offline: false, status: undefined }).map((r) => r.id)).toEqual(["signin", "key", "local", "skip"])
    expect(KeteSetup.rows({ offline: true, status: undefined }).map((r) => r.id)).toEqual(["key", "local", "skip"])
  })

  test("local row counts reachable servers with models", () => {
    const status = {
      offline: false,
      providers: [
        { id: "ollama" as const, state: "reachable" as const, url: "u", models: 2, hint: "", insecure: false },
        { id: "vllm" as const, state: "unreachable" as const, url: "u", hint: "", insecure: false },
      ],
    }
    expect(KeteSetup.rows({ offline: true, status }).find((r) => r.id === "local")?.description).toBe("1 local server found")
  })

  test("parses only http(s) URL lines", () => {
    expect(KeteSetup.parseLoginURL("  https://kete.example/device?code=AB-12")).toBe(
      "https://kete.example/device?code=AB-12",
    )
    expect(KeteSetup.parseLoginURL("Signing in to Kete Code at https://kete.example")).toBeUndefined()
    expect(KeteSetup.parseLoginURL("Waiting for approval...")).toBeUndefined()
    expect(KeteSetup.parseLoginURL("ftp://x.example/a")).toBeUndefined()
  })

  test("hint only for the no-model error", () => {
    const none = { type: "provider.no-route", message: "No model is available for session ses_1" }
    expect(KeteSetup.withHint(none)).toBe(`${none.message}\n${KeteSetup.HINT}`)
    expect(KeteSetup.withHint({ type: "provider.no-route", message: "Model unavailable: a/b" })).toBe("Model unavailable: a/b")
    expect(KeteSetup.withHint({ type: "unknown", message: "No model is available for session x" })).toBe(
      "No model is available for session x",
    )
  })
})
