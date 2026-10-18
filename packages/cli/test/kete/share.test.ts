import { describe, expect, test } from "bun:test"
import { KeteShareFlow } from "../../src/kete/share-flow"

const preview = {
  counts: { messages: 4, tools: 3, diffs: 2 },
  bytes: 2048,
  redactions: 2,
  truncated: false,
  visibility: "org",
  linkAllowed: true,
  maxDays: 30,
  digest: "d1",
}
const record = { id: "s1", url: "https://portal.example/shares/s1", visibility: "org", expires_at: "2026-11-17T00:00:00Z", session: "ses_1" }

function setup(overrides: Partial<KeteShareFlow.Deps> = {}, answers: Record<string, unknown> = {}) {
  const out: string[] = []
  const err: string[] = []
  const calls: Array<{ directory: string; method: string; input: unknown }> = []
  const asked: string[] = []
  const value: KeteShareFlow.Deps = {
    interactive: true,
    agentShell: false,
    confirm: async (message) => (asked.push(message), true),
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    resolve: async (id) => ({ id: id ?? "ses_1", directory: "/work" }),
    call: async (directory, method, input) => {
      calls.push({ directory, method, input })
      return answers[method] ?? { preview, share: { record }, unshare: { removed: true } }[method]
    },
    ...overrides,
  }
  return { value, out, err, calls, asked }
}

describe("kete share", () => {
  test("--yes prints the preview, uploads without asking, and prints the link", async () => {
    const { value, out, calls, asked } = setup()
    expect(await KeteShareFlow.share(value, { link: false, yes: true })).toBe(0)
    expect(asked).toEqual([])
    expect(out.join("")).toContain("4 messages, 3 tool calls, 2 changed files")
    expect(out.join("")).toContain("Secrets removed: 2")
    expect(out.join("")).toContain("Shared: https://portal.example/shares/s1")
    expect(calls.map((call) => call.method)).toEqual(["preview", "share"])
    expect(calls[1]).toEqual({ directory: "/work", method: "share", input: { sessionID: "ses_1", visibility: "org" } })
  })

  test("a confirmed share passes the preview's digest, so a changed session is refused", async () => {
    const changed = setup({}, { share: { refusal: { kind: "changed", message: "The session changed since the preview; review it again." } } })
    expect(await KeteShareFlow.share(changed.value, { link: false, yes: false })).toBe(2)
    expect(changed.calls[1]!.input).toEqual({ sessionID: "ses_1", visibility: "org", digest: "d1" })
    expect(changed.err.join("")).toContain("review it again")
  })

  test("from an agent's shell it refuses, with or without --yes, before any call", async () => {
    for (const yes of [true, false]) {
      const { value, err, calls } = setup({ agentShell: true })
      expect(await KeteShareFlow.share(value, { link: false, yes })).toBe(2)
      expect(err.join("")).toContain("not from an agent's shell")
      expect(calls).toEqual([])
    }
  })

  test("platform text is printed without control characters", async () => {
    const { value, out, err } = setup(
      {},
      { share: { record: { ...record, url: "https://portal.example/s1", expires_at: "2026-11-17T00:00:00Z\u001b[2J" } } },
    )
    expect(await KeteShareFlow.share(value, { link: false, yes: true })).toBe(0)
    expect(out.join("")).not.toContain("\u001b")
    const refused = setup({}, { preview: { ...preview, refusal: { kind: "failed", message: "bad\u001b]0;x\u0007 thing" } } })
    await KeteShareFlow.share(refused.value, { link: false, yes: true })
    expect(refused.err.join("")).toContain("bad]0;x thing")
    expect(err).toEqual([])
  })

  test("with a terminal and no --yes it asks; a no uploads nothing and exits 2", async () => {
    const yes = setup()
    expect(await KeteShareFlow.share(yes.value, { link: false, yes: false })).toBe(0)
    expect(yes.asked).toHaveLength(1)
    const no = setup({ confirm: async () => false })
    expect(await KeteShareFlow.share(no.value, { link: false, yes: false })).toBe(2)
    expect(no.calls.map((call) => call.method)).toEqual(["preview"])
  })

  test("without a terminal and without --yes it refuses (exit 2) and uploads nothing", async () => {
    const { value, err, calls } = setup({ interactive: false })
    expect(await KeteShareFlow.share(value, { link: false, yes: false })).toBe(2)
    expect(err.join("")).toContain("--yes")
    expect(calls.map((call) => call.method)).toEqual(["preview"])
  })

  test("a runtime refusal exits 2 with its message and a failure exits 1; no upload either way", async () => {
    const refused = setup({}, { preview: { ...preview, refusal: { kind: "org_disabled", message: "Your organization has turned session sharing off." } } })
    expect(await KeteShareFlow.share(refused.value, { link: false, yes: true })).toBe(2)
    expect(refused.err.join("")).toContain("turned session sharing off")
    const failed = setup({}, { share: { refusal: { kind: "failed", message: "The platform is unavailable (request r1)" } } })
    expect(await KeteShareFlow.share(failed.value, { link: false, yes: true })).toBe(1)
    expect(failed.err.join("")).toContain("request r1")
  })

  test("--link asks for link visibility, and refuses to widen an existing organization share", async () => {
    const link = setup({}, { preview: { ...preview, visibility: "link" } })
    expect(await KeteShareFlow.share(link.value, { link: true, yes: true })).toBe(0)
    expect(link.calls[0]!.input).toEqual({ sessionID: "ses_1", visibility: "link" })
    const existing = setup({}, { preview: { ...preview, existing: record } })
    expect(await KeteShareFlow.share(existing.value, { link: true, yes: true })).toBe(2)
    expect(existing.calls.map((call) => call.method)).toEqual(["preview"])
  })

  test("no session in the folder fails", async () => {
    const { value, calls } = setup({ resolve: async () => undefined })
    expect(await KeteShareFlow.share(value, { link: false, yes: true })).toBe(1)
    expect(calls).toEqual([])
  })
})

describe("kete unshare", () => {
  test("deletes and says so; a session that is not shared exits 0", async () => {
    const done = setup()
    expect(await KeteShareFlow.unshare(done.value, { sessionID: "ses_9" })).toBe(0)
    expect(done.out.join("")).toContain("Share deleted.")
    expect(done.calls[0]).toMatchObject({ method: "unshare", input: { sessionID: "ses_9" } })
    const none = setup({}, { unshare: { removed: false } })
    expect(await KeteShareFlow.unshare(none.value, {})).toBe(0)
    expect(none.out.join("")).toContain("isn't shared")
  })

  test("a refusal exits 2", async () => {
    const { value } = setup({}, { unshare: { refusal: { kind: "signed_out", message: "Sign in with `kete login`" } } })
    expect(await KeteShareFlow.unshare(value, {})).toBe(2)
  })
})
