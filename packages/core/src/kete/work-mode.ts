// Work mode enforcement (WS1 1.3, docs/tasks/2026-11-05-ws1-work-enforcement): a session whose root-most
// ancestor has `kete.sessionMode: "work"` is held to the Work profile (modes/work.jsonc). Code sessions
// pass through untouched. Deny by default, fail closed: a session that can't be resolved is Work.
//
// - Tools: an allowlist (`allowedTools`). Every other tool (MCP, worktree, memory, workflow, schedule,
//   artifacts, future plugin tools) is removed from each model request and refused at
//   `tool.execute.before`.
// - Files: every `read`, `edit` and `external_directory` resource must, by real path (symlinks followed),
//   be inside the location or a live `kete.dirs` folder. A sibling folder of the project is outside.
//   `glob`/`grep` paths, a shell `workdir` and absolute or `..` glob patterns are checked the same way.
// - Shell: only allowlisted programs (`shellGate`), no redirect to a file, no substitution or wrapper;
//   never on Windows while the profile says so; only inside the OS sandbox (`sandbox_off` is denied, so
//   an off or unavailable sandbox refuses the command) and never with network (the request is marked
//   with `KeteSandboxActions.markWork`; KeteSandbox.prepare reads it).
// - Audit: every refusal is appended to the root's audit file (`work_refusal`); a failed write is logged
//   and the refusal stands.
//
// Residual risk: an allowed interpreter (`python -c`, `node -e`, a script) can read any file the OS
// sandbox lets it read and write anywhere the sandbox makes writable: the project directory (sibling
// folders included) plus `kete.dirs`, not only the location. Network is off. Narrowing the sandbox to
// the location for Work sessions is left to WS2's grant store. Work refusal lines share the root's file
// with an unattended run's writer but use their own writer state (own per-root mutex).

export * as KeteWorkMode from "./work-mode.js"

import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import type { KeteModesRpc } from "@opencode/schema/kete/modes"
import { Tool } from "@opencode/schema/tool"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect, Option } from "effect"
import { FileAccess } from "../file-access.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Location } from "../location.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KeteAddDir } from "./add-dir.js"
import { KeteAudit } from "./audit.js"
import { KeteModes } from "./modes.js"
import { KeteRealPath } from "./real-path.js"
import { KeteSandboxActions } from "./sandbox/actions.js"
import { KeteSessionMode } from "./session-mode.js"
import { KeteShellRisk } from "./shell-risk.js"

const MAX_DEPTH = 32
const MAX_CACHE = 1000

type Rule = KeteAudit.WorkRefusalLine["rule"]

/** Tools every Work session has (whatever the profile); the shell and web tools depend on it. */
const BASE_TOOLS = ["read", "glob", "grep", "edit", "write", "patch", "todowrite", "skill", "subagent", "question", "present_plan"]

/** The only tools a Work session has. MCP is never included, whatever `profile.mcp` says (fail closed). */
export function allowedTools(profile: KeteModesRpc.Profile): ReadonlySet<string> {
  const tools = new Set(BASE_TOOLS)
  if (profile.shell.run !== "off") tools.add("shell")
  if (profile.web) for (const tool of ["webfetch", "websearch"]) tools.add(tool)
  return tools
}

export const toolRefusal = (tool: string) => `Work mode: the ${tool} tool is not available.`
export const filesRefusal = "Work mode: this path is outside the folders you granted."
export const sandboxRefusal = "Work mode: commands run only inside the sandbox, without network."

/** Drops every tool Work mode doesn't allow from a model request's tool list. */
export function filterTools(profile: KeteModesRpc.Profile, tools: Record<string, unknown>) {
  const allowed = allowedTools(profile)
  for (const tool of Object.keys(tools)) if (!allowed.has(tool)) delete tools[tool]
}

/**
 * Why a command may not run in Work mode, or `undefined` when it may. Both tokenizer readings (POSIX
 * and Windows-shell backslashes) must parse and pass: the tokenizer fails closed on substitution,
 * subshells, heredocs and unbalanced quotes. The first word of every segment must be a bare name on the
 * profile's allowlist (no path, expansion, glob, brace or `NAME=` prefix, which also rules out `sh`, `env`,
 * `sudo`, `xargs`, `eval`, `cd`, `curl`), and nothing may redirect to a file (`2>&1` is fine).
 */
export function shellGate(command: string, profile: KeteModesRpc.Profile, platform: NodeJS.Platform): string | undefined {
  if (profile.shell.run === "off") return "commands are not available"
  if (platform === "win32" && profile.shell.windows === "off") return "commands are not available on Windows"
  if (profile.shell.run === "any") return undefined
  for (const posix of [true, false]) {
    const parsed = KeteShellRisk.tokenize(command, { posix })
    if (!parsed.ok) return "the command can't be checked safely"
    if (parsed.segments.length === 0) return "the command is empty"
    for (const segment of parsed.segments) {
      const first = segment.words[0]
      if (first === undefined) return "a command has no program"
      if (first.expands || first.glob || first.brace || first.value.includes("=") || /[\\/]/.test(first.value))
        return "the program must be a plain name"
      if (!profile.shell.allow.includes(first.value) || (!profile.git && (first.value === "git" || first.value === "gh")))
        return `${first.value} is not allowed`
      if (segment.redirects.some((redirect) => redirect.target !== undefined)) return "redirecting output to a file is not allowed"
    }
  }
  return undefined
}

