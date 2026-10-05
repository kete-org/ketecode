// What the TUI and the web UI (also the VS Code panel) show about local models (Ollama, LM Studio,
// vLLM): the picker's "Local" group, the "no tools" badge and context size, the line for a local
// server that isn't reachable, the first-run offer and the once-per-session "this model can only
// answer" notice. Pure rules over the `kete.local-models` status (schema/src/kete/local-models.ts),
// typed structurally because util has no internal dependencies; each client fetches the status and
// renders (tui/src/kete/local-models.ts, app/src/kete/local-models.ts).

export * as KeteLocalPicker from "./local-picker.js"

import { Brand } from "./brand.js"

export type ProviderID = "ollama" | "lmstudio" | "vllm"

export const providers: Readonly<Record<ProviderID, string>> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
}

/** The picker's group title for local models. */
export const group = "Local"

export function isLocal(providerID: string): providerID is ProviderID {
  return Object.hasOwn(providers, providerID)
}

/** `32k ctx`, `128k ctx`, `1M ctx`; undefined when the window is unknown (0). */
export function contextLabel(tokens: number): string | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined
  const base = tokens % 1024 === 0 ? 1024 : 1000
  if (tokens >= base * base) return `${trim(tokens / (base * base))}M ctx`
  if (tokens >= base) return `${trim(tokens / base)}k ctx`
  return `${tokens} ctx`
}

const trim = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, ""))

export type Model = {
  readonly providerID: string
  readonly tools: boolean
  readonly context: number
}

/** The badges a local model gets in a picker: "no tools" when it can't call tools, then its context size. */
export function badges(model: Model): string[] {
  if (!isLocal(model.providerID)) return []
  const context = contextLabel(model.context)
  return [...(model.tools ? [] : ["no tools"]), ...(context ? [context] : [])]
}

export type ProviderStatus = {
  readonly id: ProviderID
  readonly state: "reachable" | "unreachable" | "not_configured" | "blocked"
  readonly url: string
  readonly models?: number
  readonly error?: string
  readonly hint: string
  readonly insecure: boolean
  readonly contextWarnings?: readonly { readonly model: string; readonly message: string }[]
}

export type Status = {
  readonly offline: boolean
  readonly providers: readonly ProviderStatus[]
}

export type Unreachable = { readonly providerID: ProviderID; readonly text: string; readonly hint: string }

/**
 * One line per local server that was set up (or answers badly on its default port) but can't be
 * reached, with the URL tried and how to start it. A server that simply isn't installed is
 * `not_configured` and gets no line, so users without local models see nothing. A server that offline
 * mode won't contact (`blocked`: not on this machine or a private network) gets a line saying so.
 */
export function unreachable(status: Status | undefined): Unreachable[] {
  return (status?.providers ?? [])
    .filter((item) => item.state === "unreachable" || item.state === "blocked")
    .map((item) => ({
      providerID: item.id,
      text:
        item.state === "blocked"
          ? `${providers[item.id]} isn't used: ${item.error ?? `offline mode: ${item.url} isn't on this machine or a private network`}.`
          : `${providers[item.id]} isn't reachable at ${item.url}${item.error ? ` (${item.error})` : ""}.`,
      hint: item.hint,
    }))
}

export type Offer = { readonly providerID: ProviderID; readonly models: number; readonly title: string }

/**
 * The first-run offer: shown once (`offered` is the persisted flag), only when the user has no model
 * yet (no config `model`, no recent or favourite) and a local server is reachable with at least one
 * model. Ollama is preferred, then LM Studio, then vLLM.
 */
export function offer(input: {
  readonly status: Status | undefined
  readonly hasModel: boolean
  readonly offered: boolean
}): Offer | undefined {
  if (input.offered || input.hasModel || !input.status) return undefined
  const order: readonly ProviderID[] = ["ollama", "lmstudio", "vllm"]
  const found = order
    .map((id) => input.status?.providers.find((item) => item.id === id))
    .find((item) => item?.state === "reachable" && (item.models ?? 0) > 0)
  if (!found) return undefined
  const models = found.models ?? 0
  return {
    providerID: found.id,
    models,
    title: `Use local models (${providers[found.id]}, ${models} ${models === 1 ? "model" : "models"})`,
  }
}

