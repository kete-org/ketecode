# Handoff: Safe permission defaults and permission modes

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-07 implementer (single agent)

Decisions:
- Seam: the existing `evaluate` hook in `kete/permission-mode.ts`, not `schema/src/agent.ts`. To let
  users and orgs loosen the defaults, the hook re-evaluates the agent + session rules + saved
  approvals and applies the defaults only when the winning rule is upstream's catch-all
  `{ "*", "*", allow }`. A config `"permissions": [{"action":"*","resource":"*","effect":"allow"}]`
  is indistinguishable from upstream's and doesn't opt out; `"shell": allow` style rules do.
- Default mode keeps edits allowed (as the brief decided); so `accept-edits` currently equals
  `default` and is left out of the clients' cycle (documented).
- Test/build commands are allowed in default mode (core loop); scripts are recognised by name
  (`test*`, `build*`, `lint*`, `typecheck*`, `check*`, …) and names containing deploy/publish/
  release/push/migrate/seed/db/install/clean/… are excluded. Accepted risk: a project script runs
  what the project defines.
- `npx`/`bunx`/`pnpm dlx` are high (they download packages) unless `--no-install`/`--no`.
- `env`/`printenv`/bare `export` are high (they print secrets into the model's context).
- Web fetch/search ask in default, allowed in auto. The tool saves `*`, so "Always allow" covers all
  URLs (no per-host scope without an upstream change).
- Plan is enforced as a mode (edits and non-read-only commands denied, even with explicit allows),
  and the web toggle's Plan also selects the Plan agent. Plan mode also denies writes to the Plan
  agent's plan directory.
- The mode is resolved from the root-most session that has one, so worktree subagents (which get
  their own metadata) and older child copies follow the root.
- `--auto` now means the `auto` mode; the bypass is `--dangerously-skip-permissions` (existed upstream,
  hidden; now documented) and its hidden alias `--yolo`. `kete run --auto` therefore no longer
  approves high-risk commands; they are rejected (non-interactive) and the run stops.
- Unattended families: safe defaults skipped; explicit `ask`/`plan` still tighten (unchanged
  behaviour for `ask`).

Open:
- MCP tool calls stay allowed by default (upstream); a default for MCP tools is a follow-up.
- JetBrains' default-mode setting still offers default/ask only (its chat uses the web toggle).
