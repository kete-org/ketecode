// Work mode enforcement (kete/work-mode.ts): files, tools, shell, network marks and the audit trail.
// Handler-level over real temporary folders and symlinks; a small adapter over node:fs stands in for
// FSUtil (as in add-dir.test.ts). Every case is re-run as a Code session, which must pass unchanged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import nfs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Exit, Option } from "effect"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { KeyedMutex } from "@opencode/core/effect/keyed-mutex"
import { KeteAudit } from "@opencode/core/kete/audit"
import { KeteModes } from "@opencode/core/kete/modes"
import { KeteSandboxActions } from "@opencode/core/kete/sandbox/actions"
import { KeteWorkMode } from "@opencode/core/kete/work-mode"
import type { SessionSchema } from "@opencode/core/session/schema"

const profile = KeteModes.get("work")
const fs = {
  existsSafe: (value: string) => Effect.sync(() => nfs.existsSync(value)),
  resolve: (value: string) => Effect.sync(() => FSUtil.resolve(value)),
  readLink: (value: string) => Effect.try({ try: () => nfs.readlinkSync(value), catch: (error) => error }),
} as unknown as KeteWorkMode.Deps["fs"]

const ids = { work: "ses_work", child: "ses_child", orphan: "ses_orphan", code: "ses_code", codeChild: "ses_codechild" }
const id = (value: string) => value as SessionSchema.ID
const sessions: Record<string, unknown> = {
  [ids.work]: { id: ids.work, metadata: { "kete.sessionMode": "work" } },
  // A child created without metadata: only the root says it is Work.
  [ids.child]: { id: ids.child, parentID: ids.work },
  [ids.orphan]: { id: ids.orphan, parentID: "ses_gone" },
  [ids.code]: { id: ids.code },
  [ids.codeChild]: { id: ids.codeChild, parentID: ids.code },
}

let root: string
let data: string
let location: string
let sibling: string
let granted: string
let outside: string
const lines = (session = ids.work) => {
  const file = path.join(data, "audit", `${session}.jsonl`)
  return nfs.existsSync(file) ? nfs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
}

beforeAll(() => {
  root = nfs.realpathSync(nfs.mkdtempSync(path.join(os.tmpdir(), "kete-work-")))
  data = path.join(root, "data")
  location = path.join(root, "project", "work")
  sibling = path.join(root, "project", "sibling")
  granted = path.join(root, "granted")
  outside = path.join(root, "outside")
  for (const dir of [location, sibling, granted, outside, data]) nfs.mkdirSync(dir, { recursive: true })
  nfs.writeFileSync(path.join(location, "a.txt"), "a")
  nfs.writeFileSync(path.join(outside, "secret.txt"), "s")
  nfs.symlinkSync(outside, path.join(location, "link"))
})
afterAll(() => nfs.rmSync(root, { recursive: true, force: true }))

const deps = (platform: NodeJS.Platform = "linux"): KeteWorkMode.Deps => {
  const writer = KeteAudit.makeWriterState(data, KeyedMutex.makeUnsafe<string>())
  return {
    profile,
    platform,
    directory: location,
    session: (sessionID) => Effect.succeed(Option.fromNullishOr(sessions[sessionID] as SessionSchema.Info | undefined)),
    roots: () => Effect.succeed([location, granted]),
    fs,
    audit: (target, line) => KeteAudit.appendWork(writer, target, line),
    cache: new Map(),
    gated: new Set(),
  }
}

const evaluate = async (
  d: KeteWorkMode.Deps,
  session: string,
  action: string,
  resources: string[],
  effect: PermissionEvaluation["effect"] = "allow",
  metadata?: Record<string, unknown>,
  call?: string,
) => {
  const source = call === undefined ? undefined : { type: "tool", messageID: "msg_1", id: call }
  const event = { sessionID: id(session), action, resources, effect, metadata, source } as PermissionEvaluation
  await Effect.runPromise(KeteWorkMode.onEvaluate(d, event))
  return event
}

