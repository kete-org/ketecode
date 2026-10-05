---
module: cli
paths: [packages/cli/src/kete/*, packages/cli/src/index.ts, packages/cli/src/commands/commands.ts, packages/cli/src/commands/handlers/serve.ts, packages/cli/src/server-process.ts]
verified-at: 4e26b57120
---
## Quick answers
- How do `kete mcp add harness|slack` and `kete mcp presets` work? Kete flows in `kete/mcp-preset.ts` over an injected `IO` (`kete/mcp-preset-io.ts`), routed from upstream's `commands/handlers/mcp/add.ts:27-42` (marked) when the name is a preset and no `--url`/command is given; flags `KeteCommands.mcpPresetParams` spread into upstream's `mcp add` spec (`commands/commands.ts:229`), `presets` registered at `:232` and `index.ts:56`. See the `mcp-presets` card.
- How does `--offline` work? `kete/offline-startup.ts` (imported at `index.ts:5`, right after the env bridge) calls `KeteCliOffline.apply` (`kete/offline.ts:55`): env, `--offline` in argv, or `kete.offline` in the global config files turns it on (`flagged`, `kete/offline.ts:37`, reads `--offline=<v>`/`--offline <v>` with the parser's truthy/falsy values: `--offline=false` and `--offline false` are off, an unknown value is on; `offline-startup.test.ts` pins it against the real parser) and sets `OPENCODE_OFFLINE`, `OPENCODE_DISABLE_MODELS_FETCH` and `OPENCODE_DISABLE_AUTOUPDATE` before any module reads env. The flag is also a registered global flag (`kete/commands.ts:24`, `framework/runtime.ts:86`) so the parser accepts it. See the `local-models` card.
- Which commands refuse offline? `login`, `sync` (not `--status`/`--approve`), `upgrade`, `models pull`: `KeteCliOffline.refused` (`kete/offline.ts:84`) prints the refusal and sets exit code 2. `updater.ts` `isDisabled` and `check()` also honour it.
- What changes in the server connection offline? `services/server-connection.ts` calls `KeteCliOffline.connection` (`kete/offline.ts:72`): always a private (`standalone`) server, `--server` refused.
- How does a command with subcommands get its handlers? A `{ $, sub }` map: `index.ts:67` (`models: { $, pull }`), `framework/runtime.ts:43-76`; the spec side is `commands: [KeteCommands.modelsPull]` at `commands/commands.ts:288`.
- What does `kete models` print on a TTY? `KeteModelsList.lines` (`kete/models-list.ts:26`) adds `tools:yes|no vision:yes|no ctx:<tokens>` for local providers (omitted ctx when unknown); piped output stays `provider/model`.
- `kete models pull <name>`: `kete/models-pull.ts:145` `pull`; calls the `kete.local-models` RPC, strips `/v1` (`ollamaRoot`, `:77`), streams Ollama's `/api/pull`, then asks for `rediscover`. Exit codes `EXIT` (`:28`). Keyed Ollama servers: no bearer token is sent (status never returns keys).
- Where does `kete job run` get the audit log in job mode (piece A3)? From the relay, not a file:
  `KeteJobStandalone.start` returns `audit` (`read(rootID)`, `failure()`, `onFailure`), and `job.ts`
  passes `readAudit`/`auditFailure` into `JobRun.run` (`job-run.ts` `Deps.readAudit`,
  `readAuditContent`). The result has no `audit_log` (N2), `audit_local: true`.
- When is a job-mode run `audit_failed`? When the relay failed (downstream pipe broken or full, the
  20 MB cap, a write timeout): `collectOutcome` checks `auditFailure()` before **and after**
  `pollAuditEnded` (shared `auditFailed()`), so a `run ended` whose push failed is never reported
  from the event-stream fallback; the poll stops as soon as the relay fails, and `job.ts`'s
  `makeOnInterrupt` interrupts the session through `audit.onFailure`. The child's fd 4 is not closed
  (known limitation, `job-mode` card).
- Does `kete job run` need the audit pipe in job mode? Yes: `KeteJobPreflight.run` reads
  `KETE_JOB_AUDIT_FD` (3-1023, not the key's fd, a FIFO), marks it close-on-exec, deletes the
  variable; missing or not a pipe -> `refused` (2). `StartOptions.auditFd` hands it to the relay.
- Why does a start failure now show the message, not `at ...`? `job-standalone.ts` skips stack-frame
  lines when keeping the child's last stderr line (<= 300 chars).
- Can job mode start on macOS? No (openat2); see the `job-mode` card. `KeteJobServe.prepare` order:
  dumpable, confinable, secrets, audit fd.
- Does `kete job run` sync in job mode? Yes, once, before starting the server: `KeteJobSync.first` (`cli/src/kete/job-sync.ts`, `job.ts:125-140`); error = exit 1, refused = exit 2; the org id is passed to the server child (`job-standalone.ts:108`). See the `job-mode` card and contracts.md §6d.
- Does `session.create` validate `agent`? No (`core/src/session.ts:273` passes it through), so an unknown agent isn't caught there; job mode checks `spec.agent` against the synced agents instead.
- What does `kete job run` do differently in job mode (`KETE_JOB_MODE`)? First
  `KeteJobPreflight.run` (`job.ts:79-82`, `kete/job-preflight.ts:39-61`): non-dumpable, then the
  gateway key read once from `KETE_JOB_GATEWAY_KEY_FD`, secret env vars deleted; failure → `refused`
  (2). Then `JobConnection.resolve` (`kete/job-connection.ts`, pure, `job.ts:112`): a `--server`
  value is refused outright (exit 2 — the client can't verify another process is running in job
  mode). Then `KeteJobStandalone.start` (`job.ts:120-131`, `kete/job-standalone.ts:155-218`) starts
  `kete serve --stdio --socket <0700 dir>/s` with the password and key on the child's fd 3; a start
  failure is `error` (1) carrying the child's last stderr line, and job mode never falls back to
  `ServerConnection.resolve`/TCP. The client is `OpenCode.make` with base `http://localhost` and
  `fetch({ unix })` (`job.ts:67-74,134-138`). Then `job.ts:165` passes `jobMode:
  KeteJobMode.enabled(process.env)` to `JobRun.run`: **cwd is the entrypoint's prepared worktree**
  (F1, `docs/tasks/2026-09-30-job-entrypoint/`). No git call at all (`repoRoot`/`headSha`/
  `worktreeAdd`/cleanup skipped, `job-run.ts:426-434,455-458,484`); `spec.branch` and `<cwd>/.git`
  are required (else exit 2 `refused`, before any session); the result says `isolated: true`,
  `worktree` = `directory` = cwd, `branch` = `spec.branch`. `job-git.ts:36`'s
  `KeteJobMode.refuseSpawn("git")` guard stays as defence in depth. See the `job-mode` card,
  `contracts.md` §6d, `docs/jobs.md` "Job mode".
- What are `kete serve`'s flags and where do they go? `commands/commands.ts:518-532` (`--hostname`,
  `--port`, `--cors`, `--service`, `--stdio`, and Kete's `--socket`, marked `:530`) →
  `commands/handlers/serve.ts:6-18` → `ServerProcess.run` (`server-process.ts`). `--socket <path>`
  is **job mode only**: `KeteJobServe.prepare` (`kete/job-serve.ts:64-99`, called at
  `server-process.ts:49-56` before anything else) refuses it outside job mode, and in job mode
  requires exactly `--stdio --socket` (no `--port`/`--hostname`), so the service, a TUI's standalone
  child and ACP refuse in a job. It then makes the process non-dumpable, reads `{v:1, password,
  gateway_key}` from `KETE_JOB_SECRETS_FD` and sets the in-memory key; the password replaces
  `Env.password` (`server-process.ts:89-96`) and `socket` reaches `ServerOptions.socket`
  (`:109`; `server-sdk` card).
- Where does the upstream standalone child come from? `packages/cli/src/services/standalone.ts:19-61`
  (`CrossSpawnSpawner`, `kete serve --stdio --port 0`, random 32-byte password as `KETE_PASSWORD`,
  ready line `{"url":…}`) — used by TUIs and `--standalone`, unchanged; `KeteJobStandalone` is its
  job-mode sibling.
- What does `KeteDumpable` do? `kete/dumpable.ts:50-62` — `prctl(PR_SET_DUMPABLE, 0)` + read-back
  via `bun:ffi` libc (lazy `require`, so the Node build bundles); Linux only, `unsupported`
  elsewhere; a failure refuses in both job processes. Precedent: `core/src/util/process-lock-ffi.bun.ts`.
- How do I cross-build the Linux binary (e.g. for the job image)? `bun run build
  --target=kete-linux-arm64 --skip-web-ui` in `packages/cli/`: the target name is `targetName()`
  (`packages/cli/script/build.ts:258`: binary, os, arch, then `baseline`/abi when present) and the
  output is `dist/<target with kete → cli>/bin/kete`, e.g. `dist/cli-linux-arm64/bin/kete`
  (`build.ts:121-122,142`). `--single` builds only the host's target.
- Where do Kete-only CLI commands live? `packages/cli/src/kete/*.ts` (login/logout/whoami/sync/commands), spread into upstream's command tree — no `kete_change` markers needed there (path already under `kete`, CLAUDE.md §4).
- What does `kete job run <spec.json>` do? Runs an agent unattended from a JSON job spec (ADR
  0005/0008): validates the spec (`job-spec.ts`), refuses a non-loopback `--server` (the worktree
  it's about to create needs to be visible to that server), creates a git worktree and branch
  itself with `git worktree add -b` (`job-git.ts` — **not** `POST /api/worktree`, so no project
  `commands.start` setup script runs outside the job's own policy/audit), starts a session there
  with `metadata: {"kete.unattended": policy}`, waits for it to finish, and reports the outcome —
  `job-run.ts` `JobRun.run`, wired to real dependencies by `job.ts`. Full contract (spec fields,
  `--json` result shape, exit codes): `docs/jobs.md`.
- How do I add a **nested** command (`kete <group> <name>`, not a flat top-level one)? A `Spec`
  whose `commands:` array holds child `Spec`s (`kete/commands.ts`'s `job` entry, `Spec.make("job",
  {commands: [Spec.make("run", {...})]})`), and a matching nested object in `index.ts`'s
  `Handlers` map (`job: { run: () => import("./kete/job") }`) — `ServerParams`/`PermissionParams`
  in `commands/commands.ts:17-40` aren't exported, so a command needing `--server`/`--standalone`
  duplicates that text verbatim (`kete/commands.ts`'s own `ServerParams` const) rather than
  importing it.
- How does upstream's `kete run` connect/stream/exit, and what does `job run` reuse from it?
  `ServerConnection.resolve` (`packages/cli/src/services/server-connection.ts:22-52`: `--server`,
  `--standalone`, else the background service) — `job.ts` calls the same function.
  `resolveSessionTarget` (`packages/cli/src/session-target.ts:32-88`) calls `session.create`
  **without** `metadata`, so `job-run.ts` builds its own `session.create` call with
  `metadata: {"kete.unattended": policy}` instead of reusing it. `runNonInteractivePrompt`
  (`packages/cli/src/run/noninteractive.ts`) streams SSE and replies to permission asks
  (`:135-154`), exits `1` on error and `130` on interrupt — `job-run.ts`'s own `watchEvents`
  follows the same subscribe-before-prompt shape but rejects every ask instead of answering it (a
  job's family should never be asked at all).
- Is there an existing "read a JSON file for a command" pattern to follow for the job spec? Only
  `kete session import` reads a JSON file from disk
  (`packages/cli/src/commands/commands.ts:438-448`); nothing in the CLI reads YAML. `job-spec.ts`
  is the first JSON-spec-file parser of its kind here.
- Why does `kete job run` set an explicit session `title`? So upstream's own auto-title-generation
  doesn't make an extra, unscripted model request before the job's first real step — wasteful for
  an unattended run nobody reads the title of. `job-run.ts` truncates `spec.prompt` to 80 chars for
  it; `kete run`'s own `resolveSessionTarget` (`session-target.ts`) still lets upstream generate one.
- How does `kete upgrade` work, and what does it trust? `packages/cli/src/kete/upgrade.ts` (handler) over `KeteUpdater` (`kete/updater.ts`, ADR 0009): it fetches `SHA256SUMS` + `SHA256SUMS.sig` from `Brand.urls.releases` (latest: `releases/latest/download/`, a version: `releases/download/kete-v<v>/`), verifies the Ed25519 signature against `kete/update-keys.json` (`release-verify.ts`), reads the version from the signed archive names, downloads the archive for `KETE_TARGET` (a `build.ts` define), checks its SHA-256, runs `--version` on it, and renames it over the binary (Windows: rename aside + roll back). No pinned key → "unavailable"; Homebrew/npm/extension/source installs (`detect`, from the real path) are never replaced. `kete uninstall` stays disabled (`uninstall-disabled.ts`).
- Why doesn't `kete upgrade` animate in CI or over `ssh`? `packages/cli/src/kete/progress.ts` uses the spinner only when stdout is a TTY; otherwise one start line and one end line (a spinner writing to a pipe prints every frame).
- Why does `kete upgrade` say updates are unavailable? The binary predates the first pinned key (`kete-update-2026`, pinned 2026-10-04, PR #78; builds from `kete-v0.2.0-rc.4` on carry it), or it is a source/local build (`channel === "local"`).
- Where's the `KETE_*`→`OPENCODE_*` env bridge? `packages/cli/src/kete/env-bridge.ts`, imported first in `packages/cli/src/index.ts:4` (must stay the first import — runs before any other module reads `process.env`).
- How do I add a new top-level `kete` subcommand? Add a `Spec` to `packages/cli/src/kete/commands.ts`'s `specs` array (it's already spread at `packages/cli/src/commands/commands.ts:493`) and a handler entry in `packages/cli/src/index.ts`'s `Handlers` map.
- How do I build the `kete` binary? `bun run build --single --skip-install --skip-web-ui` in `packages/cli/` (CLAUDE.md §8) → `packages/cli/dist/cli-<os>-<arch>/bin/kete`; flags read at `packages/cli/script/build.ts:26,29,30`.

## Purpose
Kete-owned CLI surface: account sign-in (`login`/`logout`/`whoami`/`sync` against the Kete platform, distinct from upstream's provider-key `auth`), unattended job runs (`job run`), and Kete Code's own verified self-update (`kete upgrade`, ADR 0009) and a disabled `uninstall`. Everything here is a thin wrapper spliced into upstream's `packages/cli/src/index.ts` and `commands/commands.ts` command tree.

## Entry points
- `packages/cli/src/index.ts:4` — `import "./kete/env-bridge"` (side-effecting, must run first).
- `packages/cli/src/index.ts:28-38` — `Handlers` map: `upgrade` (`kete/upgrade.ts`), `uninstall`, `login`, `logout`, `whoami`, `sync` and (nested) `job: { run }` all route to `./kete/*` modules (each `kete_change`-marked).
- `packages/cli/src/index.ts:5,67` — `import "./kete/offline-startup"` (offline decision) and the `models: { $, pull }` handler map (`kete_change`).
- `packages/cli/src/index.ts:126` — `Effect.provide(KeteUpdater.layer)` (`kete_change`), replaces upstream's `Updater` service with the verified Kete updater.
- `packages/cli/src/commands/commands.ts:493` — `...KeteCommands.specs` spreads `login`/`logout`/`whoami`/`sync`/`job` command specs into the root command list (`kete_change`).
- `packages/cli/src/kete/commands.ts` — `Spec.make("login", …)` etc., and `Spec.make("job", {commands: [Spec.make("run", …)]})` for the nested command; the actual command definitions (params, descriptions).

## Key files
| File | Lines | Role |
| --- | --- | --- |
| `packages/cli/src/kete/env-bridge.ts` | 6 | Runs `KeteEnv.bridge(process.env)`; first import of the CLI entry point |
| `packages/cli/src/kete/commands.ts` | ~90 | `Spec` definitions for `login`/`logout`/`whoami`/`sync`/`job run`, spread into `commands.ts`; owns a local `ServerParams` (duplicated verbatim from upstream's unexported `commands/commands.ts:17-26`) for `job run`'s `--server`/`--standalone` |
| `packages/cli/src/kete/account-flow.ts` | 434 | `login`/`logout`/`whoami`/`sync` flows over injected I/O (testable without a real terminal); `whoami()` also prints the resolved `kete.runtime.type`/`KETE_RUNTIME_TYPE` via `@opencode/util/kete/runtime-registration` — see the account-login card |
| `packages/cli/src/kete/account-io.ts` | 35 | Real stdout/stderr + account store + background-service reload, implementing `account-flow.ts`'s `IO` |
| `packages/cli/src/kete/cli-login.ts` | 364 | PKCE + loopback callback listener + `/api/v1/cli/*` calls (platform's CLI login protocol) |
| `packages/cli/src/kete/{login,logout,whoami,sync}.ts` | 25/18/18/21 | `Runtime.handler` wiring each command spec to `account-flow.ts` |
| `packages/cli/src/kete/offline.ts` | 110 | Pure offline rules: `flagged`, `configValue`/`fromConfig`, `apply`, `connection`, `refused` |
| `packages/cli/src/kete/offline-startup.ts` | 27 | Side effect only: reads global config files and calls `apply` at startup |
| `packages/cli/src/kete/models-pull.ts` | 371 | `kete models pull`: injectable `Deps`, `pull`, timeouts, progress, exit codes |
| `packages/cli/src/kete/models-list.ts` | 35 | `kete models` TTY detail lines for local providers |
| `packages/cli/src/kete/updater.ts` | 434 | `KeteUpdater`: `Updater.Service` over injectable `Deps` (fetch, extract, probe, rename): `detect`, `signedRelease`, `install` (download + checksum + `--version` probe + atomic swap), background `run` honouring `autoupdate`; `UpdateError.code` discriminates refusals |
| `packages/cli/src/kete/release-verify.ts` | 177 | Pure: `pinnedKeys`, `verifySignature` (Ed25519, `node:crypto`), `parseChecksums`, `releaseOf` (version + per-target archive from signed names), `compareVersions`, `targets` |
| `packages/cli/src/kete/update-keys.json` | — | Pinned Ed25519 public keys (`{ id, publicKey }`, raw 32 bytes base64); `kete-update-2026` since rc.4; the private key is env `release-signing`'s `KETE_UPDATE_SIGNING_KEY` |
| `packages/cli/src/kete/upgrade.ts` | 75 | `upgrade` handler: managed installs get their manager's command, refuses a mismatched `--method` and downgrades, spinner around `updater.upgrade("curl", v)` |
| `packages/cli/src/kete/uninstall-disabled.ts` | 33 | `uninstall` handler: deletes nothing, prints the Homebrew/npm command or the binary and directories to remove |
| `packages/cli/src/kete/job-spec.ts` | 219 | `JobSpec.parse` — job spec v1 parse/validate, pure over injected `Deps` (`readFile`/`stat`/`realpath`); every error names the field path; `prompt_file` is confined to the spec's own directory via `realpath` on both sides (AC1, reviewer fix: path-traversal/symlink containment) |
| `packages/cli/src/kete/job-git.ts` | 90 | `JobGit.run`/`worktreeAdd`/`worktreeDiscard` — timeout-bounded, no-shell `git` via `node:child_process.execFile`; never throws on a non-zero exit, only on a missing `git` binary; in job mode `KeteJobMode.refuseSpawn("git")` runs first (`:36`), and `RunOptions.env` lets tests inject the flag without mutating `process.env` |
| `packages/cli/src/kete/job-connection.ts` | 28 | `JobConnection.resolve(args, env)` — pure: off is a no-op, on refuses `--server` and forces `standalone: true`; see the `job-mode` card |
| `packages/cli/src/kete/job-run.ts` | 783 | `JobRun.run` — the pure orchestration: validate → server-locality check → worktree+branch → session create with `kete.unattended` metadata → subscribe-before-prompt → wait → outcome/exit-code mapping → `--json`/text+summary output. Imports only `@opencode/client/promise`, `@opencode/schema/*`, `@opencode/util/kete/brand`, `node:*` (deliberately **not** `./job-spec.js`/`./job-git.js`, even for types — see the file's own header) so `packages/server/test/kete/job-run.test.ts` can import it directly against a real embedded server |
| `packages/cli/src/kete/job.ts` | 171 | The real handler: job-mode preflight, reads+parses the spec file, `KeteJobStandalone.start` (job mode) or `ServerConnection.resolve`, builds real `Deps` (client, `JobGit`, fs, clock, SIGINT), calls `JobRun.run` (with `jobMode`, `:165`), sets `process.exitCode` |
| `packages/cli/src/kete/job-preflight.ts` | 61 | `KeteJobPreflight.run` — non-dumpable, gateway key from `KETE_JOB_GATEWAY_KEY_FD`, env secrets dropped, refusals |
| `packages/cli/src/kete/job-standalone.ts` | 218 | `KeteJobStandalone.start` — socket dir, child spawn with secrets on fd 3 (`additionalFds`), stderr forwarding, ready-line check, cleanup |
| `packages/cli/src/kete/job-serve.ts` | 99 | `KeteJobServe.prepare` — `kete serve`'s job-mode checks and secrets read |
| `packages/cli/src/kete/dumpable.ts` | 67 | `KeteDumpable.disable`/`message` — non-dumpable via `prctl` |

## Data flow
1. Process start → `packages/cli/src/index.ts:4` imports `env-bridge.ts` → `KeteEnv.bridge(process.env)` drops inherited `OPENCODE_*`, moves `KETE_X`→`OPENCODE_X`, sets `KETE_ENV_BRIDGED=1` (rules in `@opencode/util/kete/env`).
2. `Commands` (from `commands/commands.ts`, including the spread `KeteCommands.specs`) is parsed by upstream's CLI framework; the matched command name looks up a handler in `index.ts`'s `Handlers` map (a nested command like `job run` looks up `Handlers.job.run`).
3. `login`/`logout`/`whoami`/`sync` handlers (`packages/cli/src/kete/{login,logout,whoami,sync}.ts`) build an `AccountIO` (`account-io.ts`) and call into `account-flow.ts`, which drives `cli-login.ts` for the browser PKCE flow and `@opencode/util/kete/account` for local storage.
4. `login`/`logout` end by reloading an already-running background `kete serve` (`account-io.ts` `reloadService`) so a live session picks up the new/cleared account without restart.
5. `upgrade` routes to `kete/upgrade.ts` → `Updater.Service` = `KeteUpdater` (signed release → checksum → probe → rename); `uninstall` to `uninstall-disabled.ts`, which only prints. The TUI's update notice uses the same service (`commands/handlers/default.ts`, `Brand.updatesAvailable`).
6. `job run <spec>` → `job.ts` parses the spec (`job-spec.ts`) → resolves the server connection (`ServerConnection.resolve`, same as `kete run`) → builds a `fetch` with `timeout: false` (a long job would otherwise hit Bun's 5-minute default deadline mid-stream) → `job-run.ts`'s `JobRun.run`: refuses a non-loopback `--server`; outside job mode, `git rev-parse --show-toplevel`/`HEAD` in `cwd` and creates a worktree+branch itself with `git worktree add -b` (D1 — never `POST /api/worktree`); in job mode uses cwd as the prepared worktree with no git call; `client.session.create({agent?, model?, location, metadata: {"kete.unattended": policy}, title: <80-char prompt prefix>})`; subscribes to the event stream before `client.session.prompt`; a `permission.asked` for the root session is treated as a runtime bug (reject + interrupt); polls the audit log for `run ended`, else classifies the execution event; prints the result (text+summary, or one `--json` object) and sets the process exit code (`docs/jobs.md`'s exit-code table).

## Data and APIs used
- Platform CLI login protocol: `docs/platform/cli-login-v1.md`, `/api/v1/cli/*` (via `cli-login.ts`) — no direct database access, adapter-only per CLAUDE.md §3.
- Account storage: `@opencode/util/kete/account` (`account.json` + `@opencode/util/kete/secret-store.ts` for the OS credential store), shared with `packages/core/src/kete/gateway.ts` since the CLI doesn't depend on `core`.
- `@opencode/client` (`Service.discover`) to find and reload a running local server (`account-io.ts`).
- `job run`: `@opencode/client/promise` (`OpenCode.make`, session/permission/message endpoints — no new endpoint), `@opencode/schema/kete/unattended` (the same `Policy` schema/message builders core decodes `kete.unattended` metadata with — the `unattended` card), `@opencode/schema/model` (`Model.Ref.parse` for `spec.model`), `node:child_process` (`git`, no shell).

## Rules that must not break
- `env-bridge.ts` import order in `packages/cli/src/index.ts:3-6` — any reordering reintroduces raw `OPENCODE_*` env reads before the bridge runs.
- Secrets: `account-flow.ts` and `cli-login.ts` file headers state the PKCE verifier, authorization code, and API key never appear in printed output, logs, or error messages (CLAUDE.md §9) — preserve this in any edit.
- `Handlers` map entries and `commands.ts` edits keep their `kete_change` markers (`packages/cli/src/index.ts:30-38,123`; `commands.ts:2,6,40-41,46,63,78,147,357,493,530`; `handlers/serve.ts:15`; `server-process.ts:20,29,49-56,90-92,109`).
- In job mode no TCP listener may exist and no secret may be in an environment: keep
  `KeteJobServe.prepare` the first thing in `processEffect`, and `job.ts`'s "no fallback" guard
  (`:129-131`).
- `kete auth` (upstream, provider keys) and `kete login` (Kete account) stay distinct commands; each `--help` text cross-references the other (`commands.ts:147`).
- Per docs/upstream-patches.md "Account sign-in": when syncing upstream, check it hasn't added its own top-level `login`/`logout`/`whoami` command — the spread at `commands.ts:493` would then collide. Same check now applies to `job` (docs/upstream-patches.md "Jobs").
- `job-run.ts` must never import a sibling `cli/src/*` module (including `./job-spec.js`/`./job-git.js`) — only `@opencode/client/promise`, `@opencode/schema/*`, `@opencode/util/*`, `node:*`, `effect` — so `packages/server/test/kete/job-run.test.ts`'s cross-package import keeps working and its own tests stay decoupled from the real `git`/spec-file plumbing.
- In job mode `job-run.ts` must make no git call and never discard the worktree: it's the
  entrypoint's (ADR 0019 rule 5). Tests: `packages/cli/test/kete/job-run.test.ts` "job mode" (a
  fake git that throws) and `packages/server/test/kete/job-run.test.ts` (a real run in a prepared
  repo with a throwing git, plus the two refusals).
- `job run` must never call `POST /api/worktree` (D1) — that endpoint's `commands.start` setup script would run outside the job's own policy and audit; the CLI creates the worktree and branch itself with `git worktree add -b`.

## Testing
- Narrowest: `bun test ./test/kete/<file>.test.ts` inside `packages/cli` — `login.test.ts`, `sync.test.ts`, `sync-mcp.test.ts`, `offline-startup.test.ts`, `models-pull.test.ts`, `updater.test.ts` (tampered checksum/signature/archive, downgrade, interrupted and Windows swaps, detection, background policy), `release-verify.test.ts`, `stats.test.ts`, `cli.test.ts`, `job-spec.test.ts`, `job-run.test.ts`, `job-connection.test.ts`, `dumpable.test.ts`, `job-preflight.test.ts`, `job-serve.test.ts`, `job-standalone.test.ts` (`packages/cli/test/kete/`).
- `job-socket.subprocess.test.ts` — the real CLI as a subprocess, a session over the socket, no TCP
  listener, no secret in either process's environ. macOS runs it in source mode (passes the package
  bunfig via `BUN_OPTIONS=--config=…`); Linux checks (dumpable, `/proc/<pid>/environ`) need a built
  binary in `JOBSOCK_E2E_BIN`, run in a container as root ± `--cap-add=SYS_PTRACE` and as non-root.
- Package-wide: `bun run test` inside `packages/cli`.
- Upstream test edit to watch: `cli/test/auth.test.ts` expects the rebranded `auth` description (docs/upstream-patches.md "Account sign-in").
- `job run` end-to-end (AC2–AC6, against a real embedded server with `TestLLM` and a real git repo, not fakes): `packages/server/test/kete/job-run.test.ts` — a cross-package import of `cli/src/kete/job-run.ts` from a `server` package test; see the `server-sdk` card for the harness (`createEmbeddedRoutes` + `TestLLM` + web-handler `fetch`) and the `import-boundaries.test.ts` rule this deliberately works around (the import crosses packages via a plain relative path, not a `tsconfig` project reference — confirmed to typecheck under `tsgo -b`).

## Changes
Adding a new flat `kete <subcommand>`:
1. Add a `Spec.make(...)` to the `specs` array in `packages/cli/src/kete/commands.ts` (already spread into the root command list — no further edit to `commands.ts` needed).
2. Add a handler module `packages/cli/src/kete/<name>.ts` following `login.ts`'s pattern (`Runtime.handler(Commands.commands.<name>, Effect.fn(...))`).
3. Register it in the `Handlers` map in `packages/cli/src/index.ts` (`kete_change`-mark the new line, next to the existing `login`/`logout`/etc. entries).
4. Put any real logic that needs to be unit-testable without a terminal in `account-flow.ts`-style plain functions over an injected `IO`, not directly in the handler.
5. Add a test under `packages/cli/test/kete/`.
6. `bun run typecheck` + `bun run test` in `packages/cli`, then `bun run --cwd packages/kete-tools upstream:check`.

Adding a **nested** `kete <group> <name>` (the `job run` pattern): a `Spec.make("<group>", {commands: [Spec.make("<name>", {params: {...}})]})` in `kete/commands.ts`, and a nested `Handlers` entry (`<group>: { <name>: () => import("./kete/<handler>") }`) in `index.ts`; `Runtime.handler(Commands.commands.<group>.commands.<name>, ...)` in the handler module. Needing `--server`/`--standalone`: copy `kete/commands.ts`'s own `ServerParams` text (upstream's `commands/commands.ts:17-26` version isn't exported).

- `docs/tasks/2026-10-03-cli-distribution/` (ADR 0009): `UpdaterDisabled`/`upgrade-disabled.ts` replaced by `updater.ts`, `release-verify.ts`, `update-keys.json`, `upgrade.ts`; `index.ts` wiring and the `upgrade` description updated; `uninstall-disabled.ts` names Homebrew/npm.

## Gotchas
- `job-preflight.ts`/`job-serve.ts`/`job-standalone.ts` take injectable `Deps`/options (env,
  dumpable, descriptor reader, command) — tests use them instead of mutating `process.env` or
  calling `prctl`.
- The updater must never download upstream OpenCode binaries, run a package manager or an installer, or install anything whose `SHA256SUMS` signature (pinned key) and archive checksum didn't verify (CLAUDE.md §9 "Updates", ADR 0009). Its tests inject `Deps`; the real `extract` shells out to `tar` (System32 `tar.exe` on Windows), classified `client-only` in `core/test/kete/job-spawn-sites.test.ts`.
- `KETE_TARGET` is undefined in a source run (`bun run dev`): `install` then refuses with "doesn't know its release target"; source runs are `channel: local` and never get that far.
- `account-io.ts`'s service reload only fires if a `kete serve` is *already* running; signing in never starts one — don't assume `login` always leaves a live server picking up the new account.
- The CLI can't import `core` (per `account-flow.ts` header comment), so account storage logic lives in `@opencode/util/kete/account`, not `core`'s config/credential system — don't move it there. `job-spec.ts`/`job-run.ts` follow the same rule: the job policy schema lives in `@opencode/schema/kete/unattended`, not `core`, so the CLI can validate it without importing core.
- `job run` only works when the server is on this machine (D1): a non-loopback `--server` exits `2` before anything is created; a project's `commands.start` setup script never runs for a job (only `POST /api/worktree` runs it, and jobs bypass that endpoint) — if a project needs setup, the prompt has to do it, under the job's own policy. A `permission.asked` from a **subagent** of the job (not the root session) isn't recognized as the runtime-bug case — see the `unattended` card's Gotchas and `docs/jobs.md` "Known gaps".
- Building without `--skip-install` runs `bun install` for every target platform's native packages (CLAUDE.md §8) — slow; use `--skip-install` for local iteration.
