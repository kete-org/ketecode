import { describe, expect, test } from "bun:test"
import path from "node:path"
import { insideWorkspace, statusBar } from "../src/status"

const signedIn = {
  signedIn: true as const,
  organization: "Acme",
  platformURL: "https://platform.example",
  gatewayURL: "https://gateway.example",
  storage: "macOS Keychain",
  handConfigured: [],
}

describe("status bar", () => {
  test("shows the server state and the signed-in organization", () => {
    const bar = statusBar({ state: "running", url: "http://127.0.0.1:4096" }, signedIn)
    expect(bar.text).toBe("$(check) $(kete-mark) Kete · Acme")
    expect(bar.tooltip).toBe(
      "Server: running on http://127.0.0.1:4096\nAccount: Acme on https://platform.example\nKey stored in macOS Keychain",
    )
    expect(bar.error).toBe(false)
  })

  test("shows when nobody is signed in, and hand configuration", () => {
    expect(statusBar({ state: "stopped" }, { signedIn: false, handConfigured: [] }).text).toBe("$(circle-outline) $(kete-mark) Kete · Signed out")
    expect(statusBar({ state: "stopped" }, { signedIn: false, handConfigured: ["KETE_GATEWAY_URL"] }).tooltip).toContain(
      "gateway configured by hand (KETE_GATEWAY_URL)",
    )
  })

  test("while checking, or when the account can't be read", () => {
    expect(statusBar({ state: "starting" }, undefined).text).toBe("$(sync~spin) $(kete-mark) Kete")
    expect(statusBar({ state: "starting" }, undefined).tooltip).toContain("Account: checking")
    expect(statusBar({ state: "stopped" }, { error: "no kete binary" }).tooltip).toContain("Account: unknown (no kete binary)")
  })

  test("restarting and failed servers", () => {
    const restarting = statusBar({ state: "restarting", attempt: 2, delay: 2_000, reason: "exited (code 1)" }, signedIn)
    expect(restarting.tooltip).toContain("restarting in 2 s (attempt 2): exited (code 1)")
    const failed = statusBar({ state: "failed", reason: "boom" }, signedIn)
    expect(failed.text).toBe("$(error) $(kete-mark) Kete · Acme")
    expect(failed.error).toBe(true)
  })
})

describe("insideWorkspace", () => {
  const folder = path.resolve("/work/project")
  test("resolves paths inside the workspace", () => {
    expect(insideWorkspace(folder, "src/app.ts")).toBe(path.join(folder, "src/app.ts"))
    expect(insideWorkspace(folder, "./a/../b.ts")).toBe(path.join(folder, "b.ts"))
  })

  test("rejects paths that leave it", () => {
    for (const relative of ["../secret", "src/../../etc/passwd", "/etc/passwd", "C:\\Windows\\win.ini", "", "."])
      expect(insideWorkspace(folder, relative)).toBeUndefined()
  })
})

describe("status bar attention", () => {
  test("shows how many prompts are waiting for approval", () => {
    const bar = statusBar({ state: "running", url: "http://127.0.0.1:1" }, { signedIn: false, handConfigured: [] }, 2)
    expect(bar.text).toBe("$(check) $(kete-mark) Kete · Signed out · $(bell-dot) 2")
    expect(bar.tooltip).toContain("2 waiting for your approval in the chat")
    expect(statusBar({ state: "running", url: "u" }, undefined, 0).text).toBe("$(check) $(kete-mark) Kete")
  })
})

describe("status bar permission mode", () => {
  test("shows when the chat asks before edits", () => {
    const bar = statusBar({ state: "running", url: "u" }, undefined, 0, "ask")
    expect(bar.text).toBe("$(check) $(kete-mark) Kete · $(shield) Ask")
    expect(bar.tooltip).toContain("asks before every edit, command and web fetch")
    expect(statusBar({ state: "running", url: "u" }, undefined, 0, "default").text).toBe("$(check) $(kete-mark) Kete")
  })

  test("shows Auto and Plan honestly", () => {
    const auto = statusBar({ state: "running", url: "u" }, undefined, 0, "auto")
    expect(auto.text).toBe("$(check) $(kete-mark) Kete · $(zap) Auto")
    expect(auto.tooltip).toContain("high-risk commands")
    const plan = statusBar({ state: "running", url: "u" }, undefined, 0, "plan")
    expect(plan.text).toBe("$(check) $(kete-mark) Kete · $(eye) Plan")
    expect(plan.tooltip).toContain("read-only")
  })
})
