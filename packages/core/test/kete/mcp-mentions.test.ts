import { describe, expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { KeteMcpMentions } from "@opencode/core/kete/mcp-mentions"
import { KeteMcpMention } from "@opencode/util/kete/mcp-mention"
import { host } from "../plugin/host"

type Resource = { server: string; uri: string; contents: Array<Record<string, string>> }

async function setup(options: { resources?: Record<string, Resource>; denied?: string[]; failing?: string[] }) {
  const hooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
  const reads: string[] = []
  const ctx: Plugin.Context = host({
    session: { hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(name, handler))) as any },
  })
  const plugin = KeteMcpMentions.make({
    read: (input) =>
      Effect.suspend(() => {
        reads.push(`${input.server}:${input.uri}`)
        if (options.failing?.includes(input.uri)) return Effect.fail(new Error("connection reset"))
        return Effect.succeed(options.resources?.[input.uri] as any)
      }),
    denied: (input) => Effect.succeed(options.denied?.includes(input.uri) ?? false),
  })
  await Effect.runPromise(plugin.effect(ctx).pipe(Scope.provide(Effect.runSync(Scope.make()))) as Effect.Effect<void>)
  const send = async (prompt: { text: string; files?: unknown[] }) => {
    const event: any = { sessionID: "ses_1", prompt: structuredClone(prompt) }
    await Effect.runPromise(hooks.get("prompt")!(event))
    return { prompt: event.prompt as { text: string; files?: Array<Record<string, any>> }, reads }
  }
  return { send }
}

const mention = { start: 6, end: 18, text: "@docs:readme" }
const decoded = (file: Record<string, any>) => Buffer.from(String(file.uri).split(",")[1]!, "base64").toString()