const before = (d: KeteWorkMode.Deps, session: string, tool: string, input: unknown) =>
  Effect.runPromiseExit(
    KeteWorkMode.onToolBefore(d, { tool, sessionID: id(session), agent: "a", messageID: "msg_1", id: "call_1", input } as unknown as ToolHooks["execute.before"]),
  )

describe("work mode files", () => {
  const cases: Array<[string, string, string, boolean]> = [
    // [name, action, resource, allowed]
    ["a file in the location", "read", "a.txt", true],
    ["a new file in a new folder of the location", "edit", "new/dir/f.txt", true],
    ["a granted folder's file", "read", path.join(granted, "f.txt"), true],
    ["a sibling folder of the project", "read", "../sibling/x.txt", false],
    ["an absolute path outside", "read", path.join(outside, "secret.txt"), false],
    ["a ../ path out", "edit", "../x.txt", false],
    ["a symlink inside leading outside", "read", "link/secret.txt", false],
    ["a new file through a symlink leading outside", "edit", "link/new.txt", false],
    ["a granted directory", "external_directory", path.join(granted, "*"), true],
    ["an outside directory", "external_directory", path.join(outside, "*"), false],
    ["the file-system root", "external_directory", "/*", false],
    ["a sibling directory", "external_directory", path.join(sibling, "*"), false],
  ]
  for (const [name, action, resource, allowed] of cases) {
    test(`files: ${name} is ${allowed ? "allowed" : "denied"}; a Code session is untouched`, async () => {
      const d = deps()
      const work = await evaluate(d, ids.work, action, [resource], "ask")
      expect(work.effect).toBe(allowed ? "ask" : "deny")
      // The same for a child that has no metadata of its own.
      expect((await evaluate(d, ids.child, action, [resource])).effect).toBe(allowed ? "allow" : "deny")
      expect((await evaluate(d, ids.code, action, [resource], "ask")).effect).toBe("ask")
      expect((await evaluate(d, ids.codeChild, action, [resource])).effect).toBe("allow")
    })
  }

  test("files: one outside resource among allowed ones denies the request; an earlier deny stays", async () => {
    const d = deps()
    expect((await evaluate(d, ids.work, "read", ["a.txt", "../sibling/x"])).effect).toBe("deny")
    const denied = await evaluate(d, ids.work, "read", ["a.txt"], "deny")
    expect(denied.message).toBeUndefined()
  })

  test("files: a session that can't be resolved is Work (fails closed)", async () => {
    const d = deps()
    expect((await evaluate(d, ids.orphan, "read", ["../sibling/x"])).effect).toBe("deny")
    expect((await evaluate(d, "ses_missing", "read", ["../sibling/x"])).effect).toBe("deny")
  })

  test("files: a chain deeper than the limit is Work", async () => {
    const d = deps()
    const chain: Record<string, unknown> = {}
    for (let index = 0; index < 40; index++) chain[`ses_d${index}`] = { id: `ses_d${index}`, parentID: `ses_d${index + 1}` }
    chain.ses_d40 = { id: "ses_d40" }
    const deep: KeteWorkMode.Deps = { ...d, session: (sessionID) => Effect.succeed(Option.fromNullishOr(chain[sessionID] as SessionSchema.Info | undefined)) }
    expect((await Effect.runPromise(KeteWorkMode.resolveFamily(deep, id("ses_d0")))).work).toBe(true)
  })

  test("files: glob, grep and shell paths are checked", async () => {
    const d = deps()
    const refused = async (tool: string, input: unknown) => Exit.isFailure(await before(d, ids.work, tool, input))
    expect(await refused("glob", { pattern: "*.ts" })).toBe(false)
    expect(await refused("glob", { pattern: "*.ts", path: "src" })).toBe(false)
    expect(await refused("glob", { pattern: "*.ts", path: "../sibling" })).toBe(true)
    expect(await refused("glob", { pattern: "*.ts", path: "link" })).toBe(true)
    expect(await refused("glob", { pattern: "*.ts", path: 5 })).toBe(true)
    expect(await refused("glob", { pattern: "/etc/*" })).toBe(true)
    expect(await refused("glob", { pattern: "../**/*.ts" })).toBe(true)
    expect(await refused("glob", { pattern: "{src,/etc}/*" })).toBe(true)
    expect(await refused("grep", { pattern: "../x" })).toBe(false) // a regex, not a path
    expect(await refused("grep", { pattern: "x", path: outside })).toBe(true)
    expect(await refused("grep", { pattern: "x", include: "../**" })).toBe(true)
    expect(await refused("shell", { command: "python a.py", workdir: outside })).toBe(true)
    expect(await refused("shell", { command: "python a.py", workdir: "link" })).toBe(true)
    expect(await refused("shell", { command: "python a.py", workdir: granted })).toBe(false)
    // Code: nothing is checked.
    expect(Exit.isFailure(await before(d, ids.code, "glob", { pattern: "*", path: outside }))).toBe(false)
  })
})

