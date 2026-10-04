// Job mode (KETE_JOB_MODE, bridged by env.ts to OPENCODE_JOB_MODE): a build running a job's tools
// under a second user, through the Go root helper (packages/kete-root-helper, kete-code-platform
// docs/jobs.md §8, ADRs 0018-0021). Every process-spawn site funnels through KeteToolRunner —
// KeteToolHelper.runner (tool-helper.ts) when KETE_JOB_TOOL_SOCKET is set, else the fail-closed
// stub (tool-runner.ts) — so a job never silently runs a tool with the wrong isolation; this
// module is the flag those readers, and the direct spawn guards in secret-store.ts and
// job-git.ts, share.
//
// The flag is an environment variable only (plan "Job mode, part 1", D2): the decision has to hold
// in the server process, where tools actually run, and an env var reaches both a standalone server
// and any child it spawns (the standalone self-spawn, D5). An invalid value fails closed — `enabled`
// treats "on" and "invalid" alike — so a typo can never silently turn job mode off.

export * as KeteJobMode from "./job-mode.js"

import { KeteEnv } from "./env.js"
import { KeteHttpURL } from "./http-url.js"

/** The internal name env.ts's bridge renames KETE_JOB_MODE to. */
export const variable = "OPENCODE_JOB_MODE"
/** The user/entrypoint-facing name. */
export const publicName = KeteEnv.publicName(variable)

/** The internal name for KETE_JOB_MAX_OUTPUT_TOKENS (D4b). */
export const maxOutputTokensVariable = "OPENCODE_JOB_MAX_OUTPUT_TOKENS"
export const maxOutputTokensPublicName = KeteEnv.publicName(maxOutputTokensVariable)

export type Environment = Record<string, string | undefined>

export type Flag = { readonly kind: "off" } | { readonly kind: "on" } | { readonly kind: "invalid"; readonly value: string }

const truncate = (value: string) => (value.length > 50 ? `${value.slice(0, 50)}…` : value)

/** Reads the flag: `"1"` is on; unset or empty is off; anything else is invalid — never guessed at
 * (CLAUDE.md §10). */
export function read(env: Environment = process.env): Flag {
  const value = env[variable]
  if (value === undefined || value === "") return { kind: "off" }
  if (value === "1") return { kind: "on" }
  return { kind: "invalid", value: truncate(value) }
}

/** Whether job mode's restrictions apply: "on" or "invalid" both count, so an unrecognized value
 * never behaves as "off". */
export function enabled(env: Environment = process.env): boolean {
  return read(env).kind !== "off"
}

export class SpawnRefusedError extends Error {
  override readonly name = "KeteJobMode.SpawnRefusedError"
}

/** The wording every process-spawn guard uses — the fail-closed ChildProcessSpawner stub
 * (tool-runner.ts) and the direct guards in secret-store.ts / job-git.ts — so a caller sees one
 * consistent message whichever caught it. The message never includes arguments or env, which may
 * hold secrets. */
export function message(what: string): string {
  return `Job mode: tools run only through the job's tool runner; refused to start \`${what}\`.`
}

/** The internal name for KETE_JOB_TOOL_SOCKET. */
export const toolSocketVariable = "OPENCODE_JOB_TOOL_SOCKET"
/** The user/entrypoint-facing name. */
export const toolSocketPublicName = KeteEnv.publicName(toolSocketVariable)

export type ToolSocket =
  | { readonly kind: "unset" }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "invalid"; readonly value: string }

/** Reads KETE_JOB_TOOL_SOCKET: unset/empty is `"unset"` (the fail-closed stub stays); a
 * POSIX-absolute path (starts with `/`, no NUL byte) is `"path"`; anything else is `"invalid"` —
 * `job-server.ts`'s `replacements` throws on that at boot, the same fail-closed treatment an
 * invalid `KETE_JOB_MODE` gets. */
export function toolSocket(env: Environment = process.env): ToolSocket {
  const value = env[toolSocketVariable]
  if (value === undefined || value === "") return { kind: "unset" }
  if (value.startsWith("/") && !value.includes("\0")) return { kind: "path", path: value }
  return { kind: "invalid", value: truncate(value) }
}

/** Throws when job mode is enabled (on or invalid); a no-op otherwise. For the spawn sites outside
 * the shared ChildProcessSpawner service (the OS credential store, `kete job run`'s own `git`). */
export function refuseSpawn(what: string, env: Environment = process.env): void {
  if (!enabled(env)) return
  throw new SpawnRefusedError(message(what))
}

/** The internal names for KETE_GATEWAY_URL / KETE_PLATFORM_URL (the entrypoint sets both, §6d). */
export const gatewayURLVariable = "OPENCODE_GATEWAY_URL"
export const gatewayURLPublicName = KeteEnv.publicName(gatewayURLVariable)
export const platformURLVariable = "OPENCODE_PLATFORM_URL"
export const platformURLPublicName = KeteEnv.publicName(platformURLVariable)

/** The gateway and platform URLs job mode uses: only the entrypoint's environment, normalised
 * (KeteHttpURL) or `undefined` when unset or not http(s). Configured URLs are ignored. */
export function endpoints(env: Environment = process.env): {
  readonly gateway: string | undefined
  readonly platform: string | undefined
} {
  return { gateway: KeteHttpURL.normalize(env[gatewayURLVariable]), platform: KeteHttpURL.normalize(env[platformURLVariable]) }
}

/** KETE_JOB_MAX_OUTPUT_TOKENS (D4b): a positive integer, else `undefined` — including when job mode
 * is off, so callers don't need to check `enabled` first. */
export function maxOutputTokens(env: Environment = process.env): number | undefined {
  const value = env[maxOutputTokensVariable]
  if (value === undefined || value === "") return undefined
  if (!/^[0-9]+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
