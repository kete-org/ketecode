# Plan: WS0 packaged-app smoke

Approved 2026-11-04 under the user's Phase A pre-approval ("use your recommended best path or options").

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Size: large (spec approved 2026-11-04); this plan needs the user's approval before building.**
No upstream file is edited. `.github/workflows/kete-desktop.yml`, `docs/desktop.md` (`isKeteOwned`,
`kete-tools/src/lib.ts:92`) and `packages/desktop/script/kete-*` are Kete-owned. No shared contract,
config schema, server endpoint or generated file changes. Security: no auth change; the script reads the
service password from the registration file like the client does and must never print it.

## Cards read
- docs/context/modules/desktop.md (verified-at b84b58294d, stale: no)
- docs/context/modules/kete-tools-ci.md (verified-at b84b58294d, stale: no)
- docs/context/modules/server-sdk.md (stale: no; not needed beyond the Basic-auth rule)

## Files
| File | Read / change | Why |
|---|---|---|
| packages/desktop/script/kete-packaged-smoke.ts | new | The smoke script: pure helpers (exported) + `if (import.meta.main)` runner |
| packages/desktop/script/kete-packaged-smoke.test.ts | new | AC1, AC4: unit tests and fake-service handshake tests (`bun:test`) |
| .github/workflows/kete-desktop.yml | change | Add the "Smoke packaged app" step after "Package desktop app" (both matrix jobs) |
| docs/desktop.md | change | "Clean-install checklist" section + how to run the smoke locally |
| packages/desktop/script/kete-icons.ts | read (`:222` on) | Pattern for a Kete script with exported helpers and an `import.meta.main` block |
| packages/desktop/script/kete-icons.test.ts | read (head) | Test file pattern (`bun:test`, relative import) |
| packages/cli/script/service-smoke.ts | read (`:1-80`, `waitForRegistration`, `waitForReady`) | Reuse its patterns: temp root env, `Schema.decodeUnknownPromise(Service.Info)`, Basic `opencode:` header, timeouts. Do not import or run it (wrong binary and state dir) |
| packages/client/src/effect/service.ts | read (`Info`, `:142`) | Registration schema (`url`, `pid`, `password`, …); import `Service` from `@opencode/client/effect/service` |
| packages/schema/src/kete/handshake.ts | read | `KeteHandshakeRpc.PROTOCOL`, `Result`; import from `@opencode/schema/kete/handshake` |
| packages/server/test/kete/handshake.test.ts | read (`:20-40`) | Wire shape: `POST /api/rpc/kete.handshake/get`, JSON body `{"input":{}}`, response `{"output":{protocol,runtime,modes}}` |
| packages/util/src/kete/desktop.ts | read | `KeteDesktop.productNames[channel]` and `artifactPrefix` (no hard-coded app names) |
| packages/desktop/script/pack.ts | read (`:44-63`) | Output layout: mac `kete-desktop-mac-<cpu>.app.tar` holding one `.app`; Windows `dist/desktop/app/` |
| packages/desktop/src/main/kete/service-file.ts | read | Registration path `<XDG_STATE_HOME>/kete/service.json` (use `Brand.appDirectory`, not a literal) |
| packages/desktop/src/main/lifecycle/configure.ts | read (`:44-75`) | `OPENCODE_DESKTOP_TEST_ROOT` sets userData to `<root>/desktop` and sessionData to `<root>/session` (also scopes the single-instance lock) |
| packages/desktop/src/main/lifecycle/environment.ts | read (`:30-46`) | macOS/Linux: the login-shell env replaces `process.env`, and `XDG_STATE_HOME` is deleted unless the shell keeps it. The probe inherits our env, so `HOME` must be the temp root (no developer rc files can override XDG) |