describe("KeteMcpMentions", () => {
  test("a mentioned text resource is read and attached as its content, keeping the mention", async () => {
    const h = await setup({
      resources: { "docs://readme": { server: "docs", uri: "docs://readme", contents: [{ type: "text", uri: "docs://readme", text: "# Hello", mimeType: "text/markdown" }] } },
    })
    const { prompt, reads } = await h.send({
      text: "Read @docs:readme",
      files: [{ uri: KeteMcpMention.encode("docs", "docs://readme"), name: "readme", mention }],
    })
    expect(reads).toEqual(["docs:docs://readme"])
    expect(prompt.text).toBe("Read @docs:readme")
    expect(prompt.files).toHaveLength(1)
    expect(prompt.files![0]).toEqual({
      uri: expect.stringMatching(/^data:text\/plain;base64,/),
      name: "MCP resource docs:docs://readme",
      mention,
      source: { type: "uri", uri: KeteMcpMention.encode("docs", "docs://readme") },
    })
    expect(decoded(prompt.files![0]!)).toBe("MCP resource docs:docs://readme\n\n# Hello")
  })

  test("other attachments are left alone and nothing is read without a mention", async () => {
    const h = await setup({})
    const files = [{ uri: "file:///repo/a.ts" }]
    const { prompt, reads } = await h.send({ text: "x", files })
    expect(prompt.files).toEqual(files)
    expect(reads).toEqual([])
  })

  test("images are attached; other binary parts aren't", async () => {
    const h = await setup({
      resources: {
        "img://1": {
          server: "s",
          uri: "img://1",
          contents: [
            { type: "blob", uri: "img://1", blob: "iVBORw0KGgo=", mimeType: "image/png" },
            { type: "blob", uri: "img://1", blob: "AAAA", mimeType: "application/zip" },
          ],
        },
        "zip://1": { server: "s", uri: "zip://1", contents: [{ type: "blob", uri: "zip://1", blob: "AAAA", mimeType: "application/zip" }] },
      },
    })
    const { prompt } = await h.send({
      text: "look",
      files: [{ uri: KeteMcpMention.encode("s", "img://1") }, { uri: KeteMcpMention.encode("s", "zip://1") }],
    })
    expect(prompt.files).toHaveLength(1)
    expect(prompt.files![0]!.uri).toBe("data:image/png;base64,iVBORw0KGgo=")
    expect(prompt.files![0]!.name).toBe("MCP resource s:img://1")
    expect(prompt.text).toContain("[MCP resource s:zip://1 was not attached: it has only binary content the model can't read]")
  })

  test("a denied, failing, missing or oversized resource is dropped and the prompt says why", async () => {
    const big = "x".repeat(KeteMcpMentions.MAX_BYTES + 1)
    const h = await setup({
      denied: ["secret://1"],
      failing: ["flaky://1"],
      resources: { "big://1": { server: "s", uri: "big://1", contents: [{ type: "text", uri: "big://1", text: big }] } },
    })
    const { prompt, reads } = await h.send({
      text: "go",
      files: ["secret://1", "flaky://1", "gone://1", "big://1"].map((uri) => ({ uri: KeteMcpMention.encode("s", uri) })),
    })
    expect(prompt.files).toEqual([])
    expect(reads).not.toContain("s:secret://1")
    expect(prompt.text).toContain("s:secret://1 was not attached: a permission rule denies reading it")
    expect(prompt.text).toContain("s:flaky://1 was not attached: the server returned an error (connection reset)")
    expect(prompt.text).toContain("s:gone://1 was not attached: its MCP server is not connected or has no resources")
    expect(prompt.text).toContain("s:big://1 was not attached: it is larger than 5 MiB")
  })

  test("non-canonical base64 is re-encoded; bytes that aren't what the server says, or unreadable text, are refused", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const wrapped = png.toString("base64").replace(/=+$/, "").replace(/(.{4})/, "$1\n")
    const h = await setup({
      resources: {
        "png://1": { server: "s", uri: "png://1", contents: [{ type: "blob", uri: "png://1", blob: wrapped, mimeType: "image/png" }] },
        "fake://1": { server: "s", uri: "fake://1", contents: [{ type: "blob", uri: "fake://1", blob: "aGVsbG8=", mimeType: "image/png" }] },
        "nul://1": { server: "s", uri: "nul://1", contents: [{ type: "text", uri: "nul://1", text: "a\u0000b" }] },
        "bmp://1": { server: "s", uri: "bmp://1", contents: [{ type: "text", uri: "bmp://1", text: "BMI table" }] },
      },
    })
    const { prompt } = await h.send({ text: "x", files: ["png://1", "fake://1", "nul://1", "bmp://1"].map((uri) => ({ uri: KeteMcpMention.encode("s", uri) })) })
    expect(prompt.files!.map((file) => file.uri)).toEqual([`data:image/png;base64,${png.toString("base64")}`, expect.stringMatching(/^data:text\/plain;base64,/)])
    expect(decoded(prompt.files![1]!)).toEndWith("BMI table")
    expect(prompt.text).toContain("s:fake://1 was not attached: its image/png content isn't valid image/png")
    expect(prompt.text).toContain("s:nul://1 was not attached: its text has content the model can't read")
  })

  test("a resource mentioned more than once (a restored prompt) is read once, keeping the mention", async () => {
    const h = await setup({ resources: { "d://1": { server: "s", uri: "d://1", contents: [{ type: "text", uri: "d://1", text: "hi" }] } } })
    const uri = KeteMcpMention.encode("s", "d://1")
    const { prompt, reads } = await h.send({ text: "Read @s:d", files: [{ uri }, { uri, mention }, { uri }] })
    expect(reads).toEqual(["s:d://1"])
    expect(prompt.files).toHaveLength(1)
    expect(prompt.files![0]!.mention).toEqual(mention)
  })

  test("a server's error message is cut to one short line", async () => {
    const h = await setup({ failing: ["x://1"] })
    const { prompt } = await h.send({ text: "x", files: [{ uri: KeteMcpMention.encode("s", "x://1") }] })
    expect(prompt.text.split("\n").at(-1)).toBe("[MCP resource s:x://1 was not attached: the server returned an error (connection reset)]")
  })

  test("an unexpected failure removes every mention file instead of failing the prompt", async () => {
    const broken = KeteMcpMentions.make({ read: () => Effect.die("boom"), denied: () => Effect.succeed(false) })
    const hooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
    const ctx: Plugin.Context = host({ session: { hook: ((name: string, handler: any) => Effect.sync(() => void hooks.set(name, handler))) as any } })
    await Effect.runPromise(broken.effect(ctx).pipe(Scope.provide(Effect.runSync(Scope.make()))) as Effect.Effect<void>)
    const event: any = { sessionID: "ses_1", prompt: { text: "x", files: [{ uri: "file:///a" }, { uri: KeteMcpMention.encode("s", "d://1") }] } }
    await Effect.runPromise(hooks.get("prompt")!(event))
    expect(event.prompt.files).toEqual([{ uri: "file:///a" }])
    expect(event.prompt.text).toContain("[MCP resources were not attached: an internal error occurred]")
  })
})
