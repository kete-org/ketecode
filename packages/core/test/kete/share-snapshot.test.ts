// The session share snapshot (kete/share/snapshot.ts): what is sent and what never is, redaction before
// truncation, the size cap, and workspace-relative paths.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { KeteShareSnapshot } from "@opencode/core/kete/share/snapshot"

const at = { created: 0 }
const user = (text: string, extra: object = {}) => ({ type: "user", id: "msg_u", time: at, text, ...extra })
const assistant = (content: object[]) => ({
  type: "assistant",
  id: "msg_a",
  time: at,
  agent: "build",
  model: { providerID: "anthropic", id: "claude" },
  content,
})
const completed = (input: object, text: string) => ({ status: "completed", input, content: [{ type: "text", text }] })
const tool = (name: string, state: object) => ({ type: "tool", id: "t", name, state, time: at })

const workspace = path.resolve("/work/project")
const build = (messages: object[], diffs: object[] = [], limit?: number) =>
  KeteShareSnapshot.build({
    messages: messages as never,
    diffs: diffs as never,
    workspace,
    title: "a title",
    version: "1.2.3",
    now: new Date("2026-10-18T00:00:00Z"),
    limit,
  })

const secret = "sk-ant-abcdefghijklmnop1234"

describe("share snapshot", () => {
  test("leaves out reasoning, system, synthetic, skill, switch events and compaction summaries", () => {
    const built = build([
      { type: "system", id: "m", time: at, text: "SYSTEMPROMPT" },
      { type: "synthetic", id: "m", time: at, text: "SYNTHETIC" },
      { type: "skill", id: "m", time: at, name: "x", skill: "x", text: "SKILLBODY" },
      { type: "agent-switched", id: "m", time: at, agent: "build" },
      { type: "idle", id: "m", time: at, outcome: "succeeded" },
      user("hello", {
        files: [{ data: "QUJD", mime: "text/plain", source: { type: "uri", uri: "file:///home/me/secret-dir/notes.txt" } }],
      }),
      assistant([{ type: "reasoning", text: "REASONING" }, { type: "text", text: "hi there" }]),
      { type: "compaction", status: "completed", id: "m", time: at, reason: "auto", summary: "SUMMARY", recent: "RECENT" },
    ])!
    const json = JSON.stringify(built.snapshot)
    for (const hidden of ["SYSTEMPROMPT", "SYNTHETIC", "SKILLBODY", "REASONING", "SUMMARY", "RECENT", "QUJD", "secret-dir"])
      expect(json).not.toContain(hidden)
    expect(built.snapshot.messages).toEqual([
      { type: "user", text: "hello", files: ["notes.txt"] },
      { type: "assistant", text: "hi there", tools: [] },
      { type: "compaction" },
    ])
    expect(built.snapshot.model).toBe("anthropic/claude")
    expect(built.counts).toEqual({ messages: 3, tools: 0, diffs: 0 })
  })

  test("a secret in tool input, tool output, a shell command and a diff is redacted and counted", () => {
    const built = build(
      [
        assistant([
          tool("bash", completed({ command: `curl -H "Authorization: Bearer abc.def" x`, api_key: "hunter2" }, `token ${secret} done`)),
        ]),
        { type: "shell", id: "m", time: at, command: `echo ${secret}`, exit: 0, output: { output: `ok ${secret}`, cursor: 0, size: 0, truncated: false } },
      ],
      [{ file: "src/a.ts", patch: `+const key = "${secret}"`, additions: 1, deletions: 0, status: "modified" }],
    )!
    const json = JSON.stringify(built.snapshot)
    expect(json).not.toContain(secret)
    expect(json).not.toContain("hunter2")
    expect(json).not.toContain("abc.def")
    expect(built.redactions).toBeGreaterThanOrEqual(5)
    expect(built.snapshot.redactions).toBe(built.redactions)
  })

  test("redaction runs before truncation: a secret across the cut is not half sent", () => {
    // The redactor's patterns need a word boundary, so the secret follows a space.
    const text = "x".repeat(4096 - 9) + " " + secret + " tail"
    const built = build([assistant([tool("read", completed({}, text))])])!
    const output = (built.snapshot.messages[0] as { tools: { output: string }[] }).tools[0]!.output
    expect(output.length).toBeLessThanOrEqual(4096)
    expect(output).not.toContain("sk-ant")
    expect(output.endsWith("[RED")).toBe(false)
  })

  test("over the cap the oldest tool outputs go first, then patches, and truncated is set", () => {
    const big = "a".repeat(3000)
    const messages = [1, 2, 3, 4].map((n) => assistant([tool(`t${n}`, completed({}, big))]))
    const whole = build(messages)!
    const built = build(messages, [], whole.bytes - 3500)!
    const outputs = built.snapshot.messages.map((item) => (item as { tools: { output: string }[] }).tools[0]!.output)
    expect(built.snapshot.truncated).toBe(true)
    expect(outputs[0]).toBe("")
    expect(outputs[3]).not.toBe("")
    expect(built.bytes).toBeLessThanOrEqual(whole.bytes - 3500)
    const patches = build(messages, [{ file: "a", patch: big, additions: 1, deletions: 0 }], 1500)!
    expect(patches.snapshot.diffs[0]!.patch).toBe("")
    expect(patches.snapshot.truncated).toBe(true)
    expect(build(messages, [], 100)).toBeUndefined()
  })

  test("a path outside the workspace keeps only its base name", () => {
    const outside = path.resolve("/etc/ssh/sshd_config")
    const built = build(
      [],
      [
        { file: path.join(workspace, "src", "a.ts"), patch: "", additions: 0, deletions: 0 },
        { file: outside, patch: "", additions: 0, deletions: 0 },
        { file: "../secret/b.ts", patch: "", additions: 0, deletions: 0 },
        { file: "docs/c.md", patch: "", additions: 0, deletions: 0 },
      ],
    )!
    expect(built.snapshot.diffs.map((item) => item.path)).toEqual(["src/a.ts", "sshd_config", "b.ts", "docs/c.md"])
  })

  test("counts above the platform's caps keep the newest and set truncated", () => {
    const built = build(
      Array.from({ length: KeteShareSnapshot.CAPS.messages + 5 }, (_, n) => user(`m${n}`)),
      Array.from({ length: KeteShareSnapshot.CAPS.diffs + 1 }, (_, n) => ({ file: `f${n}`, patch: "", additions: 0, deletions: 0 })),
      100 * 1024 * 1024,
    )!
    expect(built.snapshot.messages).toHaveLength(KeteShareSnapshot.CAPS.messages)
    expect((built.snapshot.messages.at(-1) as { text: string }).text).toBe(`m${KeteShareSnapshot.CAPS.messages + 4}`)
    expect(built.snapshot.diffs).toHaveLength(KeteShareSnapshot.CAPS.diffs)
    expect(built.snapshot.truncated).toBe(true)
  })

  test("a file part without a name is labelled by its type, never by its uri", () => {
    const data = "data:image/png;base64,SECRETBASE64/PART"
    const built = build([
      user("look", { files: [{ data: "QUJD", mime: "image/png", source: { type: "uri", uri: data } }] }),
      assistant([tool("read", { status: "completed", input: {}, content: [{ type: "file", uri: data, mime: "image/png" }] })]),
    ])!
    const json = JSON.stringify(built.snapshot)
    expect(json).not.toContain("SECRETBASE64")
    expect(json).not.toContain("PART")
    expect((built.snapshot.messages[0] as { files: string[] }).files).toEqual(["[file: image/png]"])
    expect(json).toContain("[file: image/png]")
  })

  test("absolute workspace and home paths become . and ~ in every string; diff paths stay relative", () => {
    const home = path.resolve("/home/me")
    const inside = path.join(workspace, "src", "a.ts")
    const built = KeteShareSnapshot.build({
      messages: [
        user(`see ${inside} and ${path.join(home, "notes.txt")} but not ${workspace}2/x`),
        assistant([tool("read", completed({ path: inside }, `read ${inside}`))]),
        { type: "shell", id: "m", time: at, command: `cat ${home}/x`, exit: 0, output: { output: `${workspace}/y` } },
      ] as never,
      diffs: [{ file: inside, patch: `--- ${inside}`, additions: 1, deletions: 0 }] as never,
      workspace,
      home,
      title: "t",
      version: "1",
      now: new Date(0),
    })!
    const json = JSON.stringify(built.snapshot)
    expect(json).not.toContain(home)
    const text = (built.snapshot.messages[0] as { text: string }).text
    expect(text).toStartWith(`see .${path.sep}${path.join("src", "a.ts")} and ${path.join("~", "notes.txt")}`)
    expect(json).toContain("2/x") // a sibling folder is not the workspace
    expect(built.snapshot.diffs[0]!.path).toBe("src/a.ts")
    // An empty or root home changes nothing.
    for (const none of ["", path.parse(home).root]) {
      const plain = KeteShareSnapshot.build({ messages: [user("/usr/bin/env")] as never, diffs: [], workspace, home: none, title: "t", version: "1", now: new Date(0) })!
      expect((plain.snapshot.messages[0] as { text: string }).text).toBe("/usr/bin/env")
    }
  })

  test("a secret file's diff and read output are not sent, and the share is marked truncated", () => {
    const built = build(
      [assistant([tool("read", completed({ path: path.join(workspace, ".env.local") }, "DB_URL=postgres://u:p@h/db"))])],
      [
        { file: path.join(workspace, ".env"), patch: "+PLAIN=value", additions: 1, deletions: 0 },
        { file: path.join(workspace, ".env.example"), patch: "+EXAMPLE=1", additions: 1, deletions: 0 },
      ],
    )!
    const json = JSON.stringify(built.snapshot)
    expect(json).not.toContain("PLAIN=value")
    expect(json).not.toContain("postgres")
    expect(built.snapshot.diffs.map((item) => item.patch)).toEqual([KeteShareSnapshot.SECRET_FILE, "+EXAMPLE=1"])
    expect((built.snapshot.messages[0] as { tools: { output: string }[] }).tools[0]!.output).toBe(KeteShareSnapshot.SECRET_FILE)
    expect(built.snapshot.truncated).toBe(true)
  })
})
