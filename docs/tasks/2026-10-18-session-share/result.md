# Result: session sharing to the portal (A5, runtime side)

## What changed
- **util:**
  - `kete/share.ts`: the client. Typed errors, `redirect: "error"`, and platform text stripped of control characters.
  - Sync contract: an optional `share` field, and cache version 3.
  - `env.ts`: `inAgentShell`.
- **schema:** `kete/share.ts`, the `kete.share` RPC (`preview`, `share`, `unshare`).
- **core:**
  - `kete/share/{snapshot,record,plugin}.ts`: the snapshot, the session record and the policy checks.
  - `tool-env.ts`: sets `KETE_AGENT_SHELL` on agent shells.
- **tui:** `kete/share.tsx`, the `/share` preview dialog and `/unshare`.
- **cli:** `kete share` and `kete unshare` (`share-flow.ts`, `share.ts`).
- **kete-vscode:** `src/share.ts` plus the "Share Session" and "Unshare Session" commands.
- **Upstream (marked, in docs/upstream-patches.md):**
  - `core/src/plugin/internal.ts`
  - `core/src/session/transfer.ts`
  - `tui/src/routes/session/index.tsx`
  - `cli/src/index.ts`
- **Docs:**
  - `docs/sharing.md`
  - `docs/platform/session-shares-v1.md`, an exact copy of the platform's
  - `sync-v1.md`
  - both CHANGELOGs
  - cards, including the new `session-share` card

## Checks
| Check | Result |
|---|---|
| `verify --base main` | 0 new failures (util 488, server 101, core 7086 / 31 that fail on main too, tui 1507, cli 716) |
| kete-vscode typecheck, `bun run test` | pass, 121 |
| root `bun run lint`, `upstream:check`, card-check | pass |
| protocol `bun run generate` | no diff (the RPC goes through the generic `/api/rpc` route) |

## Acceptance criteria
- [x] AC1 to AC7: `core/test/kete/share-snapshot.test.ts`, `core/test/kete/share.test.ts`, `util/test/kete/share.test.ts`, `tui/test/kete/share.test.tsx`, `cli/test/kete/share.test.ts`, `kete-vscode/test/share.test.ts`.
- [x] AC8: the checks above.
- [x] AC9, end to end against a local platform: PASS, 2026-10-19.
  - **Setup:** local Supabase and the portal from platform commit fcd1790. Runtime 92d8130596 run from source with an isolated HOME. A scripted fake OpenAI-compatible model through the vllm provider, so no paid model was used.
  - **Login:** `kete login` completed the real PKCE exchange. No browser was available, so approval went through the same `create_cli_auth_code` RPC that the portal's Approve button calls.
  - **Share:** the session had a write tool call, a shell tool call that echoed a fake `sk-test-…` key, and a hello.txt diff. `kete share <id> --yes` returned POST 201.
  - **View:** the signed-in `/shares/<id>` page rendered the share. The DB snapshot recorded 2 redactions, and the key appeared in neither the page nor the DB.
  - **Re-share:** after a new turn, re-sharing sent PUT to the same id and updated the snapshot.
  - **Link share:** with org policy `link`, `/s/<token>` rendered for an anonymous viewer and a bad token gave 404. Before a `kete sync`, `--link` was refused with exit 2, which is the intended fail-closed behaviour.
  - **Unshare:** `kete unshare` deleted both shares (204), removed the rows and cleared `kete.share` from the session metadata. The pages then returned not-found.
  - **Not checked:** audit rows, the interactive preview, and a real browser.
  - **Follow-up:** the shared redactor's `envSecretField` pattern (`util/src/kete/redact.ts:52`) runs to the end of the token. It cut the closing `"}` off a JSON tool input. That is over-redaction, not a leak.

## Review
- **Code review:** approved. Two minor findings fixed:
  - if saving the record fails, the message says to remove the share in the portal;
  - a change of visibility is refused instead of being ignored.
- **Security review:** no HIGH findings. Two MEDIUM and six LOW fixed:
  - **MEDIUM:**
    - a file without a name is shown as `[file: <mime>]`, so a `data:` URI can't leak;
    - the workspace and home paths are rewritten to `.` and `~`.
  - **LOW:**
    - control characters stripped from platform responses;
    - error messages capped;
    - the preview digest is checked again at upload;
    - `.env` and credential files are never sent;
    - `kete share` is refused from an agent's shell;
    - the request folder must be the session's.
- **Platform review follow-ups:**
  - the runtime version is capped at 64;
  - an untitled session is sent as "Untitled session";
  - a link revoked by policy is re-shared as an org share, and its dead link is dropped.

## Deviations (details in handoff.md)
- No change to the TUI fixture: the test serves `kete.share` through `createFetch`.
- `unshare` is refused only in job mode, offline or signed out, so you can still delete a share after policy turns sharing off.
- Extra refusal kinds beyond the spec: `failed`, `changed`, `already_shared`, `location_mismatch`.
