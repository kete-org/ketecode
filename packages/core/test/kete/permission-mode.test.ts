import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Agent } from "@opencode/core/agent"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import type { SessionSchema } from "@opencode/core/session/schema"

type Mode = KetePermissionMode.Mode
type Decision = Permission.Rule["effect"]

const upstreamDefault: Permission.Ruleset = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
]

function fakeSession(input: {
  id: string
  parentID?: string
  agent?: string
  metadata?: Record<string, unknown>
  permissions?: Permission.Ruleset
}): SessionSchema.Info {
  return {
    id: Session.ID.make(input.id),
    parentID: input.parentID === undefined ? undefined : Session.ID.make(input.parentID),
    agent: input.agent,
    metadata: input.metadata,
    permissions: input.permissions,
  } as unknown as SessionSchema.Info // only the fields KetePermissionMode reads
}

function lookup(input: {
  sessions: SessionSchema.Info[]
  rules?: Permission.Ruleset
  approved?: Permission.Ruleset
  fallback?: Mode
  buildChanged?: Set<string>
}): KetePermissionMode.Lookup {
  const byID = new Map(input.sessions.map((session) => [session.id as string, session]))
  return {
    session: (id) => Effect.succeed(Option.fromNullishOr(byID.get(id))),
    agent: () =>
      Effect.succeed({ id: Agent.ID.make("build"), permissions: input.rules ?? upstreamDefault } as unknown as Agent.Info),
    approved: Effect.succeed(input.approved ?? []),
    fallback: input.fallback ?? "default",
    protectedRoots: ["/home/me/.config/kete", "/home/me/.local/share/kete"],
    buildChanged: input.buildChanged ?? new Set(),
  }
}

const run = (
  look: KetePermissionMode.Lookup,
  action: string,
  resources: string[],
  effect: Decision = "allow",
  sessionID = "ses_root",
  metadata?: Record<string, unknown>,
) =>
  Effect.runSync(
    Effect.gen(function* () {
      const event = { sessionID: Session.ID.make(sessionID), action, resources, metadata, effect, message: undefined as string | undefined }
      yield* KetePermissionMode.apply(look, event)
      return event
    }),
  )

const decision = (mode: Mode | undefined, action: string, resource: string, extra?: Partial<Parameters<typeof lookup>[0]>) =>
  run(
    lookup({
      sessions: [fakeSession({ id: "ses_root", metadata: mode === undefined ? undefined : { [KetePermissionMode.metadataKey]: mode } })],
      ...extra,
    }),
    action,
    [resource],
  ).effect

