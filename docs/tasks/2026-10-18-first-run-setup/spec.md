# Spec: one first-run setup flow (A15)

- Task: `docs/tasks/2026-10-18-first-run-setup` · Size: medium · Created: 2026-10-18
- Status: approved 2026-10-18 (plan approved by the user; spec agreed when the user asked to start A15, 2026-10-18, under the standing "carry on through every remaining item" instruction) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Someone who starts `kete` with nothing set up gets one screen with three ways to start: sign in to Kete
(gateway models), add their own API key, or use a local model Kete found. The separate local-model
offer, sidebar card and "connect an integration" toast no longer compete. Parity item A15.

## Review of today's pieces (from the scout, 2026-10-18)
- Home screen: logo, notices and tips, and no setup prompt. `/connect` is only ranked first in the
  palette.
- Sending a prompt without a provider: a toast plus `DialogIntegration`.
- Sidebar (session view): upstream's "Getting started" card, with dismissal stored under `getting-started`.
- Local-model offer: `useKeteLocalModels()` (`tui/src/kete/local-offer.tsx`) shows a confirm only
  when a local model is already in the catalog. Stored under `kete-local-offer`.
- Sign-in: `kete login` exists only in the CLI. A signed-in account supplies the `kete` gateway
  provider.
- `kete run` with no model fails with `ModelNotSelectedError` and no hint.

## Scope
Cards: `local-models` (main), `account-login`, `cli`, `ui-branding` (or the card owning the TUI home);
also add the scout's missing first-run notes.

- **The setup screen** (TUI dialog, Kete-owned under `tui/src/kete/`):
  - **When it shows:** on start, once the model catalog is ready, when no provider is connected and no
    model is set (the conditions the local offer already computes), and setup hasn't been finished or
    skipped. The new storage key is `kete-setup`, `{ done: true }`. It never shows in offline mode for
    sign-in (that row is hidden), and never in job mode or unattended runs.
  - **Rows:**
    1. **Sign in to Kete:** starts the same browser sign-in `kete login` uses, from inside the TUI. The
       plan picks the mechanism: a child `kete login` process whose output is captured, or a runtime
       call. The screen shows the sign-in URL (for headless machines) and waits with a cancel option. On
       success it checks that the `kete` provider now has models and selects the default one.
    2. **Use my own API key:** opens the existing `DialogIntegration` (`/connect`). Once that connects,
       setup is done.
    3. **Use a local model:** listed with what was found (Ollama, LM Studio, vLLM, using the existing
       `kete.local-models` status). It picks one the same way as `firstRunOffer`. When nothing is found,
       the row says how to start Ollama or LM Studio and offers to check again.
    4. **Skip for now:** records `done`. `/setup` brings the screen back.
- **Existing pieces:**
  - The local-model offer doesn't run when the setup screen has shown (or is showing). It still runs
    on its own when someone has set up but later gains a local model, as today.
  - The sidebar "Getting started" button and the no-provider prompt toast open the setup screen instead
    of `DialogIntegration` directly. This only changes what they open; their logic stays upstream's
    (marked edits if they are upstream files).
- **`/setup` command:** the slash command and palette entry reopen the screen at any time.
- **CLI hint:** when `kete run` (or the TUI) hits `ModelNotSelectedError`, the message adds:
  "Run `kete` to set up, or `kete login`, `kete auth login`, or start a local model server." The text
  comes from a Kete-owned helper and is added where the CLI prints the error, not in upstream core.
- **Docs:** `.github/README.md` (getting started), the CHANGELOG, cards.

## Out of scope
- The VS Code / web panel's first run (it keeps `KeteLocalOffer`). JetBrains.
- New provider sign-in methods. Platform changes.
- Choosing among many gateway models during setup (the default is picked; `/models` changes it).

## Acceptance criteria
- [ ] AC1 with no provider, no model and no `kete-setup` record, the screen shows once on start. With
  any of those set, it doesn't.
- [ ] AC2 "Use my own API key" opens the integration dialog, and a successful connection records done.
- [ ] AC3 "Use a local model" lists the detected servers and models and selects one. With none found it
  shows the start-a-server hint and "check again".
- [ ] AC4 "Sign in to Kete" runs the sign-in, shows the URL, can be cancelled, and on success selects a
  gateway model. It is hidden offline.
- [ ] AC5 "Skip" records done, and `/setup` reopens the screen.
- [ ] AC6 the local-model offer doesn't also appear once the setup screen has shown. The sidebar button
  and the prompt toast open the setup screen.
- [ ] AC7 `kete run` with no model prints the setup hint and keeps its exit code.
- [ ] AC8 checks: typecheck and tests in tui and cli (Kete tests plus the affected upstream tests), and
  `upstream:check`.

## Risks and constraints
- **Upstream:** the sidebar and prompt edits are in upstream TUI files, so they are kept to marked
  one-liners. Everything else is Kete-owned.
- **Sign-in from the TUI:** a child process must not leak the key to the TUI's output or logs. The key
  stays in the OS store, as `kete login` does today. The child gets a timeout, and cancelling kills it.
- **Contracts:** `/setup` and the `kete-setup` storage key. No config or protocol change is expected.
- **Terminal sizes:** the screen must fit 80×24.
