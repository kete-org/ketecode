---
module: permissions
paths: [packages/core/src/kete/permission-mode.ts, packages/core/src/kete/shell-risk.ts, packages/util/src/kete/permission-mode.ts, packages/core/src/kete/permission-ceiling.ts, packages/core/src/permission.ts, packages/core/src/plugin/internal.ts, packages/cli/src/kete/permission-mode.ts, packages/tui/src/kete/permission-mode.tsx]
verified-at: ad8739fb7a
---
## Quick answers
- What does Kete Code allow by default in an interactive session? Upstream's default agent allows
  everything (`schema/src/agent.ts` `default`, `"*": allow`); Kete's safe defaults are applied on the
  `evaluate` hook by `permission-mode.ts` `apply()` (`:164`) only where that catch-all is the winning
  rule (`catchAll`, re-evaluating agent + session rules + saved approvals): edits allow; shell by
  `kete/shell-risk.ts` `classify()` (`:389`) — read/build allow, other ask, high ask; webfetch/
  websearch ask. User guide and full table: `docs/permissions.md`. No upstream agent edit.
- Which modes exist and what do they do? `default`, `accept-edits` (= default today), `auto` (only
  high-risk shell asks), `ask` (every edit/shell/web asks, even explicit allows), `plan` (edits and
  non-read shell denied, even explicit allows) — `decide()` (`permission-mode.ts:87`), names shared in
  `util/src/kete/permission-mode.ts`. Mode = root-most session's `kete.permissionMode`
  (`resolveMode`, `:148`), else `KETE_PERMISSION_MODE`, else default.
- How do I let users loosen a default? Any rule naming the action wins over the defaults (config
  `permissions`, agent rules, session rules, saved "always"); `"*": allow` doesn't, because it's
  indistinguishable from upstream's catch-all. `ask`/`plan` ignore explicit allows.
