// Job mode's MCP and model restrictions (D3, D4): registered in plugin/internal.ts's `post` list,
// right before KeteUnattended.Plugin (last). A no-op outside job mode. It also installs the
// orchestration pieces of an orchestrated job (kete/orchestrate.ts: the coordinator's `orchestrate`
// tool and the `.kete-orchestration` rule), and review mode for a pull request review job
// (kete/review-mode.ts: read-only tools, the `review` tool, every other action denied); nothing for
// any other job.
//
// - Every MCP server is disabled: global config, well-known and platform-synced, stdio and remote
//   (D12). Registered after KeteAgentSync.Plugin, so synced servers are covered too.
// - Every model whose provider isn't the Kete gateway's is removed, so only `kete/<model>` models
//   are selectable — the request executor (kete/job-request.ts) only recognizes the gateway's
//   routes, and only `kete` models use HTTP transport (kete/gateway.ts, model-resolver.ts:392).

export * as KeteJobPlugin from "./job-plugin.js"

import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { define } from "@opencode/plugin/effect/plugin"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Effect } from "effect"
import { KeteGateway } from "./gateway.js"
import { KeteOrchestrate } from "./orchestrate.js"
import { KeteReviewMode } from "./review-mode.js"

export const Plugin = define({
  id: "kete.job-mode",
  effect: Effect.fn("KeteJobPlugin.Plugin")(function* (ctx: PluginContext) {
    if (!KeteJobMode.enabled()) return

    yield* ctx.mcp.transform((editor) => {
      for (const [name] of editor.list())
        editor.update(name, (config) => {
          config.disabled = true
        })
    })

    yield* ctx.model.transform((models) => {
      for (const model of models.list()) {
        if (model.providerID === KeteGateway.providerID) continue
        models.remove(model.providerID, model.id)
      }
    })

    yield* KeteOrchestrate.install(ctx)
    yield* KeteReviewMode.install(ctx)
  }),
})
