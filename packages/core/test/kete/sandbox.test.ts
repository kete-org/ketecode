// Unit tests for the local OS sandbox (ADR 0013): settings precedence, the generated Seatbelt
// profile and bwrap arguments (escaping, ordering), the git hooksPath reader, the model-facing
// notice, the escape hook's decisions, and the approval marks the permission hooks leave.
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Agent } from "@opencode/core/agent"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { KeteSandbox } from "@opencode/core/kete/sandbox"
import { KeteSandboxActions } from "@opencode/core/kete/sandbox/actions"
import { KeteBubblewrap } from "@opencode/core/kete/sandbox/bubblewrap"
import type { Policy } from "@opencode/core/kete/sandbox/policy"
import { KeteSandboxResolve } from "@opencode/core/kete/sandbox/resolve"
import { KeteSeatbelt } from "@opencode/core/kete/sandbox/seatbelt"
import { KeteSandboxSettings } from "@opencode/core/kete/sandbox/settings"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import type { SessionSchema } from "@opencode/core/session/schema"

const GLOBAL = "/home/me/.config/kete"
const user = (sandbox: object) => ({ path: `${GLOBAL}/kete.jsonc`, sandbox: sandbox as never })
const project = (sandbox: object) => ({ path: "/work/repo/.kete/kete.jsonc", sandbox: sandbox as never })
const resolve = (documents: KeteSandboxSettings.Document[], env: Record<string, string> = {}) =>
  KeteSandboxSettings.resolve({ documents, globalDirectory: GLOBAL, env })

describe("sandbox settings", () => {
  test("defaults: auto, network for approved commands, caches writable, loopback reachable", () => {
    expect(resolve([])).toMatchObject({ mode: "auto", network: "approved", caches: true, loopback: true, ignored: [] })
    expect(resolve([project({ loopback: false })]).loopback).toBe(false)
    expect(resolve([user({ loopback: false }), project({ loopback: true })])).toMatchObject({ loopback: false, ignored: ["loopback true"] })
  })

  test("the user's global config and KETE_SANDBOX may loosen", () => {
    expect(resolve([user({ mode: "off", network: "all", allowWrite: ["~/.gradle"] })])).toMatchObject({
      mode: "off",
      modeSource: "global config",
      network: "all",
      allowWrite: ["~/.gradle"],
    })
    expect(resolve([], { [KeteSandboxSettings.variable]: "off" })).toMatchObject({ mode: "off", modeSource: "KETE_SANDBOX" })
  })

  test("a project config only tightens; loosening is ignored and reported", () => {
    const settings = resolve([
      project({ mode: "off", network: "all", caches: true, allowWrite: ["/"], allowRead: ["~/.ssh"], denyWrite: ["dist"] }),
    ])
    expect(settings).toMatchObject({ mode: "auto", network: "approved", allowWrite: [], allowRead: [], denyWrite: ["dist"] })
    expect(settings.ignored).toEqual(expect.arrayContaining(['mode "off"', 'network "all"', "allowWrite", "allowRead"]))
    expect(resolve([project({ mode: "required", network: "none", caches: false })])).toMatchObject({
      mode: "required",
      network: "none",
      caches: false,
    })
    // A project can turn the sandbox back on after the user turned it off.
    expect(resolve([user({ mode: "off" }), project({ mode: "auto" })]).mode).toBe("auto")
  })

  test("an invalid KETE_SANDBOX fails closed (required)", () => {
    expect(resolve([], { [KeteSandboxSettings.variable]: "of" })).toMatchObject({ mode: "required", invalid: "of" })
  })

  test("a document without a path counts as project configuration", () => {
    expect(resolve([{ sandbox: { mode: "off" } as never }]).mode).toBe("auto")
  })

  test("expand: ~, ~/ and relative paths", () => {
    expect(KeteSandboxSettings.expand("~", "/home/me", "/w")).toBe("/home/me")
    expect(KeteSandboxSettings.expand("~/.npm", "/home/me", "/w")).toBe("/home/me/.npm")
    expect(KeteSandboxSettings.expand("dist", "/home/me", "/w")).toBe("/w/dist")
    expect(KeteSandboxSettings.expand("/abs", "/home/me", "/w")).toBe("/abs")
  })
})

