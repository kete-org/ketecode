// Config hooks (core/src/kete/hooks.ts, kete/hooks/*): settings per document (user vs project),
// matching, the fingerprint, output interpretation, the trust store, policy, and the plugin end to
// end with real shell commands: PreToolUse blocks (exit 2, JSON deny, failure, timeout), context
// for PostToolUse and UserPromptSubmit, SessionStart context as a synthetic message, Stop and
// Notification, project hooks only after trust (asked once, remembered, asked again on change,
// declined, never asked in an unattended run), and nothing in job mode.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer, PubSub, Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import type { Plugin } from "@opencode/plugin/effect"
import { KeteHooks } from "@opencode/core/kete/hooks"
import { KeteHooksRun } from "@opencode/core/kete/hooks/run"
import { KeteHooksSettings } from "@opencode/core/kete/hooks/settings"
import { KeteHooksTrust } from "@opencode/core/kete/hooks/trust"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { host } from "../plugin/host"

const posix = process.platform !== "win32"

describe("settings", () => {
  const globalDirectory = "/home/u/.config/kete"
  const docs = [
    { path: "/home/u/.config/kete/kete.json", hooks: { PreToolUse: [{ command: "user-check", match: "shell" }] } },
    { path: "/repo/kete.json", hooks: { PreToolUse: [{ command: "repo-check", timeout: 5 }], Stop: [{ command: "say done" }] } },
  ] as unknown as KeteHooksSettings.Document[]

  test("user and project hooks, in order, with defaults", () => {
    expect(KeteHooksSettings.collect(docs, globalDirectory)).toEqual([
      { event: "PreToolUse", command: "user-check", match: "shell", timeout: 60, source: "user" },
      { event: "PreToolUse", command: "repo-check", timeout: 5, source: "project" },
      { event: "Stop", command: "say done", timeout: 60, source: "project" },
    ])
  })

  test("the fingerprint covers exactly the project hooks", () => {
    const all = KeteHooksSettings.collect(docs, globalDirectory)
    const base = KeteHooksSettings.fingerprint(all)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(KeteHooksSettings.fingerprint(all.map((entry) => (entry.source === "user" ? { ...entry, command: "x" } : entry)))).toBe(base)
    expect(KeteHooksSettings.fingerprint(all.map((entry) => (entry.command === "say done" ? { ...entry, command: "say  done" } : entry)))).not.toBe(base)
    expect(KeteHooksSettings.fingerprint(all.map((entry) => (entry.timeout === 5 ? { ...entry, timeout: 6 } : entry)))).not.toBe(base)
  })

  test("matching by tool name", () => {
    expect(KeteHooksSettings.matches({}, "shell")).toBe(true)
    expect(KeteHooksSettings.matches({ match: "edit|write | patch" }, "patch")).toBe(true)
    expect(KeteHooksSettings.matches({ match: "mcp_*" }, "mcp_github_search")).toBe(true)
    expect(KeteHooksSettings.matches({ match: "shell" }, "shellx")).toBe(false)
  })

  test("a policy can turn hooks off", () => {
    expect(KeteHooksSettings.disabledByPolicy([{ action: "permission", resource: "hooks:*", effect: "deny" }], "Stop")).toBe(true)
    expect(KeteHooksSettings.disabledByPolicy([{ action: "permission", resource: "hooks:Stop", effect: "deny" }], "PreToolUse")).toBe(false)
    expect(
      KeteHooksSettings.disabledByPolicy(
        [
          { action: "permission", resource: "hooks:*", effect: "deny" },
          { action: "permission", resource: "hooks:Stop", effect: "allow" },
        ],
        "Stop",
      ),
    ).toBe(false)
  })
})

