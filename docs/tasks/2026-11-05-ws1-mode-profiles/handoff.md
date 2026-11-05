# Handoff: WS1 mode profiles

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 planner
- Done: read INDEX, spec, config-kete card; ran `node scripts/agent/stale-cards.mjs config-kete permissions server-sdk`.
- Blocked: plan not written. Two cards the spec touches are stale; the librarian must refresh them first:
  - `permissions` (3 files since 2800ac0ed3: `core/src/kete/permission-mode.ts`, `core/src/kete/plan-approval.ts`, `core/src/plugin/internal.ts`; commits #85, #87, #88, #89). `internal.ts` is the one upstream file this task edits.
  - `server-sdk` (covers the handshake and RPC serving; 2 files since 94eab8d8fd: `protocol/openapi.json`, `client/src/promise/generated/types.ts`; commits #82, #86, #88).
- `config-kete` is fresh.
- Next: librarian refreshes `permissions` and `server-sdk`, then re-run the planner.

## 2026-11-05 planner (re-run)
- Done: `stale-cards.mjs config-kete permissions server-sdk` → all current. Wrote `plan.md` (15 files).
- Decision: register `kete.modes` inside the Kete-owned `KeteHandshake.Plugin` instead of a new plugin in upstream
  `core/src/plugin/internal.ts` (upstream-first; zero upstream edits). Fallback in the plan if the user wants a separate plugin.
- Decision: embed profiles with Bun's native `.jsonc` import (parsed at bundle time) and decode with
  `onExcessProperty: "error"`; text import + `jsonc-parser` is the fallback.
- Found: `core/src/kete/modes/{code,work}.jsonc` and `core/test/kete/modes.test.ts` already exist (Phase 0); the plan fills/rewrites them.
- Worktree has no `node_modules`; `bun install` is step 0.
- Docs enough: no — missing: config-kete has no line on how a Kete file is embedded in the binary (`with { type: "text" }` as in `core/src/models-dev.ts:18`, `kete/skill.ts:22`; bun-types declares `*.jsonc`/`*.txt`); no card names `core/src/kete/modes/*.jsonc` or `core/test/kete/modes.test.ts`.
- Docs enough: no — missing: no card cites the strict-decode pattern `onExcessProperty: "error"` (`core/src/kete/unattended-policy.ts:88`).
- Open: AC4 smoke command (temp HOME + `KETE_SERVER_PASSWORD` + curl) is my construction, not in `commands.md`.

## 2026-11-05 implementer
- Done: all plan steps 1-6 written (schema `kete/modes.ts` + test, `code.jsonc`/`work.jsonc`, core loader `kete/modes.ts`, handshake registers `kete.modes`, core and server tests, plan doc + upstream-patches note). Zero upstream edits; `internal.ts` untouched.
- NOT RUN: this agent had no shell tool, so `bun install`, typecheck, tests, build, lint and `upstream:check` were not run. Every AC is unverified.
- Risks to check first: native `.jsonc` import typing/bundling (plan's fallback is text import + `jsonc-parser`); the `as` cast in the schema modes test.
- Cards not updated (librarian's job).
