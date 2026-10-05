// `kete mcp add harness|slack` and `kete mcp presets` (docs/integrations/). A preset expands to an
// ordinary MCP server entry plus permission rules (@opencode/schema/kete/mcp-presets) and is written
// into the same config file upstream's `kete mcp add` writes to. The flows run over an injected `IO`
// so tests need no terminal, OS secret store or server.
//
// Secrets: the Harness API key goes straight from the hidden prompt to the OS secret store; config
// gets only `{kete-secret:mcp:harness}`. The key is never printed, logged or put in an error. The
// store also keeps a fingerprint of the server definition written to config, and the runtime only
// releases the key to that exact definition (util/src/kete/mcp-secret.ts). Re-running the command
// (e.g. with another `--org`) reuses the stored key and re-binds it; `--new-key` asks for a new one.

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { KeteMcpPresets } from "@opencode/schema/kete/mcp-presets"
import type { Permission } from "@opencode/schema/permission"
import { KeteMcpSecret } from "@opencode/util/kete/mcp-secret"
import { KeteOffline } from "@opencode/util/kete/offline"

export type SignInResult =
  | { readonly status: "complete" }
  | { readonly status: "failed" | "expired" | "cancelled" | "timeout" | "unavailable"; readonly message?: string }

export interface IO {
  readonly print: (line: string) => void
  readonly warn: (line: string) => void
  readonly environment: Record<string, string | undefined>
  /** Whether a hidden prompt can be shown (stdin and stdout are terminals). */
  readonly interactive: boolean
  /** Hidden input; `undefined` when the user cancelled. */
  readonly promptSecret: (message: string) => Promise<string | undefined>
  /** Stores `secret` for `server`, bound to `definition`, in the OS secret store (or its fallback file). */
  readonly saveSecret: (
    server: string,
    secret: string,
    definition: KeteMcpSecret.LocalDefinition,
  ) => Promise<{ readonly description: string; readonly fallback: boolean }>
  /** The secret already stored for `server`, if any. */
  readonly storedSecret: (server: string) => Promise<string | undefined>
  readonly readText: (file: string) => Promise<string | undefined>
  readonly writeText: (file: string, text: string) => Promise<void>
  /** `kete.integrations.slack.clientId` from the project or global config, with where it was found. */
  readonly configuredSlackClientId: () => Promise<ConfiguredClientId | undefined>
  /** The organization's Slack app from the last platform sync, when there is one. */
  readonly syncedSlackClientId: () => Promise<string | undefined>
  /** Runs the server's OAuth sign-in through the local runtime (upstream's `kete mcp auth` flow). */
  readonly signIn: (server: string) => Promise<SignInResult>
}

export interface ConfiguredClientId {
  readonly clientId: string
  readonly scope: "project" | "global"
  readonly file: string
}

export interface Input {
  readonly name: KeteMcpPresets.Name
  readonly configPath: string
  readonly write: boolean
  readonly org?: string
  readonly project?: string
  readonly baseUrl?: string
  readonly clientId?: string
  /** Harness: ask for a new API key even when one is stored. */
  readonly newKey?: boolean
}

/** 0 done, 1 failed, 2 refused before writing anything (missing input), 130 cancelled. */
export type Exit = 0 | 1 | 2 | 130

/** Flags that only presets take. */
export function presetFlags(input: Omit<Input, "name" | "configPath">): string[] {
  return [
    input.write ? "--write" : undefined,
    input.org !== undefined ? "--org" : undefined,
    input.project !== undefined ? "--project" : undefined,
    input.baseUrl !== undefined ? "--base-url" : undefined,
    input.clientId !== undefined ? "--client-id" : undefined,
    input.newKey ? "--new-key" : undefined,
  ].filter((flag): flag is string => flag !== undefined)
}

export type Route =
  | { readonly kind: "server" }
  | { readonly kind: "preset"; readonly name: KeteMcpPresets.Name }
  | { readonly kind: "error"; readonly message: string }

/**
 * What `kete mcp add <name>` means: a preset when `<name>` is one and no `--url` or command is given;
 * otherwise upstream's own server entry. Preset flags anywhere else are an error, never ignored.
 */
export function route(name: string, hasServer: boolean, flags: readonly string[]): Route {
  const preset = KeteMcpPresets.find(name)
  if (preset && !hasServer) {
    const foreign = flags.filter((flag) => !allowed[preset.name].includes(flag))
    if (foreign.length > 0)
      return { kind: "error", message: `${foreign.join(", ")} ${foreign.length === 1 ? "doesn't" : "don't"} apply to the ${preset.name} preset` }
    return { kind: "preset", name: preset.name }
  }
  if (flags.length > 0)
    return {
      kind: "error",
      message: `${flags.join(", ")} only ${flags.length === 1 ? "applies" : "apply"} to the built-in presets (${KeteMcpPresets.catalogue.map((item) => item.name).join(", ")}), added without --url or a command`,
    }
  return { kind: "server" }
}

