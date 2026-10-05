// Built-in MCP presets (docs/integrations/): named templates that expand to ordinary MCP server
// config entries (upstream's `mcp.servers` format) plus permission rules (upstream's top-level
// `permissions`). Nothing about a preset is special at runtime: `kete mcp add <preset>` writes the
// expansion into config, and the runtime treats it like any other server.
//
// Lives in @opencode/schema so both the CLI (which writes the expansion) and core (offline mode's
// skip) can use it; the CLI doesn't depend on core.
//
// Safety defaults (spec docs/tasks/2026-10-05-mcp-presets):
// - Harness runs an exact pinned version of the official npm package, never `@latest`, read-only
//   unless `--write`. Its write and execute tools stay on `ask` even with `--write`.
// - Every tool from a preset server asks first unless it is known to be read-only: the rules start
//   with a catch-all `ask` for the server, then `allow` the known read tools, then `ask` the known
//   write tools again (permission rules: last match wins).

export * as KeteMcpPresets from "./mcp-presets.js"

import { Schema } from "effect"
import { Mcp } from "../mcp.js"
import { Permission } from "../permission.js"

export type Name = "harness" | "slack"

/** The official Harness MCP server (MIT, github.com/harness/mcp-server). Upgrade by changing this pin. */
export const harnessPackage = "harness-mcp-v2"
export const harnessVersion = "3.2.32"
export const harnessDefaultBaseUrl = "https://app.harness.io"

/** Slack's official remote MCP server (OAuth v2 user flow, PKCE). */
export const slackUrl = "https://mcp.slack.com/mcp"
/** A fixed loopback redirect, so the Slack app can list it exactly (upstream's default port is random). */
export const slackRedirectUri = "http://127.0.0.1:34561/callback"

