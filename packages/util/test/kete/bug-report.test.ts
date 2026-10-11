import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteBugReport } from "../../src/kete/bug-report.js"
import { KeteBugReportFile } from "../../src/kete/bug-report-file.js"

const HOME = "/home/alice"
// Planted secrets: none of these may appear in a report or an issue link.
const SECRETS = {
  apiKey: "sk-ant-api03-PLANTEDkey0123456789abcdef",
  openai: "sk-proj-PLANTEDopenai0123456789",
  bearer: "PLANTEDbearer.tokenvalue",
  email: "alice.planted@example.com",
  org: "3f2b8c1a-9d4e-4f6a-8b7c-1234567890ab",
  prompt: "PLANTED-PROMPT please refactor the billing module",
  envValue: "PLANTED-ENV-VALUE",
  github: "ghp_PLANTEDabcdefghijklmnopqrstuvwxyz0123",
  opaque: "PLANTEDopaque0123456789abcdefghijklmnop",
}

const LOG = [
  `timestamp=2026-10-11T09:00:00.000Z level=INFO run=ab12cd34 message="cli starting" version=0.2.7 channel=latest args="[\\"run\\",\\"${SECRETS.prompt}\\"]" role=cli`,
  `timestamp=2026-10-11T09:00:01.000Z level=ERROR run=ab12cd34 message="request failed" error="401 for Bearer ${SECRETS.bearer} with key ${SECRETS.apiKey}" http.url="https://api.example.com/v1?key=${SECRETS.openai}" path=${HOME}/work/secret-project/src/billing.ts`,
  `timestamp=2026-10-11T09:00:02.000Z level=WARN run=ab12cd34 message="signed in as ${SECRETS.email} org ${SECRETS.org}" cause="failed reading ${HOME}/.config/kete/kete.json"`,
  `timestamp=2026-10-11T09:00:03.000Z level=INFO run=ab12cd34 message="event" event.data="{\\"text\\":\\"${SECRETS.prompt}\\"}" command="export TOKEN=${SECRETS.envValue}"`,
  `timestamp=2026-10-11T09:00:04.000Z level=INFO run=ab12cd34 message="tool output \\u001b[31mred\\u001b[0m ${SECRETS.github} ${SECRETS.opaque}"`,
  `Error: a stack line that isn't logfmt with ${SECRETS.prompt}`,
].join("\n")

function facts(overrides: Partial<KeteBugReport.Facts> = {}): KeteBugReport.Facts {
  return {
    source: "cli",
    version: "0.2.7",
    channel: "latest",
    os: { platform: "linux", release: "6.8.0", arch: "x64" },
    env: {
      TERM: "xterm-256color",
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.1.0",
      SHELL: "/usr/bin/zsh",
      TMUX: "/tmp/tmux-1000/default,1,0",
      OPENAI_API_KEY: SECRETS.openai,
      KETE_API_KEY: SECRETS.apiKey,
      SECRET_THING: SECRETS.envValue,
      USER_EMAIL: SECRETS.email,
    },
    install: "direct",
    signedIn: "yes",
    providers: ["anthropic", "kete", "ollama"],
    permissionMode: "default",
    sandbox: { state: "on", mechanism: "bubblewrap", mode: "auto", network: "approved" },
    offline: false,
    mcp: [
      { name: "github", status: "connected" },
      { name: "slack", status: "needs_auth" },
    ],
    log: LOG,
    description: `It crashes when I open ${HOME}/work/app. My key is ${SECRETS.apiKey}, mail me at ${SECRETS.email}.`,
    ...overrides,
  }
}

function expectNoSecrets(text: string) {
  for (const value of Object.values(SECRETS)) expect(text).not.toContain(value)
  expect(text).not.toContain("PLANTED")
  expect(text).not.toContain(HOME)
  expect(text).not.toContain("secret-project")
  expect(text).not.toContain("\u001b")
}

