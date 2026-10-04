// Runtime registration (kete-code-platform `PUT /api/v1/runtimes/{installation_id}`): the platform
// learns which runtime installations its organization runs, where, and at which version. Sent at
// startup when the version changed or a day has passed, and daily while running; never blocks or
// fails anything. Carries only the runtime type, version, OS, arch and the device name the user
// chose at `kete login`: never code, prompts, paths or secrets.
//
// The installation id is random, created once per data directory (<data>/installation.json, 0600).

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { KeteAccount } from "./account.js"

/** Where this runtime runs. */
export const runtimeTypes = ["local", "kete_cloud", "enterprise_private"] as const
export type RuntimeType = (typeof runtimeTypes)[number]

/** The KETE_* name; the env bridge renames it to OPENCODE_RUNTIME_TYPE before plugins run. */
export const runtimeTypeVariable = "OPENCODE_RUNTIME_TYPE"

export type ResolvedRuntimeType =
  | { readonly kind: "ok"; readonly type: RuntimeType; readonly source: "config" | "KETE_RUNTIME_TYPE" | "default" }
  | { readonly kind: "invalid"; readonly source: "config" | "KETE_RUNTIME_TYPE"; readonly value: string }

const truncate = (value: string) => (value.length > 50 ? `${value.slice(0, 50)}…` : value)

/**
 * The runtime type: a configured value wins, else KETE_RUNTIME_TYPE, else "local". An unknown
 * value at either source is reported as invalid rather than guessed at (CLAUDE.md §10); an empty
 * environment variable counts as unset.
 */
export function resolveRuntimeType(configured: unknown, environment: Record<string, string | undefined>): ResolvedRuntimeType {
  if (configured !== undefined) {
    if (typeof configured === "string" && (runtimeTypes as readonly string[]).includes(configured))
      return { kind: "ok", type: configured as RuntimeType, source: "config" }
    return { kind: "invalid", source: "config", value: truncate(String(configured)) }
  }
  const variable = environment[runtimeTypeVariable]
  if (!variable) return { kind: "ok", type: "local", source: "default" }
  if ((runtimeTypes as readonly string[]).includes(variable)) return { kind: "ok", type: variable as RuntimeType, source: "KETE_RUNTIME_TYPE" }
  return { kind: "invalid", source: "KETE_RUNTIME_TYPE", value: truncate(variable) }
}

export type Options = KeteAccount.Options & {
  readonly version: string
  readonly runtimeType?: RuntimeType
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  readonly now?: () => Date
  /** Re-register after this long even when nothing changed. */
  readonly every?: number
}

export type Outcome =
  | { readonly kind: "signed-out" }
  | { readonly kind: "skipped"; readonly installation: string }
  | { readonly kind: "registered"; readonly installation: string }
  | { readonly kind: "failed"; readonly installation: string; readonly error: string }

const State = Schema.Struct({
  installation_id: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
  /** What was last registered, so an unchanged runtime registers at most daily. */
  registered: Schema.optional(
    Schema.Struct({
      at: Schema.String,
      version: Schema.String,
      organization: Schema.String,
      key_id: Schema.String,
      /** Missing means "local": installation.json files written before this field existed. */
      runtime_type: Schema.optional(Schema.String),
    }),
  ),
})
type State = typeof State.Type

const DAY = 24 * 60 * 60 * 1000
const timeout = 10_000

export function file(options: Pick<Options, "data">) {
  return path.join(options.data, "installation.json")
}

async function readState(options: Pick<Options, "data">): Promise<State | undefined> {
  const text = await readFile(file(options), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(State))(text)
  return decoded._tag === "Some" ? decoded.value : undefined
}

async function writeState(options: Pick<Options, "data">, state: State) {
  const target = file(options)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  await rename(temporary, target)
}

/** This installation's id, created on first use. */
export async function installation(options: Pick<Options, "data">): Promise<State> {
  const state = await readState(options)
  if (state) return state
  const created: State = { installation_id: randomUUID() }
  await writeState(options, created)
  return created
}

export function platformOS(platform: NodeJS.Platform = process.platform) {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other"
}

/** Registers if signed in and due; reports what happened and never throws. */
export async function register(options: Options): Promise<Outcome> {
  const account = await KeteAccount.read(options).catch(() => undefined)
  if (!account) return { kind: "signed-out" }
  const state = await installation(options)
  const now = options.now?.() ?? new Date()
  const last = state.registered
  const due =
    !last ||
    last.version !== options.version ||
    last.organization !== account.organization.id ||
    last.key_id !== account.key_id ||
    (last.runtime_type ?? "local") !== (options.runtimeType ?? "local") ||
    now.getTime() - Date.parse(last.at) >= (options.every ?? DAY) ||
    Number.isNaN(Date.parse(last.at))
  if (!due) return { kind: "skipped", installation: state.installation_id }

  const key = await KeteAccount.key(options, account).catch(() => undefined)
  if (key === undefined) return { kind: "failed", installation: state.installation_id, error: "the account key is missing" }
  const send = options.fetch ?? fetch
  const response = await send(`${account.platform_url}/api/v1/runtimes/${state.installation_id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      runtime_type: options.runtimeType ?? "local",
      // The contract's version pattern; anything else (a local build's odd version) is reported as-is but trimmed.
      version: options.version.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 50) || "unknown",
      os: platformOS(),
      arch: process.arch.replace(/[^a-z0-9_]/g, "").slice(0, 20) || "unknown",
      device_name: account.device_name.slice(0, 100),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (response instanceof Error)
    return { kind: "failed", installation: state.installation_id, error: `could not reach ${account.platform_url}` }
  await response.body?.cancel().catch(() => undefined)
  // An older platform without the endpoint: nothing to register with; try again tomorrow.
  if (response.status === 404 || !response.ok)
    return {
      kind: "failed",
      installation: state.installation_id,
      error: `the platform answered HTTP ${response.status}${response.headers.get("x-kete-request-id") ? ` (request ${response.headers.get("x-kete-request-id")})` : ""}`,
    }
  await writeState(options, {
    installation_id: state.installation_id,
    registered: {
      at: now.toISOString(),
      version: options.version,
      organization: account.organization.id,
      key_id: account.key_id,
      runtime_type: options.runtimeType ?? "local",
    },
  })
  return { kind: "registered", installation: state.installation_id }
}

export * as KeteRuntimeRegistration from "./runtime-registration.js"
