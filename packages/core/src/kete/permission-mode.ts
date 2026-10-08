// A session's permission mode, and Kete Code's safe defaults for interactive sessions.
//
// Upstream's default agent allows every action (`"*": allow`) except reads of `.env` files and
// paths outside the workspace. Kete Code layers its safe defaults on top of that here, on the
// permission service's `evaluate` hook, instead of editing upstream's agent defaults: when an
// allow comes only from that catch-all rule, the session's mode decides whether the request
// still runs without asking. A rule that names the action (from an agent, the user's or
// project's `permissions` config, or the session) is an explicit choice and is kept — except in
// "ask" and "plan" modes, which are explicit choices too. A saved "Always allow" counts too, except
// for high-risk commands and ones that run anything (`KeteShellRisk.saveable`). A config rule
// `"*": allow` can't be told apart from upstream's and gets the defaults.
//
// Whatever the mode (Plan denies instead): an edit to Kete Code's own configuration, agents,
// skills, plugins or commands (`.kete/**`, `kete.json(c)`, the global config directory) or to
// `.git/**` always asks — otherwise an agent could write itself a permission rule. In Default and
// Accept-edits, editing a build/test entry point (package.json, Makefile, `*.config.*`, …) asks,
// and after one was edited the session's next test/build command asks once.
//
// This is a guard, not a sandbox: an allowed test command runs whatever the project's code does.
//
// Modes (session metadata `kete.permissionMode`, inherited from the root session; sessions
// without it use `KETE_PERMISSION_MODE`, then "default"):
//   default      edits allowed; read-only and test/build shell commands allowed; every other shell
//                command, high-risk command (kete/shell-risk.ts) and web fetch/search asks.
//   accept-edits the same as default today (edits are already allowed by default); kept as an
//                explicit name for clients that offer it.
//   auto         edits and shell commands allowed, web fetch/search allowed; high-risk and
//                unparseable shell commands still ask. Not a bypass.
//   ask          asks before every edit, shell command and web fetch/search, even explicitly allowed ones.
//   plan         read-only: edits are denied; shell commands other than read-only ones are denied;
//                web fetch/search as default.
//
// It only ever tightens: the permission service decides deny before this hook runs, the result
// is never looser than the decision it was given, and organization and configuration policies
// (kete/sync/plugin.ts, config/plugin/policy.ts) run after it and can still deny. Unattended
// runs (kete/unattended.ts) keep their own fail-closed policy: the safe defaults don't apply in an
// unattended family, though an explicit "ask" or "plan" mode still tightens.

export * as KetePermissionMode from "./permission-mode.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Permission as PermissionSchema } from "@opencode/schema/permission"
import { KetePermissionModes } from "@opencode/util/kete/permission-mode"
import { Effect, Option } from "effect"
import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Agent } from "../agent.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { PermissionSaved } from "../permission/saved.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KeteShellRisk } from "./shell-risk.js"
import { KeteUnattendedPolicy } from "./unattended-policy.js"

export const metadataKey = KetePermissionModes.metadataKey
export const modes = KetePermissionModes.modes
export type Mode = KetePermissionModes.Mode

type Decision = PermissionSchema.Effect

/** The actions "ask" mode asks before: file edits (edit, write, patch), shell commands, web fetches and searches. */
export const guarded: ReadonlySet<string> = new Set(["edit", "shell", "webfetch", "websearch"])

const network: ReadonlySet<string> = new Set(["webfetch", "websearch"])

/**
 * What Plan mode lets through (other checks still apply): reading and searching, questions, skills,
 * read-only shell commands, web requests (asked), MCP resource reads, budget prompts, and
 * subagents — which run in Plan mode too, since a subagent follows its root session's mode.
 * Everything else, including MCP tools (the runtime has no read-only marking for them) and
 * worktrees, is denied.
 */
export const planAllowed: ReadonlySet<string> = new Set([
  "read", "glob", "grep", "question", "skill", "budget", "external_directory", "webfetch", "websearch",
  "shell", "subagent", "opencode_list_mcp_resources", "opencode_read_mcp_resource",
])

export const parse = KetePermissionModes.parse

const rank: Record<Decision, number> = { deny: 0, ask: 1, allow: 2 }
const stricter = (a: Decision, b: Decision): Decision => (rank[a] <= rank[b] ? a : b)

