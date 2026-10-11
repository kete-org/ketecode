import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteBugReport } from "@opencode/util/kete/bug-report"
import { KeteBugFlow } from "../../src/kete/bug-flow"

// Planted secrets: none may reach stdout, the saved file or an issue link.
const SECRETS = {
  apiKey: "sk-ant-api03-PLANTEDkey0123456789abcdef",
  bearer: "PLANTEDbearer.tokenvalue",
  email: "alice.planted@example.com",
  prompt: "PLANTED-PROMPT refactor the billing module",
  envValue: "PLANTED-ENV-VALUE",
}
const HOME = "/home/alice"
const LOG = [
  `timestamp=2026-10-11T09:00:00.000Z level=INFO message="cli starting" args="[\\"run\\",\\"${SECRETS.prompt}\\"]" role=cli`,
  `timestamp=2026-10-11T09:00:01.000Z level=ERROR message="request failed" error="Authorization: Bearer ${SECRETS.bearer} key=${SECRETS.apiKey} for ${SECRETS.email}" path=${HOME}/secret-project`,
].join("\n")

function expectClean(text: string) {
  expect(text).not.toContain("PLANTED")
  expect(text).not.toContain(SECRETS.email)
  expect(text).not.toContain(HOME)
}

function deps(overrides: Partial<KeteBugFlow.Deps> = {}) {
  const calls = { out: [] as string[], err: [] as string[], saved: [] as string[], confirm: 0, open: [] as string[] }
  const value: KeteBugFlow.Deps = {
    version: "0.2.7",
    channel: "latest",
    os: { platform: "darwin", release: "25.6.0", arch: "arm64" },
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh", OPENAI_API_KEY: SECRETS.apiKey, MY_SECRET: SECRETS.envValue },
    home: HOME,
    offline: false,
    install: async () => "homebrew",
    signedIn: async () => true,
    runtime: async () => ({
      providers: ["anthropic"],
      mcp: [{ name: "github", status: "connected" }],
      sandbox: { state: "on", mechanism: "seatbelt", mode: "auto", network: "approved" },
    }),
    log: async () => LOG,
    save: async (text) => {
      calls.saved.push(text)
      return "/tmp/kete-bug-test.md"
    },
    interactive: true,
    confirm: async () => {
      calls.confirm++
      return true
    },
    open: async (url) => {
      calls.open.push(url)
    },
    out: (text) => calls.out.push(text),
    err: (text) => calls.err.push(text),
    ...overrides,
  }
  return { deps: value, calls }
}

describe("KeteBugFlow.run", () => {
  test("--print prints and saves the report, never asks or opens", async () => {
    const { deps: d, calls } = deps()
    expect(await KeteBugFlow.run(d, { description: `It broke ${SECRETS.apiKey}`, print: true })).toBe(0)
    expect(calls.confirm).toBe(0)
    expect(calls.open).toEqual([])
    expect(calls.out).toHaveLength(1)
    expect(calls.saved).toEqual(calls.out)
    const report = calls.out[0]!
    expect(report).toContain("- Install: homebrew")
    expect(report).toContain("- Signed in: yes")
    expect(report).toContain("- Model providers: anthropic")
    expect(report).toContain("- Sandbox: on (seatbelt; mode auto; network approved)")
    expect(report).toContain("- MCP servers: 1 (github: connected)")
    expect(report).toContain("- Shell: zsh")
    expect(report).toContain("It broke [REDACTED]")
    expectClean(report)
    expect(calls.err.join("\n")).toContain("Full report saved to /tmp/kete-bug-test.md")
    expect(calls.err.join("\n")).toContain("report it privately: https://github.com/kete-org/ketecode/security/advisories/new")
  })

  test("without a terminal: prints and saves, never asks or opens", async () => {
    const { deps: d, calls } = deps({ interactive: false })
    expect(await KeteBugFlow.run(d, { description: "", print: false })).toBe(0)
    expect(calls.confirm).toBe(0)
    expect(calls.open).toEqual([])
    expect(calls.saved).toHaveLength(1)
    expect(calls.err.join("\n")).toContain("Not a terminal, so nothing was opened")
  })

  test("in a terminal, no (the default) opens nothing", async () => {
    const { deps: d, calls } = deps({ confirm: async () => false })
    expect(await KeteBugFlow.run(d, { description: "", print: false })).toBe(0)
    expect(calls.open).toEqual([])
  })

  test("yes opens the pre-filled issue form, with nothing secret in the link", async () => {
    const order: string[] = []
    const { deps: d, calls } = deps({
      confirm: async () => {
        calls.confirm++
        order.push("confirm")
        return true
      },
      err: (text) => {
        calls.err.push(text)
        order.push(text)
      },
    })
    await KeteBugFlow.run(d, { description: "Crash on start", print: false })
    expect(calls.confirm).toBe(1)
    // Said before the question: the link carries the report to GitHub.
    expect(order.indexOf(KeteBugReport.LINK_NOTICE)).toBeGreaterThan(-1)
    expect(order.indexOf(KeteBugReport.LINK_NOTICE)).toBeLessThan(order.indexOf("confirm"))
    expect(calls.open).toHaveLength(1)
    const url = calls.open[0]!
    expect(url.startsWith("https://github.com/kete-org/ketecode/issues/new?")).toBe(true)
    expect(new URL(url).searchParams.get("title")).toBe("Crash on start")
    expectClean(decodeURIComponent(url))
  })

  test("a runtime that can't be reached, a broken account file and no log still make a report", async () => {
    const { deps: d, calls } = deps({
      runtime: async () => {
        throw new Error("connection refused")
      },
      signedIn: async () => {
        throw new Error(`${HOME}/.config/kete/account.json is not valid`)
      },
      install: async () => {
        throw new Error("no")
      },
      log: async () => undefined,
    })
    expect(await KeteBugFlow.run(d, { description: "", print: true })).toBe(0)
    const report = calls.out[0]!
    expect(report).toContain("- Signed in: unknown")
    expect(report).toContain("- Model providers: unavailable")
    expect(report).toContain("No log file found.")
  })

  test("a save failure is reported and fails the command, the report still prints", async () => {
    const { deps: d, calls } = deps({
      save: async () => {
        throw new Error(`EACCES ${HOME}/tmp`)
      },
    })
    expect(await KeteBugFlow.run(d, { description: "", print: true })).toBe(1)
    expect(calls.out).toHaveLength(1)
    expect(calls.err.join("\n")).toContain("Couldn't save the report to a file: EACCES ~/tmp")
  })
})

