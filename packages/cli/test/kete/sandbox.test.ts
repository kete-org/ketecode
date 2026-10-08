// `kete sandbox`'s output and exit codes for each state the runtime reports (cli/src/kete/sandbox.ts).
import { describe, expect, test } from "bun:test"
import { KeteCliSandbox } from "../../src/kete/sandbox"

const base = { platform: "darwin", mode: "auto", network: "approved", ignored: [] } as const

describe("kete sandbox", () => {
  test("on: exit 0, names the mechanism", () => {
    const result = KeteCliSandbox.describe({ ...base, state: "on", mechanism: "seatbelt" })
    expect(result.code).toBe(0)
    expect(result.lines.join("\n")).toContain("sandbox-exec")
  })
  test("unavailable: exit 1, says so loudly, and what to do on Linux", () => {
    const result = KeteCliSandbox.describe({ ...base, platform: "linux", state: "unavailable", reason: "bubblewrap (bwrap) isn't installed" })
    expect(result.code).toBe(1)
    expect(result.lines[0]).toContain("NOT SANDBOXED")
    expect(result.lines.join("\n")).toContain("apt install bubblewrap")
  })
  test("required and unavailable: commands are refused", () => {
    const result = KeteCliSandbox.describe({ ...base, mode: "required", state: "unavailable", reason: "x" })
    expect(result.lines.join("\n")).toContain("refused")
  })
  test("off: exit 1, how to turn it back on", () => {
    const result = KeteCliSandbox.describe({ ...base, mode: "off", state: "off", reason: "turned off (KETE_SANDBOX)" })
    expect(result.code).toBe(1)
    expect(result.lines.join("\n")).toContain("KETE_SANDBOX")
  })
  test("ignored project settings are listed; a job is fine", () => {
    expect(KeteCliSandbox.describe({ ...base, state: "on", ignored: ['mode "off"'] }).lines.join("\n")).toContain('mode "off"')
    expect(KeteCliSandbox.describe({ ...base, state: "job" }).code).toBe(0)
  })
})