/** Which rule allowed a resource: upstream's catch-all, a saved "Always allow", or an explicit rule. */
export type Source = "catch-all" | "saved" | "explicit"

/** One resource of a request, as this module sees it. */
export interface Resource {
  /** The command, path or URL. */
  readonly value: string
  readonly source: Source
  /** For edits: Kete Code's configuration or git's internals (always asks). */
  readonly protected?: boolean
  /** For edits: a build/test entry point (asks in Default and Accept-edits). */
  readonly entryPoint?: boolean
}

export interface Input {
  readonly mode: Mode
  readonly action: string
  readonly resources: ReadonlyArray<Resource>
  /** Whether the session belongs to an unattended run (kete/unattended-policy.ts). */
  readonly unattended: boolean
  /** For shell: the whole command line, for directory changes the per-command check can't see. */
  readonly line?: string
  /** For shell: a build/test entry point was edited in this session family since the last check. */
  readonly buildChanged?: boolean
}

export interface Outcome {
  readonly effect: Decision
  readonly message?: string
  /** The "build setup changed" check fired (the caller then forgets the change). */
  readonly buildCheck?: boolean
}

const ALLOW: Outcome = { effect: "allow" }
const PLAN_EDIT = "Plan mode is read-only: switch to another permission mode to edit files."
const PROTECTED =
  "Kete Code always asks before changing its own configuration, agents, skills or plugins, or git's internals (.git)."

/** Whether a resource still gets the safe defaults: no explicit rule, and no saved approval that may count. */
function defaulted(resource: Resource, shell: boolean) {
  if (resource.source === "catch-all") return true
  return resource.source === "saved" && shell && !KeteShellRisk.saveable(resource.value)
}

/**
 * What `input.mode` allows for one request, before the decision it was given: `allow` means "no
 * objection". The caller takes the stricter of this and the given decision, so it can never loosen.
 */
export function decide(input: Input): Outcome {
  const { mode, action } = input
  if (mode === "plan") {
    if (action === "edit") return { effect: "deny", message: PLAN_EDIT }
    if (!planAllowed.has(action))
      return { effect: "deny", message: `Plan mode is read-only: \`${action}\` isn't available. Switch permission mode to use it.` }
    if (action === "shell") {
      for (const resource of input.resources) {
        const risk = KeteShellRisk.classify(resource.value)
        if (risk.risk !== "read")
          return { effect: "deny", message: `Plan mode is read-only: \`${short(resource.value)}\` ${risk.reason}.` }
      }
      const line = input.line === undefined ? undefined : KeteShellRisk.classifyLine(input.line)
      if (line?.risk === "high") return { effect: "deny", message: `Plan mode is read-only: the command ${line.reason}.` }
      return ALLOW
    }
  }
  if (mode === "ask")
    return guarded.has(action) ? { effect: "ask", message: "Ask mode: approve each edit, command and web request." } : ALLOW
  if (input.unattended) return ALLOW
  if (action === "edit") {
    if (input.resources.some((resource) => resource.protected)) return { effect: "ask", message: PROTECTED }
    if (
      (mode === "default" || mode === "accept-edits") &&
      input.resources.some((resource) => resource.entryPoint && resource.source !== "explicit")
    )
      return {
        effect: "ask",
        message: "This file is part of how the project builds or tests: changing it changes what test and build commands run.",
      }
    return ALLOW
  }
  if (action === "shell") {
    let result: Outcome = ALLOW
    let build = false
    for (const resource of input.resources) {
      if (!defaulted(resource, true)) continue
      const risk = KeteShellRisk.classify(resource.value)
      if (risk.risk === "build") build = true
      const asks = risk.risk === "high" || (risk.risk === "other" && mode !== "auto")
      if (!asks) continue
      const message =
        risk.risk === "high"
          ? `High-risk command: \`${short(resource.value)}\` ${risk.reason}.`
          : `\`${short(resource.value)}\` ${risk.reason}.`
      if (result.effect === "allow" || risk.risk === "high") result = { effect: "ask", message }
    }
    const anyDefaulted = input.resources.some((resource) => defaulted(resource, true))
    if (input.line !== undefined && anyDefaulted) {
      const line = KeteShellRisk.classifyLine(input.line)
      if (line.risk === "high") result = { effect: "ask", message: `High-risk command: it ${line.reason}.` }
    }
    if (build && input.buildChanged && (mode === "default" || mode === "accept-edits"))
      return {
        effect: "ask",
        message: result.message ?? "The project's build or test setup was changed in this session: check before running it.",
        buildCheck: true,
      }
    return result
  }
  if (network.has(action) && mode !== "auto" && input.resources.some((resource) => resource.source === "catch-all"))
    return { effect: "ask", message: "Kete Code asks before web requests." }
  return ALLOW
}

