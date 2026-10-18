# Plan: session share

**Large task: needs user approval before building.** It includes upstream edits (4 files plus the TUI test fixture, all marked,
listed below), a new shared `/api/v1` contract plus an additive sync field, and a security change
(code leaves the machine). No config schema change (`share` already exists, `schema/src/config.ts:42`).

**Blocker for AC9 and the contract copy:** the platform side isn't built yet. Its branch
`feature/session-shares` has no commits beyond main, and `docs/contracts/session-shares-v1.md` doesn't exist there.
Steps 1–12 can be built from the contract in spec.md. Step 13 (the mirror diff) and AC9 wait for the platform.

## Cards read
- docs/context/modules/sync.md (verified-at ecfae5cce7, stale: no)
- docs/context/modules/audit-log.md (stale: no)
- docs/context/modules/account-login.md (stale: no; refreshed in the working tree)
- docs/context/modules/add-dir.md (stale: no; refreshed in the working tree)
- docs/context/modules/local-models.md (verified-at 063cfce610, stale: no)
- docs/context/modules/server-sdk.md (verified-at 063cfce610, stale: no)
- docs/context/modules/cli.md (verified-at 063cfce610, stale: no)
- docs/context/modules/vscode-extension.md (verified-at 063cfce610, stale: no)
- docs/context/modules/attribution-hosted.md, runtime-registration.md, job-mode.md, config-kete.md (stale: no)

## Upstream edits (each line marked `kete_change`; record all in docs/upstream-patches.md "Session sharing")
| File | Edit | Why no seam works |
|---|---|---|
| `packages/core/src/plugin/internal.ts` | import + `KeteShare.Plugin` in `post`, before `KeteUnattended.Plugin`, which must stay last (not in `guarded`) | Internal plugins have only this registration list |
| `packages/core/src/session/transfer.ts` | `:106`: wrap the existing marked line, `KeteShareRecord.without(KeteAddDir.withoutDirs(...))`, plus an import | Imports skip `setMetadata`; this marked line is the only strip point (add-dir precedent) |
| `packages/tui/src/routes/session/index.tsx` | `:872`, `:951`: new `run:` bodies; delete `enabled: false` at `:949`; one import | The commands are defined inline in the route. Leave `unavailable` (`:652`) in place; delete it only if typecheck or lint flags it as unused |
| `packages/cli/src/index.ts` | two `Handlers` entries `share`/`unshare`, same as `:36` | The handler map is the only routing seam (cli card) |

## Design decisions (beyond spec)
- **Record carries its session:** `kete.share = { id, url, visibility, expires_at, session }`. A record whose `session` isn't this
  session's id is ignored. This matters because children inherit parent metadata (`core/src/session.ts:279`), and forks may too.
  `share` refuses a child session (`parentID` set): "Share the main session".
- **Config `share: "disabled"` anywhere wins.** Read every config entry, not `Config.latest`, because the more restrictive setting
  wins (CLAUDE.md §5). The precedent is `kete.memory` (`core/src/kete/memory-files.ts:191`).
- **Sync cache version 2 → 3.** A v2 cache decoded the response without `share`, so a 304 would keep it missing forever. This is the
  same fix as `delegable`: never resend a v1/v2 ETag (`util/src/kete/sync/sync.ts:55-58,76,88-130`).
- Synced policy comes from `KeteSyncCache.read(account config, account.organization)` (util), not from the sync plugin's
  in-memory state. A missing cache means the request is sent and the platform decides.
- No protocol/client regeneration: `kete.share` is a plugin RPC on the generic `POST /api/rpc/:rpcID/:method` route (server-sdk card).