describe("output", () => {
  test("exit codes and JSON", () => {
    expect(KeteHooksRun.interpret(0, "", "")).toEqual({ kind: "ok" })
    expect(KeteHooksRun.interpret(0, "remember X\n", "")).toEqual({ kind: "ok", context: "remember X" })
    expect(KeteHooksRun.interpret(0, '{"decision":"deny","reason":"no"}', "")).toEqual({ kind: "ok", decision: "deny", reason: "no" })
    expect(KeteHooksRun.interpret(0, '{"context":"c","decision":"allow"}', "")).toEqual({ kind: "ok", decision: "allow", context: "c" })
    expect(KeteHooksRun.interpret(2, "", "not allowed\n")).toEqual({ kind: "deny", reason: "not allowed" })
    expect(KeteHooksRun.interpret(1, "", "boom")).toEqual({ kind: "error", message: "exited with 1: boom" })
    expect(KeteHooksRun.interpret(0, "x".repeat(KeteHooksRun.MAX_TEXT + 10), "").kind).toBe("ok")
    expect(KeteHooksRun.shell("echo hi", "win32", { ComSpec: "C:\\Windows\\cmd.exe" })).toEqual({
      file: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", '"(echo hi) < "%KETE_HOOK_INPUT%""'],
    })
    expect(KeteHooksRun.shell("echo hi", "linux")).toEqual({ file: "/bin/sh", args: ["-c", 'exec <"$KETE_HOOK_INPUT"\necho hi'] })
  })
})