describe("KeteBugReport.build", () => {
  test("has every listed field and none of the excluded data", () => {
    const report = KeteBugReport.build(facts(), HOME)
    const text = report.text
    expect(text).toContain("- Kete Code: 0.2.7 (channel latest)")
    expect(text).toContain("- OS: Linux 6.8.0 (x64)")
    expect(text).toContain("- Terminal: ghostty 1.1.0, TERM xterm-256color, in tmux")
    expect(text).toContain("- Shell: zsh")
    expect(text).toContain("- Install: direct")
    expect(text).toContain("- Signed in: yes")
    expect(text).toContain("- Model providers: anthropic, kete, ollama")
    expect(text).toContain("- Permission mode: default")
    expect(text).toContain("- Sandbox: on (bubblewrap; mode auto; network approved)")
    expect(text).toContain("- Offline mode: off")
    expect(text).toContain("- MCP servers: 2 (github: connected, slack: needs_auth)")
    expect(text).toContain('message="cli starting"')
    expect(text).toContain('message="request failed"')
    expect(text).toContain("1 lines not in the log format were left out.")
    // The description is kept, scrubbed.
    expect(text).toContain("It crashes when I open ~/work/app.")
    expect(text).toContain("[EMAIL]")
    // Log fields outside the allowlist are gone, not just masked.
    expect(text).not.toContain("args=")
    expect(text).not.toContain("event.data")
    expect(text).not.toContain("command=")
    expect(text).not.toContain("http.url")
    expect(text).not.toContain("path=")
    expect(text).not.toContain("run=")
    // Home paths in kept fields become ~.
    expect(text).toContain("~/.config/kete/kete.json")
    expectNoSecrets(text)
    expectNoSecrets(report.title)
  })

  test("says what it couldn't find out", () => {
    const text = KeteBugReport.build(
      facts({ providers: undefined, sandbox: undefined, mcp: undefined, log: undefined, install: undefined, signedIn: "unknown", permissionMode: undefined, description: undefined }),
      HOME,
    ).text
    expect(text).toContain("- Model providers: unavailable")
    expect(text).toContain("- Sandbox: unavailable")
    expect(text).toContain("- MCP servers: unavailable")
    expect(text).toContain("- Install: unknown")
    expect(text).toContain("- Signed in: unknown")
    expect(text).toContain("No log file found.")
    expect(text).toContain("What happened, what you expected")
  })

  test("keeps only the last 200 log lines", () => {
    const log = Array.from({ length: 250 }, (_, index) => `timestamp=t level=INFO message=line-${index}`).join("\n")
    const text = KeteBugReport.build(facts({ log }), HOME).text
    expect(text).toContain("message=line-249")
    expect(text).toContain("message=line-50")
    expect(text).not.toContain("message=line-49\n")
    expect(text).toContain("## Log (last 200 lines")
  })

  test("a Windows home directory becomes ~ with either separator", () => {
    const home = "C:\\Users\\alice"
    const text = KeteBugReport.scrub("at C:\\Users\\alice\\proj\\a.ts and C:/Users/alice/proj/b.ts", home)
    expect(text).toBe("at ~\\proj\\a.ts and ~/proj/b.ts")
  })

  test("URL query strings and fragments are masked, host and path kept", () => {
    expect(KeteBugReport.scrub("GET https://api.example.com/v1/models?key=abc&x=1 failed", HOME)).toBe(
      "GET https://api.example.com/v1/models?[…] failed",
    )
    expect(KeteBugReport.scrub("(see https://example.com/a#token=xyz)", HOME)).toBe("(see https://example.com/a?[…])")
  })

  test("the title is the description's first line, scrubbed", () => {
    expect(KeteBugReport.build(facts({ description: `Crash with ${SECRETS.apiKey}\nmore` }), HOME).title).toBe("Crash with [REDACTED]")
    expect(KeteBugReport.build(facts({ description: undefined }), HOME).title).toBe("Bug report")
  })
})

