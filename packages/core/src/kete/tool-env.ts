// The environment a subprocess the agent starts (the shell tool) gets — task
// `2026-10-05-unattended-secret-hygiene`, decision A1.
//
// The runtime's own environment holds credentials: Kete's (the gateway key, the server password, the
// OpenCode Zen key — `KETE_*`, bridged to `OPENCODE_*` by util/src/kete/env.ts) and, usually, the
// user's provider keys (`ANTHROPIC_API_KEY`, …). A command that prints its environment would hand
// them to the model through the command's output. So:
//
// - **always**, Kete's own credentials are removed: a `KETE_*`/`OPENCODE_*` name ending in `_KEY`,
//   `_TOKEN`, `_SECRET` or `_PASSWORD`, plus job mode's secret names (`KeteJobSecrets`);
// - in an **unattended** run (ADR 0008: the session family carries `kete.unattended`, or job mode),
//   provider and other credentials are removed too — names that look like credentials, and the
//   names the provider plugins read that don't (`AWS_ACCESS_KEY_ID`, …); `kete.unattended.passEnv`
//   keeps the ones a build legitimately needs, but never re-admits a Kete credential;
// - an **interactive** session keeps everything else: a person approves each command there, and
//   their builds expect their environment.
//
// Matching is case-insensitive (a lowercase `github_token` is still a secret); `passEnv` matches
// exactly on POSIX, where `foo` and `FOO` are different variables, and case-insensitively on
// Windows, where they are the same one.

export * as KeteToolEnv from "./tool-env.js"

import { Effect } from "effect"
import type { ConfigKete } from "@opencode/schema/config/kete"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteJobSecrets } from "@opencode/util/kete/job-secrets"
import { KeteUnattendedPolicy } from "./unattended-policy.js"
import type { SessionSchema } from "../session/schema.js"

export type Environment = Record<string, string | undefined>

const ketePrefixes = ["KETE_", "OPENCODE_"] as const
const keteCredentialSuffixes = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD"] as const
const keteExplicit: ReadonlySet<string> = new Set(KeteJobSecrets.environmentSecrets)

/** Suffixes that mark a credential in an unattended run (upper-cased names). */
export const credentialSuffixes = [
  "_API_KEY",
  "_APIKEY",
  "_KEY",
  "_TOKEN",
  "_SECRET",
  "_SECRET_KEY",
  "_PASSWORD",
  "_PASSWD",
  "_PAT",
  "_CREDENTIALS",
  "_PRIVATE_KEY",
  "_ACCESS_KEY",
] as const

/** Credential names that don't follow the suffix pattern: bare names, and what the provider plugins
 * (core/src/plugin/provider/*) read for AWS Bedrock and Google Vertex. */
export const credentialNames: ReadonlySet<string> = new Set([
  "TOKEN",
  "API_KEY",
  "APIKEY",
  "PASSWORD",
  "SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
])

/** Kete's own credential: removed from every agent subprocess, interactive or not. */
export function isKeteCredential(name: string): boolean {
  const upper = name.toUpperCase()
  if (keteExplicit.has(upper)) return true
  if (!ketePrefixes.some((prefix) => upper.startsWith(prefix))) return false
  return keteCredentialSuffixes.some((suffix) => upper.endsWith(suffix))
}

/** A name that looks like a credential (provider key, token, password), removed in an unattended run. */
export function isCredential(name: string): boolean {
  const upper = name.toUpperCase()
  return isKeteCredential(upper) || credentialNames.has(upper) || credentialSuffixes.some((suffix) => upper.endsWith(suffix))
}

export interface Options {
  /** An unattended run (ADR 0008) or job mode: credentials are removed, not only Kete's own. */
  readonly unattended: boolean
  /** `kete.unattended.passEnv`: names an unattended run keeps although they look like credentials. */
  readonly passEnv?: ReadonlyArray<string>
  /** Defaults to `process.platform`; Windows compares `passEnv` case-insensitively. */
  readonly platform?: NodeJS.Platform
}

/** A copy of `env` without the variables `options` says a subprocess must not see. */
export function filter(env: Environment, options: Options): Environment {
  const windows = (options.platform ?? process.platform) === "win32"
  const pass = new Set((options.passEnv ?? []).map((name) => (windows ? name.toUpperCase() : name)))
  const result: Environment = {}
  for (const [name, value] of Object.entries(env)) {
    if (isKeteCredential(name)) continue
    if (options.unattended && isCredential(name) && !pass.has(windows ? name.toUpperCase() : name)) continue
    result[name] = value
  }
  return result
}

/** The always-applied part: Kete's own credentials removed, everything else kept. */
export function withoutKeteCredentials(env: Environment): Environment {
  return filter(env, { unattended: false })
}

/** What `forSession` needs: the session lookup `KeteUnattendedPolicy.resolve` walks, the `kete`
 * config (for `passEnv`), and the process environment job mode is read from. */
export interface Lookup {
  readonly session: KeteUnattendedPolicy.Get
  readonly config: Effect.Effect<ConfigKete.Info | undefined>
  readonly processEnv?: Environment
  readonly platform?: NodeJS.Platform
}

/** `env` filtered for a command the agent runs in `sessionID`: unattended if the session family is
 * (ADR 0008) or the process is in job mode, interactive otherwise. */
export const forSession = Effect.fnUntraced(function* (lookup: Lookup, sessionID: SessionSchema.ID, env: Environment) {
  const jobMode = KeteJobMode.enabled(lookup.processEnv ?? process.env)
  const state = jobMode ? undefined : yield* KeteUnattendedPolicy.resolve(lookup.session, sessionID)
  const unattended = jobMode || state?.kind === "unattended"
  const passEnv = unattended ? (yield* lookup.config)?.unattended?.passEnv : undefined
  return filter(env, { unattended, passEnv, platform: lookup.platform })
})