## Steps
1. **Write `script/kete-packaged-smoke.ts`.** Exported pure helpers (each unit-tested):
   - `findApp({ dir, platform, channel })`: returns `{ kind: "tar", tar, bundle }` on darwin
     (`<dir>/<artifactPrefix>-mac-<arch>.app.tar`, bundle `<productNames[channel]>.app`) or
     `{ kind: "exe", exe }` on win32 (`<dir>/app/<productNames[channel]>.exe`). Throws a clear error
     naming the path it looked for and what it found. `--app <path>` overrides (an exe, a `.app`
     dir or a `.app.tar`). Channel from `--channel`, else `OPENCODE_CHANNEL`, else `dev`.
   - `executable(bundle)`: `<bundle>/Contents/MacOS/<name without .app>` (confirmed on a real pack).
   - `smokeEnv(root, base)`: `{ ...base, HOME, USERPROFILE: root, XDG_{CONFIG,DATA,CACHE,STATE}_HOME:
     <root>/<x>, OPENCODE_DESKTOP_TEST_ROOT: <root>/app }`.
   - `registrationPath(env)`: `<XDG_STATE_HOME>/<Brand.appDirectory>/service.json`.
   - `readRegistration(file)`: JSON + `Schema.decodeUnknownPromise(Service.Info)`; undefined if
     missing or partly written (retry), throws if valid JSON fails the schema or lacks `password`.
   - `handshakeRequest(url, password)`: a `Request` to `new URL("/api/rpc/kete.handshake/get", url)`,
     POST, `content-type: application/json`, `authorization: Basic btoa("opencode:" + password)`,
     body `{"input":{}}`, `AbortSignal.timeout(5_000)`.
   - `handshake(url, password)`: fetches it; rejects with `no service at <url>` on a connection error,
     `handshake HTTP <status>` on non-200, `protocol <n>, expected <PROTOCOL>` on mismatch,
     `modes <list> lacks "code"`, or a decode error (decode `output` with `KeteHandshakeRpc.Result`).
     Messages contain the URL and status only, never the password or header.
   - `redact(text, secrets)`: replaces each secret and its base64 Basic credential with `[redacted]`.
2. **Runner (`import.meta.main`).** `mkdtemp` root (`realpath`); mac: `tar -xf <tar> -C <root>/bundle`
   (`Bun.spawn` argument array). Launch the executable with `smokeEnv`, stdout/stderr piped and kept.
   Wait up to 180 s (poll 250 ms) for a registration whose handshake passes; print `ready in <s>`.
   Kill the registered pid (`process.kill(pid, "SIGKILL")`; record every pid seen), start a timer,
   wait up to 60 s for a registration with a different pid whose handshake passes; print
   `restart <s> s (target 5 s, ceiling 60 s)`; fail past the ceiling. All waits are condition polls with
   a deadline, no fixed sleeps. Exit 0 on success.
