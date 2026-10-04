# Request to kete-code-platform: synced agents with mode "all"

Status: implemented (kete-code-platform docs/adr/0017-agents-in-both-modes.md; task
`docs/tasks/2026-09-28-agent-mode-all`). The wire shape is not `mode: "all"`: the sync contract's
`mode` still allows only `primary` and `subagent`, so released runtimes keep decoding it. An
organization agent that's `all` is sent as `mode: "primary", delegable: true`
(`docs/platform/sync-v1.md`); the runtime maps that pair back to Kete's own `mode: "all"` in
`packages/core/src/kete/sync/plugin.ts`. A runtime that doesn't know `delegable` ignores it and
keeps treating the agent as primary only.

## Problem

The sync contract (`docs/platform/sync-v1.md`) allows an agent's `mode` to be `primary` or
`subagent`. The runtime also knows `all`: an agent the user can switch to *and* another agent can
delegate to. Workflows (`kete.workflows`, `core/src/kete/workflows.ts`) run every step as a
subagent, and the subagent tool refuses primary agents, so an organization's Security or DevOps
agent (both `primary` in `create_builtin_agents`) can't be a workflow step or be delegated to.

For developers who aren't signed in, the runtime's starter roles (`core/src/kete/roles.ts`) already
make Security and DevOps `all`. Signed in, the organization's definitions win, so the same
workflow behaves differently.

## Proposal (as implemented)

1. Allow `mode: "all"` in the agents table (`agents.mode` check) and `create_builtin_agents`; the
   sync **contract** keeps `mode` at `primary`/`subagent` only (released runtimes decode it
   strictly) and gains an optional `delegable: boolean`, sent only when true.
2. Make the Security and DevOps built-in agents `all` in `create_builtin_agents`, with a migration
   for every organization's built-in Security and DevOps agent still at `primary`.
3. Show the mode in the portal's agent editor as "Primary", "Subagent" or "Both".

The runtime accepts a delegable agent from sync as soon as the contract sends it:
`util/src/kete/sync/contract.ts` decodes the new `delegable` field, and
`packages/core/src/kete/sync/plugin.ts` maps `mode: "primary", delegable: true` to Kete's own
`mode: "all"`.
