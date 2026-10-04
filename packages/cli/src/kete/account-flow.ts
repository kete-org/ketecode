// `kete login`, `kete logout` and `kete whoami`, as plain functions over injected I/O so tests can run
// them end to end against a fake platform. The Effect handlers in ./login.ts etc. supply the real I/O.
//
// Nothing here prints, logs or throws the API key: output goes through `print`/`warn` with fixed text
// plus non-secret account details, and every error message is built from non-secret values.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { Brand } from "@opencode/util/kete/brand"
import { KeteAccount } from "@opencode/util/kete/account"
import { KeteRuntimeRegistration } from "@opencode/util/kete/runtime-registration"
import { KeteSyncApprovals } from "@opencode/util/kete/sync/approvals"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { KeteSyncMcpStatus } from "@opencode/util/kete/sync/mcp-status"
import { KeteSync } from "@opencode/util/kete/sync/sync"
import { CliLogin } from "./cli-login"

export type IO = {
  readonly print: (line: string) => void
  readonly warn: (line: string) => void
  readonly account: KeteAccount.Options
  /** Environment after the KETE_* → OPENCODE_* bridge. */
  readonly environment: Record<string, string | undefined>
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** Asks a running background service to pick up the change; returns whether one was running. */
  readonly reload: () => Promise<boolean>
}

export const platformVariable = "OPENCODE_PLATFORM_URL"
const gatewayVariables = ["OPENCODE_GATEWAY_URL", "OPENCODE_GATEWAY_KEY"] as const

export async function login(
  io: IO,
  input: {
    platformURL?: string
    port?: number
    /** Opens the authorize URL in a browser; `undefined` when the user asked not to. */
    open?: (url: string) => Promise<void>
    timeout?: number
    ssh: boolean
  },
) {
  const previous = await KeteAccount.read(io.account).catch(() => undefined)
  const platform = await resolvePlatform(io, input.platformURL, previous)
  const hand = await handConfigured(io)

  const verifier = CliLogin.pkce()
  const state = CliLogin.state()
  const device = CliLogin.deviceName()
  const callback = CliLogin.listen({ state, port: input.port, timeout: input.timeout })
  const url = CliLogin.authorizeURL({ platform, port: callback.port, state, challenge: verifier.challenge, device })

  io.print(`Signing in to ${Brand.displayName} at ${platform}`)
  if (previous) io.print(`You are signed in to ${previous.organization.name}; signing in again replaces that account.`)
  io.print("")
  io.print("Open this URL in your browser to approve the sign-in:")
  io.print(`  ${url}`)
  io.print("")
  if (input.ssh && input.port === undefined)
    io.print(
      `This looks like an SSH session. If your browser runs on another machine, cancel and run \`${Brand.cliName} login --port <port>\`, then forward it with \`ssh -L <port>:127.0.0.1:<port> <host>\`.`,
    )
  if (input.open) await input.open(url).catch(() => io.warn("Could not open a browser; open the URL above yourself."))
  io.print(`Waiting for approval (times out in ${Math.round((input.timeout ?? CliLogin.callbackTimeout) / 60_000)} minutes)...`)

  const token = await callback.code
    .then((code) => CliLogin.exchange({ platform, code, verifier: verifier.verifier, device, fetch: io.fetch }))
    .finally(callback.close)
  const saved = await KeteAccount.save(
    io.account,
    {
      platform_url: platform,
      gateway_url: token.gateway_url,
      organization: token.organization,
      key_id: token.key_id,
      device_name: device,
    },
    token.api_key,
  )

  // Replace, don't accumulate: revoke and forget the account this login replaced.
  if (previous && previous.key_id !== saved.account.key_id) await retire(io, previous)

  io.print(`Signed in to ${token.organization.name}.`)
  io.print(`The key is stored in ${saved.store.description}.`)
  if (saved.store.kind === "file")
    io.warn(
      `No OS credential store was available (${saved.skipped.map((item) => `${item.store.description}: ${item.reason}`).join("; ") || "none on this platform"}), so the key is in a file only you can read.`,
    )
  if (hand.length > 0)
    io.print(
      `Your hand-configured gateway settings (${hand.join(", ")}) are kept, but this account takes precedence while you are signed in.`,
    )
  // Bring the organization's managed agents down now, so they are there on the next start. A failure
  // only warns: the runtime syncs again at startup and every 5 minutes.
  const synced = await KeteSync.sync({ ...io.account, fetch: io.fetch })
  if (synced.kind === "updated" && synced.cached.response.agents.length > 0)
    io.print(`Synced ${count(synced.cached.response.agents.length)} managed by ${synced.cached.response.organization.name}.`)
  if (synced.kind === "failed") io.warn(`Could not sync your organization's agents yet: ${synced.error.message}`)
  await announceReload(io)
}

