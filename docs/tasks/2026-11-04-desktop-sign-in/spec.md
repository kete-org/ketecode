# Spec: desktop sign-in

- Task: `docs/tasks/2026-11-04-desktop-sign-in` · Size: large · Created: 2026-11-04
- Status: approved (2026-11-04) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal

A person who only has the desktop app (or the web UI on their own machine) can sign in to their Kete
organization, see who they are signed in as, and sign out, without opening a terminal. Today that needs
`kete login`. Work mode's users are the ones this is for.

## Scope

Modules: `account-login`, `sync`, `gateway`, `web-app`, `ui-branding` (cards in `docs/context/modules/`).

1. **Runtime RPC `kete.account`** (schema in `packages/schema/src/kete/account.ts`, plugin in
   `packages/core/src/kete/`), following the `kete.todo` pattern:
   - `status`: signed in or not; organization name; platform host; whether offline mode is on. Never the
     key or key id.
   - `login`: starts sign-in and returns the browser URL to open. The runtime runs the existing
     `kete login` flow (PKCE S256, loopback callback on 127.0.0.1, 5-minute limit) in a child process of
     its own executable, as the TUI's first-run screen already does (`tui/src/kete/setup-login.ts`). The
     key is created and stored by that process only and never passes through the RPC or the UI.
   - `cancel`: stops a sign-in in progress.
   - `logout`: runs `kete logout` the same way (revokes the key, clears the account and sync cache).
   - Events: `rpc.kete.account.changed` when sign-in completes, fails, is cancelled or signs out.
   - After a change the runtime reloads what depends on the account (gateway models, sync, share) without
     a restart.
2. **Web UI**: an **Account** page in Settings (a GUI-plugin settings page in `gui-plugins/src/kete/account/`, approved in the plan) showing the status with
   **Sign in** and **Sign out**, and a sign-in prompt in the new-session panel when signed out. Sign in
   opens the URL with the platform's `openExternal`, shows "Waiting for the browser…" with **Cancel**,
   and updates on the `changed` event. Errors are shown in plain words.
3. **Platform URL:** `Brand.urls.platform` is set to `https://app.ketecode.ai` (approved), so sign-in works with no flags.
   `--platform-url`, `KETE_PLATFORM_URL` and `kete.platform.url` still override it.

## Out of scope

- A new sign-in protocol (device code, `kete://` callback): the existing loopback flow is reused.
- Moving the PKCE flow from `packages/cli` into `packages/core`.
- Signing in through a remote server (LAN pairing, `--server`, VS Code remote): refused, see AC5.
- Switching between several organizations, and account management (keys, members) beyond sign-out.
- Portal or platform API changes (kete-code-platform).
- The TUI's existing first-run sign-in (unchanged).

## Acceptance criteria

- [ ] AC1: `status` returns signed-out, then signed-in with the organization name and platform host after
      a sign-in, and never contains the key, key id, verifier or code (test with a fake platform).
- [ ] AC2: `login` returns an `https://<platform>/cli/authorize?…` URL (http only for a loopback platform)
      carrying `state` and an S256 `code_challenge`; completing the callback saves the account and emits
      `changed`; the stored key is the platform's (fake platform test).
- [ ] AC3: `cancel` stops the sign-in: the loopback listener closes, nothing is saved, `changed` reports it.
      A second `login` while one runs returns the same attempt instead of starting another.
- [ ] AC4: `logout` revokes the key on the platform (fake platform sees `POST /api/v1/cli/logout`), clears
      the account and emits `changed`; `status` is signed-out.
- [ ] AC5: `login` and `logout` are refused unless the server runs on this machine for its own user
      (not for a remote or paired client), in offline mode, and in job mode, each with a clear reason.
- [ ] AC6: after sign-in, the gateway's models appear without restarting the runtime; after sign-out
      they disappear.
- [ ] AC7: The app shows Account in Settings and a signed-out prompt; Sign in opens the browser URL via
      `openExternal`; the waiting state, Cancel, success and error render (app unit tests).
- [ ] AC8: no key, code or verifier in RPC payloads, events, logs or errors (asserted in AC1–AC4's tests).
- [ ] AC9: typecheck, the touched packages' tests, lint, `upstream:check`; the protocol and client are
      regenerated only if the HTTP API changes (it shouldn't: RPCs ride the existing endpoint).

## Risks and constraints

- **Security (credentials, browser auth):** the key must stay inside the `kete login` child process and
  the OS keychain. The RPC lets a UI start a sign-in, so only a local, same-user client may call it
  (AC5); a remote client could otherwise sign this machine into another organization.
- **Contract:** `kete.account` is a new runtime RPC used by the app; once released it's a contract.
- **Platform URL:** setting `Brand.urls.platform` to `https://app.ketecode.ai` changes `kete login`'s default for
  everyone (approved).
- **Reload:** the gateway and sync read the account on their own schedules today; AC6 needs an explicit
  reload after a change, not a 5-minute wait.
- **Child process:** the runtime must start its own executable (packaged desktop: the bundled CLI; dev:
  the source), with no shell, and stop it on cancel or shutdown.
- **Upstream edits:** expected to be small (plugin registration in `core/src/plugin/internal.ts`, the
  TUI/web client fixtures); everything else lives in Kete paths.