const policy = (overrides: Partial<Policy> = {}): Policy => ({
  workspace: "/work/repo",
  writable: ["/work/repo", "/tmp"],
  readOnly: ["/home/me/.config/kete"],
  gitDirectories: [],
  pinned: ["/work/repo/.git"],
  masked: ["/work/repo/kete.jsonc"],
  overlays: [{ source: "/home/me/.local/share/kete/tmp/x/exclude", target: "/work/repo/.git/info/exclude" }],
  hidden: [
    { path: "/home/me/.ssh", directory: true },
    { path: "/home/me/.netrc", directory: false },
  ],
  visible: ["/home/me/.ssh/known_hosts"],
  network: false,
  loopback: true,
  tmpfs: ["/tmp", "/var/tmp"],
  sockets: ["/work/repo", "/tmp/kete-sandbox-x"],
  ...overrides,
})

describe("Seatbelt profile", () => {
  test("paths are parameters, never profile text", () => {
    const evil = '/work/a") (allow file-write* (subpath "/")) ;'
    const built = KeteSeatbelt.profile(policy({ workspace: evil, writable: [evil] }))
    expect(built.profile).not.toContain("allow file-write* (subpath \"/\")")
    expect(built.profile).not.toContain(evil)
    expect(built.parameters.map(([, value]) => value)).toContain(evil)
    // The regex parameter for the workspace is escaped.
    expect(built.parameters.map(([, value]) => value)).toContain(KeteSeatbelt.escapeRegex(evil))
  })

  test("escapeRegex escapes every ERE metacharacter", () => {
    expect(KeteSeatbelt.escapeRegex("a.b*c+d?e(f)g[h]i{j}k|l^m$n\\o")).toBe("a\\.b\\*c\\+d\\?e\\(f\\)g\\[h\\]i\\{j\\}k\\|l\\^m\\$n\\\\o")
  })

  test("network rules only without network; Mach allowlist and AppleEvents always", () => {
    const off = KeteSeatbelt.profile(policy()).profile
    expect(off).toContain("(deny network-outbound)")
    expect(off).toContain('(allow network-outbound (remote ip "localhost:*"))')
    expect(KeteSeatbelt.profile(policy({ loopback: false })).profile).not.toContain('remote ip "localhost:*"')
    const on = KeteSeatbelt.profile(policy({ network: true })).profile
    expect(on).not.toContain("(deny network-outbound)")
    for (const text of [off, on]) {
      expect(text).toContain("(deny mach-lookup)")
      expect(text).toContain("(deny appleevent-send)")
      expect(text).toContain("(deny job-creation)")
      expect(text).not.toContain("com.apple.pasteboard")
      expect(text).not.toContain("launchservicesd")
    }
  })

  test("credential reads are denied, with exceptions after", () => {
    const text = KeteSeatbelt.profile(policy()).profile
    expect(text.indexOf("(deny file-read*")).toBeGreaterThan(-1)
    expect(text.indexOf("(allow file-read*")).toBeGreaterThan(text.indexOf("(deny file-read*"))
  })

  test("command: sandbox-exec -p profile -D… -- shell args", () => {
    const built = KeteSeatbelt.command(policy(), "/bin/zsh", ["-c", "echo hi"])
    expect(built.file).toBe("/usr/bin/sandbox-exec")
    expect(built.args[0]).toBe("-p")
    expect(built.args.slice(-4)).toEqual(["--", "/bin/zsh", "-c", "echo hi"])
    expect(built.args.filter((arg) => arg === "-D").length).toBeGreaterThan(0)
  })

  test("relative paths and control characters are refused", () => {
    expect(() => KeteSeatbelt.profile(policy({ writable: ["relative"] }))).toThrow()
    expect(() => KeteSeatbelt.profile(policy({ workspace: "/work/a\nb" }))).toThrow()
  })
})

