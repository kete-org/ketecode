---
module: roles-skills
paths: [packages/core/src/kete/roles.ts, packages/core/src/kete/skill.ts, packages/core/src/kete/skill/*.md, packages/kete-tools/src/role-*.ts]
verified-at: 0b8a24ff25
---
## Quick answers
- What agents does a fresh, non-signed-in install get? Code Reviewer, QA, Docs Writer (subagents), and Security and DevOps (mode `"all"` — usable as primary or delegated-to), defined in `packages/core/src/kete/roles.ts:57-154`.
- Why "not signed in"? Signed in to a Kete organization, the platform's synced agents decide instead (`roles.ts:6-8`); a local starter role would wrongly reappear after an org paused it.
- What replaces upstream's `opencode`/`report` skills? `packages/core/src/kete/skill.ts`, which removes them and adds a `kete` skill and a Kete-specific `report` skill, so upstream's own skill markdown is never edited and never conflicts on sync.
- How is role behavior verified end-to-end? `packages/kete-tools/src/role-check.ts` — runs each role against a real model in a throwaway repo/HOME and checks files changed and text said, via scenarios in `role-scenarios.ts`.
- Is "Plan" one of these starter roles? No — it's upstream's own `plan` agent (`core/src/plugin/plan.ts`, id `"plan"`, primary, not in this card's `roles` array), unaffected by whether starter roles are injected. The web app's chat-panel Auto/Ask/Plan toggle selects it like any other agent (`packages/app/src/kete/mode.ts`, `web-app` card); see the `permissions` card for how that toggle relates to `kete.permissionMode`.

## Purpose
Gives a local, unauthenticated Kete Code install the same five built-in roles the platform provisions for organizations (mirroring kete-code-platform's `create_builtin_agents`), each with least-privilege permission rules; and replaces upstream's OpenCode-specific `opencode`/`report` skills (which would otherwise mislead the model post-rebrand) with Kete-owned equivalents without touching upstream files.

## Entry points
- `packages/core/src/kete/roles.ts:156-178` `make(options)` / `roles.ts:180` `Plugin` (`id: "kete.roles"`) — an `agent.transform` plugin.
- `packages/core/src/kete/skill.ts:37` `Plugin` (`id: "kete.skill"`) — a `skill.transform` + `tool.transform` plugin.
- Both registered in `packages/core/src/plugin/internal.ts` `pre` list: `KeteRoles.Plugin` at line 274 ("before `KeteBudgetRule` so they get its rule"), `KeteSkillPlugin.Plugin` at line 268 (last, "after `SkillPlugin` and `OpenCodeTools`, whose output it replaces").
- CLI: `bun run --cwd packages/kete-tools role-check --model <provider/model> [--kete <binary>] [--role <id>] [--kete-account]` (`role-check.ts:1-13`).

## Key files
- `roles.ts:21-46` shared rule fragments: `readOnly` (read/glob/grep allowed, `.env*` asks, `external_directory` asks), `lookCommands`/`allowShell` (status/diff/log/ls/grep/find/cat/wc only), `never` (hard denies: `sudo *`, `rm -rf /*`, `rm -rf ~*`), `subagent` (denies `question`/`subagent` for subagent-mode roles).
- `roles.ts:57-154` `roles` array — five `Role` records (`roles.ts:48-55`: id, name, description, `mode: "primary"|"subagent"|"all"`, `system`, `permissions`). Code Reviewer and Docs Writer are read-only plus scoped doc edits; QA and DevOps ask before edit/shell; Security asks before shell/webfetch and never repeats a found secret past its first four characters (`roles.ts:120`).
- `roles.ts:156-176` guards on `KeteAccount.read` — an *unreadable* account store is treated as "signed in" (`roles.ts:161-163`), so a broken account store never causes starter roles to override an organization's choices.
- `skill.ts:35` `replacedSkills = ["opencode", "report"]` — the only upstream skill IDs this plugin removes.
- `skill.ts:22-23,25,29` loads `./skill/kete.md` and `./skill/report.md` as build-time text imports; `KeteDescription`/`ReportDescription` are generated from `Brand.displayName` (never hardcoded product names, CLAUDE.md §5).
- `skill.ts:32,62-64` `ToolNamespaceDescription` — re-describes the inherited `opencode` tool namespace (the namespace ID itself is a tool-API contract and stays unchanged).
- `skill.ts:69-85` `reportDestination(issues)` — before `Brand.urls.issues` exists, tells the model to never publish anywhere and hand the user a markdown block instead; once it exists, tells it to confirm with the user before filing.
- `skill.ts:87-105` `reportWithDiagnostics` appends a live diagnostics snapshot (version, channel, OS, terminal, shell, active plugin packages) to the report skill content at registration time.
- `packages/kete-tools/src/role-scenarios.ts:4-19` `Scenario` type (role, agent, task, `auto` approve-prompts flag, seed `files`, `mayChange`/`mustChange` file-pattern assertions, `mustSay`/`mustNotSay` text assertions) and `SCENARIOS` — one fixture per role (e.g. code-reviewer must name the off-by-one in a seeded `math.js`; security must flag a seeded fake key but never repeat it).
- `packages/kete-tools/src/role-check.ts:64-114` `run()` — creates a throwaway git repo + HOME/XDG tree, strips `KETE_*`/`OPENCODE_*` from the inherited environment (`role-check.ts:78-80`), spawns `kete run --standalone --format json --model <model> --agent <role> [--auto] <task>`, then evaluates via `role-scenarios.ts`'s `evaluate`/`changedFiles`.
- `role-check.ts:17-53` `gatewayEnvironment()` — with `--kete-account`, borrows the signed-in account's gateway URL/key for the run (via `KeteAccount`), while the run itself still starts unauthenticated so starter roles remain in play; spends the organization's credit.

## Data flow
Plugin activation: `KeteRoles.Plugin` reads the local account store once at startup → if signed in (or unreadable), does nothing, leaving agent definitions to `KeteAgentSync` (platform sync, registered later in `plugin/internal.ts:308`, after this plugin so synced agents win) → otherwise, for each of the five `roles` entries it upserts an `Agent` via `ctx.agent.transform`, replacing (not appending to) the frozen `permissions` array (`roles.ts:172-174`) → agents defined in the user's own configuration with the same id still win, because config agents load after this plugin (`roles.ts:8`). Skills: `KeteSkillPlugin.Plugin` removes `opencode`/`report` and adds `kete`/`report` via `ctx.skill.transform`, and relabels the `opencode` tool namespace via `ctx.tool.transform` — runs after upstream's `SkillPlugin`, so it always overwrites rather than races it.

## Data and APIs used
- `@opencode/util/kete/account` (`KeteAccount.read`) — local sign-in state, gates whether starter roles are injected.
- `packages/core/src/kete/skill/kete.md` — Kete facts (paths, `KETE_*` env vars, commands, differences from upstream) plus a name-mapping table for reusing OpenCode's v2 docs as the upstream reference; the gateway-settings paragraph (`kete.md:60-66`) also names `kete.runtime.type`/`KETE_RUNTIME_TYPE` (ADR 0005) next to `kete.platform.url`; an "Unattended runs" bullet (`kete.md:88-101`) explains the `kete.unattended` policy shape, required limits, and the always-on Kete-config edit deny to the model — see the `unattended` card for the enforcement itself; an "Unattended jobs" bullet (`kete.md:102-107`) tells the model what `kete job run` does (spec file, its own worktree/branch, never touches the working checkout) — see the `cli` card and `docs/jobs.md`; a "Job mode" bullet (`kete.md:108-115`), inserted before it, tells the model what a `KETE_JOB_MODE=1` build refuses/ignores, and (A3) that file tools never follow a symlink or leave the worktree, so it should use real paths inside it — see the `job-mode` card; the following "Unattended audit log" bullet (`kete.md:116-124`) tells the model where and how its unattended actions are recorded (a local file; in a cloud job only the entrypoint's audit pipe, no file) — see the `audit-log` card.
- `packages/core/src/kete/skill/report.md` — the base report-drafting skill content, extended at runtime with the diagnostics snapshot.
- `role-check.ts` spawns the built `kete` binary as a subprocess (`--kete` flag, default `"kete"`) and reads `ANTHROPIC_API_KEY`-style env vars or `--kete-account`'s borrowed gateway credentials for the model.

## Rules that must not break
- Security and DevOps must stay `mode: "all"` so a workflow step (or the default agent) can delegate to them (docs/upstream-patches.md "Workflows"; confirmed `roles.ts:115,137`).
- Starter roles must never be added when signed in to an organization — an unreadable account store fails closed toward "signed in" (`roles.ts:161-163`), not toward re-adding local roles.
- A published agent's `permissions` array is frozen; both `roles.ts:173` and `budget-rule.ts` (see budget card) replace it (`[...x]`) rather than mutating in place.
- `KeteSkillPlugin` must stay registered after `SkillPlugin` and `OpenCodeTools` (`plugin/internal.ts:267-268`) so it overwrites their output; keep it last in `pre` on upstream reorder.
- The Security role must never repeat a found secret beyond its first four characters, in any part of its answer or in suggested commands (`roles.ts:120`) — this is enforced only by the system prompt, verified behaviorally by `role-scenarios.ts`'s `mustNotSay` on the seeded fake key.

## Testing
- `bun run test ./test/kete/roles.test.ts` inside `packages/core/`.
- `bun run test ./test/kete/skill.test.ts` inside `packages/core/`.
- `bun run test ./test/kete/skill-mcp-sync.test.ts` inside `packages/core/`.
- `bun test ./test/role-scenarios.test.ts` inside `packages/kete-tools/` (pure scenario/evaluate logic, no model).
- `bun run --cwd packages/kete-tools role-check --model <provider/model> [--role <id>]` — end-to-end behavior check against a real model; costs whatever that model costs, nothing runs without an explicit `--model` (`role-check.ts:1-13,30-33`).

## Changes
- docs/upstream-patches.md "Starter role agents" (feature/local-role-agents) and "Built-in skills" (feature/kete-skill) — file lists and the `plugin/internal.ts` registration-order notes.
- docs/architecture.md §24 (Initial Agent Categories), §29-31 (Skills Architecture, Portability, Must Be Inspectable).

## Gotchas
- `roles.ts:22` `readOnly` denies-then-allows (`*: deny` first, then specific allows) — each role's `permissions` array order matters for `Permission.evaluate`'s first-match semantics; don't reorder fragments when editing a role.
- `role-check.ts` strips `KETE_*` and `OPENCODE_*` from the *inherited* environment before each run (`role-check.ts:78-80`) specifically so a developer's own signed-in session never leaks into the check; `--kete-account` re-adds only the three gateway variables, never the full account.
- The role-check log file is deleted on success unless `--keep` is passed (`role-check.ts:113`), and is documented as never containing the gateway key even on failure (`role-check.ts:111`) — don't add logging that would put the key in `run.log`.
- `skill.ts`'s `configuredPlugins()` (`skill.ts:107-114`) reads `Config.Service` at *report-skill registration time*, so the diagnostics snapshot reflects plugins configured when the skill was loaded, not necessarily current state if config changes later in the session.