/** The model to select when the offer is accepted: the provider's first listed model, preferring one that can call tools. */
export function pick<T extends { readonly providerID: string; readonly tools: boolean }>(
  models: readonly T[],
  providerID: ProviderID,
): T | undefined {
  const own = models.filter((model) => model.providerID === providerID)
  return own.find((model) => model.tools) ?? own[0]
}

export const noToolsMessage = `This model can't call tools in ${Brand.displayName}: it can only answer, not read or edit files or run commands. Pick a model with tool support to make changes.`

/**
 * The once-per-session notice for a model that can't call tools. Returns the message when it should
 * show (and the caller then records `key` in `seen`); undefined when the model can call tools or the
 * notice was already shown for this session.
 */
export function noToolsNotice(input: {
  readonly sessionKey: string
  readonly model: { readonly tools: boolean } | undefined
  readonly seen: ReadonlySet<string>
}): string | undefined {
  if (!input.model || input.model.tools) return undefined
  if (input.seen.has(input.sessionKey)) return undefined
  return noToolsMessage
}

/** The Ollama context warnings in a status, for a client to show once each. */
export function contextWarnings(status: Status | undefined): { readonly key: string; readonly message: string }[] {
  return (status?.providers ?? []).flatMap((item) =>
    (item.contextWarnings ?? []).map((warning) => ({ key: `${item.id}/${warning.model}`, message: warning.message })),
  )
}

export const offlineLabel = "Offline"

export type OfferDeps = {
  readonly hasModel: boolean
  readonly offered: boolean
  readonly status: () => Promise<Status>
  /** Records that the offer was made (persisted), before it is shown, so it never repeats. */
  readonly markOffered: () => Promise<void> | void
  /** Shows the offer; resolves true when the user accepts. */
  readonly confirm: (offer: Offer) => Promise<boolean>
  readonly models: () => readonly { readonly providerID: string; readonly id: string; readonly tools: boolean }[]
  /** Selects the model the same way the model dialog does (the client's own persisted selection; no config write). */
  readonly select: (model: { readonly providerID: string; readonly modelID: string }) => void
}

export type OfferResult =
  | { readonly kind: "skipped" }
  | { readonly kind: "declined" }
  | { readonly kind: "selected"; readonly providerID: string; readonly modelID: string }
  | { readonly kind: "no_model"; readonly providerID: ProviderID }

/**
 * The first-run offer: when the user has no model yet and has never been offered, ask the runtime
 * for the local servers' status; with a reachable server that has models, record the offer and ask
 * once. Accepting selects that server's first model (one that can call tools if any can).
 */
export async function firstRunOffer(deps: OfferDeps): Promise<OfferResult> {
  if (deps.offered || deps.hasModel) return { kind: "skipped" }
  const found = offer({ status: await deps.status(), hasModel: deps.hasModel, offered: deps.offered })
  if (!found) return { kind: "skipped" }
  await deps.markOffered()
  if (!(await deps.confirm(found))) return { kind: "declined" }
  const model = pick(deps.models(), found.providerID)
  if (!model) return { kind: "no_model", providerID: found.providerID }
  deps.select({ providerID: model.providerID, modelID: model.id })
  return { kind: "selected", providerID: model.providerID, modelID: model.id }
}

/**
 * Tracks the once-per-session "this model can only answer" notice: `check` returns the message the
 * first time a session runs with a model that can't call tools, and nothing after that.
 */
export function noToolsTracker() {
  const seen = new Set<string>()
  return {
    check(sessionID: string, model: { readonly tools: boolean } | undefined): string | undefined {
      const message = noToolsNotice({ sessionKey: sessionID, model, seen })
      if (message) seen.add(sessionID)
      return message
    },
  }
}

type ConfigEntry = { readonly type: string; readonly info?: { readonly kete?: { readonly offline?: boolean } } }

/**
 * Whether offline mode is on for this location, as the runtime decides it: the process flag (on or
 * invalid; the CLI sets it before the TUI or server starts) or `kete.offline` in the highest-priority config
 * document that has a `kete` block (core's `Config.latest`).
 */
export function offlineFrom(flag: boolean, entries: readonly ConfigEntry[] | undefined): boolean {
  if (flag) return true
  const kete = entries?.findLast((entry) => entry.type === "document" && entry.info?.kete !== undefined)?.info?.kete
  return kete?.offline === true
}

/** Whether the catalog lists any model from a local server: the first-run offer asks for status only then. */
export function hasLocalModels(models: readonly { readonly providerID: string }[] | undefined): boolean {
  return (models ?? []).some((model) => isLocal(model.providerID))
}