function short(value: string) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > 120 ? line.slice(0, 117) + "..." : line
}

/** Applies `decide` to an `evaluate` hook event: only ever tightens. */
export function tighten(event: { effect: Decision; message?: string }, outcome: Outcome) {
  const next = stricter(event.effect, outcome.effect)
  if (next === event.effect) return
  event.effect = next
  if (outcome.message !== undefined) event.message = outcome.message
}

/** Longest ancestor chain followed when looking for the root session's mode. */
const MAX_DEPTH = 32

export interface Lookup {
  readonly session: (sessionID: SessionSchema.ID) => Effect.Effect<Option.Option<SessionSchema.Info>>
  readonly agent: (agentID: string | undefined) => Effect.Effect<Agent.Info | undefined>
  /** Saved "always" approvals, as allow rules. */
  readonly approved: Effect.Effect<Permission.Ruleset>
  /** The mode for sessions without one. */
  readonly fallback: Mode
  /** Absolute directories that are Kete Code's own (global config and data). */
  readonly protectedRoots?: ReadonlyArray<string>
  /**
   * Session families (by root session ID) that changed a build/test entry point since the last check.
   * In memory, per runtime process: a restart forgets it (the next test/build command then doesn't
   * ask for an earlier edit).
   */
  readonly buildChanged?: Set<string>
  /**
   * An edit target's real path (symlinks resolved, through its deepest existing parent): relative to
   * the real workspace when inside it, absolute otherwise. `FileAccess` resolves edit paths lexically,
   * so `cfg -> .git` would otherwise let `cfg/config` through.
   */
  readonly realpath?: (value: string) => Effect.Effect<string | undefined>
}

/** The family's root session and the mode of the root-most session that has one (else the fallback). */
export const resolveFamily = Effect.fnUntraced(function* (lookup: Lookup, sessionID: SessionSchema.ID) {
  let found: Mode | undefined
  let root: SessionSchema.ID = sessionID
  let current: SessionSchema.ID | undefined = sessionID
  for (let depth = 0; current !== undefined && depth <= MAX_DEPTH; depth++) {
    const session: Option.Option<SessionSchema.Info> = yield* lookup.session(current)
    if (Option.isNone(session)) break
    root = current
    const mode = parse(session.value.metadata?.[metadataKey])
    if (mode !== undefined) found = mode
    current = session.value.parentID
  }
  return { mode: found ?? lookup.fallback, root }
})

/** The mode of the root-most session in `sessionID`'s family that has one, else the fallback. */
export const resolveMode = (lookup: Lookup, sessionID: SessionSchema.ID) =>
  resolveFamily(lookup, sessionID).pipe(Effect.map((family) => family.mode))

