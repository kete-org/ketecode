// Offline mode's location-scoped parts (docs/local-models.md): `--offline`, KETE_OFFLINE or
// `kete.offline: true` (global or project config). Registered in plugin/internal.ts's `post` list and
// guarded, so repository config can't remove it. Process-wide parts (the models.dev fetch, update
// checks, the server's connection choice) are decided at start by the CLI (cli/src/kete/offline-startup.ts).
//
// - Only local models stay: Ollama, LM Studio, vLLM, and providers whose base URL is a loopback or
//   private-network IP literal (or `localhost`). Everything else is removed from the model list, the
//   only place requests resolve a model from, and refused again by the runner check (run-checks.ts).
// - Remote (URL) MCP servers, including synced ones, are disabled; stdio servers keep working.
// - `webfetch` and `websearch` are removed from every request and refused if called anyway.
// Offline never touches a permission rule or policy: it only removes models, servers and tools, so
// cached organization policy applies exactly as online.

export * as KeteOffline from "./offline.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { KeteOffline as OfflineFlag } from "@opencode/util/kete/offline"
import { Effect, Exit } from "effect"
import { Config } from "../config.js"
import type { PluginInternal } from "../plugin/internal.js"
import { KeteLocalHosts } from "./local-hosts.js"

export const id = "kete.offline"

/** Local server providers: their default hosts are on this machine. Their actual address still decides (D5). */
export const localProviders: ReadonlySet<string> = new Set(["ollama", "lmstudio", "vllm"])

function isLocalServer(providerID: string): providerID is KeteLocalHosts.ProviderID {
  return localProviders.has(providerID)
}

/** Tools that reach the internet. */
export const webTools: readonly string[] = ["webfetch", "websearch"]

export type Environment = Record<string, string | undefined>

/** Whether offline mode applies: the flag (on or invalid), or `kete.offline` in the loaded config. */
export function enabled(env: Environment = process.env, kete?: { readonly offline?: boolean }): boolean {
  return OfflineFlag.enabled(env) || kete?.offline === true
}

/** Whether a model from `providerID` is local: a local provider, or a base URL on this machine or a private network. */
export function isLocalModel(providerID: string, baseURL: unknown): boolean {
  // The address decides whenever it's known: an Ollama pointed at a public host isn't local. Only
  // without one does the provider count, because the local servers' defaults are on this machine.
  if (typeof baseURL === "string" && baseURL !== "") return OfflineFlag.isLocalURL(baseURL)
  return localProviders.has(providerID)
}

export const unavailableSuffix =
  " Offline mode is on: only local models are available (Ollama, LM Studio, vLLM, or a provider on this machine or a private network)."

/** Appended to "Model unavailable" errors: a model removed by offline mode fails at resolution, before the runner check. */
export function unavailableHint(env: Environment = process.env): string {
  return OfflineFlag.enabled(env) ? unavailableSuffix : ""
}

/** The runner check's message for a model that isn't local. */
export function refusal(providerID: string, modelID: string): string {
  return `Offline mode: ${providerID}/${modelID} isn't a local model. Pick an Ollama, LM Studio or vLLM model, or a provider on this machine or a private network.`
}

export const webRefusal = "Offline mode: web access is off (webfetch and websearch need the network)."

export const Plugin = define({
  id,
  effect: Effect.fn("KeteOffline.Plugin")(function* (ctx) {
    const config = yield* Config.Service
    const environment = process.env
    // Transforms and hooks read the setting as it is now, so a project `kete.offline` counts too. The
    // config read is in memory; should it ever fail, the last known value stays in use.
    const state = { last: enabled(environment) }
    const current = () => {
      const exit = Effect.runSyncExit(config.entries())
      if (Exit.isSuccess(exit)) state.last = enabled(environment, Config.latest(exit.value, "kete"))
      return state.last
    }

    yield* ctx.model.transform((models) => {
      if (!current()) return
      for (const model of models.list()) {
        const record = models.provider.get(model.providerID)
        const settings: Record<string, unknown> | undefined = model.settings ?? undefined
        const providerSettings: Record<string, unknown> | undefined = record?.provider.settings ?? undefined
        // A model's own base URL (a gateway route, say) overrides its provider's.
        // Then the host from OLLAMA_HOST / KETE_*_HOST, which feeds the local servers' origin.
        const baseURL =
          settings?.baseURL ??
          providerSettings?.baseURL ??
          (isLocalServer(model.providerID) ? KeteLocalHosts.origin(model.providerID, environment) : undefined)
        if (!isLocalModel(model.providerID, baseURL)) models.remove(model.providerID, model.id)
      }
    })

    yield* ctx.mcp.transform((editor) => {
      if (!current()) return
      for (const [name, server] of editor.list()) {
        if (server.type !== "remote") continue
        editor.update(name, (item) => {
          item.disabled = true
        })
      }
    })

    const removeWebTools = (event: { tools: Record<string, unknown> }) =>
      Effect.sync(() => {
        if (!current()) return
        for (const name of webTools) delete event.tools[name]
      })
    yield* ctx.session.hook("context", removeWebTools)
    yield* ctx.session.hook("compaction", removeWebTools)
    yield* ctx.session.hook("generate", removeWebTools)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        if (!webTools.includes(event.tool) || !current()) return
        return yield* new Tool.Error({ message: webRefusal })
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)