describe("bwrap arguments", () => {
  test("namespaces, then writable, pinned and read-only binds in that order", () => {
    const args = KeteBubblewrap.args(policy(), "/work/repo/src")
    expect(args).toContain("--unshare-net")
    expect(args.slice(0, 4)).toEqual(["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc"])
    // The private /tmp comes before the workspace bound inside it.
    expect(args.join(" ")).toContain("--tmpfs /tmp")
    const index = (option: string, value: string) => args.findIndex((arg, i) => arg === option && args[i + 1] === value)
    expect(index("--bind", "/work/repo")).toBeLessThan(index("--bind", "/work/repo/.git"))
    expect(index("--bind", "/work/repo/.git")).toBeLessThan(index("--ro-bind", "/home/me/.config/kete"))
    expect(args.slice(-2)).toEqual(["--chdir", "/work/repo/src"])
  })

  test("hidden files get /dev/null, hidden directories a tmpfs made read-only after the exceptions", () => {
    const args = KeteBubblewrap.args(policy(), "/work/repo")
    expect(args.join(" ")).toContain("--ro-bind /dev/null /home/me/.netrc")
    expect(args.join(" ")).toContain("--ro-bind /dev/null /work/repo/kete.jsonc")
    expect(args.join(" ")).toContain("--ro-bind /home/me/.local/share/kete/tmp/x/exclude /work/repo/.git/info/exclude")
    const tmpfs = args.indexOf("--tmpfs")
    const visible = args.findIndex((arg, i) => arg === "--ro-bind" && args[i + 1] === "/home/me/.ssh/known_hosts")
    const remount = args.indexOf("--remount-ro")
    expect(tmpfs).toBeLessThan(visible)
    expect(visible).toBeLessThan(remount)
  })

  test("network shares the host's network namespace", () => {
    expect(KeteBubblewrap.args(policy({ network: true }), "/work/repo")).not.toContain("--unshare-net")
  })

  test("command puts -- before the shell", () => {
    const built = KeteBubblewrap.command("/usr/bin/bwrap", policy(), "/work/repo", "/bin/bash", ["-c", "true"])
    expect(built.file).toBe("/usr/bin/bwrap")
    expect(built.args.slice(-4)).toEqual(["--", "/bin/bash", "-c", "true"])
  })
})

describe("git hooksPath reader", () => {
  test("reads core.hooksPath, last one wins, ignores other sections and comments", () => {
    expect(KeteSandboxResolve.hooksPath("[core]\n\thooksPath = .husky/_\n")).toBe(".husky/_")
    expect(KeteSandboxResolve.hooksPath('[core]\n  hookspath = "a b" ; comment\n[core]\nhooksPath=c\n')).toBe("c")
    expect(KeteSandboxResolve.hooksPath('[remote "origin"]\nhooksPath = x\n')).toBeUndefined()
    expect(KeteSandboxResolve.hooksPath("# [core]\n# hooksPath = x\n")).toBeUndefined()
  })
})

describe("notice", () => {
  const sandboxed = (network: boolean): KeteSandbox.Outcome => ({ kind: "sandboxed", network })
  test("only when a sandboxed command failed the way the sandbox makes things fail", () => {
    expect(KeteSandbox.notice(sandboxed(false), 0, "Operation not permitted")).toBeUndefined()
    expect(KeteSandbox.notice(sandboxed(false), 1, "test failed: expected 2")).toBeUndefined()
    expect(KeteSandbox.notice(sandboxed(false), 1, "sh: .git/config: Operation not permitted")).toContain('"off"')
    expect(KeteSandbox.notice(sandboxed(false), 1, "getaddrinfo ENOTFOUND registry.npmjs.org")).toContain('"network"')
    expect(KeteSandbox.notice(sandboxed(true), 1, "EROFS: read-only file system")).toContain('"off"')
  })
  test("after a requested escape", () => {
    expect(KeteSandbox.notice({ kind: "unsandboxed", reason: "requested", detail: "" }, 0, "")).toContain("outside the OS sandbox")
    expect(KeteSandbox.notice({ kind: "unsandboxed", reason: "unavailable", detail: "" }, 1, "Operation not permitted")).toBeUndefined()
  })
})

describe("escape decisions", () => {
  test("requested escapes ask, Plan denies them, automatic ones pass", () => {
    expect(KeteSandbox.decide("default", "sandbox_off", ["make"], { command: "make", reason: "requested" })?.effect).toBe("ask")
    expect(KeteSandbox.decide("auto", "sandbox_network", ["npm test"], { command: "npm test" })?.effect).toBe("ask")
    expect(KeteSandbox.decide("plan", "sandbox_network", ["npm test"], {})?.effect).toBe("deny")
    expect(KeteSandbox.decide("plan", "sandbox_off", ["ls"], { reason: "unavailable" })).toBeUndefined()
    expect(KeteSandbox.decide("default", "sandbox_off", ["ls"], { reason: "disabled" })).toBeUndefined()
    expect(KeteSandbox.decide("default", "shell", ["ls"], {})).toBeUndefined()
    // A missing reason is treated as a request (asks), never as automatic.
    expect(KeteSandbox.decide("default", "sandbox_off", ["ls"], {})?.effect).toBe("ask")
  })
})