const catchAll = (rule: Permission.Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"

// macOS and Windows file systems are case-insensitive by default.
const caseless = process.platform === "darwin" || process.platform === "win32"
const normalize = (value: string) => {
  const slashed = value.split("\\").join("/").replace(/\/+$/, "")
  return caseless ? slashed.toLowerCase() : slashed
}

function isProtected(value: string, roots: ReadonlyArray<string>) {
  if (KeteShellRisk.protectedPath(value)) return true
  const path = normalize(value)
  return roots.some((root) => {
    const base = normalize(root)
    return base !== "" && (path === base || path.startsWith(base + "/"))
  })
}

/** Applies the session's mode to one `evaluate` hook event. */
export const apply = Effect.fnUntraced(function* (
  lookup: Lookup,
  event: {
    readonly sessionID: SessionSchema.ID
    readonly agent?: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly metadata?: Record<string, unknown>
    effect: Decision
    message?: string
  },
) {
  if (event.effect === "deny") return
  if (!guarded.has(event.action)) {
    // Only Plan mode does anything outside the guarded actions.
    const { mode } = yield* resolveFamily(lookup, event.sessionID)
    if (mode === "plan") tighten(event, decide({ mode, action: event.action, resources: [], unattended: false }))
    return
  }
  const { mode, root } = yield* resolveFamily(lookup, event.sessionID)
  const session = yield* lookup.session(event.sessionID)
  const unattended = (yield* KeteUnattendedPolicy.resolve(lookup.session, event.sessionID)).kind === "unattended"
  // The rules the permission service used, to tell a catch-all allow from an explicit or saved one.
  const info = Option.getOrUndefined(session)
  const agent = yield* lookup.agent(event.agent ?? info?.agent)
  const configured = Permission.merge(agent?.permissions ?? [], info?.permissions ?? [])
  const approved = yield* lookup.approved
  const all = [...configured, ...approved]
  const roots = lookup.protectedRoots ?? []
  const resources = yield* Effect.forEach(event.resources, (value) =>
    Effect.gen(function* () {
      const rule = Permission.evaluate(event.action, value, all)
      const source: Source = approved.includes(rule) ? "saved" : catchAll(rule) ? "catch-all" : "explicit"
      if (event.action !== "edit") return { value, source } satisfies Resource
      const real = lookup.realpath ? yield* lookup.realpath(value) : undefined
      const paths = real === undefined || real === value ? [value] : [value, real]
      return {
        value,
        source,
        protected: paths.some((candidate) => isProtected(candidate, roots)),
        entryPoint: paths.some(KeteShellRisk.entryPoint),
      } satisfies Resource
    }),
  )
  const line = event.action === "shell" && typeof event.metadata?.command === "string" ? event.metadata.command : undefined
  const outcome = decide({
    mode,
    action: event.action,
    resources,
    unattended,
    line,
    buildChanged: lookup.buildChanged?.has(root) ?? false,
  })
  const final = stricter(event.effect, outcome.effect)
  tighten(event, outcome)
  if (outcome.buildCheck) lookup.buildChanged?.delete(root)
  // A change to a build/test entry point that may go ahead (an edit, `npm pkg set`, `> package.json`):
  // the next test/build command asks once. Instruction files (AGENTS.md) ask but don't count.
  if (final !== "deny") {
    const edited =
      event.action === "edit" &&
      resources.some((resource) => resource.entryPoint && !KeteShellRisk.instructionFile(resource.value))
    const shell = event.action === "shell" && [...event.resources, ...(line ? [line] : [])].some(KeteShellRisk.changesBuild)
    if (edited || shell) lookup.buildChanged?.add(root)
  }
})

/**
 * `value` with symlinks resolved through its deepest existing ancestor; see `Lookup.realpath`.
 * Through `FSUtil` (wrapped in job mode, kete/job-fs-util.ts), never `fs` directly.
 */
export const realTarget = Effect.fnUntraced(function* (
  files: Pick<FSUtil.Interface, "existsSafe" | "resolve">,
  directory: string,
  value: string,
) {
  const absolute = path.resolve(directory, value)
  let existing = absolute
  const rest: string[] = []
  while (!(yield* files.existsSafe(existing))) {
    const parent = path.dirname(existing)
    if (parent === existing) return undefined
    rest.unshift(path.basename(existing))
    existing = parent
  }
  const real = path.join(yield* files.resolve(existing), ...rest)
  const root = yield* files.resolve(directory)
  const relative = path.relative(root, real)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : real
})

export const Plugin = define({
  id: "kete.permission-mode",
  effect: Effect.fn(function* (ctx) {
    const raw = process.env.KETE_PERMISSION_MODE
    const fallback = parse(raw) ?? "default"
    if (raw !== undefined && raw !== "" && !parse(raw))
      yield* Effect.logWarning("ignoring KETE_PERMISSION_MODE: expected one of " + modes.join(", "), { value: raw })
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const saved = yield* PermissionSaved.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const files = yield* FSUtil.Service
    const lookup: Lookup = {
      session: (sessionID) => sessions.get(sessionID).pipe(Effect.option),
      agent: (agentID) => agents.resolve(agentID),
      approved: saved
        .list({ projectID: location.project.id })
        .pipe(
          Effect.map((items) =>
            items.map((item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" })),
          ),
        ),
      fallback,
      protectedRoots: [global.config, global.data],
      realpath: (value) => realTarget(files, location.directory, value),
      // Per runtime process, keyed by root session; entries are removed when the check fires.
      buildChanged: new Set(),
    }
    yield* ctx.permission.hook("evaluate", (event) => apply(lookup, event))
  }),
})