describe("kete bug (subprocess)", () => {
  let root: string
  let closed: string

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-bug-")))
    await fs.mkdir(path.join(root, "tmp"))
    // The source run's channel is "local": its log file is kete-local.log.
    await fs.mkdir(path.join(root, "data", "kete", "log"), { recursive: true })
    await fs.writeFile(
      path.join(root, "data", "kete", "log", "kete-local.log"),
      LOG.replaceAll(HOME, root) + "\n",
    )
    // A port nothing listens on, so no runtime is started or reached.
    const server = Bun.serve({ port: 0, fetch: () => new Response("") })
    closed = `http://127.0.0.1:${server.port}`
    await server.stop(true)
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function environment() {
    const env: Record<string, string | undefined> = { ...process.env }
    for (const name of Object.keys(env)) if (/^(KETE|OPENCODE)_/i.test(name)) delete env[name]
    return {
      ...env,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: path.join(root, "tmp"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      OPENAI_API_KEY: SECRETS.apiKey,
      MY_SECRET: SECRETS.envValue,
    }
  }

  async function cli(args: string[]) {
    // Pipes, not a terminal: `kete bug` must never prompt or open a browser here.
    const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../../src/index.ts"), ...args], {
      cwd: path.join(import.meta.dir, "../.."),
      env: environment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode }
  }

  async function savedFile(stderr: string) {
    const match = /Full report saved to (.+?) \(only you can read it\)/.exec(stderr)
    expect(match).not.toBeNull()
    return match![1]!
  }

  for (const args of [["--print"], []]) {
    test(`kete bug ${args.join(" ")} exits 0, prints the report and writes it with mode 0600`, async () => {
      const result = await cli(["bug", ...args, "--server", closed, `crash ${SECRETS.apiKey}`])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("## Environment")
      expect(result.stdout).toContain("- Signed in: no")
      expect(result.stdout).toContain("- Model providers: unavailable")
      expect(result.stdout).toContain('message="request failed"')
      expect(result.stdout).toContain("crash [REDACTED]")
      expect(result.stdout).not.toContain(QUESTION_TEXT)
      expect(result.stderr).not.toContain(QUESTION_TEXT)
      for (const text of [result.stdout, result.stderr]) {
        expect(text).not.toContain("PLANTED")
        expect(text).not.toContain(SECRETS.email)
      }
      expect(result.stdout).not.toContain(root)
      const file = await savedFile(result.stderr)
      expect(path.dirname(file)).toBe(path.join(root, "tmp"))
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
      expect(await fs.readFile(file, "utf8")).toBe(result.stdout.replace(/\n$/, ""))
    }, 60_000)
  }
})

const QUESTION_TEXT = KeteBugFlow.QUESTION