describe("trust store", () => {
  test("remembers a fingerprint per repository; a bad file trusts nothing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kete-hooks-trust-"))
    try {
      const store = KeteHooksTrust.make(dir)
      const hash = "a".repeat(64)
      expect(await store.trusted("/repo", hash)).toBe(false)
      await store.trust("/repo", hash, ["make check"])
      expect(await store.trusted("/repo", hash)).toBe(true)
      expect(await store.trusted("/repo", "b".repeat(64))).toBe(false)
      expect(await store.trusted("/other", hash)).toBe(false)
      if (posix) expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600)
      await fs.writeFile(store.file, "{nope")
      expect(await store.trusted("/repo", hash)).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!posix)("the plugin with real commands", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function setup(options: {
    user?: Record<string, unknown>
    project?: Record<string, unknown>
    env?: Record<string, string | undefined>
    ask?: boolean
    unattended?: boolean
    policies?: Array<{ action: string; resource: string; effect: "allow" | "deny" }>
  }) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-hooks-test-")))
    const globalDir = path.join(dir, "config")
    const workspace = path.join(dir, "repo")
    const state = path.join(dir, "state")
    await fs.mkdir(workspace, { recursive: true })
    await fs.mkdir(globalDir, { recursive: true })
    const toolHooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
    const sessionHooks = new Map<string, (event: any) => Effect.Effect<unknown, unknown>>()
    const synthetic: Array<{ sessionID: string; text: string }> = []
    const asked: string[] = []
    const events = Effect.runSync(PubSub.unbounded<{ type: string; data: unknown }>())
    const ctx: Plugin.Context = host({
      tool: { hook: ((name: string, handler: any) => Effect.sync(() => void toolHooks.set(name, handler))) as any } as any,
      session: {
        hook: ((name: string, handler: any) => Effect.sync(() => void sessionHooks.set(name, handler))) as any,
        synthetic: ((input: { sessionID: string; text: string }) => Effect.sync(() => void synthetic.push(input))) as any,
      },
      event: { subscribe: () => Stream.fromPubSub(events) as any },
    })
    const location = new Location.Info({
      directory: AbsolutePath.make(workspace),
      project: { id: Project.ID.global, directory: AbsolutePath.make(workspace), canonical: AbsolutePath.make(workspace) },
    })
    const entries = [
      ...(options.user ? [{ type: "document", path: path.join(globalDir, "kete.json"), info: { kete: { hooks: options.user } } }] : []),
      ...(options.project
        ? [{ type: "document", path: path.join(workspace, "kete.json"), info: { kete: { hooks: options.project } } }]
        : []),
      ...(options.policies ? [{ type: "document", path: path.join(globalDir, "p.json"), info: { experimental: { policies: options.policies } } }] : []),
    ]
    let current: unknown[] = entries
    let answer = options.ask ?? true
    const plugin = KeteHooks.make({
      env: { PATH: process.env.PATH, HOME: dir, KETE_API_KEY: "secret-key", ...options.env },
      ask: (input) =>
        Effect.sync(() => {
          asked.push(KeteHooks.trustDescription(input.repository, input.entries))
          return answer
        }),
      unattended: () => Effect.succeed(options.unattended ?? false),
    })
    const layer = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        return Layer.mergeAll(
          Layer.succeed(Location.Service, location),
          Layer.succeed(Environment.Service, Environment.Service.of({ files: {} as any, spawner })),
          Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.sync(() => current) } as any)),
          Layer.succeed(ManagedPolicy.Service, ManagedPolicy.Service.of({ current: () => ({ statements: [] }), set: () => Effect.void } as any)),
          Layer.succeed(Global.Service, Global.Service.of({ config: globalDir, home: dir, state } as any)),
        )
      }).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node))),
    )
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(plugin.effect(ctx).pipe(Effect.provide(layer), Scope.provide(scope)) as Effect.Effect<void>)
    cleanups.push(async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await fs.rm(dir, { recursive: true, force: true })
    })
    const before = (tool: string, input: unknown = { command: "ls" }) =>
      Effect.runPromiseExit(toolHooks.get("execute.before")!({ tool, sessionID: "ses_1", input }))
    const after = async (tool: string, text = "done") => {
      const event: any = { tool, sessionID: "ses_1", status: "completed", input: {}, result: { content: [{ type: "text", text }] } }
      await Effect.runPromise(toolHooks.get("execute.after")!(event))
      return event.result.content.map((item: { text: string }) => item.text).join("\n")
    }
    const prompt = async (text: string) => {
      const event: any = { sessionID: "ses_1", prompt: { text } }
      await Effect.runPromise(sessionHooks.get("prompt")!(event))
      return event.prompt.text as string
    }
    const emit = (type: string, data: unknown) => Effect.runPromise(PubSub.publish(events, { type, data }))
    const file = (name: string) => path.join(dir, name)
    const waitFor = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return {
      before,
      after,
      prompt,
      emit,
      file,
      waitFor,
      asked,
      synthetic,
      toolHooks,
      setAnswer: (value: boolean) => (answer = value),
      setProject: (hooks: Record<string, unknown>) => {
        current = [
          ...entries.filter((entry) => !entry.path.startsWith(workspace)),
          { type: "document", path: path.join(workspace, "kete.json"), info: { kete: { hooks } } },
        ]
      },
    }
  }

  const message = (exit: Exit.Exit<unknown, unknown>) => JSON.stringify(exit)

  test("PreToolUse: exit 2 and JSON deny block with the reason; matching by tool; the payload on stdin", async () => {
    const h = await setup({
      user: {
        PreToolUse: [
          { match: "shell", command: `cat > "${"$"}KETE_PROJECT_DIR/../payload.json"; echo "no shell today" >&2; exit 2` },
          { match: "write", command: `echo '{"decision":"deny","reason":"read-only Friday"}'` },
        ],
      },
    })
    const blocked = await h.before("shell", { command: "rm -rf build" })
    expect(Exit.isFailure(blocked)).toBe(true)
    expect(message(blocked)).toContain("Blocked by a PreToolUse hook: no shell today")
    const payload = JSON.parse(await fs.readFile(h.file("payload.json"), "utf8"))
    expect(payload).toMatchObject({ event: "PreToolUse", session_id: "ses_1", tool: "shell", tool_input: { command: "rm -rf build" } })
    expect(message(await h.before("write"))).toContain("read-only Friday")
    expect(Exit.isSuccess(await h.before("read"))).toBe(true)
  })

  test("PreToolUse fails closed: a failing or slow hook blocks", async () => {
    const failing = await setup({ user: { PreToolUse: [{ command: "exit 7" }] } })
    expect(message(await failing.before("read"))).toContain("exited with 7")
    const slow = await setup({ user: { PreToolUse: [{ command: "sleep 5", timeout: 1 }] } })
    const started = Date.now()
    expect(message(await slow.before("read"))).toContain("timed out after 1 s")
    expect(Date.now() - started).toBeLessThan(4500)
  }, 15_000)

  test("PostToolUse and UserPromptSubmit add context; credentials stay out of the environment", async () => {
    const h = await setup({
      user: {
        PostToolUse: [{ match: "edit", command: `echo "lint: 2 warnings"; env > "${"$"}KETE_PROJECT_DIR/../env.txt"` }],
        UserPromptSubmit: [{ command: `echo '{"context":"Branch: main"}'` }],
      },
    })
    expect(await h.after("edit")).toBe('done\n<hook event="PostToolUse">\nlint: 2 warnings\n</hook>')
    expect(await h.after("read")).toBe("done")
    expect(await h.prompt("fix it")).toBe('fix it\n\n<hook event="UserPromptSubmit">\nBranch: main\n</hook>')
    const env = await fs.readFile(h.file("env.txt"), "utf8")
    expect(env).toContain("KETE_HOOK_EVENT=PostToolUse")
    expect(env).not.toContain("secret-key")
  })

  test("SessionStart context becomes a synthetic message; Stop and Notification run", async () => {
    const h = await setup({
      user: {
        SessionStart: [{ command: "echo 'Use pnpm here.'" }],
        Stop: [{ command: `cat > "${"$"}KETE_PROJECT_DIR/../stop.json"` }],
        Notification: [{ command: `cat >> "${"$"}KETE_PROJECT_DIR/../notify.txt"` }],
      },
    })
    await h.emit("session.created", { sessionID: "ses_9", agent: "build" })
    await h.waitFor(async () => h.synthetic.length > 0)
    expect(h.synthetic).toEqual([{ sessionID: "ses_9", text: '<hook event="SessionStart">\nUse pnpm here.\n</hook>', resume: false } as any])
    await h.emit("session.execution.succeeded", { sessionID: "ses_9" })
    await h.emit("permission.asked", { sessionID: "ses_9", action: "shell" })
    await h.emit("form.created", { form: { sessionID: "ses_9", title: "Questions", metadata: { kind: "question" } } })
    await h.emit("form.created", { form: { sessionID: "ses_9", title: "x", metadata: { kind: KeteHooks.TRUST_FORM_KIND } } })
    const read = (name: string) => fs.readFile(h.file(name), "utf8").catch(() => "")
    const parses = (text: string) => {
      try {
        JSON.parse(text)
        return true
      } catch {
        return false
      }
    }
    await h.waitFor(async () => parses(await read("stop.json")) && (await read("notify.txt")).split("}{").length === 2)
    expect(JSON.parse(await read("stop.json"))).toMatchObject({ event: "Stop", session_id: "ses_9", status: "succeeded" })
    const notify = await read("notify.txt")
    expect(notify).toContain("Kete Code needs your permission: shell")
    expect(notify).toContain("Kete Code has a question: Questions")
  })

  test("project hooks run only after trust; asked once; asked again when they change", async () => {
    const h = await setup({ project: { PreToolUse: [{ command: "echo blocked >&2; exit 2" }] } })
    expect(message(await h.before("read"))).toContain("blocked")
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toContain("- PreToolUse: echo blocked >&2; exit 2")
    expect(message(await h.before("read"))).toContain("blocked")
    expect(h.asked).toHaveLength(1)
    h.setProject({ PreToolUse: [{ command: "echo changed >&2; exit 2" }] })
    h.setAnswer(false)
    expect(Exit.isSuccess(await h.before("read"))).toBe(true)
    expect(h.asked).toHaveLength(2)
    // Declined: not asked again in this process.
    expect(Exit.isSuccess(await h.before("read"))).toBe(true)
    expect(h.asked).toHaveLength(2)
  })

  test("declined project hooks don't run; user hooks still do", async () => {
    const h = await setup({
      ask: false,
      user: { PostToolUse: [{ command: "echo user" }] },
      project: { PostToolUse: [{ command: "echo project" }] },
    })
    expect(await h.after("edit")).toBe('done\n<hook event="PostToolUse">\nuser\n</hook>')
  })

  test("an unattended run never asks and skips untrusted project hooks", async () => {
    const h = await setup({ unattended: true, project: { PreToolUse: [{ command: "exit 2" }] } })
    expect(Exit.isSuccess(await h.before("read"))).toBe(true)
    expect(h.asked).toEqual([])
  })

  test("Stop and Notification never ask", async () => {
    const h = await setup({ project: { Stop: [{ command: "true" }] } })
    await h.emit("session.execution.succeeded", { sessionID: "ses_1" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.asked).toEqual([])
  })

  test("a policy denying hooks turns them off", async () => {
    const h = await setup({
      user: { PreToolUse: [{ command: "exit 2" }] },
      policies: [{ action: "permission", resource: "hooks:*", effect: "deny" }],
    })
    expect(Exit.isSuccess(await h.before("read"))).toBe(true)
  })

  test("job mode registers nothing", async () => {
    const h = await setup({ env: { OPENCODE_JOB_MODE: "1" }, user: { PreToolUse: [{ command: "exit 2" }] } })
    expect(h.toolHooks.size).toBe(0)
  })
})
