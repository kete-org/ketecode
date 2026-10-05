---
module: permissions
paths: [packages/core/src/kete/permission-mode.ts, packages/core/src/kete/permission-ceiling.ts, packages/core/src/permission.ts, packages/core/src/plugin/internal.ts]
verified-at: 604889ab32
---
## Quick answers
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
- What do these plugins add on top of upstream permissions? (1) an editor-chosen session-wide "ask before edits/shell/webfetch" mode, (2) a hard ceiling so a subagent can never get looser permissions than any ancestor session, and (3)/(4) an unattended run's fail-closed policy — see the `unattended` card for the full contract and hooks.
- Can permission-mode or permission-ceiling turn a deny into an allow, or an ask into an allow? No — both only ever tighten (`permission-mode.ts:26-28`, `permission-ceiling.ts:92-97`). The two `unattended` plugins are the only ones that can turn `ask` into `allow` (and only for a run's own policy) — see the `unattended` card.
- Where do they plug in? All run on the permission system's `evaluate` hook (`packages/core/src/permission.ts:179`), which only fires after `Permission.Service` has already ruled a request isn't denied.
- Full `evaluate` hook order (`plugin/internal.ts` `pre` then `post`, `pre` runs first): `KeteUnattended.PolicyPlugin` (`:277`, loosens `ask`→`allow` for a run's policy) → `KetePermissionMode.Plugin` (`:279`) → `KetePermissionCeiling.Plugin` (`:287`) → ... → `KeteAgentSync.Plugin`'s sync-policy hook (`kete/sync/plugin.ts:279`, org-synced policy) → `ConfigPolicyPlugin.Plugin` (`config/plugin/policy.ts:44`, local `kete.policy` config) → `KeteUnattended.Plugin` (last: in an unattended family, first denies outright any Kete-configuration target — `.kete/`, `kete.json`/`kete.jsonc`, the global config dir — even overriding an `allow` (D2, `kete job run` task, `unattended` card's `configTarget`), then denies any `ask` still standing) → the **read-only audit `evaluate` hook** (`kete/audit.ts` `onEvaluate`, installed by `KeteUnattended.Plugin` itself, not registered in `plugin/internal.ts` — `audit-log` card), which only records the final decision and can't change it. This full chain wasn't recorded anywhere before the unattended-runs task (2026-09-28).
- How is session metadata updated, and can a hook refuse it? `Session.setMetadata` (`packages/core/src/session/session.ts:76-82`) is the only publisher of `SessionEvent.MetadataUpdated`; session hooks can't fail (`plugin/hooks.ts:23-30`), so as of this task it calls a plain guard function directly (`KeteUnattendedPolicy.guardMetadata`) rather than a hook — see the `unattended` card.
- Does a config-rule deny ever reach an `evaluate` hook (including the audit hook)? No — `Permission.Service` returns `deny` for a configured deny rule *before* triggering `evaluate` (`permission.ts:173-176`), so no `evaluate` hook, including the audit one, ever sees it; such a call only shows up as the audit log's `tool` line with `status: "error"` (D2, `audit-log` card).
- Who writes `kete.permissionMode` today? Two clients, both GET-merge-PATCH (metadata is replaced
  whole server-side): the VS Code extension's title-bar "Ask before edits" toggle
  (`kete-vscode/src/extension.ts:1205-1276`, `vscode-extension` card) and, as of this task, the web
  app's chat-panel Auto/Ask/Plan toggle (`packages/app/src/kete/mode.ts`'s `apply()`, `web-app`
  card). A **new** session's mode is instead written atomically into `session.create`'s `metadata`
  (`new-session/composer-adapter.ts`, via `packages/client/src/solid/data.ts`'s `kete_change`-marked
  `metadata` field — `server-sdk` card) so there's no window where the session exists without its
  mode. Both writers only ever set `"default"` or `"ask"`, never touch `permissions` directly, and
  both re-read on `session.metadata.updated` to stay in sync with each other.
- Is "Plan" a permission mode? No — the web app's toggle's third state selects upstream's `plan`
  agent (`core/src/plugin/plan.ts`, id `"plan"`, primary); it writes no metadata for that state. The
  `roles-skills` card doesn't cover this agent (only Kete's starter roles); `mode.ts`'s `derive()`
  treats `agent === "plan"` as the Plan state regardless of `kete.permissionMode`.
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
- `packages/core/src/kete/permission-mode.ts:30` `Plugin` (`id: "kete.permission-mode"`).
- `packages/core/src/kete/permission-ceiling.ts:100` `Plugin` (`id: "kete.permission-ceiling"`).
- Registered in `packages/core/src/plugin/internal.ts` `pre` list: `KeteUnattended.PolicyPlugin` at line 277 (after `KeteBudgetRule`, before mode/ceiling — see `unattended` card), `KetePermissionMode.Plugin` at line 279, `KetePermissionCeiling.Plugin` at line 287 (after `KeteWorktrees`, so it sees worktree-related permission events too). `KeteUnattended.Plugin` is last in the `post` list (`:315`), after `ConfigPolicyPlugin.Plugin`; both its own id and `PolicyPlugin`'s are in `guarded` (`:321-329`, a `// kete_change start/end` block since 895f9e239b — comment-only move, the ids didn't change) so repository config can't remove either. The audit `evaluate` hook (`audit-log` card) is not itself in this list or in `guarded` — it's installed at runtime from inside `KeteUnattended.Plugin`'s own effect, after that plugin registers its late hook, so it inherits `KeteUnattended.Plugin`'s guarded status without a separate entry.
- Seam: `packages/core/src/permission.ts:179` `hooks.trigger("permission", "evaluate", {...})` inside `evaluateInput` (`permission.ts:173-188`) — the only place any of these plugins' hooks fire.

## Key files
- `permission-mode.ts:14` `metadataKey = "kete.permissionMode"` — session metadata key an editor client sets (e.g. VS Code's "Ask before edits" toggle); subagent sessions inherit it.
- `permission-mode.ts:19` `guarded` — the three actions "ask" mode affects: `edit`, `shell`, `webfetch`.
- `permission-mode.ts:26-28` `apply()` — pure function: turns `allow` into `ask` for guarded actions when mode is `"ask"`; no-op otherwise.
- `permission-mode.ts:33` env fallback `KETE_PERMISSION_MODE` used when a session has no metadata key, so an editor can set its default for new sessions.
- `permission-ceiling.ts:50-79` `ceiling()` — walks the parent-session chain (max depth 32, `MAX_DEPTH`, `permission-ceiling.ts:39`) computing the strictest decision any ancestor's agent rules (plus that ancestor's saved "always" approvals) would give the same request; a missing ancestor fails closed to `"deny"`.
- `permission-ceiling.ts:82-98` `apply()` — combines the event's current effect with `ceiling()` via `stricter()` (`permission-ceiling.ts:26-28`, rank `deny < ask < allow`); sets a denial message when tightened to `deny`.
- `permission-ceiling.ts:100-120` `Plugin` — wires `Lookup` (`permission-ceiling.ts:42-49`) from `Session.Service`, `Agent.Service`, `PermissionSaved.Service`, `Location.Service`.
- `permission-ceiling.ts:49` `Lookup.policy(sessionID)` — the session's unattended-run policy (`unattended` card), as allow rules with `budget`/`question` filtered out, `[]` when interactive; `ceiling()` appends it alongside saved approvals (`:65,81`) so a subagent's ancestors get what the family's unattended policy allows its root, the same way they already get saved "always" approvals — without this a policy-allowed `ask` would be denied once evaluated for a subagent.

## Data flow
A tool call or model action requests a permission → `Permission.Service.assert` (`permission.ts`) resolves configured rules + saved approvals, computes a base `effect` (`permission.ts:173-178`) → if not already denied, `hooks.trigger("permission", "evaluate", event)` runs every registered `evaluate` hook in plugin registration order (`permission.ts:179`) → in an unattended family, `KeteUnattended.PolicyPlugin`'s hook runs first: an `allow` that came only from a saved approval is recomputed as `ask` (D3), then an `ask` the run's policy allows becomes `allow` → `KetePermissionMode`'s hook may tighten `allow` → `ask` for guarded actions based on session metadata/env → `KetePermissionCeiling`'s hook may further tighten based on the ancestor chain (now including the family's unattended policy as an allowance for ancestors) → later, the sync-policy hook (`kete/sync/plugin.ts:279`) and `ConfigPolicyPlugin` (`config/plugin/policy.ts:44`) may tighten further per organization/local policy → finally, in an unattended family, `KeteUnattended.Plugin`'s late hook denies a Kete-configuration target outright (D2, overriding even an `allow`), then denies any `ask` still standing → in that same family, the audit `evaluate` hook (`audit-log` card) runs last of all and writes a `permission` line recording `event.effect`/`event.message` but never changes them → the final `event.effect`/`event.message` becomes the permission decision returned to the caller (`permission.ts:187`).

## Data and APIs used
- Session metadata: `kete.permissionMode` (`"default" | "ask"`), read via `ctx.session.get({sessionID})` (`permission-mode.ts:41-43`).
- Environment: `KETE_PERMISSION_MODE` (permission-mode fallback).
- Services (permission-ceiling): `Session.Service.get`, `Agent.Service.resolve`, `PermissionSaved.Service.list({projectID})` (saved "always" approvals as synthetic allow rules), `Location.Service` for the current project ID.
- `PermissionSaved` is registered as a plugin-visible service in `plugin/internal.ts:113,152` (`// kete_change`) specifically so `KetePermissionCeiling` can read saved approvals.

## Rules that must not break
- `Permission` must still return `deny` *before* triggering the `evaluate` hook — neither plugin ever sees or can override an upstream deny (docs/upstream-patches.md "Permission modes"; verify via `test/kete/permission-mode-service.test.ts` on upstream sync).
- The guarded action set for permission-mode must stay `edit`, `shell`, `webfetch` — check on upstream sync that tool actions haven't been renamed.
- Permission-ceiling only tightens (`stricter()`), never loosens; a subagent must never exceed what every ancestor's agent would independently be granted (docs/architecture.md §27-28, §22 IDE Architecture — editor-driven "ask" mode).
- Registration order matters for both: `KetePermissionMode` after `KeteBudgetRule` and after `KeteUnattended.PolicyPlugin`; `KetePermissionCeiling` after `KeteWorktrees` (`plugin/internal.ts:279,287`) — reordering changes which hook sees which event state first, though mode and ceiling are designed to compose regardless of order since each only tightens. `KeteUnattended.PolicyPlugin` must stay the first `pre` hook that touches `evaluate` (only `KeteBudgetRule`, an `agent.transform` hook, precedes it) and `KeteUnattended.Plugin` must stay last in `post`, or a hook that would otherwise tighten `ask` back could be skipped or a loosened `allow` could reach a caller (`plugin/internal.ts:277,315`, `guarded` at `:321-327` stops repository config from removing either).

## Testing
- `bun run test ./test/kete/permission-mode.test.ts` inside `packages/core/` (pure `apply`/`parse` logic).
- `bun run test ./test/kete/permission-mode-service.test.ts` inside `packages/core/` (hook wiring, deny-before-hook invariant).
- `bun run test ./test/kete/permission-ceiling.test.ts` inside `packages/core/`.

## Changes
- docs/upstream-patches.md "Permission modes" (feature/vscode-permission-modes) and "Subagent security" (fix/subagent-security) — file-by-file change lists and sync checklist.
- docs/upstream-patches.md "Unattended runs (feature/unattended-policy)" — the two new plugins, the full `evaluate` hook order, and `permission-ceiling.ts`'s `Lookup.policy` addition; see the `unattended` card for the module itself.
- docs/architecture.md §22 (IDE Architecture), §27-28 (Human-in-the-Loop, High-Risk Operations) — design rationale for editor-driven modes and risk tiers.

## Gotchas
- `permission-ceiling.ts` resolves a missing agent as `[{action:"*", resource:"*", effect:"deny"}]` (`permission-ceiling.ts:69-70`) — matches upstream's own "deny for a missing agent" behavior, so a corrupted ancestor fails closed rather than open.
- Saved "always" approvals count for *ancestors* exactly as they do for the child (`permission-ceiling.ts:60,74`) — approving once doesn't cause an ancestor to ask forever on replay, but also means an ancestor's stale saved approval silently raises the child's ceiling.
- `MAX_DEPTH = 32` (`permission-ceiling.ts:39`) treats an over-deep ancestor chain as a cycle/corruption and fails closed to `deny`, not a permissive default.