describe("free text in log fields", () => {
  const field = (line: string, key: string) => {
    const kept = KeteBugReport.logLines(line, HOME).lines[0] ?? ""
    const match = new RegExp(`${key.replace(".", "\\.")}=("(?:[^"\\\\]|\\\\.)*"|\\S*)`).exec(kept)
    const value = match?.[1] ?? ""
    return value.startsWith('"') ? (JSON.parse(value) as string) : value
  }

  test("absolute paths outside home become <path>: POSIX, Windows, UNC and file URLs", () => {
    const line = [
      "timestamp=t level=ERROR",
      'message="opening /srv/PLANTED-project/src/app.ts failed"',
      'error="ENOENT: open \'C:\\\\Work\\\\PLANTED-client\\\\a.ts\'"',
      'cause="read \\\\\\\\fileserver\\\\PLANTED-share\\\\x.txt"',
      'reason="see file:///opt/PLANTED-tools/x and ~/notes and ' + HOME + '/repo/a.ts"',
    ].join(" ")
    expect(field(line, "message")).toBe("opening <path> failed")
    expect(field(line, "error")).toBe("ENOENT: open '<path>'")
    expect(field(line, "cause")).toBe("read <path>")
    expect(field(line, "reason")).toBe("see <path> and ~/notes and ~/repo/a.ts")
    expect(KeteBugReport.logLines(line, HOME).lines.join("\n")).not.toContain("PLANTED")
  })

  test("URLs keep host and path; a Windows path written with / is masked too", () => {
    const line = 'timestamp=t level=WARN cause="HttpClientError: 500 GET https://api.example.com/api/v1/models at D:/PLANTED/x"'
    expect(field(line, "cause")).toBe("HttpClientError: 500 GET https://api.example.com/api/v1/models at <path>")
  })

  test("an MCP error body echoing a prompt is <data>, and error, cause and reason are capped", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code: -32602, message: `invalid params`, data: { prompt: SECRETS.prompt } } })
    const line = `timestamp=t level=ERROR message=${JSON.stringify(`mcp call failed ${body}`)} error=${JSON.stringify(`MCP error -32602: ${body}`)} reason=${JSON.stringify(`[{"role":"user","content":"${SECRETS.prompt}"}]`)} cause=${JSON.stringify(`Tool failed: {"messages":[{"content":"${SECRETS.prompt}`)}`
    expect(field(line, "message")).toBe("mcp call failed <data>")
    expect(field(line, "error")).toBe("MCP error -32602: <data>")
    expect(field(line, "reason")).toBe("<data>")
    expect(field(line, "cause")).toBe("Tool failed: <data>")
    const long = `timestamp=t level=ERROR error=${JSON.stringify(`upstream said: ${"PLANTED words ".repeat(40)}`)}`
    const value = field(long, "error")
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(121 + 3)
    expect(value.endsWith("…")).toBe(true)
  })

  test("a multi-line Cause keeps its first line only, no stack frames", () => {
    const cause = `Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect (node:net:1595:16)\n    at run (/srv/PLANTED-app/index.js:10:3)\nCaused by: PLANTED-inner`
    const line = `timestamp=t level=ERROR message="boom" cause=${JSON.stringify(cause)} error=${JSON.stringify(cause)}`
    expect(field(line, "cause")).toBe("Error: connect ECONNREFUSED")
    expect(field(line, "error")).toBe("Error: connect ECONNREFUSED")
    expect(KeteBugReport.logLines(line, HOME).lines.join("\n")).not.toMatch(/PLANTED|TCPConnectWrap/)
  })

  test("scrubLine is one line, capped, with paths and payloads masked", () => {
    expect(KeteBugReport.scrubLine("x\n/etc/y/z", HOME, 200)).toBe("x")
    expect(KeteBugReport.scrubLine(`${"a".repeat(500)}`, HOME, 200)).toBe(`${"a".repeat(200)}…`)
  })
})

describe("home directory spellings", () => {
  test("only a whole path prefix: not inside another path or a longer name", () => {
    expect(KeteBugReport.scrub("/home/bob/x /private/home/bob/y /home/bobby/z data/home/bob", "/home/bob")).toBe(
      "~/x /private/home/bob/y /home/bobby/z data/home/bob",
    )
  })

  test("Windows homes match in any case", () => {
    expect(KeteBugReport.scrub("at c:\\users\\ALICE\\a.ts and C:/Users/Alice/b.ts", "C:\\Users\\alice")).toBe("at ~\\a.ts and ~/b.ts")
    // A POSIX home stays case-sensitive.
    expect(KeteBugReport.scrub("/HOME/ALICE/x", HOME)).toBe("/HOME/ALICE/x")
  })

  test("the URL-encoded spelling", () => {
    expect(KeteBugReport.scrub("file:///Users/Bob%20Smith/a.ts", "/Users/Bob Smith")).toBe("file://~/a.ts")
  })

  test("every spelling in a list (real path, temp-directory profile prefix)", () => {
    expect(KeteBugReport.scrub("/home/alice/a /data/users/alice/b C:\\Users\\ALICE~1\\Temp", [HOME, "/data/users/alice", "C:\\Users\\ALICE~1"])).toBe(
      "~/a ~/b ~\\Temp",
    )
  })
})

describe("characters and URLs", () => {
  test("C1 control, bidi and zero-width characters are removed", () => {
    expect(KeteBugReport.scrub("a\u0085b\u009bc\u202ed\u2066e\u200bf\ufeffg\u200fh", HOME)).toBe("abcdefgh")
  })

  test("query strings are masked on any scheme", () => {
    expect(KeteBugReport.scrub("socket wss://relay.example.com/v1/stream?sig=PLANTEDsig&x=1 closed", HOME)).toBe(
      "socket wss://relay.example.com/v1/stream?[…] closed",
    )
    expect(KeteBugReport.scrub("ftp://host/a#frag", HOME)).toBe("ftp://host/a?[…]")
  })
})