- What always asks regardless of rules (PR #20 review)? Edits to `.kete/**`, `kete.json(c)`, the
  global config/data dirs (`Lookup.protectedRoots`) and `.git/**` (`KeteShellRisk.protectedPath`),
  in every mode but Plan (denies). Build/test entry points (`KeteShellRisk.entryPoint`) ask in
  default/accept-edits unless a configured rule allows them; after one, the next test/build command
  asks once (`Lookup.buildChanged`, keyed by root session). Saved approvals never cover high-risk
  commands or ones that run anything (`KeteShellRisk.saveable`); the shell tool then offers no
  "Always allow" (`save: []`). Web fetch saves the URL's origin (`kete/web-host.ts`).
- How is `cd` checked when the shell tool never asks for it? The shell tool (marked edit) passes the
  whole line as `metadata.command`; `KeteShellRisk.classifyLine` flags `cd`/`pushd` out of the
  workspace.
- How are `cd` in subshells/loops, symlinks and redirects handled (re-review)? `shell/parse.ts`
  (marked) adds `kete/shell-directory.ts` directories for `cd`/`pushd` with no or an unknown target,
  so `external_directory` asks; edits are also checked on their real path (`realTarget`, through
  `FSUtil`: realpath of the deepest existing ancestor, then `readLink` per remaining component, so
  dangling links count; a chain over 32 links is `UNRESOLVED`, a protected path); web fetch follows redirects itself (`kete/web-redirect.ts`) and asks before another
  origin. `KeteShellRisk.changesBuild` flags `npm pkg set` etc. Accepted residual risk: edited test
  files run under `npm test` (`docs/permissions.md`; Wave 0b's sandbox contains it).
- What can Plan mode do? Only `planAllowed` actions (read, glob, grep, question, skill, budget,
  external_directory, webfetch/websearch, read-only shell, subagent, MCP resource reads); MCP tools
  and `worktree` are denied. Subagents inherit Plan through the root session.
- Do the safe defaults apply in unattended runs? No — `apply()` resolves `KeteUnattendedPolicy` and
  `decide()` returns no objection for an unattended family, except explicit `ask`/`plan`.
- Where are the clients' surfaces? CLI `--permission-mode`/`--auto` (`cli/src/kete/permission-mode.ts`,
  `cli` card); TUI `<leader>p`, `/mode`, status row (`tui/src/kete/permission-mode.tsx`); web toggle
  (`web-app` card); VS Code status bar (`vscode-extension` card).
- Does a permission decision change a shell command's environment? No — permissions decide whether it runs; what it sees is `core/src/kete/tool-env.ts` (Kete credentials never; other credentials not in an unattended run), wired after `prepare`'s `permission.assert` in the shell tool's `before` callback (`core/src/tool/plugin/shell.ts:217`). See the `unattended` card.
- What is in the `post` plugin order now? `internal.ts:319-321`: `KeteLocalModels.Plugin` (after `ConfigProviderPlugin`) then `KeteOffline.Plugin`, before `KeteJobPlugin` and `KeteUnattended`. Neither adds `evaluate` rules, so offline mode never widens a permission; `KeteOffline.Plugin.id` is in `guarded` (`internal.ts:337`) so repository config can't remove it.
- Where does job mode's `KeteJobPlugin.Plugin` sit in `plugin/internal.ts`'s registration lists,
  and does it touch `evaluate`? It's in `post`, immediately **before** `KeteUnattended.Plugin`
  (`internal.ts:316`, `// kete_change: before KeteUnattended.Plugin; job mode disables every MCP
  server and every non-kete model`), with its id added to the existing marked `guarded` block
  (`internal.ts:330`) — but it never hooks `evaluate`; it only runs `ctx.mcp.transform`/
  `ctx.model.transform` at startup. It doesn't participate in the `evaluate` hook order below; it's
  positioned next to `KeteUnattended.Plugin` only because both are "last, guarded, job-mode-adjacent"
  concerns, not because of hook ordering. Full contract: the `job-mode` card.
- What do these plugins add on top of upstream permissions? (1) the safe defaults and session permission modes (above), (2) a hard ceiling so a subagent can never get looser permissions than any ancestor session, and (3)/(4) an unattended run's fail-closed policy — see the `unattended` card for the full contract and hooks.
- Can permission-mode or permission-ceiling turn a deny into an allow, or an ask into an allow? No — both only ever tighten (`permission-mode.ts:26-28`, `permission-ceiling.ts:92-97`). The two `unattended` plugins are the only ones that can turn `ask` into `allow` (and only for a run's own policy) — see the `unattended` card.
- Where do they plug in? All run on the permission system's `evaluate` hook (`packages/core/src/permission.ts:179`), which only fires after `Permission.Service` has already ruled a request isn't denied.
- Full `evaluate` hook order (`plugin/internal.ts` `pre` then `post`, `pre` runs first): `KeteUnattended.PolicyPlugin` (`:277`, loosens `ask`→`allow` for a run's policy) → `KetePermissionMode.Plugin` (`:279`) → `KetePermissionCeiling.Plugin` (`:287`) → ... → `KeteAgentSync.Plugin`'s sync-policy hook (`kete/sync/plugin.ts:279`, org-synced policy) → `ConfigPolicyPlugin.Plugin` (`config/plugin/policy.ts:44`, local `kete.policy` config) → `KeteUnattended.Plugin` (last: in an unattended family, first denies outright any Kete-configuration target — `.kete/`, `kete.json`/`kete.jsonc`, the global config dir — even overriding an `allow` (D2, `kete job run` task, `unattended` card's `configTarget`), then denies any `ask` still standing) → the **read-only audit `evaluate` hook** (`kete/audit.ts` `onEvaluate`, installed by `KeteUnattended.Plugin` itself, not registered in `plugin/internal.ts` — `audit-log` card), which only records the final decision and can't change it. This full chain wasn't recorded anywhere before the unattended-runs task (2026-09-28).
- How is session metadata updated, and can a hook refuse it? `Session.setMetadata` (`packages/core/src/session/session.ts:76-82`) is the only publisher of `SessionEvent.MetadataUpdated`; session hooks can't fail (`plugin/hooks.ts:23-30`), so as of this task it calls a plain guard function directly (`KeteUnattendedPolicy.guardMetadata`) rather than a hook — see the `unattended` card.
- Does a config-rule deny ever reach an `evaluate` hook (including the audit hook)? No — `Permission.Service` returns `deny` for a configured deny rule *before* triggering `evaluate` (`permission.ts:173-176`), so no `evaluate` hook, including the audit one, ever sees it; such a call only shows up as the audit log's `tool` line with `status: "error"` (D2, `audit-log` card).
- Who writes `kete.permissionMode` today? All GET-merge-PATCH (metadata is replaced whole
  server-side): the VS Code title-bar shield (ask/default, `vscode-extension` card), the web app's
  Default/Auto/Ask/Plan toggle (`packages/app/src/kete/mode.ts` `apply()`, `web-app` card), the TUI's
  cycle command and `kete run --permission-mode` (`cli/src/kete/permission-mode.ts` `apply()`). A
  **new** session's mode is written atomically into `session.create`'s `metadata` (web:
  `new-session/composer-adapter.ts`; TUI: `component/prompt/index.tsx`, both via
  `packages/client/src/solid/data.ts`'s `kete_change`-marked `metadata` field). None touches
  `permissions` directly.
- Is "Plan" a permission mode? Yes, since feature/safe-defaults-modes: `plan` denies edits and
  non-read-only shell in the runtime. The web toggle's Plan writes it **and** selects upstream's
  `plan` agent (`core/src/plugin/plan.ts`) when offered; `derive()` still shows Plan when the agent is
  `plan`. Plan mode also denies the Plan agent's own plan-directory writes.
- Does upstream's own default agent allow anything into Kete's config by default? Yes —
  `core/src/agent.ts:63` allows `external_directory` into the global config directory by default;
  without `kete job run`'s D2 config-target deny (`unattended` card) an unattended run could still
  write there. `edit` permission resources (what `configTarget` matches against) are project-
  relative inside the project and absolute outside it, and `edit`/`write`/`patch` all assert action
  `edit` (`file-access.ts:97-125`; `tool/plugin/edit.ts:181`, `write.ts:79`, `patch.ts:197`); `shell`
  asserts one resource per parsed command text (`tool/plugin/shell.ts:134-136`) — the shape D2's
  best-effort shell-text check matches against.

## Purpose
Extends upstream's allow/ask/deny permission engine with Kete-specific policies, all applied only after upstream's own rule evaluation: a per-session UI toggle for stricter prompting (for editor clients like VS Code), a security backstop that caps subagent permissions at their ancestors' level so a restricted parent agent can't spawn an unrestricted child, and (the `unattended` card) a run-level policy that fails an unattended session closed. This card covers permission-mode and permission-ceiling in depth and the full `evaluate` hook order; for the unattended plugins' own logic see the `unattended` card.

## Entry points
- `packages/core/src/kete/permission-mode.ts:195` `Plugin` (`id: "kete.permission-mode"`); pure parts `decide()` `:87`, `apply()` `:164`.
- `packages/core/src/kete/shell-risk.ts:389` `classify()` (pure; `tokenize()` `:73`).
- `packages/core/src/kete/permission-ceiling.ts:100` `Plugin` (`id: "kete.permission-ceiling"`).
- Registered in `packages/core/src/plugin/internal.ts` `pre` list: `KeteUnattended.PolicyPlugin` at line 277 (after `KeteBudgetRule`, before mode/ceiling — see `unattended` card), `KetePermissionMode.Plugin` at line 279, `KetePermissionCeiling.Plugin` at line 287 (after `KeteWorktrees`, so it sees worktree-related permission events too). `KeteUnattended.Plugin` is last in the `post` list (`:315`), after `ConfigPolicyPlugin.Plugin`; both its own id and `PolicyPlugin`'s are in `guarded` (`:321-329`, a `// kete_change start/end` block since 895f9e239b — comment-only move, the ids didn't change) so repository config can't remove either. The audit `evaluate` hook (`audit-log` card) is not itself in this list or in `guarded` — it's installed at runtime from inside `KeteUnattended.Plugin`'s own effect, after that plugin registers its late hook, so it inherits `KeteUnattended.Plugin`'s guarded status without a separate entry.
- Seam: `packages/core/src/permission.ts:179` `hooks.trigger("permission", "evaluate", {...})` inside `evaluateInput` (`permission.ts:173-188`) — the only place any of these plugins' hooks fire.

## Key files
- `util/src/kete/permission-mode.ts` — `metadataKey = "kete.permissionMode"`, `modes`, labels, descriptions, client cycle order (Default → Auto → Ask → Plan).
- `permission-mode.ts:51` `guarded` — the actions modes affect: `edit`, `shell`, `webfetch`, `websearch`.
- `permission-mode.ts:87` `decide()` — pure per-request objection for a mode (allow = no objection); `tighten()` `:128` takes the stricter of it and the given decision.
- `permission-mode.ts:164` `apply()` — resolves the mode (root-most session, `resolveMode` `:148`), the unattended state, and per resource whether the winning rule is upstream's catch-all (`catchAll`); `Plugin` reads `KETE_PERMISSION_MODE` as the fallback.
- `shell-risk.ts` — tokenizer (fails closed on `$(`, backticks, subshells, heredocs, process substitution, unbalanced quotes), wrappers (`sudo`, `env`, `xargs`, `timeout`, `sh -c`, `eval`, `find -exec`, `cmd /c`), tables (network, infra, database, delete, privilege, system, credential tools, package managers), credential paths and outside-workspace paths.
- `permission-ceiling.ts:50-79` `ceiling()` — walks the parent-session chain (max depth 32, `MAX_DEPTH`, `permission-ceiling.ts:39`) computing the strictest decision any ancestor's agent rules (plus that ancestor's saved "always" approvals) would give the same request; a missing ancestor fails closed to `"deny"`.
- `permission-ceiling.ts:82-98` `apply()` — combines the event's current effect with `ceiling()` via `stricter()` (`permission-ceiling.ts:26-28`, rank `deny < ask < allow`); sets a denial message when tightened to `deny`.
- `permission-ceiling.ts:100-120` `Plugin` — wires `Lookup` (`permission-ceiling.ts:42-49`) from `Session.Service`, `Agent.Service`, `PermissionSaved.Service`, `Location.Service`.
- `permission-ceiling.ts:49` `Lookup.policy(sessionID)` — the session's unattended-run policy (`unattended` card), as allow rules with `budget`/`question` filtered out, `[]` when interactive; `ceiling()` appends it alongside saved approvals (`:65,81`) so a subagent's ancestors get what the family's unattended policy allows its root, the same way they already get saved "always" approvals — without this a policy-allowed `ask` would be denied once evaluated for a subagent.

## Data flow
A tool call or model action requests a permission → `Permission.Service.assert` (`permission.ts`) resolves configured rules + saved approvals, computes a base `effect` (`permission.ts:173-178`) → if not already denied, `hooks.trigger("permission", "evaluate", event)` runs every registered `evaluate` hook in plugin registration order (`permission.ts:179`) → in an unattended family, `KeteUnattended.PolicyPlugin`'s hook runs first: an `allow` that came only from a saved approval is recomputed as `ask` (D3), then an `ask` the run's policy allows becomes `allow` → `KetePermissionMode`'s hook may tighten `allow` → `ask` for guarded actions based on session metadata/env → `KetePermissionCeiling`'s hook may further tighten based on the ancestor chain (now including the family's unattended policy as an allowance for ancestors) → later, the sync-policy hook (`kete/sync/plugin.ts:279`) and `ConfigPolicyPlugin` (`config/plugin/policy.ts:44`) may tighten further per organization/local policy → finally, in an unattended family, `KeteUnattended.Plugin`'s late hook denies a Kete-configuration target outright (D2, overriding even an `allow`), then denies any `ask` still standing → in that same family, the audit `evaluate` hook (`audit-log` card) runs last of all and writes a `permission` line recording `event.effect`/`event.message` but never changes them → the final `event.effect`/`event.message` becomes the permission decision returned to the caller (`permission.ts:187`).

## Data and APIs used
- Session metadata: `kete.permissionMode` (`default | accept-edits | auto | ask | plan`), read through `Session.Service.get` along the parent chain.
- Services (permission-mode): `Session.Service`, `Agent.Service.resolve`, `PermissionSaved.Service.list`, `Location.Service` (same as permission-ceiling).
- Environment: `KETE_PERMISSION_MODE` (permission-mode fallback).
- Services (permission-ceiling): `Session.Service.get`, `Agent.Service.resolve`, `PermissionSaved.Service.list({projectID})` (saved "always" approvals as synthetic allow rules), `Location.Service` for the current project ID.
- `PermissionSaved` is registered as a plugin-visible service in `plugin/internal.ts:113,152` (`// kete_change`) specifically so `KetePermissionCeiling` can read saved approvals.

## Rules that must not break
- `Permission` must still return `deny` *before* triggering the `evaluate` hook — neither plugin ever sees or can override an upstream deny (docs/upstream-patches.md "Permission modes"; verify via `test/kete/permission-mode-service.test.ts` on upstream sync).
- The guarded action set for permission-mode must stay `edit`, `shell`, `webfetch`, `websearch` — check on upstream sync that tool actions haven't been renamed.
- The safe defaults key on upstream's catch-all `{ "*", "*", allow }` being the winning rule; if upstream changes its default agent, revisit `catchAll`. The classifier may only tighten: never return a decision looser than the one given (`tighten`).
- Unattended families keep their own policy: `decide()` must return no objection for them except in `ask`/`plan`.
- Permission-ceiling only tightens (`stricter()`), never loosens; a subagent must never exceed what every ancestor's agent would independently be granted (docs/architecture.md §27-28, §22 IDE Architecture — editor-driven "ask" mode).
- Registration order matters for both: `KetePermissionMode` after `KeteBudgetRule` and after `KeteUnattended.PolicyPlugin`; `KetePermissionCeiling` after `KeteWorktrees` (`plugin/internal.ts:279,287`) — reordering changes which hook sees which event state first, though mode and ceiling are designed to compose regardless of order since each only tightens. `KeteUnattended.PolicyPlugin` must stay the first `pre` hook that touches `evaluate` (only `KeteBudgetRule`, an `agent.transform` hook, precedes it) and `KeteUnattended.Plugin` must stay last in `post`, or a hook that would otherwise tighten `ask` back could be skipped or a loosened `allow` could reach a caller (`plugin/internal.ts:277,315`, `guarded` at `:321-327` stops repository config from removing either).

## Testing
- `bun run test ./test/kete/shell-risk.test.ts` inside `packages/core/` (classification table, ~225 cases).
- `bun run test ./test/kete/permission-mode.test.ts` inside `packages/core/` (mode table, explicit vs catch-all, saved approvals, root mode, unattended).
- `bun run test ./test/kete/permission-mode-service.test.ts` inside `packages/core/` (real service, deny-before-hook, later org-style deny, `ShellParse.scan` resources).
- `bun test test/kete/permission-mode.test.ts` in `packages/cli/` and `bun test test/kete/permission-mode.test.tsx` in `packages/tui/`.
- `bun run test ./test/kete/permission-ceiling.test.ts` inside `packages/core/`.

## Changes
- docs/upstream-patches.md "Safe defaults and permission modes" (feature/safe-defaults-modes), "Permission modes" (feature/vscode-permission-modes) and "Subagent security" (fix/subagent-security) — file-by-file change lists and sync checklist.
- docs/upstream-patches.md "Unattended runs (feature/unattended-policy)" — the two new plugins, the full `evaluate` hook order, and `permission-ceiling.ts`'s `Lookup.policy` addition; see the `unattended` card for the module itself.
- docs/architecture.md §22 (IDE Architecture), §27-28 (Human-in-the-Loop, High-Risk Operations) — design rationale for editor-driven modes and risk tiers.

## Gotchas
- `kete run` can't answer prompts: in default mode any "other" or high-risk command is rejected and the run stops; `--auto` still rejects high-risk ones; only `--dangerously-skip-permissions` approves everything.
- Upstream's wildcard treats a trailing ` *` as optional: a saved `git push *` approval also covers bare `git push`.
- Web fetch's "Always allow" saves `*` (all URLs) — there's no per-host scope.
- `permission-ceiling.ts` resolves a missing agent as `[{action:"*", resource:"*", effect:"deny"}]` (`permission-ceiling.ts:69-70`) — matches upstream's own "deny for a missing agent" behavior, so a corrupted ancestor fails closed rather than open.
- Saved "always" approvals count for *ancestors* exactly as they do for the child (`permission-ceiling.ts:60,74`) — approving once doesn't cause an ancestor to ask forever on replay, but also means an ancestor's stale saved approval silently raises the child's ceiling.
- `MAX_DEPTH = 32` (`permission-ceiling.ts:39`) treats an over-deep ancestor chain as a cycle/corruption and fails closed to `deny`, not a permissive default.
