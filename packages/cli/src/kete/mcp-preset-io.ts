// The real terminal, files, OS secret store, sync cache and local runtime behind ./mcp-preset.ts.

import { EOL } from "node:os"
import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isCancel, password } from "@clack/prompts"
import { OpenCode, type IntegrationOAuthMethod, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Brand } from "@opencode/util/kete/brand"
import { KeteAccount } from "@opencode/util/kete/account"
import { KeteMcpSecret } from "@opencode/util/kete/mcp-secret"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { KeteSyncIntegrations } from "@opencode/util/kete/sync/integrations"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { ServiceConfig } from "../services/service-config"
import { resolveIntegration } from "../commands/handlers/mcp/resolve"
import { openUrl } from "../ui/prompt"
import type { KeteMcpPreset } from "./mcp-preset"

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000
const RELOAD_TIMEOUT_MS = 30_000

async function read(file: string) {
  return readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

/** `kete.integrations.slack.clientId` from the first config file (project first, then global) that sets it, and where. */
export async function configuredSlackClientId(
  directories: readonly { readonly path: string; readonly scope: "project" | "global" }[],
): Promise<KeteMcpPreset.ConfiguredClientId | undefined> {
  for (const directory of directories) {
    for (const name of Brand.configFiles) {
      const file = path.join(directory.path, name)
      const text = await read(file)
      if (text === undefined) continue
      const value: unknown = parse(text, [], { allowTrailingComma: true })
      const clientId = dig(value, ["kete", "integrations", "slack", "clientId"])
      if (typeof clientId === "string" && clientId !== "") return { clientId, scope: directory.scope, file }
    }
  }
  return undefined
}

function dig(value: unknown, keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const signIn = Effect.fn("cli.kete.mcp-preset.sign-in")(function* (name: string) {
  const location = { directory: process.cwd() }
  const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  // The runtime picks up the new server on reload; without it the sign-in could race the config watcher.
  yield* Effect.tryPromise({
    try: (signal) => client.location.reload({ signal: AbortSignal.any([signal, AbortSignal.timeout(RELOAD_TIMEOUT_MS)]) }),
    catch: () => new Error("the runtime did not reload its configuration"),
  })
  const integration = yield* resolveIntegration(client, name, location)
  const method = integration?.methods.find((candidate): candidate is IntegrationOAuthMethod => candidate.type === "oauth")
  if (!integration || !method)
    return { status: "unavailable", message: `MCP server "${name}" has no OAuth sign-in` } as const
  const started = yield* Effect.promise(() =>
    client.integration.oauth.connect({ integrationID: integration.id, methodID: method.id, location }),
  )
  const attempt = started.data
  if (attempt.mode === "code")
    return { status: "unavailable", message: "this server needs manual code entry, which the CLI doesn't support" } as const
  process.stdout.write(attempt.instructions + EOL + attempt.url + EOL)
  yield* openUrl(attempt.url)
  return yield* poll(client, integration.id, attempt.attemptID, location, Date.now() + SIGN_IN_TIMEOUT_MS)
})

const poll = (
  client: OpenCodeClient,
  integrationID: string,
  attemptID: string,
  location: { directory: string },
  deadline: number,
): Effect.Effect<KeteMcpPreset.SignInResult> =>
  Effect.gen(function* () {
    const status = yield* Effect.promise(() => client.integration.oauth.status({ integrationID, attemptID, location })).pipe(
      Effect.map((result) => result.data),
    )
    if (status.status === "complete") return { status: "complete" } as const
    if (status.status === "failed") return { status: "failed", message: status.message } as const
    if (status.status !== "pending") return { status: status.status } as const
    if (Date.now() > deadline) return { status: "timeout", message: "no answer from the browser within 10 minutes" } as const
    yield* Effect.sleep("1 second")
    return yield* poll(client, integrationID, attemptID, location, deadline)
  })

export const make = Effect.fn("cli.kete.mcp-preset.io")(function* () {
  const run = Effect.runPromiseWith(yield* Effect.context<Effect.Services<ReturnType<typeof signIn>>>())
  const global = yield* Global.Service
  const cwd = process.cwd()
  const account = KeteAccount.defaults()
  return {
    print: (line: string) => process.stdout.write(line + EOL),
    warn: (line: string) => process.stderr.write(line + EOL),
    environment: process.env,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    promptSecret: async (message: string) => {
      const value = await password({ message })
      return isCancel(value) ? undefined : value
    },
    saveSecret: async (server: string, secret: string, definition: KeteMcpSecret.LocalDefinition) => {
      const saved = await KeteMcpSecret.save(KeteMcpSecret.stores(global.data), server, secret, definition)
      return { description: saved.store.description, fallback: saved.store.kind === "file" }
    },
    storedSecret: async (server: string) =>
      (await KeteMcpSecret.read(KeteMcpSecret.stores(global.data), KeteMcpSecret.entry(server)))?.secret,
    readText: read,
    writeText: async (file: string, text: string) => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, text)
    },
    configuredSlackClientId: () =>
      configuredSlackClientId([
        { path: cwd, scope: "project" },
        { path: path.join(cwd, Brand.projectDirectory), scope: "project" },
        { path: global.config, scope: "global" },
      ]),
    syncedSlackClientId: async () => {
      // Absent sync data (not signed in, never synced, an older platform) just means no organization app.
      const signedIn = await KeteAccount.read(account).catch(() => undefined)
      if (!signedIn || !KeteSyncCache.validOrganization(signedIn.organization.id)) return undefined
      const cached = await KeteSyncCache.read(account.config, signedIn.organization.id).catch((error: unknown) => {
        process.stderr.write(`Warning: the platform sync cache could not be read (${error instanceof Error ? error.message : String(error)})${EOL}`)
        return undefined
      })
      return KeteSyncIntegrations.slackClientId(cached?.response)
    },
    signIn: (name: string) =>
      run(signIn(name)).catch((error: unknown) => ({
        status: "failed" as const,
        message: error instanceof Error ? error.message : String(error),
      })),
  } satisfies KeteMcpPreset.IO
})

export * as KeteMcpPresetIO from "./mcp-preset-io"
