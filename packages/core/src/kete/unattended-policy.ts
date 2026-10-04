// The contract for an unattended run (ADR 0008): session metadata key `kete.unattended`, set only
// at session creation, never removed or changed afterward. Every session in an unattended family
// carries its own copy of the key — a plain child inherits it (session.ts `create`'s
// `metadata: input.metadata ?? parent?.metadata`), a worktree subagent's own metadata already
// spreads the parent's (kete/worktrees.ts:253's `{ ...parent.metadata, [worktreeKey]: record }`),
// and `inheritMetadata` guards the remaining case defensively: any caller (today or future) that
// supplies its own metadata at creation without spreading the parent's still gets the parent
// family's `kete.unattended` forced onto it, so this invariant never depends on every call site
// getting the spread right.
//
// `resolve` still walks `parentID` upward, defensively, for a session created before this
// invariant existed: the run is unattended if the session itself or any resolvable ancestor
// carries the key, using the root-most one found. A broken chain (a missing ancestor —
// session_v2.parent_id has no FK — or one past MAX_DEPTH) before any session is found means
// **interactive**, unchanged behavior; a broken chain after a session was found still fails
// closed, using that session's value. Anything that can't be resolved with confidence once a
// session IS found — a decode failure, an unknown version — fails closed: `allows` never returns
// true and the caller gets no budget or time limit, so kete/unattended.ts refuses every prompt.
// Every new field bumps `version`.
//
// No session or permission service imports here (type imports only), so session/session.ts can
// import this module to guard `setMetadata`/`setPermissions` without a cycle — the same reason
// kete/worktree-lease.ts is kept apart from kete/worktrees.ts.

export * as KeteUnattendedPolicy from "./unattended-policy.js"

import { isDeepStrictEqual } from "node:util"
import { Effect, Option, Result, SchemaIssue, SchemaParser } from "effect"
import { Brand } from "@opencode/util/kete/brand"
import { KeteUnattendedSchema } from "@opencode/schema/kete/unattended"
import type { SessionSchema } from "../session/schema.js"
import { Wildcard } from "../util/wildcard.js"

export const metadataKey = "kete.unattended"

/** Longest ancestor chain walked; a deeper chain is a cycle or corruption, like permission-ceiling.ts's. */
const MAX_DEPTH = 32

/** Actions a policy's `allow` rules can never grant, whatever they match. */
const neverAllowed: ReadonlySet<string> = new Set(["question", "budget"])

// `AllowRule`/`Policy` moved to `@opencode/schema/kete/unattended` (the CLI can't import core, and
// needs the identical schema to validate a job spec's `policy` field); re-exported here so every
// existing `KeteUnattendedPolicy.Policy` caller compiles unchanged.
export const AllowRule = KeteUnattendedSchema.AllowRule
export type AllowRule = KeteUnattendedSchema.AllowRule
export const Policy = KeteUnattendedSchema.Policy
export type Policy = KeteUnattendedSchema.Policy

/** The fail-closed policy: no allow rules, no budget, no time limit. */
export const emptyPolicy: Policy = { version: 1 }

const decodePolicy = SchemaParser.decodeUnknownResult(Policy)
const formatIssue = SchemaIssue.makeFormatterDefault()

export interface Interactive {
  readonly kind: "interactive"
}
export interface Unattended {
  readonly kind: "unattended"
  readonly policy: Policy
  /** The root-most session `resolve` found carrying the key; its `time.created` anchors the run's clock. */
  readonly root: SessionSchema.Info
  /** Set when that session's `kete.unattended` couldn't be decoded; `policy` is then `emptyPolicy`. */
  readonly invalid?: string
}
export type State = Interactive | Unattended

/** How callers look a session up; `Effect.option` around a service's `get` gives this. */
export type Get = (sessionID: SessionSchema.ID) => Effect.Effect<Option.Option<SessionSchema.Info>>

/**
 * Walks from `sessionID` up through `parentID`: unattended if the session itself or any
 * resolvable ancestor carries `kete.unattended`, using the root-most one found (ties should not
 * happen — every session in the family carries an identical copy — but the outermost wins if they
 * ever differ). Interactive only when the whole resolvable chain has no session carrying the key.
 */
export const resolve = Effect.fnUntraced(function* (get: Get, sessionID: SessionSchema.ID) {
  let found: SessionSchema.Info | undefined
  let currentID: SessionSchema.ID | undefined = sessionID
  for (let depth = 0; currentID !== undefined && depth <= MAX_DEPTH; depth++) {
    const current: Option.Option<SessionSchema.Info> = yield* get(currentID)
    if (Option.isNone(current)) break
    if (current.value.metadata?.[metadataKey] !== undefined) found = current.value
    currentID = current.value.parentID
  }
  if (found === undefined) return { kind: "interactive" } as State
  const decoded = decodePolicy(found.metadata![metadataKey], { onExcessProperty: "error" })
  if (Result.isFailure(decoded))
    return { kind: "unattended", policy: emptyPolicy, root: found, invalid: formatIssue(decoded.failure) } as State
  return { kind: "unattended", policy: decoded.success, root: found } as State
})