describe("work mode shell", () => {
  const allowed = [
    "python script.py",
    "python3 -c 'print(1)'",
    "node a.js | python b.py",
    "python a.py 2>&1",
    "python a.py && node b.js; python c.py",
    'python "a b.py"',
  ]
  const refused = [
    "",
    "   ",
    "ls",
    "cat a.txt",
    "git status",
    "sh -c 'python a.py'",
    "bash -c ls",
    "env python a.py",
    "sudo python a.py",
    "xargs python",
    "eval python",
    "curl https://example.com",
    "cd .. && python a.py",
    "python a.py > out.txt",
    "python a.py >> out.txt",
    "python a.py &> out.txt",
    "python $(whoami)",
    "python `whoami`",
    "python <<EOF\nx\nEOF",
    "python 'unbalanced",
    "FOO=1 python a.py",
    "./python a.py",
    "/usr/bin/python a.py",
    "$X a.py",
    "py* a.py",
    "{python,ls} a.py",
    "python a.py && ls",
    "python a.py | sh",
    "python a.py; curl x",
    "(python a.py)",
    "r\\m x",
  ]
  for (const command of allowed)
    test(`shell: ${JSON.stringify(command)} may run`, () => expect(KeteWorkMode.shellGate(command, profile, "linux")).toBeUndefined())
  for (const command of refused)
    test(`shell: ${JSON.stringify(command)} is refused`, () => expect(KeteWorkMode.shellGate(command, profile, "linux")).toBeString())

  test("shell: nothing runs on Windows while the profile says so", () => {
    expect(KeteWorkMode.shellGate("python a.py", profile, "win32")).toMatch(/Windows/)
    expect(KeteWorkMode.shellGate("python a.py", { ...profile, shell: { ...profile.shell, windows: "same" } }, "win32")).toBeUndefined()
    expect(KeteWorkMode.shellGate("python a.py", { ...profile, shell: { ...profile.shell, run: "off" } }, "linux")).toBeString()
  })

  test("shell: git and gh need the profile's git flag", () => {
    const git = { ...profile, shell: { ...profile.shell, allow: ["git", "gh", "python"] } }
    expect(KeteWorkMode.shellGate("git status", git, "linux")).toBeString()
    expect(KeteWorkMode.shellGate("gh pr list", git, "linux")).toBeString()
    expect(KeteWorkMode.shellGate("git status", { ...git, git: true }, "linux")).toBeUndefined()
  })

  test("shell: the tool hook refuses a command, a sandbox request, and does so only in Work", async () => {
    const d = deps()
    const exit = (session: string, input: unknown) => before(d, session, "shell", input)
    expect(Exit.isFailure(await exit(ids.work, { command: "python a.py" }))).toBe(false)
    expect(Exit.isFailure(await exit(ids.child, { command: "ls" }))).toBe(true)
    expect(Exit.isFailure(await exit(ids.work, { command: "python a.py", sandbox: "network" }))).toBe(true)
    expect(Exit.isFailure(await exit(ids.work, { command: "python a.py", sandbox: "off" }))).toBe(true)
    expect(Exit.isFailure(await exit(ids.work, {}))).toBe(true)
    expect(Exit.isFailure(await exit(ids.work, { command: 5 }))).toBe(true)
    expect(Exit.isFailure(await before(deps("win32"), ids.work, "shell", { command: "python a.py" }))).toBe(true)
    expect(Exit.isFailure(await exit(ids.code, { command: "ls", sandbox: "off" }))).toBe(false)
    expect(Exit.isFailure(await exit(ids.codeChild, { command: "ls" }))).toBe(false)
  })
})