// Approval marks: set only by the last hook (KeteSandbox.ApprovalPlugin), from the final decision.
const upstreamDefault: Permission.Ruleset = [{ action: "*", resource: "*", effect: "allow" }]
function lookup(approved: Permission.Ruleset = [], mode?: KetePermissionMode.Mode): KetePermissionMode.Lookup {
  const session = {
    id: Session.ID.make("ses_root"),
    metadata: mode ? { [KetePermissionMode.metadataKey]: mode } : undefined,
  } as unknown as SessionSchema.Info
  return {
    session: () => Effect.succeed(Option.some(session)),
    agent: () => Effect.succeed({ id: Agent.ID.make("build"), permissions: upstreamDefault } as unknown as Agent.Info),
    approved: Effect.succeed(approved),
    fallback: "default",
    buildChanged: new Set(),
  }
}
type Event = { sessionID: ReturnType<typeof Session.ID.make>; action: string; resources: string[]; metadata: Record<string, unknown>; effect: Permission.Rule["effect"]; message?: string }
/** Runs hooks in order, as PluginHooks.trigger does, with the approval hook last. */
const pipeline = (look: KetePermissionMode.Lookup, action: string, resources: string[], between: Array<(event: Event) => void> = []) =>
  Effect.runSync(
    Effect.gen(function* () {
      const event: Event = { sessionID: Session.ID.make("ses_root"), action, resources, metadata: { command: resources.join(" && ") }, effect: "allow" }
      yield* KetePermissionMode.apply(look, event)
      for (const hook of between) hook(event)
      KeteSandboxActions.approve(event)
      return { effect: event.effect, approved: KeteSandboxActions.approved(event.metadata) }
    }),
  )

describe("approval marks", () => {
  test("a command that asks is marked; one the defaults allow is not", () => {
    expect(pipeline(lookup(), "shell", ["npm install"])).toEqual({ effect: "ask", approved: true })
    expect(pipeline(lookup(), "shell", ["npm test"])).toEqual({ effect: "allow", approved: false })
    expect(pipeline(lookup(), "shell", ["ls"])).toEqual({ effect: "allow", approved: false })
  })
  test("auto mode runs other commands without asking: not marked", () => {
    expect(pipeline(lookup([], "auto"), "shell", ["node script.js"])).toEqual({ effect: "allow", approved: false })
  })
  test("a saved Always allow grants running the command, not network", () => {
    const saved: Permission.Ruleset = [{ action: "shell", resource: "make serve", effect: "allow" }]
    expect(pipeline(lookup(saved), "shell", ["make serve"])).toEqual({ effect: "allow", approved: false })
  })
  test("a hook that turns ask into allow after permission-mode doesn't pass on network", () => {
    const loosen = (event: Event) => {
      if (event.effect === "ask") event.effect = "allow"
    }
    expect(pipeline(lookup(), "shell", ["npm install"], [loosen])).toEqual({ effect: "allow", approved: false })
  })
  test("a later deny is never marked; an unattended policy allow is", () => {
    const deny = (event: Event) => {
      event.effect = "deny"
    }
    expect(pipeline(lookup(), "shell", ["npm install"], [deny])).toEqual({ effect: "deny", approved: false })
    const policy = (event: Event) => KeteSandboxActions.markPolicyAllowed(event.metadata)
    expect(pipeline(lookup(), "shell", ["npm ci"], [policy, (event) => void (event.effect = "allow")]).approved).toBe(true)
  })
  test("sandbox actions are left to the sandbox's own hook, also in Plan", () => {
    expect(pipeline(lookup([], "plan"), "sandbox_off", ["ls"]).effect).toBe("allow")
  })
})

describe("sandboxed environment", () => {
  test("temp variables point at the private directory; agents only with network", () => {
    const env = { PATH: "/bin", TMPDIR: "/tmp", SSH_AUTH_SOCK: "/tmp/agent.sock", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" }
    const without = KeteSandbox.environment(env, "/tmp/kete-sandbox-x", false)
    expect(without).toMatchObject({ PATH: "/bin", TMPDIR: "/tmp/kete-sandbox-x", TMP: "/tmp/kete-sandbox-x", TEMP: "/tmp/kete-sandbox-x" })
    expect(without.SSH_AUTH_SOCK).toBeUndefined()
    expect(without.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
    expect(KeteSandbox.environment(env, "/t", true).SSH_AUTH_SOCK).toBe("/tmp/agent.sock")
  })
})
