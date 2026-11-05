# Result: WS0 packaged-app smoke

## What changed
- `packages/desktop/script/kete-packaged-smoke.ts` (+ `kete-packaged-smoke.test.ts`), Kete-owned: finds the packed app in `dist/desktop/` (or `--app`), unpacks it into a temp root, launches it with `OPENCODE_DESKTOP_TEST_ROOT` (which re-points the app's XDG dirs) and a temp `HOME`, pins the runtime to a free port in the CLI's service config, waits for the registration (`<root>/app/state/kete/service*.json`) and a passing `kete.handshake` (protocol and `code` mode), waits for the app's "background service ready" log line, SIGKILLs the runtime and waits for a new pid whose handshake passes. Prints ready / connected / restart times; stops the app and every runtime it saw; fails if one survives; prints the app output and logs on failure with the password (and its Basic header) redacted, including in the final error. `--keep` keeps the temp root.
- `.github/workflows/kete-desktop.yml`: "Smoke packaged app" step on both jobs, after the artifact upload (a failing build stays downloadable), 6 min timeout.
- `docs/desktop.md`: "Smoke test" (usage, same-channel builds, free port, `--keep`) and "Clean-install checklist" (macOS and Windows).
- No upstream file changed.

## Checks
The implementer had no shell; the main session ran every check and fixed the script after local runs.

| Check | Result |
|---|---|
| `bun test ./script/kete-packaged-smoke.test.ts` | 14 pass |
| desktop `bun test --timeout 30000`, typecheck | 265 pass / 4 skip (Windows installer on macOS) / 0 fail; clean (typecheck doesn't cover `script/`; the tests load it) |
| `bun run lint`, `upstream:check` | exit 0; pass |
| `verify --base main` | not run: it covers util/server/core/tui/cli, none touched |
| Local AC2, macOS arm64, `OPENCODE_CHANNEL=dev` pack | 4/4 pass (last after the review fixes): ready 4.8–5.2 s, restart 5.5 s each; no app or runtime process left; temp dirs removed |
| CI AC3 | both jobs pass: macOS ready 10.5 s, restart 6.9 s; Windows ready 4.4 s, restart 6.0 s |
| Review | reviewer: changes needed (2 major: Windows paths unverified, Windows cleanup; 4 minor) → Windows cleanup awaits `taskkill` per runtime pid, `rm` failure is a warning, not-found error lists the dir, step timeout 10 min, docs note; Windows layout checked by this PR's Windows job (AC3). Not done: redacting a password from a registration that fails to decode (low risk) |

Local-run fixes to the implementer's script: the registration lives under the test root with a channel-dependent
name (not `$XDG_STATE_HOME/kete/service.json`); app output goes to a file because the runtime inherits the app's
stdio and outlives it (a pipe hung the failure path); the kill waits for the app's own first connection; a free
port avoids the dev channel's fixed port (taken by an installed `kete serve` here).

## Acceptance criteria
- [x] AC1 — unit tests: `findApp`, `executable`, `smokeEnv`, `registrationDir`, `findRegistration` (channel-named file), `readRegistration` (missing/partial/invalid), `appConnected`, `writeServiceConfig`/`freePort`, `handshakeRequest`, `redact`.
- [x] AC2 — three local runs pass (above).
- [x] AC3 — CI on this PR (macOS and Windows).
- [x] AC4 — tests with a fake service: wrong protocol and missing `code` rejected, no service → "no service at …"; `--app /nonexistent` exits 1 with a clear message.
- [x] AC5 — checklist in `docs/desktop.md`; checks above.

Observed: kill→ready 5.5 s for the packaged app on an M-series Mac, against the 5 s target (detection about
0.5–1 s, runtime start about 4.5 s). The script reports it; it fails only past 60 s.

## Windows findings (first run of the packaged app on Windows)
- CI bundled the **published** CLI on Windows: `OPENCODE_TARGET=windows-x64` made the CLI build produce `cli-windows-x64` while the
  desktop bundles `cli-windows-x64-baseline`, so the desktop build silently downloaded `@ketecode/cli-windows-x64@latest` (no
  `kete.handshake`). The workflow now builds the bundled target and fails if it is missing. Release builds were not affected.
- The test root lost its state dir on Windows: upstream's `preferApplicationEnvironment` drops `XDG_STATE_HOME` unless a login shell
  sets it, and Windows reads none. One marked line keeps it under `OPENCODE_DESKTOP_TEST_ROOT` (real installs unaffected).
- Overriding `USERPROFILE` broke Windows known folders (Documents); the smoke now keeps it.
- On failure the smoke prints the runtime's own output (run with pipes and detached), a Windows process/port snapshot, the
  runtime log's warnings and errors, and handshake probes with and without a directory.

## Cards updated
desktop, kete-tools-ci (smoke script, workflow step, same-channel rule, fixed dev port, test root, inherited stdio).

## Metrics
- Agents used: scout, librarian ×2 (pre-plan refresh, close), planner ×2 (first stopped on stale cards), implementer (no shell), reviewer
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-04)