/**
 * Whether every one of `resources` is granted by `policy`'s allow rules for `action` — never true
 * for `question` or `budget`, which a policy can never allow (kete/unattended.ts's late hook denies
 * them outright in an unattended family).
 */
export function allows(policy: Policy, action: string, resources: ReadonlyArray<string>): boolean {
  if (neverAllowed.has(action)) return false
  const rules = policy.allow ?? []
  if (rules.length === 0) return false
  return resources.every((resource) =>
    rules.some((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)),
  )
}

const configFileNames = new Set(Brand.configFiles.map((name) => name.toLowerCase()))
const projectDirName = Brand.projectDirectory.toLowerCase()

function normalizedSegments(value: string): ReadonlyArray<string> {
  return value.replaceAll("\\", "/").toLowerCase().split("/").filter((segment) => segment.length > 0)
}

/** A `.kete` path segment or a `kete.json`/`kete.jsonc` filename, anywhere in `value` — the same
 * places project config discovery reads one, whatever directory it's nested under. */
function hasProjectConfigSegment(value: string): boolean {
  return normalizedSegments(value).some((segment) => segment === projectDirName || configFileNames.has(segment))
}

/** `value` at or under `globalConfig` (case-insensitive, `\` and `/` both accepted — Windows). */
function insideGlobalConfig(value: string, globalConfig: string): boolean {
  const normalizedValue = value.replaceAll("\\", "/").toLowerCase()
  const normalizedGlobal = globalConfig.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "")
  return normalizedValue === normalizedGlobal || normalizedValue.startsWith(normalizedGlobal + "/")
}

/**
 * D2: whether an unattended run's `action`/`resources` target Kete configuration — an `edit`
 * resource (edit/write/patch all assert action `edit`, `file-access.ts`: project-relative inside
 * the project, absolute outside) under a `.kete/` segment, a `kete.json`/`kete.jsonc` filename, or
 * the global config directory; or, best-effort, a `shell` command's resource text (the parsed
 * command, `tool/plugin/shell.ts`) that mentions any of those. Pure and string-only: a symlink
 * pointing into `.kete/` isn't caught (resources are lexical, like `file-access.ts:97-106`), and an
 * obfuscated shell command isn't either — both documented gaps (`docs/jobs.md`).
 */
export function configTarget(
  action: string,
  resources: ReadonlyArray<string>,
  options: { readonly globalConfig: string },
): boolean {
  if (action !== "edit" && action !== "shell") return false
  return resources.some((resource) => hasProjectConfigSegment(resource) || insideGlobalConfig(resource, options.globalConfig))
}

/**
 * The metadata a new child gets: upstream's own inheritance (`providedMetadata ?? parentMetadata`)
 * when the parent isn't unattended; otherwise `providedMetadata` with `kete.unattended` forced to
 * match the parent's, whether or not the caller's own metadata already spread the parent's —
 * every session in the family must carry the key itself, so `resolve` never depends on an
 * ancestor that could later disappear.
 */
export function inheritMetadata(
  parentMetadata: SessionSchema.Metadata | undefined,
  providedMetadata: SessionSchema.Metadata | undefined,
): SessionSchema.Metadata | undefined {
  const parentPolicy = parentMetadata?.[metadataKey]
  if (parentPolicy === undefined) return providedMetadata ?? parentMetadata
  if (providedMetadata === undefined) return parentMetadata
  if (isDeepStrictEqual(providedMetadata[metadataKey], parentPolicy)) return providedMetadata
  return { ...providedMetadata, [metadataKey]: parentPolicy }
}

export class LockedError extends Error {
  constructor(reason: string) {
    super(`This session's "${metadataKey}" is locked: ${reason}`)
    this.name = "KeteUnattendedLockedError"
  }
}

/**
 * Refuses a metadata update that adds, changes or drops `kete.unattended` (ADR 0008): the key can
 * only be set when a session is created, never afterward. Other keys are unaffected.
 */
export function guardMetadata(
  current: SessionSchema.Metadata | undefined,
  next: SessionSchema.Metadata,
): Effect.Effect<void> {
  const before = current?.[metadataKey]
  const after = next[metadataKey]
  if (before === undefined && after === undefined) return Effect.void
  if (before === undefined)
    return Effect.die(new LockedError("it can only be set when the session is created, not added afterward"))
  if (!isDeepStrictEqual(before, after))
    return Effect.die(new LockedError("it can't be changed or removed while set"))
  return Effect.void
}

/** Refuses `setPermissions` in an unattended family (D2): a `permissions` rule could widen the run's policy mid-run. */
export const guardPermissions = Effect.fnUntraced(function* (get: Get, sessionID: SessionSchema.ID) {
  const state = yield* resolve(get, sessionID)
  if (state.kind === "interactive") return
  yield* Effect.die(new LockedError("this session's family is running unattended; permissions can't be changed"))
})