/** `kete sync`: brings the organization's managed agents down now. Throws when the sync fails. */
/** `kete sync`: brings the organization's managed agents, skills and MCP servers down now. Throws when the sync fails. */
export async function sync(io: IO, options: { approve?: string; command?: string } = {}) {
  if (options.command !== undefined && !options.approve)
    throw new CliLogin.LoginError("--command only goes with --approve <server>.")
  if (options.approve) return approve(io, options.approve, options.command)
  const outcome = await KeteSync.sync({ ...io.account, fetch: io.fetch })
  if (outcome.kind === "signed-out") {
    io.print(`Not signed in, so there are no managed agents. Run \`${Brand.cliName} login\` to sign in.`)
    return outcome
  }
  if (outcome.kind === "failed") {
    const kept = outcome.cached
      ? ` Still using the last copy (${count(outcome.cached.response.agents.length)}, synced ${outcome.cached.synced_at}).`
      : ""
    const reason = outcome.error.message.replace(/\.+$/, "")
    throw new CliLogin.LoginError(`Could not sync managed agents: ${reason}.${kept}`)
  }
  const response = outcome.cached.response
  const organization = response.organization.name
  const total = count(response.agents.length)
  if (outcome.kind === "unchanged") io.print(`Managed agents are up to date: ${total} from ${organization}.`)
  if (outcome.kind === "updated") {
    const changes = [
      outcome.changes.added.length > 0 ? `added ${outcome.changes.added.join(", ")}` : undefined,
      outcome.changes.updated.length > 0 ? `updated ${outcome.changes.updated.join(", ")}` : undefined,
      outcome.changes.removed.length > 0 ? `removed ${outcome.changes.removed.join(", ")}` : undefined,
    ].filter((item) => item !== undefined)
    io.print(`Synced ${total} from ${organization}${changes.length > 0 ? `: ${changes.join("; ")}` : ""}.`)
  }

  const skills = response.skills ?? []
  if (skills.length > 0 || outcome.skills.removed.length > 0) {
    const parts = [
      `${skills.length} skill${skills.length === 1 ? "" : "s"}`,
      outcome.skills.written.length > 0 ? `written ${outcome.skills.written.join(", ")}` : undefined,
      outcome.skills.removed.length > 0 ? `removed ${outcome.skills.removed.join(", ")}` : undefined,
    ].filter((item) => item !== undefined)
    io.print(`Skills: ${parts.join("; ")}.`)
  }
  for (const failed of outcome.skills.failed)
    io.warn(`The skill ${failed.slug} could not be downloaded (${failed.error}); the previous copy stays in use.`)

  const servers = response.mcp_servers ?? []
  if (servers.length > 0) {
    const approvals = await KeteSyncApprovals.read(io.account.config, response.organization.id)
    const statuses = servers.map((server) => KeteSyncMcpStatus.status(server, approvals))
    io.print(`MCP servers: ${statuses.map((item) => `${item.key}${item.enabled ? "" : " (off)"}`).join(", ")}.`)
    for (const item of statuses.filter((status) => status.note)) io.print(`  ${item.key}: ${item.note}.`)
  }

  const policies = response.policies ?? []
  if (policies.length > 0) {
    const enforced = policies.filter((policy) => policy.enforcement === "enforced")
    const audit = policies.filter((policy) => policy.enforcement === "audit_only")
    io.print(
      `Policies: ${[
        enforced.length > 0 ? `${enforced.length} enforced (${enforced.map((policy) => policy.name).join(", ")})` : undefined,
        audit.length > 0 ? `${audit.length} audit-only` : undefined,
      ]
        .filter((item) => item !== undefined)
        .join("; ")}.`,
    )
  }

  const changed = outcome.kind === "updated" || outcome.skills.written.length > 0 || outcome.skills.removed.length > 0
  if (changed) await announceReload(io)
  return outcome
}

