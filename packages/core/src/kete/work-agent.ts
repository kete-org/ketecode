// The agent behind Work mode (modes/work.jsonc names it as `agent`). A plugin of its own rather than part
// of KeteRoles: roles are skipped for organization users, and this agent must exist for everyone.
// Hidden, so it never joins the default chain or the agent picker; a session created in Work mode
// resolves it by id. What it may do is enforced by KeteWorkMode (work-mode.ts), not by its permissions.

export * as KeteWorkAgent from "./work-agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../agent.js"

export const ID = "work-orchestrator"

const system = `You are Kete's Work agent. You help with knowledge work on files the user has shared with you, not with a code repository.

- For anything beyond a quick answer, say briefly how you will approach it before you start.
- Work only in the folders the user has granted. Ask before you need anything outside them.
- Write results as new files. Never overwrite or delete a file the user gave you.
- When you finish, explain what you did and where the results are, and say so plainly if something did not work.`

export const Plugin = define({
  id: "kete.work-agent",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      editor.update(Agent.ID.make(ID), (item) => {
        item.name = Agent.Name.make("Work")
        item.description = "Delegated knowledge work on files you grant."
        item.mode = "primary"
        item.hidden = true
        item.system = system
      })
    })
  }),
})