/** Permission actions for MCP tools are `<server>_<tool>` (core/src/tool/mcp.ts `name`). */
export const action = (server: string, tool: string) =>
  `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

export const harnessReadTools = [
  "harness_describe",
  "harness_schema",
  "harness_list",
  "harness_get",
  "harness_search",
  "harness_diagnose",
  "harness_status",
] as const
export const harnessWriteTools = ["harness_create", "harness_update", "harness_delete", "harness_execute"] as const

// Slack's tool names from its published tool list (docs.slack.dev/ai/slack-mcp-server). Slack may
// add or rename tools; anything not listed here falls under the catch-all `ask`.
export const slackReadTools = [
  "slack_search_public",
  "slack_search_public_and_private",
  "slack_search_channels",
  "slack_search_users",
  "slack_read_channel",
  "slack_read_thread",
  "slack_read_canvas",
  "slack_read_user_profile",
] as const
export const slackWriteTools = [
  "slack_send_message",
  "slack_send_message_draft",
  "slack_schedule_message",
  "slack_create_canvas",
  "slack_update_canvas",
  "slack_get_file_upload_url",
  "slack_complete_file_upload",
] as const

export interface Preset {
  readonly name: Name
  readonly title: string
  readonly description: string
  readonly transport: "local" | "remote"
  /** Every preset reaches the internet, so offline mode skips it. */
  readonly network: true
  readonly docs: string
}

export const catalogue: readonly Preset[] = [
  {
    name: "harness",
    title: "Harness",
    description: `Harness pipelines, deployments and more (official server, ${harnessPackage}@${harnessVersion}); read-only unless --write`,
    transport: "local",
    network: true,
    docs: "docs/integrations/harness.md",
  },
  {
    name: "slack",
    title: "Slack",
    description: "Search and read Slack; sending and posting ask first (Slack's remote server, OAuth sign-in)",
    transport: "remote",
    network: true,
    docs: "docs/integrations/slack.md",
  },
]

export function find(name: string): Preset | undefined {
  return catalogue.find((preset) => preset.name === name)
}

export interface Expansion {
  readonly server: Mcp.ServerConfig
  readonly permissions: Permission.Ruleset
}

const decodeServer = Schema.decodeUnknownSync(Mcp.ServerConfig)
const decodeRules = Schema.decodeUnknownSync(Permission.Ruleset)

const rule = (actionName: string, effect: Permission.Effect): Permission.Rule => ({
  action: actionName,
  resource: "*",
  effect,
})

function rules(server: string, reads: readonly string[], writes: readonly string[]): Permission.Ruleset {
  return decodeRules([
    rule(`${action(server, "")}*`, "ask"),
    ...reads.map((tool) => rule(action(server, tool), "allow")),
    ...writes.map((tool) => rule(action(server, tool), "ask")),
  ])
}

/** The preset's permission rules for a server named `server` (the preset's own name by default). */
export function permissions(name: Name, server: string = name): Permission.Ruleset {
  return name === "harness"
    ? rules(server, harnessReadTools, harnessWriteTools)
    : rules(server, slackReadTools, slackWriteTools)
}

const identifier = /^[A-Za-z0-9_-]{1,128}$/
const toolsets = /^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$/

export interface HarnessOptions {
  /** The HARNESS_API_KEY value: a stored-secret reference or `{env:HARNESS_API_KEY}`, never the key itself. */
  readonly apiKey: string
  readonly write?: boolean
  readonly org?: string
  readonly project?: string
  readonly baseUrl?: string
  readonly accountId?: string
  readonly toolsets?: string
}

export function harness(options: HarnessOptions): Expansion {
  if (options.org !== undefined && !identifier.test(options.org))
    throw new Error("--org must be a Harness identifier (letters, digits, _ and -)")
  if (options.project !== undefined && !identifier.test(options.project))
    throw new Error("--project must be a Harness identifier (letters, digits, _ and -)")
  if (options.accountId !== undefined && !identifier.test(options.accountId))
    throw new Error("The Harness account ID must contain only letters, digits, _ and -")
  if (options.toolsets !== undefined && !toolsets.test(options.toolsets))
    throw new Error("Harness toolsets must be a comma-separated list of names")
  if (options.baseUrl !== undefined) {
    const url = URL.canParse(options.baseUrl) ? new URL(options.baseUrl) : undefined
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
      throw new Error("--base-url must be an http(s) URL without credentials, e.g. https://harness.example.com")
  }
  const environment: Record<string, string> = {
    HARNESS_API_KEY: options.apiKey,
    HARNESS_READ_ONLY: options.write ? "false" : "true",
    // Always explicit, so the server never falls back to a base URL from elsewhere (e.g. a `.env`) and the
    // stored key's fingerprint covers where it is sent.
    HARNESS_BASE_URL: (options.baseUrl ?? harnessDefaultBaseUrl).replace(/\/+$/, ""),
    ...(options.accountId ? { HARNESS_ACCOUNT_ID: options.accountId } : {}),
    ...(options.org ? { HARNESS_ORG: options.org } : {}),
    ...(options.project ? { HARNESS_PROJECT: options.project } : {}),
    ...(options.toolsets ? { HARNESS_TOOLSETS: options.toolsets } : {}),
  }
  return {
    server: decodeServer({ type: "local", command: ["npx", "-y", `${harnessPackage}@${harnessVersion}`], environment }),
    permissions: permissions("harness"),
  }
}

/** Slack app client IDs look like `1234567890.1234567890123`. */
const clientIdPattern = /^[A-Za-z0-9._-]{1,128}$/

export function validClientId(value: string): boolean {
  return clientIdPattern.test(value)
}

export function slack(options: { readonly clientId: string }): Expansion {
  if (!validClientId(options.clientId)) throw new Error("The Slack client ID must contain only letters, digits, ., _ and -")
  return {
    // No client secret: Kete Code never writes one into config. The sign-in uses PKCE with the client ID.
    server: decodeServer({
      type: "remote",
      url: slackUrl,
      oauth: { client_id: options.clientId, redirect_uri: slackRedirectUri },
    }),
    permissions: permissions("slack"),
  }
}

/** Which preset a configured server came from, by its signature (the pinned package, or Slack's URL). */
export function detect(server: {
  readonly type: string
  readonly command?: readonly string[]
  readonly url?: string
}): Name | undefined {
  if (server.type === "local" && server.command)
    return server.command.some((part) => part === harnessPackage || part.startsWith(`${harnessPackage}@`))
      ? "harness"
      : undefined
  if (server.type === "remote" && server.url !== undefined && URL.canParse(server.url))
    return new URL(server.url).host === new URL(slackUrl).host ? "slack" : undefined
  return undefined
}

/** What offline mode says about the preset servers it skipped. */
export function offlineMessage(servers: readonly string[]): string {
  return `Offline mode: skipped MCP server${servers.length === 1 ? "" : "s"} ${servers.map((name) => `"${name}"`).join(", ")} (built-in preset${servers.length === 1 ? "" : "s"} that need${servers.length === 1 ? "s" : ""} the network). Turn offline mode off to use ${servers.length === 1 ? "it" : "them"}.`
}

const strictness: Record<Permission.Effect, number> = { allow: 0, ask: 1, deny: 2 }

export interface Merged {
  readonly rules: Permission.Rule[]
  /** The user's `allow` rules the preset replaced with a stricter rule of its own (worth a warning). */
  readonly replaced: Permission.Rule[]
}

/**
 * Merges a preset's rules into a config's `permissions`. For each action the preset sets:
 * - an existing rule on the same action with a narrower resource, or stricter than the preset's (a
 *   `deny`, or an `ask` where the preset allows), is the user's choice: it is kept and moved after the
 *   preset's rules so it still wins (permission rules: last match wins);
 * - an existing `resource: "*"` rule as strict as the preset's is an earlier copy and is dropped, so
 *   re-running `kete mcp add` never duplicates rules;
 * - an existing `resource: "*"` `allow` where the preset asks is replaced and reported in `replaced`.
 * Rules for other actions keep their place and order.
 */
export function mergePermissions(existing: readonly Permission.Rule[], added: Permission.Ruleset): Merged {
  const preset = new Map(added.map((item) => [item.action, item.effect]))
  const before: Permission.Rule[] = []
  const after: Permission.Rule[] = []
  const replaced: Permission.Rule[] = []
  for (const item of existing) {
    const effect = preset.get(item.action)
    if (effect === undefined) before.push(item)
    else if (item.resource !== "*" || strictness[item.effect] > strictness[effect]) after.push(item)
    else if (strictness[item.effect] < strictness[effect]) replaced.push(item)
  }
  return { rules: [...before, ...added, ...after], replaced }
}