/**
 * `kete sync --status`: the synced MCP servers and what each needs, from the cached sync (no network).
 * The JSON form is for editors (the VS Code extension's MCP view); it never contains a secret.
 */
export async function syncStatus(io: IO, options: { json: boolean }) {
  const loaded = await KeteSync.load(io.account)
  if (!loaded) {
    if (options.json) io.print(JSON.stringify({ signed_in: (await KeteAccount.read(io.account)) !== undefined, synced: false, servers: [] }))
    else io.print(`Nothing synced yet. Run \`${Brand.cliName} login\`, then \`${Brand.cliName} sync\`.`)
    return
  }
  const response = loaded.cached.response
  const approvals = await KeteSyncApprovals.read(io.account.config, response.organization.id)
  const servers = (response.mcp_servers ?? []).map((server) => {
    const status = KeteSyncMcpStatus.status(server, approvals)
    return {
      key: server.key,
      name: server.name,
      transport: server.transport,
      command: server.transport === "stdio" ? server.command : null,
      url: server.transport === "stdio" ? null : server.url,
      enabled: status.enabled,
      needs: status.needs ?? null,
      note: status.note ?? null,
    }
  })
  if (options.json) {
    io.print(
      JSON.stringify({
        signed_in: true,
        synced: true,
        organization: response.organization,
        synced_at: loaded.cached.synced_at,
        servers,
      }),
    )
    return
  }
  if (servers.length === 0) io.print(`${response.organization.name} manages no MCP servers.`)
  for (const server of servers)
    io.print(`${server.key} (${server.name}): ${server.enabled ? "on" : "off"}${server.note ? `; ${server.note}` : ""}`)
}

/** `kete sync --approve <key>`: lets a synced stdio MCP server run its current command on this machine. */
async function approve(io: IO, key: string, reviewed?: string) {
  const loaded = await KeteSync.load(io.account)
  if (!loaded) throw new CliLogin.LoginError(`Nothing to approve: sign in and run \`${Brand.cliName} sync\` first.`)
  const server = (loaded.cached.response.mcp_servers ?? []).find((item) => item.key === key)
  if (!server) throw new CliLogin.LoginError(`${loaded.cached.response.organization.name} has no synced MCP server named ${key}.`)
  if (server.transport !== "stdio" || !server.command)
    throw new CliLogin.LoginError(`${key} doesn't run a command on this machine, so it needs no approval.`)
  if (!KeteSyncMcpStatus.split(server.command))
    throw new CliLogin.LoginError(`${key}'s command can't be parsed, so it can't run: ${server.command}`)
  // An editor shows the command, then approves it: never approve a different one synced meanwhile.
  if (reviewed !== undefined && reviewed !== server.command)
    throw new CliLogin.LoginError(`${key}'s command changed since you reviewed it; nothing was approved. It is now: ${server.command}`)
  await KeteSyncApprovals.approve(io.account.config, loaded.cached.response.organization.id, key, server.command)
  io.print(`Approved ${server.name} (${key}) to run on this machine:`)
  io.print(`  ${server.command}`)
  io.print(`If ${loaded.cached.response.organization.name} changes this command, it will need your approval again.`)
  await announceReload(io)
  return { kind: "approved" as const }
}

function count(agents: number) {
  return `${agents} agent${agents === 1 ? "" : "s"}`
}