const allowed: Record<KeteMcpPresets.Name, readonly string[]> = {
  harness: ["--write", "--org", "--project", "--base-url", "--new-key"],
  slack: ["--client-id"],
}

export async function add(io: IO, input: Input): Promise<Exit> {
  return input.name === "harness" ? addHarness(io, input) : addSlack(io, input)
}

function offline(io: IO) {
  return KeteOffline.enabled(io.environment)
}

const offlineNote = (name: string) =>
  `Offline mode is on: the ${name} server is skipped until offline mode is off (it needs the network).`

async function addHarness(io: IO, input: Input): Promise<Exit> {
  const options = { write: input.write, org: input.org, project: input.project, baseUrl: input.baseUrl }
  // Check the flags before asking for the key.
  try {
    KeteMcpPresets.harness({ ...options, apiKey: "{env:HARNESS_API_KEY}" })
  } catch (error) {
    io.warn(message(error))
    return 2
  }

  // A stored key is reused (re-running to change an option shouldn't need it again) unless --new-key.
  let secret: { readonly value: string; readonly reused: boolean } | undefined
  if (!input.newKey) {
    const existing = await io.storedSecret("harness").catch((error: unknown) => {
      io.warn(`The stored Harness API key could not be read (${message(error)}); enter it again.`)
      return undefined
    })
    if (existing !== undefined) secret = { value: existing, reused: true }
  }
  if (secret === undefined && io.interactive) {
    const entered = await io.promptSecret("Harness API key (a personal access or service account token; input is hidden)")
    if (entered === undefined) return 130
    const trimmed = entered.trim()
    if (trimmed === "") {
      io.warn("No API key entered; nothing was changed.")
      return 2
    }
    if (!KeteMcpSecret.storable(trimmed)) {
      io.warn("That API key has characters Kete Code can't store (spaces, quotes, backslashes or non-ASCII); nothing was changed.")
      return 2
    }
    secret = { value: trimmed, reused: false }
  }
  if (secret === undefined && !io.environment.HARNESS_API_KEY) {
    io.warn(
      "kete mcp add harness needs a terminal to read the API key (hidden input), or HARNESS_API_KEY set in the environment the runtime starts with.",
    )
    return 2
  }

  const expansion = KeteMcpPresets.harness({
    ...options,
    apiKey: secret ? KeteMcpSecret.reference("harness") : "{env:HARNESS_API_KEY}",
  })
  let stored: { description: string; fallback: boolean } | undefined
  if (secret) {
    if (expansion.server.type !== "local") throw new Error("The Harness preset must expand to a local server")
    try {
      // Bound to exactly the definition written below; the runtime refuses any other.
      stored = await io.saveSecret("harness", secret.value, expansion.server)
    } catch (error) {
      io.warn(message(error))
      return 1
    }
  }
  try {
    await writeConfig(io, input.configPath, "harness", expansion)
  } catch (error) {
    io.warn(message(error))
    return 1
  }

  io.print(`MCP server "harness" added to ${input.configPath} (${KeteMcpPresets.harnessPackage}@${KeteMcpPresets.harnessVersion}).`)
  if (stored && secret?.reused) {
    io.print(
      `Reusing the API key already stored in ${stored.description}, now bound to this server definition (use --new-key to replace it).`,
    )
    if (stored.fallback) io.warn("No OS credential store was available, so the key is in a file only you can read.")
  } else if (stored) {
    io.print(`API key stored in ${stored.description}; the config refers to it, it isn't in the file.`)
    if (stored.fallback) io.warn("No OS credential store was available, so the key is in a file only you can read.")
  } else {
    io.print("The API key comes from HARNESS_API_KEY in the runtime's environment.")
  }
  io.print(
    input.write
      ? "Read-only mode is off: create, update, delete and execute tools are available and ask before each use."
      : "Read-only: the server can't create, update, delete or execute anything. Add --write to allow it (each use still asks first).",
  )
  if (offline(io)) io.print(offlineNote("harness"))
  return 0
}

export const slackAppRequirement = [
  "Slack's MCP server only accepts Slack apps published in the Slack Marketplace or internal to your workspace,",
  "and a workspace admin must approve the app. Create or pick such an app, then run:",
  "  kete mcp add slack --client-id <the app's client ID>",
  "or set kete.integrations.slack.clientId in your config. See docs/integrations/slack.md.",
].join("\n")

