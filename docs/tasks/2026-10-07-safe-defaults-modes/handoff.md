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

## 2026-10-08 implementer (review fixes)

Addressed the independent review of PR #20 (B1–B3, S1–S7, nits). Decisions:
- Protected paths (B1) ask in every mode, even over explicit allow rules and saved approvals;
  unattended families are left to their own policy (D2 already denies Kete config there).
- Entry points (B2): a configured rule (agent/config/session) loosens them, a saved approval doesn't.
  The "build setup changed" flag is per runtime process, keyed by root session, set when an
  entry-point edit isn't denied by this hook (later org policies may still deny it; then the extra
  ask is harmless) and cleared when the check fires.
- `cd` (S1): upstream's shell tool never asks for `cd`. A marked edit passes the whole command line
  as request metadata (`metadata.command`); `classifyLine` only looks at directory changes so loops
  and other compound syntax don't start asking.
- S4: a marked edit in the shell tool drops `save` (so clients don't offer "Always allow") when any
  command is high-risk or runs anything; saved approvals for such commands are ignored anyway.
- S5: web fetch saves `[origin, origin/*]` (marked edit + `kete/web-host.ts`); websearch keeps `*`.
- S6: Plan allows read, glob, grep, question, skill, budget, external_directory, webfetch/search,
  shell (read-only), subagent and MCP resource reads; everything else is denied. Subagents stay
  allowed because they resolve the root's Plan mode (tested), and the Plan agent uses them.
- `$((…))` arithmetic is now parsed (needed so upstream's shell-tool test keeps its save pattern).
- `git --git-dir ../x/.git log` is high (a protected path in a non-read command).

## 2026-10-08 implementer (re-review fixes)

- N1 fixed: the `grep` case returns through a shared `readOnly()` check (no fallthrough).
- `cd`: done in `shell/parse.ts` (both scanners) rather than in `classifyLine`, since tree-sitter
  already finds every `cd`; legacy uses the command's source text because its parts drop
  number-only words (`cd 123`). `classifyLine` stays as a second check for simple lines.
- Edits' real path goes through `FSUtil` (wrapped in job mode), not `fs` (job-fs-sites test).
- Web fetch: redirects are followed by `kete/web-redirect.ts` with `redirect: "manual"`; the
  upstream `execute` helper is left in place, unused, to keep the upstream diff small.
- Plan allowlist checked against every action that asserts a permission in core (todo and LSP
  tools don't ask permission, so they're unaffected).
- Residual risk (ordinary test files run code under `npm test`) accepted by the coordinator;
  documented in `docs/permissions.md` and the spec; containment is Wave 0b's sandbox.