3. **Cleanup in `finally` (also on failure).** Stop the app: win32 `taskkill /PID <pid> /T /F`
   (argument array); else `SIGTERM`, wait 10 s for exit, then `SIGKILL`. Then `SIGKILL` every runtime
   pid seen (ignore only `ESRCH`). Then check each pid is gone (`process.kill(pid, 0)` throws `ESRCH`)
   within 10 s; a survivor fails the run with its pid ("left a process behind"). On failure, before
   removing the root, print the app's stdout/stderr and the last 200 lines of each `**/*.log` under the
   root (`Bun.Glob`; covers `<root>/app/desktop/logs` and the runtime's logs), all through `redact`.
   Remove the root with `fs.rm(..., { recursive: true, force: true, maxRetries: 5 })` (Windows locks).
   Top level: `main().catch(e => { console.error("packaged smoke failed: " + message); process.exitCode = 1 })`.
4. **Tests `script/kete-packaged-smoke.test.ts`** (temp dirs per test, `Bun.serve({ port: 0 })` fakes):
   `findApp` mac/win/missing/override/channel; `executable`; `smokeEnv` sets every isolating var and
   keeps the base env; `readRegistration` valid / missing / partial JSON / missing password;
   `handshakeRequest` URL, method, body and header correct, and `String(request)` plus a thrown error's
   message contain no password; `handshake` passes on a correct fake, rejects on wrong protocol,
   missing `"code"`, 401, and a stopped server (port closed) with the messages above; `redact`.
5. **Workflow.** After "Package desktop app", before "Upload app":
   ```yaml
   # Launches the packaged app (not the dev build) with an isolated state dir, checks its runtime's
   # handshake, kills the runtime and waits for the app to restart it (docs/desktop.md).
   - name: Smoke packaged app
     timeout-minutes: 6
     run: bun run --cwd packages/desktop script/kete-packaged-smoke.ts --dir ../../dist/desktop
   ```
   (Or resolve the default dir from the script's location: `path.join(import.meta.dir, "../../../dist/desktop")`,
   and drop `--dir`.) `OPENCODE_CHANNEL: dev` is already in the job env.
6. **`docs/desktop.md`.** Add "## Smoke test" (the local command, what it checks, that it needs a
   fresh `pack`, that it leaves nothing running) and "## Clean-install checklist" for macOS and
   Windows per the spec: install from the CI artifact, open the unsigned app (existing `xattr` / SmartScreen
   note), sign in, start a Code session and get an answer, kill the runtime (Activity Monitor / Task
   Manager, `opencode-cli`) and see the notice and the "restarted" toast, quit and confirm no
   `opencode-cli` keeps running, uninstall (delete the app, `~/Library/Application Support/<app id>` /
   `%APPDATA%\<app id>`, and `~/.local/state/kete`). Note in the checklist that quitting the app does
   not stop the runtime by design (desktop card, "Rules"), so step "confirm no runtime" means: stop it
   with `kete service stop` (or check what the CLI provides) — implementer: if no such command exists,
   say "end `opencode-cli` in Activity Monitor / Task Manager" instead; do not add one.
7. Run the verification below; then commit nothing (the main session commits).

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `cd packages/desktop && bun test ./script/kete-packaged-smoke.test.ts` |
| AC4 | same file (wrong-protocol, missing-mode, 401, closed-port cases); plus `cd packages/desktop && bun script/kete-packaged-smoke.ts --app /nonexistent; echo $?` → clear message, `1` |
| AC2 | `cd packages/desktop && bun script/kete-packaged-smoke.ts` against the fresh `dist/desktop/kete-desktop-mac-arm64.app.tar` → passes, prints ready and restart times; then `pgrep -fl "Kete Code Dev\|opencode-cli"` → nothing from this run |
| AC3 | push the branch; both `kete-desktop` jobs on the PR are green (`gh run list --repo kete-org/ketecode --workflow kete-desktop.yml --branch feature/desktop-packaged-smoke`) |
| AC5 | `cd packages/desktop && bun run test && bun run typecheck` (typecheck covers `src` only, `tsconfig.json` include; the script is checked by `bun test` loading it); root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; workflow lint `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -no-color .github/workflows/kete-desktop.yml` (skip if Docker is unavailable, and say so) |

## Cards to update after the build
- desktop: Quick answers for the smoke script (path, what it isolates, `OPENCODE_DESKTOP_TEST_ROOT`,
  the shell-env `XDG_STATE_HOME` rule, the RPC wire shape); Testing (new test file, CI step); Key files.
- commands.md: desktop row, add the smoke command.
- kete-tools-ci: its Quick answer on `service-smoke.ts` points to the new packaged smoke.

## Risks
- macOS runner: the app is launched from the `.app`'s executable directly, so Gatekeeper is not
  consulted for a locally untarred, never-quarantined bundle; if CI shows otherwise, add
  `xattr -dr com.apple.quarantine` before launch.
- Windows: Defender scan of the staged `opencode-cli.exe` on first launch; the 180 s ready timeout covers it.
- Windows exe name `<productName>.exe` is the electron-builder default, unconfirmed on a real build (card).
- Electron helper processes on macOS die with the main process; the pid check only covers the main
  app pid and runtime pids. AC2's `pgrep` covers the helpers locally.