describe("runtime answers", () => {
  test("provider IDs only, disabled ones and odd values left out", () => {
    const value = [
      { id: "anthropic", activation: "auto", headers: { authorization: SECRETS.bearer } },
      { id: "openai", activation: "disabled" },
      { id: "ollama", activation: "enabled", settings: { apiKey: SECRETS.apiKey } },
      { id: "bad id with spaces" },
      "nonsense",
    ]
    expect(KeteBugReport.providerIds(value)).toEqual(["anthropic", "ollama"])
    expect(KeteBugReport.providerIds({ data: [] })).toBeUndefined()
  })

  test("MCP names and states only, never error messages", () => {
    const states = KeteBugReport.mcpStates([
      { name: "github", status: { status: "failed", error: `401 ${SECRETS.bearer}` } },
      { name: "weird name/../x", status: { status: "connected" } },
      { name: "x", status: { status: "made-up" } },
    ])
    expect(states).toEqual([
      { name: "github", status: "failed" },
      { name: "(unnamed)", status: "connected" },
      { name: "x", status: "unknown" },
    ])
    expect(JSON.stringify(states)).not.toContain("PLANTED")
  })
})

describe("KeteBugReport.issueURL", () => {
  test("opens the pre-filled bug-report form on Kete's tracker", () => {
    const report = KeteBugReport.build(facts({ log: "timestamp=t level=INFO message=short" }), HOME)
    const { url, complete } = KeteBugReport.issueURL(report)
    expect(complete).toBe(true)
    expect(url.startsWith("https://github.com/kete-org/ketecode/issues/new?")).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get("template")).toBe("bug-report.yml")
    expect(params.get("title")).toBe(report.title)
    expect(params.get("description")).toBe(report.text)
    expect(params.get("opencode-version")).toBe("0.2.7")
    expect(params.get("os")).toBe("Linux 6.8.0 (x64)")
    expect(params.get("terminal")).toBe("ghostty 1.1.0, TERM xterm-256color, in tmux")
    expectNoSecrets(decodeURIComponent(url))
  })

  test("over the cap: the oldest log lines are dropped and the body names the saved file", () => {
    const log = Array.from({ length: 200 }, (_, index) => `timestamp=2026-10-11T09:00:00.000Z level=INFO message="a fairly long log message number ${index}"`).join("\n")
    const report = KeteBugReport.build(facts({ log }), HOME)
    const { url, complete } = KeteBugReport.issueURL(report, "/tmp/x/kete-bug-1.md")
    expect(complete).toBe(false)
    expect(url.length).toBeLessThanOrEqual(KeteBugReport.MAX_URL)
    const body = new URL(url).searchParams.get("description") ?? ""
    expect(body).toContain("message number 199")
    expect(body).not.toContain("message number 0\"")
    expect(body).toContain("The full report is in the file kete-bug-1.md")
    expect(body).not.toContain("/tmp/x")
    expectNoSecrets(decodeURIComponent(url))
  })

  test("a huge description still fits", () => {
    const report = KeteBugReport.build(facts({ description: "x ".repeat(5000) }), HOME)
    expect(KeteBugReport.issueURL(report, "kete-bug-1.md").url.length).toBeLessThanOrEqual(KeteBugReport.MAX_URL)
  })
})

describe("KeteBugReportFile", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "kete-bug-report-"))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("save writes a new file only its owner can read", async () => {
    const file = await KeteBugReportFile.save(root, "kete", "report")
    expect(path.dirname(file)).toBe(root)
    expect(path.basename(file)).toMatch(/^kete-bug-.*\.md$/)
    expect(await readFile(file, "utf8")).toBe("report")
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test("homes adds the real path and the temp directory's profile prefix", async () => {
    const { mkdir, realpath, symlink } = await import("node:fs/promises")
    const home = path.join(root, "home")
    await mkdir(path.join(home, "tmp"), { recursive: true })
    const alias = path.join(root, "alias")
    await symlink(home, alias, "junction")
    const realHome = await realpath(home)
    const spellings = KeteBugReportFile.homes(home, path.join(alias, "tmp"))
    expect(spellings).toContain(home)
    expect(spellings).toContain(realHome)
    expect(spellings).toContain(alias)
    // A temp directory outside the profile adds nothing.
    expect(KeteBugReportFile.homes(home, root)).toEqual([...new Set([home, realHome])])
    // A missing home has no other spelling.
    expect(KeteBugReportFile.homes(path.join(root, "missing"))).toEqual([path.join(root, "missing")])
  })

  test("tail reads the end from a line boundary, and undefined when missing", async () => {
    const file = path.join(root, "log.txt")
    await writeFile(file, "first line\nsecond line\nthird line\n")
    expect(await KeteBugReportFile.tail(file, 1024)).toBe("first line\nsecond line\nthird line\n")
    expect(await KeteBugReportFile.tail(file, 15)).toBe("third line\n")
    expect(await KeteBugReportFile.tail(path.join(root, "missing.log"))).toBeUndefined()
  })
})
