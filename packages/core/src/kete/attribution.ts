// How Kete Code identifies itself to model providers that credit the calling app.
//
// Upstream's provider plugins (plugin/provider/{openrouter,vercel,kilo,llmgateway,zenmux,nvidia,
// cerebras}.ts) set attribution headers that credit OpenCode. This plugin runs after them and replaces
// exactly those default values with Kete Code's (Brand.attribution), so the upstream files stay
// untouched and any other value, such as one a user configured, is left alone:
// - `HTTP-Referer: https://opencode.ai/` → Brand.urls.website; removed while Kete Code has none.
//   (Without a referer OpenRouter lists no app page; requests work the same. LLM Gateway then
//   identifies the app by its User-Agent, which starts with `kete/`.)
// - `X-Title: opencode` → "Kete Code".
// - LLM Gateway `X-Source: opencode` → the website's host; removed while Kete Code has none. LLM
//   Gateway rejects a malformed source with 400, so it is only ever a plain host name.
// - NVIDIA `X-BILLING-INVOKE-ORIGIN: OpenCode` → "KeteCode".
// - Cerebras `X-Cerebras-3rd-Party-Integration: opencode` → "kete-code".
// Deliberately unchanged: OpenAI's `originator: opencode` (ChatGPT sign-in; the value changes the
// backend's behaviour) and the `x-opencode-*` session headers. See docs/upstream-patches.md.

export * as KeteAttribution from "./attribution.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Brand } from "@opencode/util/kete/brand"
import { Effect } from "effect"
import type { PluginInternal } from "../plugin/internal.js"

/** Upstream's default value for each header (lower-cased name) and Kete Code's replacement; undefined removes it. */
export const replacements: Record<string, { readonly upstream: string; readonly kete: string | undefined }> = {
  "http-referer": { upstream: "https://opencode.ai/", kete: Brand.urls.website },
  "x-title": { upstream: "opencode", kete: Brand.attribution.title },
  "x-source": { upstream: "opencode", kete: Brand.urls.website ? new URL(Brand.urls.website).host : undefined },
  "x-billing-invoke-origin": { upstream: "OpenCode", kete: Brand.attribution.nvidiaOrigin },
  "x-cerebras-3rd-party-integration": { upstream: "opencode", kete: Brand.attribution.cerebrasIntegration },
}

/** The headers with upstream's attribution values replaced; the same object when nothing matches. */
export function rewrite(headers: Record<string, string>) {
  const changed = Object.entries(headers).some(
    ([name, value]) => replacements[name.toLowerCase()]?.upstream === value,
  )
  if (!changed) return headers
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      const replacement = replacements[name.toLowerCase()]
      if (!replacement || replacement.upstream !== value) return [[name, value]]
      return replacement.kete === undefined ? [] : [[name, replacement.kete]]
    }),
  )
}

export const Plugin = define({
  id: "kete.provider.attribution",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.provider.transform((providers) => {
      for (const item of providers.list()) {
        const headers = item.provider.headers
        if (!headers || rewrite(headers) === headers) continue
        providers.update(item.provider.id, (provider) => {
          provider.headers = rewrite(provider.headers ?? {})
        })
      }
    })
  }),
} satisfies PluginInternal.InternalPlugin)
