// Offline mode in the CLI (docs/local-models.md). ./offline-startup.ts runs `apply` once, right after
// the KETE_* env bridge and before any other module reads the environment, so the decision is made
// once per process and inherited by any `kete serve` it starts:
//
// - `--offline` (before a `--`), `KETE_OFFLINE` (bridged to OPENCODE_OFFLINE) or `kete.offline` in
//   the global config turns it on. An invalid KETE_OFFLINE value or a non-boolean `kete.offline`
//   counts as on: offline fails closed, a typo never silently puts a user back online.
// - When on, the existing upstream switches OPENCODE_DISABLE_MODELS_FETCH (models.dev) and
//   OPENCODE_DISABLE_AUTOUPDATE (update checks) are set too, so neither needs new code.
// - `connection` makes every command use a private server: the background service may have been
//   started online. `--server` is refused, because the client can't check a remote server's mode.
// - `refused` is how a command that needs the network (login, sync, upgrade, models pull) stops.
//
// Nothing here loosens a rule: offline only removes things (models, servers, tools, network calls).

export * as KeteCliOffline from "./offline"

import { KeteOffline } from "@opencode/util/kete/offline"
import { parse, type ParseError } from "jsonc-parser"
import { EOL } from "node:os"

export type Environment = Record<string, string | undefined>

/** What the global config says about `kete.offline`: unset, a boolean, or something else (fails closed). */
export type ConfigValue = "unset" | "on" | "off"

/** Whether `--offline` is among the arguments, ignoring everything after a `--`. */
export function flagged(argv: readonly string[]): boolean {
  for (const argument of argv) {
    if (argument === "--") return false
    if (argument === "--offline" || argument === "--offline=true") return true
  }
  return false
}

/** Reads `kete.offline` from one config file's text. Unparseable files and absent keys are "unset". */
export function configValue(text: string): ConfigValue {
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || typeof input !== "object" || input === null || !("kete" in input)) return "unset"
  const kete = input.kete
  if (typeof kete !== "object" || kete === null || !("offline" in kete)) return "unset"
  const value = kete.offline
  if (value === undefined) return "unset"
  return value === false ? "off" : "on"
}

/** The last file that sets `kete.offline` decides, as when the runtime merges the global config files. */
export function fromConfig(texts: readonly (string | undefined)[]): boolean {
  const values = texts.map((text) => (text === undefined ? "unset" : configValue(text))).filter((v) => v !== "unset")
  return values.at(-1) === "on"
}

/** Decides offline mode and, when on, sets the switches in `env` (in place). Returns whether it is on. */
export function apply(env: Environment, argv: readonly string[], readConfig: () => readonly (string | undefined)[]): boolean {
  const on = KeteOffline.enabled(env) || flagged(argv) || fromConfig(readConfig())
  if (!on) return false
  // An invalid value already means "on"; keep it as it is so the runtime reports the same thing.
  if (!KeteOffline.enabled(env)) env[KeteOffline.variable] = "1"
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  return true
}

export type ConnectionArgs = { readonly server?: string; readonly standalone?: boolean }

export type Connection<Args extends ConnectionArgs> =
  | { readonly ok: true; readonly args: Omit<Args, "standalone"> & { readonly standalone?: boolean } }
  | { readonly ok: false; readonly message: string }

/** Offline: a private server, never the background service, and never a remote `--server`. */
export function connection<Args extends ConnectionArgs>(args: Args, env: Environment = process.env): Connection<Args> {
  if (!KeteOffline.enabled(env)) return { ok: true, args }
  if (args.server !== undefined)
    return {
      ok: false,
      message:
        "Offline mode is on, so --server can't be used: Kete Code can't check that a remote server is offline too. Drop --server to use a private server on this machine.",
    }
  return { ok: true, args: { ...args, standalone: true } }
}

/** When offline mode is on: prints the refusal for `command` to stderr, sets exit code 2 and returns true. */
export function refused(command: string, env: Environment = process.env, write: (text: string) => void = (text) => process.stderr.write(text)): boolean {
  if (!KeteOffline.enabled(env)) return false
  write(KeteOffline.refuse(command) + EOL)
  process.exitCode = 2
  return true
}
