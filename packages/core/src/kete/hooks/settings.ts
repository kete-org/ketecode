// Which config hooks apply (kete/hooks.ts): `kete.hooks` from every configuration document, split by
// who wrote it. Documents under the global config directory are the user's own and run directly; any
// other document (a repository's `kete.json`, `.kete/`) is project configuration, which runs only
// after the user trusts its exact commands. The `kete` object isn't merged across files elsewhere
// (config-kete card); this reads every document, like the sandbox settings do.

export * as KeteHooksSettings from "./settings.js"

import { createHash } from "node:crypto"
import path from "path"
import { ConfigKete } from "@opencode/schema/config/kete"
import type { ConfigPolicy } from "@opencode/schema/config/policy"
import { Wildcard } from "../../util/wildcard.js"

export type Event = ConfigKete.HookEvent
export const events = ConfigKete.HookEvents

export interface Entry {
  readonly event: Event
  readonly command: string
  readonly match?: string
  /** Seconds. */
  readonly timeout: number
  readonly source: "user" | "project"
}

export interface Document {
  /** The file the document came from; documents without one count as project configuration. */
  readonly path?: string
  readonly hooks?: ConfigKete.Hooks
}

export const DEFAULT_TIMEOUT = 60

function inside(file: string, directory: string) {
  const relative = path.relative(directory, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Every hook, in document order (lowest priority first), user and project alike. */
export function collect(documents: ReadonlyArray<Document>, globalDirectory: string): Entry[] {
  const result: Entry[] = []
  for (const doc of documents) {
    if (!doc.hooks) continue
    const source = doc.path !== undefined && inside(doc.path, globalDirectory) ? "user" : "project"
    for (const event of events)
      for (const hook of doc.hooks[event] ?? [])
        result.push({
          event,
          command: hook.command,
          ...(hook.match === undefined ? {} : { match: hook.match }),
          timeout: hook.timeout ?? DEFAULT_TIMEOUT,
          source,
        })
  }
  return result
}

/**
 * The fingerprint the user trusts: every project hook's event, matcher, timeout and exact command,
 * in order. Any change to them asks again.
 */
export function fingerprint(entries: ReadonlyArray<Entry>): string {
  const project = entries
    .filter((entry) => entry.source === "project")
    .map((entry) => [entry.event, entry.match ?? null, entry.timeout, entry.command])
  return createHash("sha256").update(JSON.stringify(project)).digest("hex")
}

/** Whether a tool hook's `match` covers this tool: wildcards, alternatives separated by `|`. */
export function matches(entry: Pick<Entry, "match">, tool: string | undefined): boolean {
  if (entry.match === undefined || tool === undefined) return true
  return entry.match.split("|").some((pattern) => {
    const trimmed = pattern.trim()
    return trimmed !== "" && Wildcard.match(tool, trimmed)
  })
}

/**
 * Whether a policy turns this event's hooks off: a `permission` statement denying `hooks:<event>`
 * (or `hooks:*`). Policies come from the organization (the connected platform) and from
 * `experimental.policies` in configuration; the last matching statement wins, as in
 * config/plugin/policy.ts.
 */
export function disabledByPolicy(policies: ReadonlyArray<Pick<ConfigPolicy.Info, "action" | "resource" | "effect">>, event: Event) {
  const statement = policies.findLast((policy) => policy.action === "permission" && Wildcard.match(`hooks:${event}`, policy.resource))
  return statement?.effect === "deny"
}