describe("work mode tools", () => {
  const permitted = ["read", "glob", "grep", "edit", "write", "patch", "todowrite", "skill", "subagent", "question", "present_plan", "shell", "webfetch", "websearch"]
  const denied = [
    "worktree_create",
    "worktree_list",
    "worktree_remove",
    "session_move",
    "memory",
    "workflow",
    "artifact_create",
    "schedule",
    "models",
    "list_mcp_resources",
    "read_mcp_resource",
    "github_create_issue",
    "some_future_tool",
    "",
  ]
  for (const tool of permitted)
    test(`tools: ${tool} is allowed`, async () => {
      expect(Exit.isFailure(await before(deps(), ids.work, tool, tool === "shell" ? { command: "python a.py" } : {}))).toBe(false)
    })
  for (const tool of denied)
    test(`tools: ${JSON.stringify(tool)} is refused in Work and runs in Code`, async () => {
      const d = deps()
      expect(Exit.isFailure(await before(d, ids.work, tool, {}))).toBe(true)
      expect(Exit.isFailure(await before(d, ids.child, tool, {}))).toBe(true)
      expect(Exit.isFailure(await before(d, ids.code, tool, {}))).toBe(false)
    })

  test("tools: the allowlist follows the profile (web off, shell off)", () => {
    expect(KeteWorkMode.allowedTools({ ...profile, web: false }).has("webfetch")).toBe(false)
    expect(KeteWorkMode.allowedTools({ ...profile, shell: { ...profile.shell, run: "off" } }).has("shell")).toBe(false)
    expect(KeteWorkMode.allowedTools(profile).has("webfetch")).toBe(true)
  })

  test("tools: filterTools leaves only the allowlist", () => {
    const tools: Record<string, unknown> = { read: {}, shell: {}, memory: {}, github_x: {}, worktree_create: {} }
    KeteWorkMode.filterTools(profile, tools)
    expect(Object.keys(tools).sort()).toEqual(["read", "shell"])
  })
})

describe("work mode network", () => {
  test("network: shell requests are marked (the copy's mark reaches the original); sandbox escapes are denied", async () => {
    const d = deps()
    const original: Record<string, unknown> = { command: "python a.py" }
    const copy = KeteSandboxActions.linked({ ...original }, original)
    expect((await before(d, ids.work, "shell", { command: "python a.py" }))._tag).toBe("Success")
    await evaluate(d, ids.work, "shell", ["python a.py"], "ask", copy, "call_1")
    expect(KeteSandboxActions.work(copy)).toBe(true)
    expect(KeteSandboxActions.work(original)).toBe(true)
    for (const action of [KeteSandboxActions.off, KeteSandboxActions.network]) {
      expect((await evaluate(d, ids.work, action, ["python a.py"], "ask")).effect).toBe("deny")
      // Even the automatic escape (sandbox off or unavailable): Work refuses to run unsandboxed.
      expect((await evaluate(d, ids.work, action, ["python a.py"], "allow", { reason: "unavailable" })).effect).toBe("deny")
    }
    const code: Record<string, unknown> = { command: "ls" }
    await evaluate(d, ids.code, "shell", ["ls"], "allow", code)
    expect(KeteSandboxActions.work(code)).toBe(false)
    expect((await evaluate(d, ids.code, KeteSandboxActions.off, ["ls"], "ask")).effect).toBe("ask")
  })
})