export async function logout(io: IO) {
  const account = await KeteAccount.read(io.account).catch((error: unknown) => {
    // An unreadable account.json is removed below; there is no key reference to revoke.
    io.warn(message(error))
    return undefined
  })
  if (!account) {
    const problems = await KeteAccount.clear(io.account, undefined)
    if (problems.length > 0) throw new CliLogin.LoginError(`Could not sign out: ${problems.join("; ")}`)
    io.print("Not signed in.")
    return
  }
  const revoked = await revokeKey(io, account)
  // The organization's managed agents go with the sign-in.
  const cache = await KeteSyncCache.remove(io.account.config, account.organization.id).then(
    () => [],
    (error: unknown) => [`the managed agents could not be removed: ${message(error)}`],
  )
  const problems = [...(await KeteAccount.clear(io.account, account)), ...cache]
  if (problems.length > 0)
    throw new CliLogin.LoginError(`Could not remove the local sign-in: ${problems.join("; ")}`)
  io.print(`Signed out of ${account.organization.name}. The key was removed from this device.`)
  if (revoked !== undefined)
    io.warn(
      `The platform could not revoke the key (${revoked}). It no longer exists on this device; to be sure it can't be used, revoke key ${account.key_id} from the ${Brand.displayName} portal at ${account.platform_url}.`,
    )
  await announceReload(io)
}

/**
 * The sign-in state as JSON, for editors and scripts: local state only (no network request, so it
 * is fast and works offline). Never contains the key.
 */
export async function whoamiJSON(io: IO) {
  const account = await KeteAccount.read(io.account)
  const hand = await handConfigured(io)
  io.print(
    JSON.stringify(
      account
        ? {
            signed_in: true,
            organization: account.organization,
            platform_url: account.platform_url,
            gateway_url: account.gateway_url,
            device_name: account.device_name,
            key_id: account.key_id,
            storage: account.storage,
            storage_description: KeteAccount.store(io.account, account.storage).description,
            signed_in_at: account.created_at,
            hand_configured: hand,
          }
        : { signed_in: false, hand_configured: hand },
    ),
  )
  return account !== undefined
}

export async function whoami(io: IO) {
  const account = await KeteAccount.read(io.account)
  if (!account) {
    io.print(`Not signed in. Run \`${Brand.cliName} login\` to sign in to your ${Brand.displayName} account.`)
    const hand = await handConfigured(io)
    if (hand.length > 0) io.print(`The gateway is configured by hand (${hand.join(", ")}).`)
    return false
  }
  const store = KeteAccount.store(io.account, account.storage)
  io.print(`Organization: ${account.organization.name} (${account.organization.id})`)
  io.print(`Platform:     ${account.platform_url}`)
  io.print(`Gateway:      ${account.gateway_url}`)
  io.print(`Device:       ${account.device_name}`)
  const runtime = KeteRuntimeRegistration.resolveRuntimeType((await globalConfig(io)).runtime, io.environment)
  if (runtime.kind === "ok" && runtime.type !== "local") io.print(`Runtime:      ${runtime.type}`)
  if (runtime.kind === "invalid")
    io.warn(
      `${runtime.source === "config" ? "kete.runtime.type" : "KETE_RUNTIME_TYPE"} is set to an unknown value (${runtime.value}); runtime registration is skipped.`,
    )
  io.print(`Key:          ${account.key_id}, stored in ${store.description}`)
  io.print(`Signed in:    ${account.created_at}`)
  const key = await KeteAccount.key(io.account, account).catch((error: unknown) => {
    io.warn(`Could not read the key: ${message(error)}`)
    return undefined
  })
  if (key === undefined) {
    io.warn(`The key is missing from ${store.description}. Run \`${Brand.cliName} login\` again.`)
    return true
  }
  const status = await CliLogin.me({ platform: account.platform_url, key, fetch: io.fetch }).then(
    (me) => `active (${me.key.name}, balance ${formatBalance(me.balance_micros, me.currency)})`,
    (error: unknown) =>
      error instanceof CliLogin.PlatformError && error.code === "invalid_key"
        ? `revoked or invalid. Run \`${Brand.cliName} login\` again.`
        : `not checked: ${message(error)}`,
  )
  io.print(`Status:       ${status}`)
  const hand = await handConfigured(io)
  if (hand.length > 0) io.print(`Hand-configured gateway settings (${hand.join(", ")}) are overridden by this account.`)
  return true
}

