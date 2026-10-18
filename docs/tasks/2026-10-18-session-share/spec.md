# Spec: session sharing to the portal (A5, runtime side)

- Task: `docs/tasks/2026-10-18-session-share` · Size: large · Created: 2026-10-18
- Status: approved 2026-10-18 by the user (incl. the public `/s/[token]` link route) <!-- draft → agreed (medium) / approved (large) → built → closed -->
- Platform side: `kete-code-platform` `docs/tasks/2026-10-18-session-shares` (API, storage, viewer, policy). Built first.

## Goal
`/share` uploads a redacted snapshot of the current session to the Kete portal, where members of your
organization (or, if the organization allows it, anyone with the link) can read it. `/unshare` deletes
it. Parity item A5. Decisions agreed with the user on 2026-10-18 (recommendations 1–4).

## Today (scouts, 2026-10-18)
- `/share` and `/unshare` are stubs in `tui/src/routes/session/index.tsx` (:652 `unavailable`, :866, :945)
  that show "Sharing is not implemented for V2 sessions yet". No runtime code sends a share.
- The `share` config field (`manual|auto|disabled`, `schema/src/config.ts:42`) is read by nothing.
- `packages/enterprise` holds OpenCode's own share backend; it stays unused.

## Contract (`docs/platform/session-shares-v1.md`, mirrored from the platform's `docs/contracts/`)
All calls use the account's key (`Authorization: Bearer`, `KeteAccount.key`), `redirect: "error"`, 15 s timeout.
A job key is never sent; the platform also refuses job keys.

- `POST /api/v1/shares` → 201 `{ id, url, visibility, expires_at, created_at }`
  body `{ session_id, title, visibility: "org" | "link", snapshot }`
- `PUT /api/v1/shares/{id}` → 200 same shape; replaces `title` and `snapshot` (owner only; expiry unchanged)
- `DELETE /api/v1/shares/{id}` → 204 (owner or org admin); 404 when already gone
- Errors (shared `ErrorResponse`): 401, 403 `share_disabled` / `share_link_not_allowed`, 404, 413 `payload_too_large`, 429, 5xx.
- `GET /api/v1/sync` gains an optional field `share: { mode: "disabled" | "org" | "link", max_days }`. Absent means `org` with 30 days.

