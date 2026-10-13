import { describe, expect, test } from "bun:test"
import { KeteDoctorFlow } from "../../src/kete/doctor-flow"

function deps(overrides: Partial<KeteDoctorFlow.Deps> = {}) {
  const out: string[] = []
  const value: KeteDoctorFlow.Deps = {
    version: "0.2.8",
    channel: "latest",
    platform: "darwin",
    env: { TERM: "xterm-256color" },
    home: "/home/alice",
    offline: false,
    interactive: true,
    install: async () => "homebrew",
    binaries: async () => ({ onPath: ["/opt/homebrew/bin/kete"], running: "/opt/homebrew/bin/kete" }),
    signedIn: async () => false,
    runtime: async () => ({
      providers: ["ollama"],
      defaultModel: { provider: "ollama", model: "qwen2.5-coder:7b" },
      mcp: [],
      sandbox: { state: "on", mechanism: "seatbelt", mode: "auto" },
      report: { files: [], trust: { state: "clear", held: [], heldCount: 0 } },
    }),
    out: (text) => void out.push(text),
    ...overrides,
  }
  return { value, out }
}

describe("kete doctor", () => {
  test("a healthy setup prints the checks and exits 0", async () => {
    const { value, out } = deps()
    expect(await KeteDoctorFlow.run(value, { format: "default" })).toBe(0)
    expect(out.join("\n")).toContain("New sessions use ollama/qwen2.5-coder:7b")
    expect(out.join("\n")).toContain("Everything looks fine.")
  })

  test("an unreachable runtime still prints the local checks, and exits 1", async () => {
    const { value, out } = deps({ runtime: async () => undefined })
    expect(await KeteDoctorFlow.run(value, { format: "default" })).toBe(1)
    const text = out.join("\n")
    expect(text).toContain("Couldn't reach the runtime")
    expect(text).toContain("Kete Code 0.2.8")
  })

  test("a fact that throws is reported as unknown, not a crash", async () => {
    const { value, out } = deps({
      signedIn: async () => {
        throw new Error("EACCES")
      },
      install: async () => {
        throw new Error("nope")
      },
      runtime: async () => {
        throw new Error("boom")
      },
    })
    expect(await KeteDoctorFlow.run(value, { format: "default" })).toBe(1)
    expect(out.join("\n")).toContain("Couldn't read the account state")
  })

  test("--format json prints one JSON object with the checks and counts", async () => {
    const { value, out } = deps({ runtime: async () => undefined })
    await KeteDoctorFlow.run(value, { format: "json" })
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out[0]!)
    expect(parsed.fail).toBe(1)
    expect(parsed.checks.some((check: { title: string }) => check.title === "Couldn't reach the runtime")).toBe(true)
  })
})
