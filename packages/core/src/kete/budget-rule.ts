// Built-in agents allow unmatched actions (e.g. `build` starts with an `*` allow rule),
// which would approve the `budget` permission (kete/budget.ts) silently. This plugin adds
// a `budget: ask` rule to every built-in agent, before configuration rules are appended,
// so explicit `budget` rules in the configuration still win. Agents defined only in
// configuration are created later and don't get it; a top-level `budget` rule covers them.
//
// Kept apart from kete/budget.ts so the plugin list doesn't import the permission and
// config services.

export * as KeteBudgetRule from "./budget-rule.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

export const action = "budget"

export const Plugin = define({
  id: "kete.budget",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      // Snapshot the IDs: updating while iterating the live list never terminates.
      for (const id of editor.list().map((agent) => agent.id))
        editor.update(id, (item) => {
          // Replace rather than push: a published agent's rule list is frozen.
          item.permissions = [...item.permissions, { action, resource: "*", effect: "ask" }]
        })
    })
  }),
})