**Snapshot v1**: JSON, at most 2 MiB serialized.
```
{ version: 1, created_at, runtime_version, title, model?: "<provider>/<model>", truncated: boolean, redactions: number,
  messages: Array<
    | { type: "user", text, files: string[] }                 // file names only, never contents
    | { type: "assistant", text, tools: { name, status, input, output }[] }  // input ≤ 2 KB, output ≤ 4 KB
    | { type: "shell", command, exit, output }                // output ≤ 4 KB
    | { type: "compaction" } >,                               // marker only; the summary is not sent
  diffs: { path, additions, deletions, patch }[] }            // patch ≤ 16 KB; path relative to the workspace
```
Field caps (from the platform plan, enforced there by Zod; the builder truncates to them so a share never gets a 400):
`title` ≤200; `messages` ≤10 000; `diffs` ≤2 000; `text` ≤256 KiB; `files` ≤200 names of ≤1 024; `tools` ≤500 per
message, `name` ≤128, `status` ≤32, `input`/`output` strings; `command` ≤8 KiB; `exit` int or null; `path` ≤1 024;
`additions`/`deletions` int ≥0. The body may be 2 MiB + 8 KiB (snapshot ≤ 2 MiB). Re-sharing a link share returns
`/shares/{id}` as `url` (only the token's hash is stored), so the runtime keeps the original link in its record.

## Scope
Cards: `sync` (main), `audit-log` (redaction pipeline), `cli`, `vscode-extension`, `attribution-hosted`
(note that sharing goes only to the Kete portal); add the missing quick answers the scouts named
(session read API, RPC calls, non-permission policy rules).

- **Snapshot builder** (`core/src/kete/share/snapshot.ts`, pure apart from the Session service):
  - It reads `Session.messages` and `Session.diff`.
  - **Included:** user text, assistant text, tool name, status, input and output, `!` shell commands, and the diffs.
  - **Left out:** system and synthetic messages, skill bodies, reasoning, compaction summaries, attached
    file contents, instructions (`AGENTS.md`, `CLAUDE.md`), memory notes, the system prompt and environment.
  - Every string goes through `KeteRedact` the way `audit.ts` `prepareValue` does: cut to a window, redact,
    then cut to the cap. Redaction always runs before truncation. The builder counts the redactions.
  - Paths outside the workspace show as their base name only.
  - Over 2 MiB, the oldest tool outputs and diff patches are dropped first and `truncated` is set.
- **Client** (`util/src/kete/share.ts`): POST, PUT and DELETE in the same shape as
  `runtime-registration.ts` and `sync/client.ts`. Errors are typed, the request ID is kept, and the key
  never appears in an error. `fetch` is injectable.
- **RPC** `kete.share` (`schema/src/kete/share.ts`, registered by a core plugin listed in `plugin/internal.ts`):
  - `preview(sessionID, visibility)` returns counts (messages, tool calls, diffs), size, redactions,
    truncated, the policy result and the existing share if there is one. Nothing is uploaded.
  - `share(sessionID, visibility)` creates the share, or updates it if the session is already shared.
  - `unshare(sessionID)` deletes it; a 404 also clears the local record.
  - **Local record:** session metadata `kete.share = { id, url, visibility, expires_at }`.
    `KeteAddDir.withoutDirs`-style stripping applies on session import, so an imported session never
    claims someone else's share.
- **Refusals,** checked in this order, each with a clear message:
  - job mode;
  - offline (`KeteOffline.active`);
  - not signed in ("Sign in with `kete login` to share. Sessions using only your own API keys can't be shared");
  - config `share: "disabled"`;
  - synced `share.mode` is `disabled`, or `org` when `link` is asked for.
  - If you're signed in but there is no sync cache yet, the runtime still sends the request and the
    platform decides. The platform is the authority; the runtime check only gives an early, clear message.
  - Config `share: "auto"` never uploads on its own and acts like `manual`.
- **TUI** (`tui/src/kete/share.tsx`):
  - `/share` opens a preview dialog. It shows what will be sent, the redaction count, the visibility
    choice (organization, or link when allowed) and the expiry. "Share" uploads, then the link is shown
    and copied to the clipboard.
  - `/unshare` asks for confirmation, then deletes.
  - The upstream stubs change only the `run:` bodies and drop `enabled: false` (marked edits).
- **CLI**: `kete share [session-id] [--link] [--yes]` and `kete unshare [session-id]`. Without `--yes`
  it prints the preview and asks; with no TTY and no `--yes` it refuses (exit 2). It prints the URL.
- **VS Code**: a "Kete: Share Session" / "Kete: Unshare Session" command on the session tree and in
  the palette. The preview appears as a modal message, the link is copied after sharing. The logic
  lives in a `vscode`-free module.
- **Docs:** `docs/platform/session-shares-v1.md`, `docs/sharing.md` (what is sent and what isn't, who
  can see it, expiry, policy), a CHANGELOG entry and the extension CHANGELOG, plus `docs/upstream-patches.md`.

## Out of scope
- Live sync of a share as the session continues (re-run `/share` to update it).
- Sharing from the web UI's own chat panel (the VS Code command covers the extension).
- Importing a shared session back into Kete.
- OpenCode's `packages/enterprise` backend and `opencode.ai/share`.

## Acceptance criteria
- [ ] AC1 snapshot: unit tests show that
  - redaction runs before truncation;
  - reasoning, system and synthetic messages, compaction summaries, file contents and skill bodies are absent;
  - a secret inside tool output and inside a diff is redacted and counted;
  - the 2 MiB cap drops the oldest outputs first and sets `truncated`;
  - a path outside the workspace keeps only its base name.
- [ ] AC2 client: tests with an injected `fetch` for 201, 200, 204, 401, 403 (both codes), 404, 413 and
  5xx, a timeout, and a redirect refused. The key never appears in an error.
- [ ] AC3 refusals: RPC tests for job mode, offline, signed out, config `disabled`, synced `disabled`,
  and synced `org` with `link`. None of them calls `fetch`. `auto` uploads nothing on its own.
- [ ] AC4 lifecycle: share → share again (PUT, same id) → unshare (DELETE, metadata cleared); a 404 on
  unshare clears the metadata; an imported session has no `kete.share`.
- [ ] AC5 TUI: preview dialog test; `/unshare` is enabled; the link toast appears; `upstream:check` passes.
- [ ] AC6 CLI: `--yes` path, refusal without a TTY, and `kete unshare`.
- [ ] AC7 VS Code: unit test of the vscode-free share module (preview text, refusal messages).
- [ ] AC8 checks: typecheck and tests in util, core, tui, cli and kete-vscode; lint; `upstream:check`;
  `verify --base main`; protocol/client regenerate if the RPC schema needs it.
- [ ] AC9 end to end against a local platform (`supabase start` + portal dev): share, view in the portal,
  re-share, unshare. Recorded in result.md.

## Risks and constraints
- **Security (review required):** code leaves the machine. Redaction must cover tool output and diffs;
  nothing is sent without the preview/confirm step, or `--yes`. The job key is never used.
- **Contract:** a new `/api/v1` contract and an additive sync field, mirrored from the platform.
- **Upstream edits:** the TUI session route stubs and `plugin/internal.ts`, both marked.
- **Privacy:** the docs say plainly what is sent; `share: "disabled"` in config turns it off for a user.
- Redaction over-redacts by design (`pass: 42`), which is acceptable in a share.