## Files
| File | Read / change | Why |
|---|---|---|
| `docs/tasks/2026-10-18-session-share/spec.md` | read | contract, snapshot v1, refusals |
| `packages/util/src/kete/redact.ts` | read | `text`, `deep`, `truncate`, `isSecretKey` |
| `packages/core/src/kete/audit.ts` | read `:43-54`, `:178-204` | `prepareValue`: window → redact → cap; copy the pipeline |
| `packages/util/src/kete/runtime-registration.ts` | read `:48`, `:77`, `:125-160` | injectable `fetch`, `redirect: "error"`, timeout |
| `packages/util/src/kete/sync/client.ts` | read `:23-63` | typed error mapping, key kept out of errors |
| `packages/util/src/kete/account.ts` | read `:19-110` | `read`, `key`, `defaults`, `platform_url`, `organization` |
| `packages/util/src/kete/sync/contract.ts` | change | optional `share: { mode, max_days }` (`Schema.optional`), near `:148` |
| `packages/util/src/kete/sync/cache.ts` | change | `version: 1 \| 2 \| 3` (`:13-24`), comment |
| `packages/util/src/kete/sync/sync.ts` | change | write version 3; resend an ETag only from a v3 cache |
| `packages/util/src/kete/job-mode.ts` | read | `KeteJobMode.enabled()` |
| `packages/util/src/kete/share.ts` | **new** | `KeteShareClient`: `create`/`update`/`remove`, response schema, `ShareError` union (`unauthorized`, `share_disabled`, `share_link_not_allowed`, `not_found`, `payload_too_large`, `rate_limited`, `server`, `network`, `timeout`, `invalid_response`) with `requestId`; 15 s timeout, `redirect: "error"`; `policy(cached)` with "absent = org, 30 days" |
| `packages/schema/src/kete/add-dir.ts`, `local-models.ts` | read | `Rpc.define` pattern |
| `packages/schema/src/kete/share.ts` | **new** | `KeteShareRpc`: `ID = "kete.share"`, `preview`/`share`/`unshare` input and output; `Refusal` as a tagged union (`job`, `offline`, `signed_out`, `config_disabled`, `org_disabled`, `link_not_allowed`, `child_session`, `too_large`) with a `message` |
| `packages/schema/src/session-message.ts` | read `:40-300` | message union (user, synthetic, system, skill, shell, assistant text/reasoning/tool, compaction) |
| `packages/schema/src/file-diff.ts` | read | `FileDiff.Info` |
| `packages/core/src/session.ts` | read `:120-160` | `Session.Service` `messages(SessionStore.MessagesInput)`, `diff({ sessionID, from?, to? })`, `get`, `setMetadata` |
| `packages/core/src/session/diff.ts` | read `:38` | what `diff` with no `from`/`to` covers; the snapshot needs the whole session (gap logged) |
| `packages/core/src/session/store.ts` | read | `MessagesInput`: paging and order, so all messages are read oldest first |
| `packages/core/src/session/session.ts` | read `:78-86` | `setMetadata` replaces metadata; send the merged object |
| `packages/core/src/kete/add-dir.ts` | read `:154-159` | `withoutDirs` shape to copy |
| `packages/core/src/kete/add-dir-plugin.ts` | read `:1-130` | plugin `define`, services, `ctx.rpc.register` |
| `packages/core/src/kete/offline.ts` | read `:43-56` | `KeteOffline.active(config)` |
| `packages/core/src/config.ts` | read `:20-30` | `Config.Interface`, `entries()`, `latest` |
| `packages/core/src/kete/memory-files.ts` | read `:185-195` | "false anywhere wins" read over all entries |
| `packages/core/src/kete/share/record.ts` | **new** | `metadataKey = "kete.share"`, `Record` schema, `read(metadata, sessionID)`, `without(metadata)`; no Session import |
| `packages/core/src/kete/share/snapshot.ts` | **new** | `build(messages, diffs, { workspace, title, model, version, now })`: pure, returns `{ snapshot, redactions, bytes, counts }`; `cap(snapshot, 2 MiB)` |
| `packages/core/src/kete/share/plugin.ts` | **new** | `make({ fetch?, env?, account? })` → `Plugin` (id `kete.share`); refusals in spec order, then preview/share/unshare |
| `packages/core/src/plugin/internal.ts` | change (upstream) | register |
| `packages/core/src/session/transfer.ts` | change (upstream) | strip on import |
| `packages/core/test/plugin/host.ts`, `core/test/kete/sync-fixture.ts` | read | test host with `rpc: rpc().host` (`:78`) |
| `packages/core/test/kete/add-dir.test.ts` | read | RPC and import-strip test pattern |
| `packages/core/test/kete/share-snapshot.test.ts` | **new** | AC1 |
| `packages/core/test/kete/share.test.ts` | **new** | AC3, AC4 |
| `packages/util/test/kete/share.test.ts` | **new** | AC2, `policy()` |
| `packages/util/test/kete/` sync cache/sync tests (existing) | change | version 3 and the ETag rule |
| `packages/tui/src/kete/add-dir.tsx`, `doctor.tsx` | read | `useClient`, `rpc.call` + decode, dialog plugin pattern |
| `packages/tui/src/ui/dialog-confirm.tsx`, `dialog-select.tsx`, `toast.tsx` | read | dialog building blocks |
| `packages/tui/src/context/clipboard` | read | `useClipboard` (used at `routes/session/index.tsx:1130`) |
| `packages/tui/src/kete/share.tsx` | **new** | `KeteShareDialog.show(dialog, client, sessionID, ...)` (preview, visibility, expiry, Share → toast with URL + clipboard); `unshare` confirm |
| `packages/tui/src/routes/session/index.tsx` | change (upstream) | wire `/share`, `/unshare` |
| `packages/tui/test/fixture/tui-client.ts` | change (marked, `:167` style) | answer `/api/rpc/kete.share/preview` |
| `packages/tui/test/kete/doctor.test.tsx` | read | dialog test pattern |
| `packages/tui/test/kete/share.test.tsx` | **new** | AC5 |
| `packages/cli/src/kete/sandbox.ts` | read `:60-90` | `ServerConnection.resolve`, `OpenCode.make`, `rpc.call` with timeout |
| `packages/cli/src/kete/commands.ts` | change | `Spec.make("share")` (`[session-id]`, `--link`, `--yes`, server params) and `unshare` |
| `packages/cli/src/kete/doctor-flow.ts`, `skill-flow.ts` (`:32`, `:147`) | read | flow over injected deps, exit 0/1/2, approve prompt |
| `packages/cli/src/kete/share-flow.ts` | **new** | flow: resolve session (given id, else newest root session in cwd via `client.session.list`), preview, print, confirm / `--yes` / no-TTY refuse (2), share, print URL; unshare |
| `packages/cli/src/kete/share.ts` | **new** | real deps + handlers |
| `packages/cli/src/index.ts` | change (upstream) | handlers |
| `packages/cli/test/kete/sandbox.test.ts`, `doctor.test.ts` | read | test pattern |
| `packages/cli/test/kete/share.test.ts` | **new** | AC6 |
| `packages/kete-vscode/src/sessions.ts`, `src/extension.ts` (`:1020-1040`, `:1250-1310`) | read | vscode-free module style; `fetch(connection.url + "/api/…")` with auth headers |
| `packages/kete-vscode/src/share.ts` | **new** | vscode-free: `previewRequest`/`shareRequest`/`unshareRequest` bodies for `POST /api/rpc/kete.share/<method>`, `parsePreview`, `previewText`, `refusalText` |
| `packages/kete-vscode/src/extension.ts` | change | `kete.shareSession` / `kete.unshareSession`: modal `showInformationMessage`, `env.clipboard.writeText` |
| `packages/kete-vscode/package.json` | change | two commands, `view/item/context` (`viewItem == session`, as at `:297`), palette |
| `packages/kete-vscode/test/sessions.test.ts` | read | pattern |
| `packages/kete-vscode/test/share.test.ts` | **new** | AC7 |
| `docs/platform/session-shares-v1.md` | **new** | contract copy (from spec now; diff against the platform's copy in step 13) |
| `docs/platform/sync-v1.md` | change | the `share` field |
| `docs/context/contracts.md` | change | new contract section |
| `docs/sharing.md` | **new** | what is sent and what isn't, who can see it, expiry, policy, `share: "disabled"` |
| `CHANGELOG.md`, `packages/kete-vscode/CHANGELOG.md`, `docs/upstream-patches.md` | change | entries |

## Steps
1. **Contract types (util).** In `sync/contract.ts`, add an optional `share` field. In `sync/cache.ts` and `sync/sync.ts`, write
   version 3 and resend an ETag only when the cache is v3; update the sync tests.
2. **Client (util).** `util/src/kete/share.ts`: `create(options, body)`, `update(options, id, body)`, `remove(options, id)`, where
   `options = { platform, key, fetch?, signal? }`. Use `redirect: "error"` and `AbortSignal.any([signal, AbortSignal.timeout(15_000)])`.
   Decode the 200/201 body (`id`, `url` must be `https:` or a loopback `http:`, `visibility`, `expires_at`, `created_at`); a bad body is `invalid_response`.
   Map errors from the `ErrorResponse` code and status, keep `x-request-id`, and never put the key or the request body in a message.
   Add `policy(response?)` returning `{ mode, max_days }`. Write the tests (AC2).
3. **RPC schema.** `schema/src/kete/share.ts`:
   - `preview` → `{ allowed: Refusal | null, counts: { messages, tools, diffs }, bytes, redactions, truncated, visibility, linkAllowed, maxDays, existing: Record | null }`
   - `share` → `{ record } | { refusal }`
   - `unshare` → `{ removed: boolean } | { refusal }`
4. **Record (core).** `core/src/kete/share/record.ts` with `read` (decode; ignore it when `session` doesn't match) and `without`.
   Edit `session/transfer.ts:106` (marked).
5. **Snapshot (core).** `core/src/kete/share/snapshot.ts`:
   - Map the message union: user → text, file **names** only; assistant → text parts and tool parts, without reasoning; shell → command, exit, output; compaction → marker.
   - Drop system, synthetic, skill and switch events.
   - For each string field, cut it to a 16 KB window, then `KeteRedact.text`, then truncate to the cap: tool input 2 KB, output 4 KB, shell output 4 KB, patch 16 KB.
     Count the redactions by comparing occurrences of `[REDACTED]` before and after.
   - Run tool input through `deep` first, then cap the serialized form.
   - Also cut to every other cap in spec.md "Field caps" (text 256 KiB, command 8 KiB, title 200, name 128, status 32, path 1 024, file names 1 024; at most 200 files, 500 tools per message, 10 000 messages and 2 000 diffs, keeping the newest and setting `truncated`). `exit` is an int or null.
   - Paths: relative inside the workspace, otherwise `path.basename`. Check containment with `path.relative` and reject `..` and absolute results (cross-platform).
   - Cap at 2 MiB: drop tool outputs oldest first (`output = ""`), then patches oldest first, and set `truncated`.
     If it is still over, refuse with `too_large`; never send anything over 2 MiB.
   - Write the tests (AC1).
6. **Plugin (core).** `core/src/kete/share/plugin.ts`. Get `Session.Service`, `Config.Service` and `Location.Service`.
   - Refusal order: job mode → `KeteOffline.active` → child session → account (`KeteAccount.read(defaults)`; none = `signed_out`, spec text)
     → config `disabled` in any entry → synced policy (`disabled`; `org` when `link` is asked for).
     `auto` behaves as `manual`: nothing runs without an RPC call.
   - `preview` builds the snapshot and uploads nothing.
   - `share`: get the key with `KeteAccount.key`. If a matching record exists, PUT; else POST. A 404 on PUT clears the record and POSTs once.
     Then `setMetadata({ ...metadata, "kete.share": record })`.
   - `unshare`: with no record, `{ removed: false }`. Otherwise DELETE; on 204 or 404, clear the record.
   - Platform errors come back as messages the user can read, not defects.
   - Register in `internal.ts` (marked). Write the tests (AC3, AC4) with the fake `fetch` from `make({ fetch })`, and assert that no refusal calls it.
7. **TUI.** `tui/src/kete/share.tsx`:
   - The dialog calls `preview`. It shows the counts, the redactions, a truncated note, a visibility select (link only when `linkAllowed`) and "Expires in N days".
   - Share → `share`, then a success toast with the URL and `clipboard.copy(url)`. A refusal shows a toast with its message.
   - Unshare goes through `DialogConfirm` → `unshare` → toast.
   - Wire the route (marked; pitfall: no JSX marker on the same line as an element), add the fixture answer, write the test (AC5).
8. **CLI.** Specs, a flow over injected IO, handlers, the two `index.ts` entries (marked). The RPC timeout is 30 s (the snapshot build plus a 15 s upload).
   Exit codes: 0 done, 1 failed, 2 refused (also no TTY without `--yes`). Write the tests (AC6).
9. **VS Code.** The `src/share.ts` pure module, commands in `extension.ts` (copy the auth headers from the existing session fetch at `:1255`), `package.json`, and the test (AC7).
10. **Docs.** `docs/sharing.md`, `docs/platform/session-shares-v1.md`, `sync-v1.md`, `contracts.md`, the CHANGELOGs, `upstream-patches.md`.
11. Run the AC8 checks (table below).
12. Security review (reviewer plus a security-review pass): redaction coverage, the key kept out of errors and logs, no upload without confirm or `--yes`, job key never used.
13. **When the platform has merged:** diff `docs/platform/session-shares-v1.md` and the sync field against the platform's `docs/contracts/` and
    `packages/shared/src/api/v1/`, fix any differences, then run AC9 (`supabase start` + portal dev) and record it in result.md.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `cd packages/core && bun run test ./test/kete/share-snapshot.test.ts` |
| AC2 | `cd packages/util && bun test ./test/kete/share.test.ts` (and `bun test ./test/kete` for the sync cache v3 change) |
| AC3 | `cd packages/core && bun run test ./test/kete/share.test.ts -t refus` |
| AC4 | `cd packages/core && bun run test ./test/kete/share.test.ts -t lifecycle` (the import strip is in the same file) |
| AC5 | `cd packages/tui && bun test ./test/kete/share.test.tsx`; `bun run --cwd packages/kete-tools upstream:check` |
| AC6 | `cd packages/cli && bun test ./test/kete/share.test.ts` |
| AC7 | `cd packages/kete-vscode && bun test ./test/share.test.ts` |
| AC8 | `bun run typecheck` and `bun run test` (tui: `bun test`) in `packages/{util,schema,core,tui,cli}`; `cd packages/kete-vscode && bun run typecheck && bun run test`; root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main`. No protocol regeneration expected; confirm with `bun run generate` in `packages/protocol` producing no diff |
| AC9 | manual: local platform (`supabase start` + portal dev in kete-code-platform), `kete login --platform <local>`, then `/share` → open the URL → `/share` again (same id) → `/unshare`; recorded in result.md |

## Cards to update after the build
- `sync`: the `share` field, cache v3
- `audit-log`: a second `KeteRedact` user (the snapshot)
- `cli`: `kete share`/`unshare`
- `vscode-extension`: the share commands
- `attribution-hosted`: sharing goes to the Kete portal only (replace the "not wired" answer)
- `add-dir`: import stripping now chains through `KeteShareRecord.without`
- `server-sdk`: the `kete.share` RPC (no regeneration)
- New quick answers (the scouts' gaps): session read API (`Session.Service.messages`/`diff`, `core/src/session.ts:134-150`); children inherit metadata (`session.ts:279`); non-permission policy rules (synced `share`)
- `docs/context/contracts.md` (new section)
- Possibly a new `share` card if the librarian judges it large enough