// ---------------------------------------------------------------------------------------------------

/** --platform-url, then KETE_PLATFORM_URL, then `kete.platform.url` in the global config, then the account signed in before, then the built-in default. */
async function resolvePlatform(io: IO, flag: string | undefined, previous: KeteAccount.Account | undefined) {
  if (flag) return CliLogin.platformURL(flag, "--platform-url")
  const variable = io.environment[platformVariable]
  if (variable) return CliLogin.platformURL(variable, "KETE_PLATFORM_URL")
  const configured = (await globalConfig(io)).platform
  if (configured) return CliLogin.platformURL(configured, "kete.platform.url")
  if (previous) return previous.platform_url
  if (Brand.urls.platform) return Brand.urls.platform
  throw new CliLogin.LoginError(
    `No ${Brand.displayName} platform URL is set. Pass --platform-url <url>, set KETE_PLATFORM_URL, or set "kete": { "platform": { "url": "<url>" } } in your global config.`,
  )
}

/** The hand-configured gateway settings a signed-in account overrides, by name (never their values). */
async function handConfigured(io: IO) {
  const config = await globalConfig(io)
  return [
    ...(config.gateway ? ["providers.kete in your config"] : []),
    ...gatewayVariables.filter((name) => io.environment[name]).map((name) => name.replace(/^OPENCODE_/, "KETE_")),
  ]
}

/** Reads the global kete.json / kete.jsonc (later wins). Project config is not consulted outside a project. */
async function globalConfig(io: IO) {
  const documents = await Promise.all(
    Brand.configFiles.map((name) =>
      readFile(path.join(io.account.config, name), "utf8").then(
        (text) => parse(text, [], { allowTrailingComma: true }) as unknown,
        () => undefined,
      ),
    ),
  )
  return documents.reduce<{ platform?: string; runtime?: unknown; gateway: boolean }>(
    (result, document) => {
      if (!isRecord(document)) return result
      const kete = isRecord(document.kete) && isRecord(document.kete.platform) ? document.kete.platform.url : undefined
      const runtime = isRecord(document.kete) && isRecord(document.kete.runtime) ? document.kete.runtime.type : undefined
      const providers = isRecord(document.providers) ? document.providers.kete : undefined
      return {
        platform: typeof kete === "string" ? kete : result.platform,
        runtime: runtime !== undefined ? runtime : result.runtime,
        gateway: result.gateway || isRecord(providers),
      }
    },
    { gateway: false },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Revokes an account's key on the platform; returns why it failed, or `undefined` on success. */
async function revokeKey(io: IO, account: KeteAccount.Account) {
  const key = await KeteAccount.key(io.account, account).catch(() => undefined)
  if (key === undefined) return "the key was already missing from this device"
  return CliLogin.revoke({ platform: account.platform_url, key, fetch: io.fetch }).then(
    () => undefined,
    (error: unknown) => message(error),
  )
}

async function retire(io: IO, account: KeteAccount.Account) {
  const revoked = await revokeKey(io, account)
  const removed = await KeteAccount.removeKey(io.account, account).then(
    () => undefined,
    (error: unknown) => message(error),
  )
  if (revoked !== undefined || removed !== undefined)
    io.warn(
      `The previous key ${account.key_id} could not be fully retired (${[revoked, removed].filter(Boolean).join("; ")}). Revoke it from the portal at ${account.platform_url}.`,
    )
}

async function announceReload(io: IO) {
  const running = await io.reload().catch((error: unknown) => {
    io.warn(`Could not reload the background service: ${message(error)}. Run \`${Brand.cliName} reload\`.`)
    return undefined
  })
  if (running) io.print("The background service picked up the change.")
}

function formatBalance(micros: number, currency: string) {
  return `${(micros / 1_000_000).toFixed(2)} ${currency}`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export * as AccountFlow from "./account-flow"
