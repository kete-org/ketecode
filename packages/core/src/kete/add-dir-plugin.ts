// The permission grant, `/add-dir` and the `kete.add-dir` RPC for extra working directories
// (add-dir.ts has the rules; docs/permissions.md).
//
// The grant: an `external_directory` request that would ask becomes allowed when every directory it
// names is, by real path, inside one of the session's folders (the root-most session's `kete.dirs`).
// Only an `ask` that comes from the default rules is loosened: a `deny` never reaches the hook
// (Permission checks denies first), and a rule a person or organization wrote for that directory
// (a path-specific `ask`) is kept: the more restrictive setting wins. Every folder is checked again
// when used, so a folder swapped for a symlink since it was added grants nothing. The `edit` or
// `read` permission that follows is evaluated as usual.
//
// Registered right after KeteUnattended.PolicyPlugin, the only other hook that loosens (a loosening hook
// must precede the tightening ones: permission mode, the subagent ceiling, organization policy).

export * as KeteAddDirPlugin from "./add-dir-plugin.js"

import path from "path"
import { define } from "@opencode/plugin/effect/plugin"
import { KeteAddDirRpc } from "@opencode/schema/kete/add-dir"
import type { Permission as PermissionSchema } from "@opencode/schema/permission"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Option } from "effect"
import { Agent } from "../agent.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { PermissionSaved } from "../permission/saved.js"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KeteAddDir } from "./add-dir.js"
import { KetePermissionMode } from "./permission-mode.js"
import { KeteSessionMove } from "./session-move.js"

export interface Lookup extends KeteAddDir.Lookup {
  readonly agent: (agentID: string | undefined) => Effect.Effect<Agent.Info | undefined>
  /** Saved "always" approvals, as allow rules. */
  readonly approved: Effect.Effect<Permission.Ruleset>
  readonly fs: Pick<FSUtil.Interface, "existsSafe" | "resolve" | "isDir" | "readLink">
  readonly context: Effect.Effect<Omit<KeteAddDir.Context, "existing">>
}

/** Whether the directory a `<dir>/*` resource names is, by real path, inside one of the folders. */
const inside = Effect.fnUntraced(function* (lookup: Lookup, base: string, folders: ReadonlyArray<string>, resource: string) {
  const value = resource.replaceAll("\\", "/")
  if (!value.endsWith("/*")) return false
  const directory = value.slice(0, -2)
  if (!path.isAbsolute(directory)) return false
  const real = yield* KetePermissionMode.realTarget(lookup.fs, base, directory)
  // `realTarget` gives a relative path for the workspace itself and `UNRESOLVED` for a symlink loop.
  if (real === undefined || real === KetePermissionMode.UNRESOLVED || !path.isAbsolute(real)) return false
  return folders.some((folder) => FSUtil.contains(folder, real))
})

/** Applies the grant to one `evaluate` hook event. */
export const granted = Effect.fnUntraced(function* (
  lookup: Lookup,
  event: {
    readonly sessionID: SessionSchema.ID
    readonly agent?: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly metadata?: Record<string, unknown>
    effect: PermissionSchema.Effect
  },
) {
  if (event.action !== "external_directory" || event.effect !== "ask") return
  // Moving the session into a folder changes what instructions and config load, so it still asks.
  if (event.metadata?.[KeteSessionMove.metadataKey] === true) return
  const folders = yield* KeteAddDir.live(lookup.fs, lookup.context, lookup, event.sessionID)
  if (folders.length === 0) return
  const info = Option.getOrUndefined(yield* lookup.session(event.sessionID))
  const agent = yield* lookup.agent(event.agent ?? info?.agent)
  const rules = [...Permission.merge(agent?.permissions ?? [], info?.permissions ?? []), ...(yield* lookup.approved)]
  const base = (yield* lookup.context).base
  let loosened = false
  for (const resource of event.resources) {
    const rule = Permission.evaluate(event.action, resource, rules)
    if (rule.effect === "allow") continue
    // Only the default `ask` (resource "*") is loosened; a rule written for this directory stands.
    if (rule.effect !== "ask" || rule.resource !== "*") return
    if (!(yield* inside(lookup, base, folders, resource))) return
    loosened = true
  }
  if (loosened) event.effect = "allow"
})

const list = (folders: ReadonlyArray<string>) =>
  folders.length === 0
    ? "No extra folders in this session. Add one with /add-dir <path>."
    : "Folders this session can work in besides the workspace:\n" + folders.map((folder) => `- ${folder}`).join("\n")

export const Plugin = define({
  id: "kete.add-dir",
  effect: Effect.fn(function* (ctx) {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const saved = yield* PermissionSaved.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
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
      fs,
      context: KeteAddDir.context(fs, location.directory),
    }
    yield* ctx.permission.hook("evaluate", (event) => granted(lookup, event))

    yield* ctx.rpc
      .register(KeteAddDirRpc.Definition, {
        check: ({ paths }) =>
          Effect.gen(function* () {
            const base = yield* lookup.context
            const existing: string[] = []
            const verdicts: KeteAddDirRpc.Verdict[] = []
            for (const item of paths) {
              const result = yield* KeteAddDir.validate(fs, item, { ...base, existing })
              if (result.ok) {
                if (!existing.includes(result.real)) existing.push(result.real)
                verdicts.push({ path: item, real: result.real })
              } else verdicts.push({ path: item, reason: result.reason.slice(0, 300) })
            }
            return { verdicts }
          }),
      })
      .pipe(Effect.orDie)

    yield* ctx.command.transform((editor) =>
      editor.add({
        name: "add-dir",
        description: "work in more folders this session: /add-dir <path>, /add-dir remove <path>, or /add-dir to list them",
        execute: (input) =>
          Effect.gen(function* () {
            const session = yield* sessions.get(input.sessionID)
            const stored = KeteAddDir.parse(session.metadata?.[KeteAddDir.metadataKey])
            const text = input.prompt.text.trim()
            const say = (message: string) => ctx.session.synthetic({ sessionID: input.sessionID, text: message, resume: false })
            const store = (next: string[]) =>
              sessions.setMetadata({ sessionID: input.sessionID, metadata: { ...session.metadata, [KeteAddDir.metadataKey]: next } })
            if (text === "") return yield* say(list(stored))
            const base = yield* lookup.context
            const remove = /^remove\s+(.+)$/s.exec(text)
            if (remove) {
              const argument = remove[1].trim()
              const result = yield* KeteAddDir.validate(fs, argument, { ...base, existing: stored })
              const real = result.ok ? result.real : undefined
              const next = stored.filter((folder) => folder !== argument && folder !== real)
              if (next.length === stored.length) return yield* Effect.fail(new Error(`${argument} isn't one of this session's extra folders.`))
              yield* store(next)
              return yield* say(list(next))
            }
            const result = yield* KeteAddDir.validate(fs, text, { ...base, existing: stored })
            if (!result.ok) return yield* Effect.fail(new Error(result.reason))
            const next = stored.includes(result.real) ? stored : [...stored, result.real]
            if (next !== stored) yield* store(next)
            return yield* say(list(next))
          }),
      }),
    )
  }),
})
