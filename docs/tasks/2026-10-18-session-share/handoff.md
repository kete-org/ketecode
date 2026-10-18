# Handoff: session share

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-18 planner
- Done: read INDEX.md, spec.md; ran `stale-cards.mjs` on the spec's cards and the cards the plan must rely on.
- Fresh: sync, audit-log, cli, vscode-extension, attribution-hosted, runtime-registration, job-mode, config-kete.
- **Stopped: the librarian must refresh these cards before planning** (the plan depends on each):
  - `account-login` (`KeteAccount.key`, signed-in check) — stale since 41ddef7737: `packages/tui/src/kete/setup-login.ts`, `packages/util/src/kete/setup.ts` (A15 #53).
  - `add-dir` (`KeteAddDir.withoutDirs`, the import-stripping pattern AC4 copies) — stale since b8e534dfcb: `packages/core/src/kete/add-dir-plugin.ts`, `packages/core/src/kete/add-dir.ts` (A13 #51 and later).
  - `local-models` (`KeteOffline.active` refusal) — stale since 41ddef7737: `packages/tui/src/kete/local-models.ts`, `local-offer.tsx`, `packages/util/src/kete/local-picker.ts` (A15 #53).
  - `server-sdk` (protocol/client regeneration for the `kete.share` RPC) — stale since f3d1b962ee: `packages/protocol/openapi.json`, `packages/client/src/promise/generated/types.ts`, `packages/server/script/kete/isolated-test.ts` (A2a #49, A2b #50, A10 #44, A13 #51).
- Note: `attribution-hosted`, `cli`, `sync`, `vscode-extension` have uncommitted edits in the working tree; the librarian should confirm those are intended before the plan cites them.
- plan.md not written. Re-run `/task-plan` after the refresh.

## 2026-10-18 planner (re-run)
- Done: `stale-cards.mjs` on all 12 cards is clean now (the librarian's refresh is in the working tree). Wrote plan.md.
- Decisions (in plan.md "Design decisions"):
  - the local record carries `session`, and child sessions are refused, because children inherit metadata (`core/src/session.ts:279`);
  - config `share: "disabled"` in any file wins;
  - sync cache version 3, so a pre-`share` ETag is never resent;
  - no protocol regeneration (generic RPC route).
- Upstream edits: `core/src/plugin/internal.ts`, `core/src/session/transfer.ts` (an existing marked line), `tui/src/routes/session/index.tsx`, `cli/src/index.ts`, `tui/test/fixture/tui-client.ts`. The spec named only the first and third.
- Blocker: platform `feature/session-shares` has no commits, and `docs/contracts/session-shares-v1.md` isn't on its main. The contract copy is from spec.md until step 13. AC9 can't run until the platform is built.
- Docs enough: no. Missing:
  - Session read API: the spec's `Session.messages`/`Session.diff` live on `Session.Service` in `core/src/session.ts:134-150`, not in `session/session.ts`.
  - Message union shape (`schema/src/session-message.ts`).
  - Children inheriting metadata (`session.ts:279`).
  - Vscode extension server calls are raw `fetch(connection.url + "/api/…")` (`extension.ts:1028,1255`).
  - Still open: does `diff` with no `from`/`to` cover the whole session (`session/diff.ts:38`)? The implementer checks.
- Open question for the user: should forked sessions start unshared? The record's `session` check already makes them unshared; confirm that's wanted.

## 2026-10-18 implementer (steps 1-10)
- **No shell tool was available: nothing was run (no typecheck, no tests, no lint, no upstream:check).** Every file is unverified; expect typecheck fixes (Effect v4 / Solid typing, `satisfies`, narrowing on `Record<string, unknown>` in `kete-vscode/src/share.ts`) and possibly brittle frame waits in the TUI test.
- Done (steps 1-10):
  - util: `sync/contract.ts` (optional `share`), `sync/cache.ts` (version 1|2|3), `sync/sync.ts` (writes 3, ETag only from a v3 cache), `test/kete/sync.test.ts` (v1 and v2 caches refetch, new copy is v3), new `kete/share.ts` (client, `ShareError`, `policy`) and `test/kete/share.test.ts`.
  - schema: new `kete/share.ts` (`KeteShareRpc`: `Refusal`, `Record`, `PreviewOutput`, `ShareOutput`, `UnshareOutput`, `Definition`).
  - core: new `kete/share/{record,snapshot,plugin}.ts`; upstream edits in `plugin/internal.ts` and `session/transfer.ts` (marked); tests `test/kete/share-snapshot.test.ts`, `test/kete/share.test.ts`.
  - tui: new `kete/share.tsx`; upstream edits in `routes/session/index.tsx` (import + 2 `run:` bodies, `enabled: false` dropped); test `test/kete/share.test.tsx`.
  - cli: new `kete/share-flow.ts`, `kete/share.ts`; specs in `kete/commands.ts`; two entries in `src/index.ts` (marked); test `test/kete/share.test.ts`.
  - vscode: new `src/share.ts`, commands in `src/extension.ts`, `package.json` (2 commands, 2 `view/item/context` entries; palette by default), `test/share.test.ts`.
  - docs: `docs/sharing.md`, `docs/platform/session-shares-v1.md`, `docs/platform/sync-v1.md` (`share` field), `CHANGELOG.md`, `packages/kete-vscode/CHANGELOG.md`, `docs/upstream-patches.md` "Session sharing".
- Deviations from plan, with reasons:
  - **Did not edit `docs/context/contracts.md`** (the rule says never edit `docs/context/`); the librarian should add the contract section and the card updates.
  - **Did not edit `tui/test/fixture/tui-client.ts`**: `createFetch(override)` lets the test serve `kete.share` itself, so no upstream test-fixture patch (the upstream-patches table does not list it).
  - The RPC `Refusal` has an extra kind `failed` (platform/network error, shown as a message; CLI exit 1) beyond the plan's list. `preview` returns `refusal` (optional) instead of `allowed`.
  - Redaction window is `cap + 16 KiB` rather than a flat 16 KB, so the window edge is always past the kept cap (the audit.ts reasoning) for the 256 KiB text cap too.
  - Diffs: the plugin asks `Session.diff` from the first user message to the last (whole session). If that throws (e.g. a location change inside the session), diffs are empty and `truncated` is set (visible in the preview). `Session.diff` with no `from`/`to` only covers the latest turn, so the range is needed; not run against a real session.
  - `unshare` is refused only for job mode, offline and signed out (not for config/org `disabled`, not for child sessions): removing your own share stays possible after policy turns sharing off. Documented in `docs/sharing.md`.
  - An existing share keeps its visibility (PUT does not change it); `--link` on an organization-only share is refused in the CLI with "unshare first". With no sync cache, `linkAllowed` is true and the platform decides.
  - The `unavailable` helper in the session route is now unused; left in place per the plan (delete it if lint flags it).
- Open: AC9 and step 13 (platform contract diff, end to end) still wait for the platform. The TUI test's frame waits (`Share session\s+Session` in the palette, "Secrets removed: 2", "The link stops working") are guesses modelled on `copy-session-id.test.tsx`; the toast URL assertion depends on `clipboard.write` not throwing in the test app.
- Checks the main session must run: `bun test ./test/kete/sync.test.ts ./test/kete/share.test.ts` (util); `bun run test ./test/kete/share-snapshot.test.ts ./test/kete/share.test.ts` (core); `bun test ./test/kete/share.test.tsx` (tui); `bun test ./test/kete/share.test.ts` (cli); `bun test ./test/share.test.ts` (kete-vscode); typecheck in util, schema, core, tui, cli, kete-vscode; root lint; `upstream:check`.
