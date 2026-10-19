---
module: session-share
paths: [packages/core/src/kete/share/**, packages/util/src/kete/share.ts, packages/schema/src/kete/share.ts, packages/tui/src/kete/share.tsx, packages/cli/src/kete/share.ts, packages/cli/src/kete/share-flow.ts, packages/kete-vscode/src/share.ts]
verified-at: 063cfce610
---
## Quick answers
- What does sharing send, and where? A redacted snapshot of one session to the Kete portal only (`POST/PUT/DELETE /api/v1/shares`), never anywhere else; what is sent is in `docs/sharing.md`, the wire contract in `docs/platform/session-shares-v1.md`.
- Where is the logic? Plugin `kete.share` with RPC `preview`/`share`/`unshare` (`core/src/kete/share/plugin.ts:60`, schema `schema/src/kete/share.ts:69`); registered in `core/src/plugin/internal.ts` (marked). TUI, CLI and VS Code are thin clients of that RPC.
- In what order are refusals made? Another folder, job mode, offline, child session, signed out, config `share: "disabled"` in any entry, synced policy (`plugin.ts:77-127`); none of them calls the network. `unshare` skips config/org-disabled and child checks so you can still delete your own share (`plugin.ts:11-12`).
- Where is the share remembered? Session metadata key `kete.share` (`core/src/kete/share/record.ts:10`), carrying `session`; a record for another session id is ignored because children inherit metadata (`core/src/session.ts:279`). Imports drop it (`core/src/session/transfer.ts` via `KeteShareRecord.without`).
- How is the snapshot redacted? Each string is windowed, run through `KeteRedact.text`, then capped, so a secret on a cut is never half-shown (`snapshot.ts:8-9,24`); 2 MiB total (`snapshot.ts:22`), then `too_large`. A `digest` from the preview makes `share` refuse (`changed`) if the session moved (`plugin.ts:215`).
- Can the agent share? No: shells the agent runs carry `KETE_AGENT_SHELL=1` (`core/src/kete/tool-env.ts:130`) and `kete share` refuses when `KeteEnv.inAgentShell` (`cli/src/kete/share.ts:24`).
- Which key is used? The signed-in account key via `KeteAccount.key`; a job key is never sent. Errors carry the request id, never the key or body (`util/src/kete/share.ts`).
- How does the VS Code extension call it? Raw `fetch` of `POST /api/rpc/kete.share/<method>` (`kete-vscode/src/extension.ts:1043`, bodies in `src/share.ts:15-19`).
- Session read API: `Session.Service.messages`/`diff` live in `core/src/session.ts:134-150`, not `session/session.ts`; `diff` with no `from`/`to` covers only the latest turn, so the plugin passes the first-to-last user message range.

## Purpose
Lets a user publish a read-only, redacted copy of a session to their Kete portal (org or link visibility) and delete it again. Runtime side of the session-shares contract.

## Entry points
- `core/src/kete/share/plugin.ts:60` `make`, `:277` `Plugin`; RPC definition `schema/src/kete/share.ts:69`.
- TUI: `tui/src/kete/share.tsx:61` `share`, `:77` `unshare`, wired to `/share` and `/unshare` in `tui/src/routes/session/index.tsx` (marked).
- CLI: `kete share [session-id] [--link] [--yes]`, `kete unshare` (`cli/src/kete/share.ts:66,76`, flow `share-flow.ts:53,102`, exit 0 done / 1 failed / 2 refused, `:15`; `cli/src/index.ts:40-41`).
- VS Code: commands `kete.shareSession`/`kete.unshareSession` (`extension.ts:213-214`).

## Key files
- `core/src/kete/share/snapshot.ts` pure `build`/`cap`/`digest`; `record.ts` metadata record; `util/src/kete/share.ts` HTTP client (`create`/`update`/`remove`, `ShareError`, `policy`, 15 s timeout, no redirects).
- `util/src/kete/sync/contract.ts:149` the synced `share: { mode, max_days }` policy; absent means org, 30 days.

## Data flow
Client calls `preview` (nothing uploaded; counts, redactions, digest) -> user confirms -> `share` rebuilds the snapshot, POSTs (or PUTs when a matching record exists; a 404 on PUT clears the record and POSTs once) -> record stored in session metadata -> URL returned.

## Data and APIs used
Account (`KeteAccount`), sync cache policy (`KeteSyncCache.read`), `Session.Service`, `Config`, `KeteOffline`, `KeteJobMode`, `KeteRedact`.

## Rules that must not break
- Nothing is uploaded without an explicit share call (preview confirm, `--yes`; no TTY without `--yes` is refused).
- Config `share: "disabled"` in any file wins (restrictive wins, CLAUDE.md §5).
- Redact before truncating; never send over 2 MiB.
- Sharing goes to the Kete portal only; no other host.

## Testing
`core/test/kete/share-snapshot.test.ts`, `share.test.ts` (fake `fetch` via `make({ fetch })`); `util/test/kete/share.test.ts`; `tui/test/kete/share.test.tsx`; `cli/test/kete/share.test.ts`; `kete-vscode/test/share.test.ts`.

## Changes
Added with the 2026-10-18 session-share task. Upstream edits are listed in `docs/upstream-patches.md` "Session sharing".

## Gotchas
- The platform side was not built at the time; the contract copy came from the spec, so diff it against the platform's copy.
- RPC `Refusal` has a `failed` kind (platform/network error) beyond the policy ones.
- An existing share keeps its visibility; `--link` on an org-only share is refused ("unshare first").