async function addSlack(io: IO, input: Input): Promise<Exit> {
  const source = await slackClientId(io, input)
  if (source === undefined) {
    io.warn("No Slack app client ID.")
    for (const line of slackAppRequirement.split("\n")) io.print(line)
    return 2
  }
  const clientId = source.clientId
  let expansion: KeteMcpPresets.Expansion
  try {
    expansion = KeteMcpPresets.slack({ clientId })
  } catch (error) {
    io.warn(message(error))
    return 2
  }
  // Shown before anything is written or signed in to: a project's config (or the organization) chose
  // this app, and signing in grants it access to your Slack.
  io.print(`Slack app client ID: ${clientId} (${source.from})`)
  try {
    await writeConfig(io, input.configPath, "slack", expansion)
  } catch (error) {
    io.warn(message(error))
    return 1
  }
  io.print(`MCP server "slack" added to ${input.configPath}.`)
  if (offline(io)) {
    io.print(offlineNote("slack"))
    io.print("Sign in later with: kete mcp auth slack")
    return 0
  }
  io.print("Signing in to Slack...")
  const result = await io.signIn("slack")
  if (result.status === "complete") {
    io.print("Signed in to Slack. Searching and reading are allowed; sending, posting and creating ask first.")
    return 0
  }
  io.warn(`Slack sign-in ${result.status}${result.message ? `: ${result.message}` : ""}`)
  io.print("The server is configured; retry the sign-in with: kete mcp auth slack")
  io.print(
    "If Slack rejects the token exchange, the app may need PKCE turned on (Slack otherwise requires its client secret, which Kete Code doesn't store in config). See docs/integrations/slack.md.",
  )
  return 1
}

async function slackClientId(io: IO, input: Input): Promise<{ readonly clientId: string; readonly from: string } | undefined> {
  if (input.clientId !== undefined) return { clientId: input.clientId, from: "from --client-id" }
  const configured = await io.configuredSlackClientId()
  if (configured)
    return { clientId: configured.clientId, from: `from ${configured.scope} config ${configured.file}` }
  const synced = await io.syncedSlackClientId()
  if (synced !== undefined) return { clientId: synced, from: "synced from your organization" }
  return undefined
}

/** Writes the server and merges its permission rules into a JSONC config, keeping comments and formatting. */
export async function writeConfig(
  io: Pick<IO, "readText" | "writeText" | "warn">,
  file: string,
  name: string,
  expansion: KeteMcpPresets.Expansion,
) {
  const text = (await io.readText(file)) ?? "{}"
  const result = edit(text, file, name, expansion)
  await io.writeText(file, result.text)
  for (const rule of result.replaced)
    io.warn(
      `Replaced your permission rule allowing ${rule.action} with the preset's "${expansion.permissions.findLast((item) => item.action === rule.action)?.effect ?? "ask"}"; add it back after the preset's rules if you want it.`,
    )
}

export function edit(
  text: string,
  file: string,
  name: string,
  expansion: KeteMcpPresets.Expansion,
): { readonly text: string; readonly replaced: Permission.Rule[] } {
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} isn't a valid JSON config object; fix it and try again`)
  const current = "permissions" in parsed ? parsed.permissions : undefined
  if (current !== undefined && !Array.isArray(current)) throw new Error(`"permissions" in ${file} isn't a list; fix it and try again`)
  const entries: unknown[] = current ?? []
  // Every entry must be a rule: dropping one silently would lose a user's permission setting.
  if (!entries.every(isRule)) throw new Error(`"permissions" in ${file} has an entry that isn't a valid rule; fix it and try again`)
  const existing = entries.filter(isRule)
  const formatting = { formattingOptions: { tabSize: 2, insertSpaces: true } }
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown
  const merged = KeteMcpPresets.mergePermissions(existing, expansion.permissions)
  let next = applyEdits(text, modify(text, ["mcp", "servers", name], plain(expansion.server), formatting))
  next = applyEdits(next, modify(next, ["permissions"], plain(merged.rules), formatting))
  return { text: next, replaced: merged.replaced }
}

function isRule(value: unknown): value is Permission.Rule {
  if (typeof value !== "object" || value === null) return false
  const rule = value as Record<string, unknown>
  return (
    typeof rule.action === "string" &&
    typeof rule.resource === "string" &&
    (rule.effect === "allow" || rule.effect === "ask" || rule.effect === "deny")
  )
}

/** `kete mcp presets`. */
export function list(io: Pick<IO, "print" | "environment">) {
  const off = KeteOffline.enabled(io.environment)
  const width = Math.max(...KeteMcpPresets.catalogue.map((preset) => preset.name.length))
  for (const preset of KeteMcpPresets.catalogue) {
    io.print(`${preset.name.padEnd(width)}  ${preset.transport.padEnd(6)}  ${preset.description}${off ? " [skipped: offline mode]" : ""}`)
  }
  io.print("")
  io.print("Add one with: kete mcp add <preset>   Docs: docs/integrations/<preset>.md")
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as KeteMcpPreset from "./mcp-preset"