describe("KetePermissionMode modes", () => {
  // [action, resource, default, accept-edits, auto, ask, plan]
  const table: ReadonlyArray<readonly [string, string, Decision, Decision, Decision, Decision, Decision]> = [
    ["read", "src/a.ts", "allow", "allow", "allow", "allow", "allow"],
    ["grep", "*", "allow", "allow", "allow", "allow", "allow"],
    ["edit", "src/a.ts", "allow", "allow", "allow", "ask", "deny"],
    ["shell", "ls -la", "allow", "allow", "allow", "ask", "allow"],
    ["shell", "git status", "allow", "allow", "allow", "ask", "allow"],
    ["shell", "npm test", "allow", "allow", "allow", "ask", "deny"],
    ["shell", "git commit -m x", "ask", "ask", "allow", "ask", "deny"],
    ["shell", "mkdir src/x", "ask", "ask", "allow", "ask", "deny"],
    ["shell", "git push", "ask", "ask", "ask", "ask", "deny"],
    ["shell", "rm -rf build", "ask", "ask", "ask", "ask", "deny"],
    ["shell", "npm install left-pad", "ask", "ask", "ask", "ask", "deny"],
    ["shell", "curl https://example.com", "ask", "ask", "ask", "ask", "deny"],
    ["shell", "echo $(whoami)", "ask", "ask", "ask", "ask", "deny"],
    ["webfetch", "https://example.com", "ask", "ask", "allow", "ask", "ask"],
    ["websearch", "effect schema", "ask", "ask", "allow", "ask", "ask"],
  ]
  const modes = ["default", "accept-edits", "auto", "ask", "plan"] as const
  for (const [action, resource, ...expected] of table) {
    modes.forEach((mode, index) => {
      test(`${mode}: ${action} ${resource} -> ${expected[index]}`, () => {
        expect(decision(mode, action, resource)).toBe(expected[index]!)
      })
    })
  }

  test("a session without a mode uses the fallback (KETE_PERMISSION_MODE), else default", () => {
    expect(decision(undefined, "shell", "git commit -m x")).toBe("ask")
    expect(decision(undefined, "shell", "git commit -m x", { fallback: "auto" })).toBe("allow")
    expect(decision(undefined, "edit", "src/a.ts", { fallback: "ask" })).toBe("ask")
    // A session's own mode wins over the fallback; an unknown value isn't a mode.
    expect(decision("default", "edit", "src/a.ts", { fallback: "ask" })).toBe("allow")
    expect(KetePermissionMode.parse("yolo")).toBeUndefined()
    expect(KetePermissionMode.parse("accept-edits")).toBe("accept-edits")
  })

  test("never loosens: deny stays deny and ask stays ask in every mode", () => {
    for (const mode of modes) {
      const look = lookup({ sessions: [fakeSession({ id: "ses_root", metadata: { [KetePermissionMode.metadataKey]: mode } })] })
      expect(run(look, "shell", ["ls"], "deny").effect).toBe("deny")
      expect(run(look, "edit", ["src/a.ts"], "deny").effect).toBe("deny")
      expect(run(look, "shell", ["ls"], "ask").effect).toBe("ask")
      expect(run(look, "webfetch", ["https://x"], "ask").effect).toBe("ask")
      expect(run(look, "external_directory", ["/tmp/x"], "ask").effect).toBe("ask")
    }
  })

  test("plan mode denies a command even when it would only have asked", () => {
    const look = lookup({ sessions: [fakeSession({ id: "ses_root", metadata: { [KetePermissionMode.metadataKey]: "plan" } })] })
    const event = run(look, "shell", ["git push"], "ask")
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("Plan mode is read-only")
  })

  test("a request asks if any of its commands asks", () => {
    const look = lookup({ sessions: [fakeSession({ id: "ses_root" })] })
    expect(run(look, "shell", ["git status", "npm test"]).effect).toBe("allow")
    const event = run(look, "shell", ["git status", "git push"])
    expect(event.effect).toBe("ask")
    expect(event.message).toContain("High-risk command")
    expect(event.message).toContain("git push")
  })

  test("an explicit allow rule is kept: users and organizations can loosen the defaults", () => {
    const rules: Permission.Ruleset = [
      ...upstreamDefault,
      { action: "shell", resource: "git push*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
    ]
    expect(decision("default", "shell", "git push origin main", { rules })).toBe("allow")
    expect(decision("default", "webfetch", "https://example.com", { rules })).toBe("allow")
    // Other commands still get the defaults.
    expect(decision("default", "shell", "git reset --hard", { rules })).toBe("ask")
    // "ask" and "plan" are explicit choices too, and win over an explicit allow.
    expect(decision("ask", "shell", "git push", { rules })).toBe("ask")
    expect(decision("plan", "shell", "git push", { rules })).toBe("deny")
  })

  test("a whole-action allow (`\"shell\": \"allow\"`) is explicit too", () => {
    const rules: Permission.Ruleset = [...upstreamDefault, { action: "shell", resource: "*", effect: "allow" }]
    expect(decision("default", "shell", "rm -rf build", { rules })).toBe("allow")
  })

  test("a saved \"always\" approval is kept for an ordinary command", () => {
    const approved: Permission.Ruleset = [{ action: "shell", resource: "git commit *", effect: "allow" }]
    expect(decision("default", "shell", "git commit -m x", { approved })).toBe("allow")
    // Upstream's wildcard treats a trailing " *" as optional, so the approval covers bare `git commit`.
    expect(decision("default", "shell", "git commit", { approved })).toBe("allow")
    expect(decision("default", "shell", "git reset --hard", { approved })).toBe("ask")
  })

  test("a saved approval never covers a high-risk command or one that runs anything", () => {
    const approved: Permission.Ruleset = [
      { action: "shell", resource: "git push *", effect: "allow" },
      { action: "shell", resource: "node *", effect: "allow" },
      { action: "shell", resource: "bash *", effect: "allow" },
    ]
    expect(decision("default", "shell", "git push origin main", { approved })).toBe("ask")
    expect(decision("default", "shell", "node -e 'x'", { approved })).toBe("ask")
    expect(decision("default", "shell", "bash -c 'ls'", { approved })).toBe("ask")
    // Only a configured rule can loosen a high-risk command.
    const rules: Permission.Ruleset = [...upstreamDefault, { action: "shell", resource: "git push *", effect: "allow" }]
    expect(decision("default", "shell", "git push origin main", { rules })).toBe("allow")
  })

  test("session rules count as explicit", () => {
    const look = lookup({
      sessions: [fakeSession({ id: "ses_root", permissions: [{ action: "shell", resource: "rm *", effect: "allow" }] })],
    })
    expect(run(look, "shell", ["rm build/x"]).effect).toBe("allow")
  })

  test("subagents use the root session's mode, even with their own copy of an older one", () => {
    const look = lookup({
      sessions: [
        fakeSession({ id: "ses_root", metadata: { [KetePermissionMode.metadataKey]: "plan" } }),
        fakeSession({ id: "ses_child", parentID: "ses_root", metadata: { [KetePermissionMode.metadataKey]: "auto" } }),
        fakeSession({ id: "ses_grandchild", parentID: "ses_child" }),
      ],
    })
    expect(run(look, "edit", ["src/a.ts"], "allow", "ses_child").effect).toBe("deny")
    expect(run(look, "edit", ["src/a.ts"], "allow", "ses_grandchild").effect).toBe("deny")
  })

  test("unattended runs keep their own policy: safe defaults don't apply, explicit ask/plan still tighten", () => {
    const unattended = { "kete.unattended": { version: 1 } }
    const plain = lookup({ sessions: [fakeSession({ id: "ses_root", metadata: unattended })] })
    expect(run(plain, "shell", ["git push"]).effect).toBe("allow")
    expect(run(plain, "webfetch", ["https://x"]).effect).toBe("allow")
    const planned = lookup({
      sessions: [fakeSession({ id: "ses_root", metadata: { ...unattended, [KetePermissionMode.metadataKey]: "plan" } })],
    })
    expect(run(planned, "edit", ["src/a.ts"]).effect).toBe("deny")
  })

  test("an unknown session uses the fallback mode", () => {
    const look = lookup({ sessions: [] })
    expect(run(look, "edit", ["src/a.ts"], "allow", "ses_missing").effect).toBe("allow")
    expect(run(look, "shell", ["git push"], "allow", "ses_missing").effect).toBe("ask")
  })

  describe("PR #20 review: self-escalation and laundering", () => {
    const withMode = (mode: Mode, extra?: Partial<Parameters<typeof lookup>[0]>) =>
      lookup({ sessions: [fakeSession({ id: "ses_root", metadata: { [KetePermissionMode.metadataKey]: mode } })], ...extra })

    test("B1: editing Kete Code's configuration, agents or .git always asks (Plan denies), even with an explicit allow", () => {
      const rules: Permission.Ruleset = [...upstreamDefault, { action: "edit", resource: "*", effect: "allow" }]
      for (const file of [".kete/kete.jsonc", ".kete/agent/x.md", ".kete/skill/s/SKILL.md", "kete.json", ".git/config", ".git/hooks/pre-commit", "/home/me/.config/kete/kete.json", "/home/me/.local/share/kete/auth.json"]) {
        for (const mode of ["default", "accept-edits", "auto", "ask"] as const) {
          const event = run(withMode(mode, { rules }), "edit", [file])
          expect([mode, file, event.effect]).toEqual([mode, file, "ask"])
        }
        expect(run(withMode("plan"), "edit", [file]).effect).toBe("deny")
      }
      expect(run(withMode("auto"), "edit", ["src/a.ts"]).effect).toBe("allow")
      expect(run(withMode("default"), "edit", [".gitignore"]).effect).toBe("allow")
    })

    test("B2: editing a build/test entry point asks in Default and Accept-edits, unless a rule allows it", () => {
      expect(run(withMode("default"), "edit", ["package.json"]).effect).toBe("ask")
      expect(run(withMode("accept-edits"), "edit", ["vitest.config.ts"]).effect).toBe("ask")
      expect(run(withMode("default"), "edit", ["tests/conftest.py"]).effect).toBe("ask")
      expect(run(withMode("auto"), "edit", ["package.json"]).effect).toBe("allow")
      expect(run(withMode("default"), "edit", ["src/index.test.ts"]).effect).toBe("allow")
      const rules: Permission.Ruleset = [...upstreamDefault, { action: "edit", resource: "package.json", effect: "allow" }]
      expect(run(withMode("default", { rules }), "edit", ["package.json"]).effect).toBe("allow")
    })

    test("B2: after an entry point is edited, the next test/build command asks once", () => {
      const changed = new Set<string>()
      const look = withMode("default", { buildChanged: changed })
      expect(run(look, "shell", ["npm test"]).effect).toBe("allow")
      run(look, "edit", ["package.json"])
      expect(changed.has("ses_root")).toBe(true)
      const event = run(look, "shell", ["npm test"])
      expect(event.effect).toBe("ask")
      expect(event.message).toContain("build or test setup")
      expect(run(look, "shell", ["npm test"]).effect).toBe("allow")
      // A denied edit (Plan) doesn't count.
      const planned = new Set<string>()
      run(withMode("plan", { buildChanged: planned }), "edit", ["package.json"])
      expect(planned.size).toBe(0)
    })

    test("S1: a command line that leaves the workspace with cd asks (Plan denies)", () => {
      const meta = { command: "cd && cat Documents/secret.txt" }
      expect(run(withMode("default"), "shell", ["cat Documents/secret.txt"], "allow", "ses_root", meta).effect).toBe("ask")
      expect(run(withMode("auto"), "shell", ["cat Documents/secret.txt"], "allow", "ses_root", meta).effect).toBe("ask")
      expect(run(withMode("plan"), "shell", ["cat Documents/secret.txt"], "allow", "ses_root", meta).effect).toBe("deny")
      expect(run(withMode("default"), "shell", ["bun run test"], "allow", "ses_root", { command: "cd packages/core && bun run test" }).effect).toBe("allow")
    })

    test("S6: Plan mode denies MCP tools and worktrees, allows reads and subagents (which inherit Plan)", () => {
      expect(run(withMode("plan"), "github_create_issue", ["*"]).effect).toBe("deny")
      expect(run(withMode("plan"), "worktree", ["*"]).effect).toBe("deny")
      expect(run(withMode("plan"), "read", ["src/a.ts"]).effect).toBe("allow")
      expect(run(withMode("plan"), "subagent", ["explore"]).effect).toBe("allow")
      expect(run(withMode("plan"), "budget", ["*"], "ask").effect).toBe("ask")
      expect(run(withMode("default"), "github_create_issue", ["*"]).effect).toBe("allow")
    })

    test("S5: a saved approval for one web host is kept; other hosts still ask", () => {
      const approved: Permission.Ruleset = [
        { action: "webfetch", resource: "https://docs.example.com", effect: "allow" },
        { action: "webfetch", resource: "https://docs.example.com/*", effect: "allow" },
      ]
      expect(run(withMode("default", { approved }), "webfetch", ["https://docs.example.com/guide"]).effect).toBe("allow")
      expect(run(withMode("default", { approved }), "webfetch", ["https://docs.example.com.evil.test/x"]).effect).toBe("ask")
    })
  })
  describe("PR #20 re-review", () => {
    const withMode = (mode: Mode, extra?: Partial<Parameters<typeof lookup>[0]>) =>
      lookup({ sessions: [fakeSession({ id: "ses_root", metadata: { [KetePermissionMode.metadataKey]: mode } })], ...extra })

    test("SF4: npm pkg set / config set make the next test command ask once", () => {
      const changed = new Set<string>()
      const look = withMode("default", { buildChanged: changed })
      expect(run(look, "shell", ["npm pkg set scripts.test=id"]).effect).toBe("ask")
      expect(changed.has("ses_root")).toBe(true)
      expect(run(look, "shell", ["npm test"]).effect).toBe("ask")
      expect(run(look, "shell", ["npm test"]).effect).toBe("allow")
    })

    test("SF6: AGENTS.md and CLAUDE.md edits ask in Default but don't flag the build", () => {
      const changed = new Set<string>()
      expect(run(withMode("default", { buildChanged: changed }), "edit", ["AGENTS.md"]).effect).toBe("ask")
      expect(changed.size).toBe(0)
    })

    test("SF3: a symlink to .git is protected through its real path", () => {
      const look: KetePermissionMode.Lookup = {
        ...withMode("auto"),
        realpath: (value) => Effect.succeed(value.startsWith("cfg/") ? ".git/" + value.slice(4) : value),
      }
      expect(run(look, "edit", ["cfg/config"]).effect).toBe("ask")
      expect(run(look, "edit", ["src/a.ts"]).effect).toBe("allow")
    })

    test("nit: protected roots compare case-insensitively on macOS and Windows", () => {
      const event = run(withMode("auto"), "edit", ["/HOME/ME/.config/KETE/agent/x.md"])
      expect(event.effect).toBe(process.platform === "darwin" || process.platform === "win32" ? "ask" : "allow")
    })
  })
})