const shellRefusal = "Work mode: only the shell tool's own checked command may run."
const worktreeRefusal = "Work mode: subagents can't run in their own git worktree."

/** A glob pattern that is absolute, home-relative or climbs out with `..` (also inside `{a,b}`). */
export const escapingPattern = (pattern: string) => /(^|[{,])(\/|\\|~|[A-Za-z]:)/.test(pattern) || /(^|[\\/{,])\.\.([\\/},]|$)/.test(pattern)

export interface Family {
  readonly work: boolean
  /** The root-most session of the family (the audit file's name). */
  readonly root: string
}

export interface Deps {
  readonly profile: KeteModesRpc.Profile
  readonly platform: NodeJS.Platform
  readonly directory: string
  readonly session: KeteAddDir.Lookup["session"]
  /** The folders a session may use: the location plus its live `kete.dirs`. */
  readonly roots: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<string>>
  readonly fs: Pick<FSUtil.Interface, "existsSafe" | "resolve" | "readLink">
  readonly audit: (root: string, line: KeteAudit.WorkRefusalLine) => Effect.Effect<void, KeteAudit.WriteError>
  readonly cache: Map<string, Family>
  /** Shell tool calls that passed `shellGate`; a `shell` permission request from anything else is refused. */
  readonly gated: Set<string>
}

/** The mode of the root-most session in `sessionID`'s family. A missing session or a chain that is too deep is Work. */
export const resolveFamily = (deps: Deps, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const cached = deps.cache.get(sessionID)
    if (cached !== undefined) return cached
    let current: SessionSchema.ID | undefined = sessionID
    let root: SessionSchema.Info | undefined
    for (let depth = 0; current !== undefined && depth <= MAX_DEPTH; depth++) {
      const session: Option.Option<SessionSchema.Info> = yield* deps.session(current)
      if (Option.isNone(session)) break
      root = session.value
      current = session.value.parentID
    }
    // Complete chain: the root's mode (the mode is locked, so it's cached). Otherwise Work, uncached.
    if (current !== undefined || root === undefined) return { work: true, root: root?.id ?? sessionID } satisfies Family
    const family: Family = { work: KeteSessionMode.mode(root.metadata) === "work", root: root.id }
    if (deps.cache.size >= MAX_CACHE) deps.cache.clear()
    deps.cache.set(sessionID, family)
    return family
  })

/** Whether `target` (absolute) is, by real path, inside the session's folders. */
const allowedPath = (deps: Deps, sessionID: SessionSchema.ID, target: string) =>
  Effect.gen(function* () {
    const real = yield* KeteRealPath.follow(deps.fs, target)
    if (real === undefined || real === KeteRealPath.UNRESOLVED) return false
    return yield* KeteRealPath.inside(deps.fs, real, yield* deps.roots(sessionID))
  })

// A directory resource ends in `/*`; the root's `/*` keeps its text, so it never resolves to the location.
const absolute = (deps: Deps, value: string) => FileAccess.resolvePath(deps.directory, value.replace(/(.)[\\/]\*$/, "$1"))

interface Source {
  readonly sessionID: SessionSchema.ID
  readonly messageID?: string
  readonly toolCallID?: string
}

const refusal = (deps: Deps, family: Family, source: Source, rule: Rule, tool: string, input: unknown, message: string) => {
  let text: string
  try {
    text = JSON.stringify(input) ?? "null"
  } catch {
    text = "[unserializable]"
  }
  const line: KeteAudit.WorkRefusalLine = {
    v: 1,
    ts: new Date().toISOString(),
    type: "work_refusal",
    session_id: source.sessionID,
    root_id: family.root,
    ...(source.messageID !== undefined ? { message_id: source.messageID } : {}),
    ...(source.toolCallID !== undefined ? { tool_call_id: source.toolCallID } : {}),
    rule,
    tool,
    input: text,
    message,
  }
  // A failed write is logged; the refusal stands.
  return deps.audit(family.root, line).pipe(
    Effect.catch((error) => Effect.logError("kete work mode: failed to write an audit line", { root: family.root, path: error.path, code: error.code })),
  )
}

