import { describe, expect, test } from "bun:test"
import { KeteDoctor } from "../../src/kete/doctor"

const HOME = "/home/alice"

function facts(overrides: Partial<KeteDoctor.Facts> = {}): KeteDoctor.Facts {
  return {
    version: "0.2.8",
    channel: "latest",
    install: "homebrew",
    platform: "darwin",
    env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
    interactive: true,
    binaries: { onPath: ["/opt/homebrew/bin/kete"], running: "/opt/homebrew/bin/kete" },
    offline: false,
    signedIn: "yes",
    runtime: true,
    providers: ["anthropic", "kete"],
    defaultModel: { provider: "anthropic", model: "claude-sonnet-5-5" },
    mcp: [{ name: "github", status: "connected" }],
    sandbox: { state: "on", mechanism: "seatbelt", mode: "auto" },
    report: {
      files: [{ path: `${HOME}/.config/kete/kete.json`, scope: "global", state: "ok", messages: [] }],
      trust: { state: "clear", held: [], heldCount: 0 },
    },
    home: HOME,
    ...overrides,
  }
}

const find = (list: KeteDoctor.Check[], text: string) => list.find((check) => check.title.includes(text))

describe("KeteDoctor.checks", () => {
  test("a healthy setup has no problems or warnings, and exits 0", () => {
    const list = KeteDoctor.checks(facts())
    expect(KeteDoctor.counts(list)).toEqual({ fail: 0, warn: 0 })
    expect(KeteDoctor.exitCode(list)).toBe(0)
    expect(KeteDoctor.render(list)).toContain("Everything looks fine.")
    // The home folder is shown as ~.
    expect(KeteDoctor.render(list)).toContain("~/.config/kete/kete.json")
    expect(KeteDoctor.render(list)).not.toContain(HOME)
  })

  test("an unreachable runtime fails, and every runtime fact says it's unknown rather than guessing", () => {
    const list = KeteDoctor.checks(
      facts({ runtime: false, providers: undefined, defaultModel: undefined, mcp: undefined, sandbox: undefined, report: undefined }),
    )
    expect(find(list, "Couldn't reach the runtime")?.status).toBe("fail")
    expect(KeteDoctor.exitCode(list)).toBe(1)
    for (const text of ["Config files:", "Model providers:", "MCP servers:", "OS sandbox:"])
      expect(find(list, text)?.title).toContain("unknown")
  })

  test("a config file the runtime ignores is a problem, with its errors and a fix", () => {
    const list = KeteDoctor.checks(
      facts({
        report: {
          files: [{ path: "/work/repo/kete.json", scope: "project", state: "invalid", messages: ["line 3: CommaExpected"] }],
          trust: { state: "clear", held: [], heldCount: 0 },
        },
      }),
    )
    const check = find(list, "/work/repo/kete.json")!
    expect(check).toMatchObject({ status: "fail", details: ["line 3: CommaExpected"] })
    expect(check.fix).toContain("ignores all of it")
  })

  test("ignored settings are a warning", () => {
    const list = KeteDoctor.checks(
      facts({
        report: {
          files: [{ path: "/work/repo/kete.json", scope: "project", state: "warnings", messages: ["logLevel: unsupported"] }],
          trust: { state: "clear", held: [], heldCount: 0 },
        },
      }),
    )
    expect(find(list, "some settings are ignored")?.status).toBe("warn")
  })

  test("an untrusted folder lists a few held-back settings, counts the rest, and says how to trust it", () => {
    const held = Array.from({ length: 12 }, (_, index) => `setting ${index}`)
    const list = KeteDoctor.checks(
      facts({ report: { files: [], trust: { state: "untrusted", held, heldCount: 43 } } }),
    )
    const check = find(list, "isn't trusted")!
    expect(check.status).toBe("warn")
    expect(check.title).toContain("43")
    expect(check.details).toHaveLength(KeteDoctor.MAX_HELD_SHOWN + 1)
    expect(check.details?.at(-1)).toBe("and 38 more")
    expect(check.fix).toContain("trust add")
  })

  test("a folder that can never be trusted doesn't suggest trusting it", () => {
    const list = KeteDoctor.checks(
      facts({ report: { files: [], trust: { state: "untrusted", held: ["mcp"], heldCount: 1, refusal: "it's your home folder" } } }),
    )
    const check = find(list, "isn't trusted")!
    expect(check.status).toBe("info")
    expect(check.fix).toBeUndefined()
    expect(check.details).toContain("Can't be trusted: it's your home folder")
  })

  test("no provider and no model are problems with fixes", () => {
    const list = KeteDoctor.checks(facts({ providers: [], defaultModel: null }))
    expect(find(list, "No model provider")).toMatchObject({ status: "fail" })
    expect(find(list, "No model provider")?.fix).toContain("auth login")
    expect(find(list, "No model is available")).toMatchObject({ status: "fail" })
  })

  test("MCP servers: failed is a problem, needing sign-in is a warning with the command", () => {
    const list = KeteDoctor.checks(
      facts({
        mcp: [
          { name: "a", status: "failed" },
          { name: "b", status: "needs_auth" },
          { name: "c", status: "disabled" },
        ],
      }),
    )
    expect(find(list, "a: failed")?.status).toBe("fail")
    expect(find(list, "b: needs")).toMatchObject({ status: "warn", fix: "Run `kete mcp auth b`." })
    expect(find(list, "c: turned off")?.status).toBe("info")
  })

  test("sandbox: off warns; required but unavailable fails; Linux is told to install bubblewrap", () => {
    expect(find(KeteDoctor.checks(facts({ sandbox: { state: "off", mode: "off", reason: "KETE_SANDBOX=off" } })), "sandbox is off")).toMatchObject({
      status: "warn",
      details: ["KETE_SANDBOX=off"],
    })
    const required = find(
      KeteDoctor.checks(facts({ platform: "linux", sandbox: { state: "unavailable", mode: "required", reason: "no bwrap" } })),
      "required",
    )!
    expect(required.status).toBe("fail")
    expect(required.fix).toContain("bubblewrap")
  })

  test("install: several executables on PATH warn and say which one runs", () => {
    const list = KeteDoctor.checks(
      facts({ binaries: { onPath: [`${HOME}/.local/bin/kete`, "/opt/homebrew/bin/kete"], running: "/opt/homebrew/bin/kete" } }),
    )
    const check = find(list, "executables are on your PATH")!
    expect(check.status).toBe("warn")
    expect(check.details).toEqual(["runs: ~/.local/bin/kete", "hidden: /opt/homebrew/bin/kete"])
  })

  test("install: not on PATH warns", () => {
    expect(find(KeteDoctor.checks(facts({ binaries: { onPath: [], running: "/x/kete" } })), "isn't on your PATH")?.status).toBe("warn")
  })

  test("terminal: TERM=dumb warns, the classic Windows console warns, NO_COLOR is noted", () => {
    expect(find(KeteDoctor.checks(facts({ env: { TERM: "dumb" } })), "dumb")?.status).toBe("warn")
    expect(find(KeteDoctor.checks(facts({ platform: "win32", env: {} })), "classic Windows console")?.status).toBe("warn")
    expect(find(KeteDoctor.checks(facts({ platform: "win32", env: { WT_SESSION: "1" } })), "classic Windows console")).toBeUndefined()
    expect(find(KeteDoctor.checks(facts({ env: { TERM: "xterm", NO_COLOR: "1" } })), "NO_COLOR")?.status).toBe("info")
  })
})

describe("KeteDoctor.render", () => {
  test("groups in order, with symbols, details, fixes and a summary", () => {
    const text = KeteDoctor.render(KeteDoctor.checks(facts({ providers: [], defaultModel: null, mcp: [{ name: "b", status: "needs_auth" }] })))
    expect(text.indexOf("Install")).toBeLessThan(text.indexOf("Models"))
    expect(text.indexOf("Models")).toBeLessThan(text.indexOf("Terminal"))
    expect(text).toContain("  ✗ No model provider is set up")
    expect(text).toContain("      → Run `kete mcp auth b`.")
    expect(text.trimEnd().split("\n").at(-1)).toBe("2 problems, 1 warning.")
  })
})

describe("KeteDoctor.shown", () => {
  test("replaces only a whole home prefix", () => {
    expect(KeteDoctor.shown("/home/alice/x", HOME)).toBe("~/x")
    expect(KeteDoctor.shown("/home/alice", HOME)).toBe("~")
    expect(KeteDoctor.shown("/home/alicex/y", HOME)).toBe("/home/alicex/y")
    expect(KeteDoctor.shown("C:\\Users\\a\\kete.json", "C:\\Users\\a")).toBe("~\\kete.json")
  })
})
