// Where the local model servers live. The upstream provider plugins (plugin/provider/{ollama,
// lmstudio,vllm}.ts) take an `origin` and prefer `providers.<id>.settings.baseURL` over it, so
// feeding them the origin from the environment gives the order: config, then environment, then the
// provider's default (docs/local-models.md).
//
// - Ollama: KETE_OLLAMA_HOST (bridged to OPENCODE_OLLAMA_HOST), then Ollama's own OLLAMA_HOST.
// - LM Studio: KETE_LMSTUDIO_HOST. vLLM: KETE_VLLM_HOST.
// Forms: `host`, `host:port`, `[v6]`, `[v6]:port`, or `scheme://host[:port][/path]` (http or https).
// Without a scheme it is http and, without a port, the provider's own port. 0.0.0.0 and :: (a
// server's "listen on everything", as Ollama's own client reads them) mean this machine.
// An invalid value is reported by `resolve` (the local-models plugin logs it) and the next source is used.

export * as KeteLocalHosts from "./local-hosts.js"

import { KeteOffline } from "@opencode/util/kete/offline"

export type ProviderID = "ollama" | "lmstudio" | "vllm"
export type Environment = Record<string, string | undefined>

export const defaults: Readonly<Record<ProviderID, { readonly origin: string; readonly port: number }>> = {
  ollama: { origin: "http://127.0.0.1:11434", port: 11434 },
  lmstudio: { origin: "http://127.0.0.1:1234", port: 1234 },
  vllm: { origin: "http://127.0.0.1:8000", port: 8000 },
}

/** The environment variables read for a provider, in precedence order (internal OPENCODE_* names). */
export const variables: Readonly<Record<ProviderID, readonly string[]>> = {
  ollama: ["OPENCODE_OLLAMA_HOST", "OLLAMA_HOST"],
  lmstudio: ["OPENCODE_LMSTUDIO_HOST"],
  vllm: ["OPENCODE_VLLM_HOST"],
}

/** Parses a host setting into an origin (`http://host:port`, plus a path when given), or undefined. */
export function parse(value: string, defaultPort: number): string | undefined {
  const text = value.trim()
  if (text === "") return undefined
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  let url: URL
  let explicitPort = true
  if (hasScheme) {
    if (!URL.canParse(text)) return undefined
    url = new URL(text)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  } else {
    const authority = text.split(/[/?#]/, 1)[0] ?? ""
    explicitPort = /(?:\]|^[^[\]:]*):[0-9]+$/.test(authority)
    if (!URL.canParse(`http://${text}`)) return undefined
    url = new URL(`http://${text}`)
  }
  if (url.hostname === "" || url.username !== "" || url.password !== "") return undefined
  const host = url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname === "[::]" ? "[::1]" : url.hostname
  const port = url.port !== "" ? `:${url.port}` : explicitPort ? "" : `:${defaultPort}`
  const path = url.pathname.replace(/\/+$/, "")
  return `${url.protocol}//${host}${port}${path}`
}

export type Resolved = {
  readonly origin: string
  readonly source: "env" | "default"
  /** The variable the origin came from, when it did. */
  readonly variable?: string
  /** Variables that were set but couldn't be parsed (values are never kept; they may hold credentials). */
  readonly invalid: readonly string[]
}

export function resolve(provider: ProviderID, env: Environment = process.env): Resolved {
  const invalid: string[] = []
  for (const variable of variables[provider]) {
    const value = env[variable]
    if (value === undefined || value.trim() === "") continue
    const origin = parse(value, defaults[provider].port)
    if (origin !== undefined) return { origin, source: "env", variable, invalid }
    invalid.push(variable)
  }
  return { origin: defaults[provider].origin, source: "default", invalid }
}

/** The origin to hand the provider plugin's `make(origin)`. */
export function origin(provider: ProviderID, env: Environment = process.env): string {
  return resolve(provider, env).origin
}

/** The plugin event the `kete.local-models` RPC's `rediscover` method emits (`rpc.<rpc id>.<event>`). */
export const rediscoverEvent = "rpc.kete.local-models.rediscover"

/** Whether `event` asks `provider` to look at its server again. Accepts any event shape. */
export function isRediscover(event: { readonly type: string; readonly data?: unknown }, provider: ProviderID): boolean {
  if (event.type !== rediscoverEvent || !("data" in event)) return false
  const data: unknown = event.data
  return typeof data === "object" && data !== null && "provider" in data && data.provider === provider
}

/** Plain http to a host that isn't this machine: code sent there crosses the network unencrypted. */
export function insecure(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  return parsed.protocol === "http:" && !KeteOffline.isLoopbackHost(parsed.hostname)
}

/** `url` without credentials, query or fragment: safe to show and to return from the status RPC. */
export function display(url: string): string {
  if (!URL.canParse(url)) return ""
  const parsed = new URL(url)
  parsed.username = ""
  parsed.password = ""
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/+$/, "")
}
