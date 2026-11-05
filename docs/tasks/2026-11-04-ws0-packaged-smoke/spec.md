# Spec: WS0 packaged-app smoke

- Task: `docs/tasks/2026-11-04-ws0-packaged-smoke` · Size: large · Created: 2026-11-04
- Status: closed (approved 2026-11-04, Phase A pre-approval: "use your recommended best path or options") <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Every desktop CI run proves the packaged app (not the dev build) starts its bundled runtime, speaks the
app's protocol, and recovers when the runtime is killed — on macOS and Windows. A written clean-install
checklist covers what CI can't (signing prompts, sign-in, a real session). PR 0.3 of
`docs/desktop-enhancement-plan.md`.

## Scope
- **Smoke script** (Kete-owned, e.g. `packages/desktop/script/kete/packaged-smoke.ts`), run with Bun:
  1. Takes the packaged app's executable path (or finds it under `dist/desktop/`).
  2. Launches it with a fresh temporary state directory (`XDG_STATE_HOME`, and whatever else keeps it
     from adopting a developer's or another job's service) and Electron's user-data dir isolated.
  3. Waits (generous timeout; first launch stages and scans the CLI) for the registration file, reads
     the URL and password, and calls `POST /api/rpc/kete.handshake/get` with the service's auth. Passes
     when `protocol === KeteHandshakeRpc.PROTOCOL` and `modes` includes `"code"`.
  4. Kills the runtime by its registered pid and waits for the app's watcher (0.2) to bring up a new
     one: a new pid in the registration file whose handshake passes. Prints the kill→ready time; fails
     only past a generous ceiling (CI machines are slow), and prints the 5 s target alongside.
  5. Quits the app and stops the runtime it started, also on failure (no orphan processes), and prints
     the app's logs on failure.
  - Never prints the password or the Authorization header.
- **CI**: a step in `.github/workflows/kete-desktop.yml` after "Package desktop app", on both matrix
  jobs, that unpacks/locates the app and runs the script.
- **Checklist**: a "Clean-install checklist" section in `docs/desktop.md` for macOS and Windows:
  install from the CI artifact, open the unsigned app, sign in, start a Code session and get an answer,
  kill the runtime and see the notice and toast, quit and confirm no runtime keeps running, uninstall.
  Plus how to run the smoke script locally.
- Also: re-run of the macOS desktop job on `main` is no longer needed (it passed on #85 and #91).

## Out of scope
- The Electron e2e with Playwright (0.4); signing and notarisation; Linux packages.
- Measuring cold start against the 3 s budget (recorded by 0.4's harness).
- Making the restart faster (only measured here).

## Acceptance criteria
- [ ] AC1: Unit tests for the script's pure parts (find the app in `dist/desktop/`, read and validate the
  registration file, build the handshake request without leaking the password into output).
- [ ] AC2: Run locally on macOS against a freshly packed app: passes, prints the restart time, leaves
  no app or runtime process behind.
- [ ] AC3: Both `kete-desktop.yml` jobs run the step on this PR and pass.
- [ ] AC4: A failing handshake (wrong protocol, no service) makes the script exit non-zero with a clear
  message — covered by a test with a fake service.
- [ ] AC5: `docs/desktop.md` has the checklist; lint, desktop typecheck/test, `upstream:check` pass.

## Risks and constraints
- GitHub runners: the unsigned macOS app may be blocked by Gatekeeper; launch the binary inside the
  `.app` directly (not `open`), and strip quarantine if needed. Windows antivirus slows first launch.
- Free minutes: the step must add about a minute or less per job.
- Security: no auth weakening; the smoke reads the service password from the registration file the
  same way the client does, and never logs it.
- No upstream file is expected to change except possibly the workflow (Kete-owned path).