describe("work mode shell and worktree escapes", () => {
  test("a shell request that isn't the gated shell tool call (a worktree setup script, a command) is refused", async () => {
    const d = deps()
    expect((await evaluate(d, ids.work, "shell", ["python a.py"], "allow")).effect).toBe("deny")
    expect((await evaluate(d, ids.work, "shell", ["./setup.sh"], "allow", {}, "call_unknown")).effect).toBe("deny")
    expect((await evaluate(d, ids.code, "shell", ["./setup.sh"], "allow")).effect).toBe("allow")
  })

  test("worktrees: the worktree action and a subagent asking for its own worktree are refused", async () => {
    const d = deps()
    expect((await evaluate(d, ids.work, "worktree", ["*"], "allow")).effect).toBe("deny")
    expect((await before(d, ids.work, "subagent", { agent: "a", prompt: "p", worktree: true }))._tag).toBe("Failure")
    const input: Record<string, unknown> = { agent: "a", prompt: "p", background: true }
    expect((await before(d, ids.work, "subagent", input))._tag).toBe("Success")
    expect(input.worktree).toBe(false)
    expect((await evaluate(d, ids.code, "worktree", ["*"], "allow")).effect).toBe("allow")
  })
})

describe("work mode audit", () => {
  test("audit: each refusal is a work_refusal line in the root's file, redacted", async () => {
    const d = deps()
    const secret = "ghp_" + "a".repeat(36)
    const session = "ses_audit_root"
    sessions[session] = { id: session, metadata: { "kete.sessionMode": "work" } }
    sessions.ses_audit_child = { id: "ses_audit_child", parentID: session }
    await before(d, "ses_audit_child", "github_create_issue", { title: secret })
    await before(d, session, "shell", { command: "ls" })
    await before(d, session, "glob", { pattern: "*", path: "../sibling" })
    await evaluate(d, session, "read", ["../sibling/x"])
    await evaluate(d, session, KeteSandboxActions.network, ["python a.py"])
    const written = lines(session)
    expect(written.map((line) => [line.type, line.rule, line.tool])).toEqual([
      ["work_refusal", "tool", "github_create_issue"],
      ["work_refusal", "shell", "shell"],
      ["work_refusal", "files", "glob"],
      ["work_refusal", "files", "read"],
      ["work_refusal", "network", KeteSandboxActions.network],
    ])
    expect(written[0]).toMatchObject({ v: 1, session_id: "ses_audit_child", root_id: session, message_id: "msg_1", tool_call_id: "call_1" })
    expect(written[0].message).toContain("Work mode")
    expect(JSON.stringify(written)).not.toContain(secret)
    // An allowed call writes nothing.
    await before(d, session, "read", {})
    expect(lines(session)).toHaveLength(5)
  })

  test("audit: a failed write is logged and the refusal stands", async () => {
    const d: KeteWorkMode.Deps = { ...deps(), audit: () => Effect.fail(new KeteAudit.WriteError({ path: "/x", code: "EACCES" })) }
    expect(Exit.isFailure(await before(d, ids.work, "memory", {}))).toBe(true)
    expect((await evaluate(d, ids.work, "read", ["../sibling/x"])).effect).toBe("deny")
  })

  test("audit: Code sessions write nothing", async () => {
    const d = deps()
    await before(d, ids.code, "memory", {})
    await evaluate(d, ids.code, "read", ["../sibling/x"])
    expect(lines(ids.code)).toHaveLength(0)
  })
})
