// Environment-variable bridge: users configure Kete Code with KETE_* variables,
// while the inherited upstream runtime reads OPENCODE_* names internally.
//
// Rather than editing every upstream `process.env.OPENCODE_X` read (about 60
// sites, plus any upstream adds later), the CLI entry point calls `bridge()` once,
// before any other module is evaluated:
//
// 1. In a top-level process (no marker): every inherited OPENCODE_* variable is
//    removed, so values meant for an OpenCode install are never honoured.
// 2. Every KETE_X variable is moved to OPENCODE_X, where upstream code reads it.
// 3. A marker is set. Processes the runtime starts (background service, askpass,
//    agent shells) inherit the bridged OPENCODE_* values plus the marker, so the
//    values the runtime deliberately hands to its children (server lease
//    password, PTY handoff) survive. KETE_X set explicitly for a child still
//    wins over the inherited value.
//
// The OPENCODE_* names are therefore internal plumbing only; the user-facing
// surface is KETE_*. There is deliberately no fallback from OPENCODE_* to KETE_*.

import { envPrefix } from "./brand.js"

const upstreamPrefix = "OPENCODE_"

/** Set on bridged processes so their children trust the inherited OPENCODE_* values. */
export const marker = `${envPrefix}ENV_BRIDGED`

export type Environment = Record<string, string | undefined>

// Windows environment names are case-insensitive, and upstream reads such as
// `process.env.OPENCODE_X` would match `opencode_x` there, so compare case-insensitively.
const hasPrefix = (name: string, prefix: string) => name.toUpperCase().startsWith(prefix)

/** Rewrites `env` in place. Idempotent: running it twice has the same effect as once. */
export function bridge(env: Environment): void {
  const inherited = env[marker] === "1"
  const names = Object.keys(env)

  if (!inherited) {
    for (const name of names) if (hasPrefix(name, upstreamPrefix)) delete env[name]
  }

  for (const name of names) {
    if (name === marker || !hasPrefix(name, envPrefix)) continue
    const value = env[name]
    delete env[name]
    if (value === undefined) continue
    env[upstreamPrefix + name.slice(envPrefix.length).toUpperCase()] = value
  }

  env[marker] = "1"
}

/**
 * The user-facing name for an internal OPENCODE_* variable, for messages that
 * tell the user which variable to set (e.g. `OPENCODE_PASSWORD` -> `KETE_PASSWORD`).
 */
export function publicName(internal: string): string {
  return hasPrefix(internal, upstreamPrefix) ? envPrefix + internal.slice(upstreamPrefix.length) : internal
}

export * as KeteEnv from "./env.js"