/** Denies a `read`/`edit`/`external_directory` outside the granted folders, and any sandbox escape; marks shell requests. */
export const onEvaluate = (deps: Deps, event: PermissionEvaluation) =>
  Effect.gen(function* () {
    if (event.effect === "deny") return
    const family = yield* resolveFamily(deps, event.sessionID)
    if (!family.work) return
    const source: Source = { sessionID: event.sessionID, messageID: event.source?.messageID, toolCallID: event.source?.id }
    const deny = (rule: Rule, message: string) =>
      Effect.gen(function* () {
        event.effect = "deny"
        event.message = message
        yield* refusal(deps, family, source, rule, event.action, event.resources, message)
      })
    if (event.action === "shell") {
      // Only the shell tool's own gated command may run; a worktree setup script or any other shell request may not.
      const call = event.source?.id
      if (call === undefined || !deps.gated.has(call)) return yield* deny("shell", shellRefusal)
      KeteSandboxActions.markWork(event.metadata)
      return
    }
    if (event.action === "worktree") return yield* deny("tool", worktreeRefusal)
    if (KeteSandboxActions.isSandboxAction(event.action)) return yield* deny("network", sandboxRefusal)
    if (event.action !== "read" && event.action !== "edit" && event.action !== "external_directory") return
    for (const resource of event.resources) {
      if (!(yield* allowedPath(deps, event.sessionID, absolute(deps, resource)))) return yield* deny("files", filesRefusal)
    }
  })

const field = (input: unknown, name: string): { present: boolean; value?: string } => {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[name] : undefined
  return value === undefined ? { present: false } : typeof value === "string" ? { present: true, value } : { present: true }
}

/** The tool gate, and the path/pattern/command checks for the tools whose permission resources aren't paths. */
export const onToolBefore = (deps: Deps, event: ToolHooks["execute.before"]) =>
  Effect.gen(function* () {
    const family = yield* resolveFamily(deps, event.sessionID)
    if (!family.work) return
    const source: Source = { sessionID: event.sessionID, messageID: event.messageID, toolCallID: event.id }
    const fail = (rule: Rule, message: string) =>
      Effect.gen(function* () {
        yield* refusal(deps, family, source, rule, event.tool, event.input, message)
        return yield* new Tool.Error({ message })
      })
    if (!allowedTools(deps.profile).has(event.tool)) return yield* fail("tool", toolRefusal(event.tool))
    if (event.tool === "glob" || event.tool === "grep" || event.tool === "shell") {
      const where = field(event.input, event.tool === "shell" ? "workdir" : "path")
      if (where.present && where.value === undefined) return yield* fail("files", filesRefusal)
      if (!(yield* allowedPath(deps, event.sessionID, absolute(deps, where.value ?? "."))))
        return yield* fail("files", filesRefusal)
    }
    if (event.tool === "glob" || event.tool === "grep") {
      const pattern = field(event.input, event.tool === "glob" ? "pattern" : "include")
      if (pattern.present && (pattern.value === undefined || escapingPattern(pattern.value))) return yield* fail("files", filesRefusal)
    }
    if (event.tool === "shell") {
      const command = field(event.input, "command")
      const sandbox = field(event.input, "sandbox")
      if (sandbox.present) return yield* fail("network", sandboxRefusal)
      const reason = command.value === undefined ? "the command is missing" : shellGate(command.value, deps.profile, deps.platform)
      if (reason !== undefined) return yield* fail("shell", `Work mode: ${reason}.`)
      deps.gated.add(event.id)
    }
    if (event.tool === "subagent") {
      if (field(event.input, "worktree").present) return yield* fail("tool", worktreeRefusal)
      // Pin it off, so `kete.subagents.worktree: "background"` can't give a Work subagent a git worktree either.
      if (typeof event.input === "object" && event.input !== null) Object.assign(event.input, { worktree: false })
    }
  })

export const Plugin = define({
  id: "kete.work-mode",
  effect: Effect.fn(function* (ctx) {
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const lookup = { session: (id: SessionSchema.ID) => sessions.get(id).pipe(Effect.option) }
    const writer = KeteAudit.makeWriterState(global.data, KeyedMutex.makeUnsafe<string>(), KeteAudit.storageFor())
    const context = KeteAddDir.context(fs, location.directory)
    const deps: Deps = {
      profile: KeteModes.get("work"),
      platform: process.platform,
      directory: location.directory,
      session: lookup.session,
      roots: (sessionID) =>
        KeteAddDir.live(fs, context, lookup, sessionID).pipe(Effect.map((folders) => [path.resolve(location.directory), ...folders])),
      fs,
      audit: (root, line) => KeteAudit.appendWork(writer, root, line),
      cache: new Map(),
      gated: new Set(),
    }
    yield* ctx.permission.hook("evaluate", (event) => onEvaluate(deps, event))
    yield* ctx.tool.hook("execute.before", (event) => onToolBefore(deps, event))
    const filter = (event: { readonly sessionID: SessionSchema.ID; tools: Record<string, unknown> }) =>
      resolveFamily(deps, event.sessionID).pipe(Effect.map((family) => (family.work ? filterTools(deps.profile, event.tools) : undefined)))
    yield* ctx.session.hook("context", filter)
    yield* ctx.session.hook("compaction", filter)
    yield* ctx.session.hook("generate", filter)
  }),
})
