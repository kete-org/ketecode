---
module: cli
paths: [packages/cli/src/kete/*, packages/cli/src/index.ts, packages/cli/src/commands/commands.ts, packages/cli/src/commands/handlers/serve.ts, packages/cli/src/server-process.ts, packages/util/src/kete/setup.ts, packages/cli/src/run/noninteractive.ts]
verified-at: c979e8f4e1
---
## Quick answers
- Where are `kete share` / `kete unshare`? Specs in `cli/src/kete/commands.ts:246,261` (`--link`, `--yes`, `ServerParams`), handlers `cli/src/kete/share.ts:66,76` (flow `share-flow.ts`), routed by two marked entries in `cli/src/index.ts:44-45`; exit 0 done / 1 failed / 2 refused. Refused from an agent shell (`KeteEnv.inAgentShell`). See card `session-share`.
- Where does `kete run` print session errors, and what does the no-model hint do? `run/noninteractive.ts:522,531` print `KeteSetup.withHint(error)` (`util/src/kete/setup.ts:57`; the file also holds the TUI first-run setup rules `shouldShow`/`rows`/`parseLoginURL`), which appends `HINT` (`:10`) only when `isNoModel` (`:53`). `ModelNotSelectedError` reaches clients as `provider.no-route` carrying only its message (`core/src/session/to-session-error.ts:56-64`), so the match is on that code plus a message prefix, pinned by `core/test/kete/setup-hint.test.ts`.
- What does `kete run` do when the agent asks permission or a question? Nobody can answer, so (outside `--auto` and V1 compatibility) it rejects the ask with feedback text and the model continues (`replyPermission` / `cancelForm` in `run/noninteractive.ts:160,190`, `PERMISSION_REJECTED_FEEDBACK`/`QUESTION_CANCELLED_FEEDBACK` `:72,75`); asks from subagent child sessions count too (`ownsSession`). The run exits 1 after a cancelled question; V1 compatibility keeps the old interrupt-and-fail path.
- Does `kete serve` open a remote tunnel? In service mode with a `remote` entry in service config, `ServerProcess` forks `RemoteTunnel.run` against the bound address (`server-process.ts:208-218`, `services/remote-tunnel.ts`). A busy port is retried for 15 s to recognise an incumbent service before failing (`:181`).
- What does `--add-dir` do? Repeatable flag (max 10, `commands/commands.ts:47`) on the default and `run` commands; paths are normalised by `KeteAddDirCli.prepare`, checked via RPC `kete.add-dir`, and written to the session's `kete.dirs` before the first prompt (`run/run.ts:135`). See the `add-dir` card.
- Which helper runs git clone/fetch/worktree with a timeout and abort signal? `JobGit.run(cwd, args, {timeoutMs, signal, env})` (`packages/cli/src/kete/job-git.ts:37`): no-shell `execFile("git")`, default 30 s (`:30`), worktree add 5 min; timeout resolves `{exitCode:-1, timedOut:true}`, missing git rejects `GitError`, job mode refuses the spawn.
- What do `kete bug`, `kete completion` and `kete trust` live in? `kete/bug.ts` (deps) + `bug-flow.ts` (flow, asks `QUESTION` before opening a GitHub issue); `kete/completion-command.ts` with `completion.ts` (bash/zsh/fish/powershell, `instructions` when no shell) and `completion-tree.ts` (`script` `:91`, tree from `--help`); `kete/trust.ts` (`list`/`add`/`remove` of trusted folders, exit 0/1/2, `:25`) over `kete/folder-trust.ts` (`inspect` `:141`, which also holds back project shell-command definitions via `KeteFolderTrustRules.documentShellCommands`/`shellCommandFiles` and fingerprints them (`:178-198`), `connection` `:236`, which `kete`/`kete run --trust-project-config` use). All registered in `index.ts` Handlers (marked).
- What do `--permission-mode`, `--auto` and `--dangerously-skip-permissions` do (feature/safe-defaults-modes)? Flags in upstream's `PermissionParams` (`commands/commands.ts`, marked) for `kete` and `kete run`. `kete/permission-mode.ts` `fromFlags` maps `--auto` to the `auto` mode (high-risk still asks; conflicting `--permission-mode` is an error) and `skipsPermissions` keeps the client-side bypass for `--dangerously-skip-permissions`/`--yolo` only. `kete run` sets the mode on the session (GET-merge-PATCH, read back) before the first prompt (`run/run.ts`, marked); the TUI gets it through `Args.permissionMode` (`permissions` card). In `kete run`, any prompt is rejected and the run stops.
- How does `kete job run` treat the repository's own config? B1 (task 2026-10-05-unattended-secret-hygiene): `JobRun.run` calls `Deps.inspectProjectConfig(realCwd, realRoot ?? realCwd)` before `location.get` (`job-run.ts:496`) and again on the worktree before `session.create` (`:558`, cleaning it up on refusal); any finding refuses (exit 2) with `projectConfigMessage` (`:217`), an inspection error too. `job.ts:222` wires `KeteJobProjectConfig.inspect` (`kete/job-project-config.ts:131`: `kete.json(c)`, `.kete/kete.json(c)`, `.kete/plugin(s)/` per directory up to the repo root; `guardedKeys` `:74`: `providers`/`provider`/`mcp` entries, `plugins`/`plugin`/`enterprise`, `share`/`autoshare` unless off, `kete.integrations`/`platform`/`unattended`/`hooks`; unparseable = finding). `--trust-project-config` (`kete/commands.ts:46`, spread into `kete run` at `commands/commands.ts:386`; also on `job run`, `kete/commands.ts:283`) or `KETE_TRUST_PROJECT_CONFIG=1` (`trusted`, `:59`) skips it; job mode skips it.
- How are built-in prompt slash commands added (`/init`, `/review`, `/commit`, `/pr`)? A plugin calls `ctx.command.transform((editor) => editor.add({ name, description, execute }))`, and `execute` sends `ctx.session.prompt({ ...input.prompt, sessionID, text, delivery })`. Upstream's are in `core/src/plugin/command.ts` (templates in `plugin/command/*.txt`); Kete's `/commit` and `/pr` are in `core/src/kete/git-commands.ts`. Config commands (`ConfigCommandPlugin`, in `post`) load later, so a configured command with the same name wins. The TUI and VS Code list them from the server's command list.
- What does `kete terminal-setup` do? `kete/terminal-setup-flow.ts`: `KeteTerminalSetup.detect` (util) from TERM_PROGRAM, KITTY_WINDOW_ID, WEZTERM_PANE, GHOSTTY_RESOURCES_DIR, ALACRITTY_WINDOW_ID, WT_SESSION…; the VS Code family by CURSOR_TRACE_ID, `__CFBundleIdentifier`, VSCODE_GIT_ASKPASS_*. Prints `guidance` lines; for an editor it appends `KEYBINDING` to `keybindingsPath(...)` with jsonc-parser `modify` (keeps comments), backup `<file>.kete-backup-<time>`, temp file + rename, only after confirm or `--yes`; `--print` changes nothing; invalid JSON or not a list exits 1 untouched. `/terminal-setup` in the TUI shows the guidance only; `kete doctor` hints at it when the terminal isn't one that reports Shift+Enter.
- What does `kete doctor` do? Gathers facts (`kete/doctor-flow.ts` `collect`, real deps in `kete/doctor.ts`): install kind (`KeteUpdater.detect`, no network), every `kete` on PATH vs `process.execPath`, account signed in (account.json only), and from the runtime `provider.list`, `model.default` (`data: null` = no model), `mcp.list`, the `kete.sandbox` and `kete.doctor` RPCs (10 s each; nothing answered = unreachable). `@opencode/util/kete/doctor` turns them into checks (`checks`, `render`, `exitCode`: 1 when any fails); `--format json`. `/doctor` in the TUI (`tui/src/kete/doctor.tsx`) uses the same checks. It never calls the update check: `KeteUpdater.make(...).check()` fetches signed release metadata (network).
- What does `kete sandbox` do? Asks the runtime whether agent shell commands go through the OS sandbox: the `kete.sandbox` status RPC (`client.rpc.call`, 15 s timeout), decoded against `KeteSandboxRpc.Status` (`kete/sandbox.ts`, `describe`); prints lines or `--format json`; exit 0 sandboxed or job, 1 unsandboxed (off/unavailable), 2 the runtime couldn't be asked (`EXIT`). Spec `kete/commands.ts:133`, handler routed at `index.ts:36`. See the `sandbox` card.
- What do orchestrated and review jobs add to `kete job run`? Two optional spec sections the cloud entrypoint copies from a claim (`job-spec.ts` `TOP_LEVEL_KEYS`, parse at the end): `orchestration` (needs `branch`; `KeteJobOrchestration.resolve`, `kete/job-orchestration.ts`, refuses outside job mode or without `KETE_JOB_ID`) and `review` (needs `branch`, excludes `orchestration`, job mode only; `job.ts:133` also removes a stale review record). Both reach the server child on the fd-3 secrets message (`job-standalone.ts:127` `secretsMessage`, read by `job-serve.ts` `setOrchestration`/`setReview`). For a review job `Deps.readReview` (`job.ts` wires `KeteReview.readRecord`) puts the recorded findings in `Result.review` (`job-run.ts` `withReview`); a missing or invalid record is said on stderr and leaves `review` out, the run's outcome unchanged. See the `job-mode` card.
- How do `kete mcp add harness|slack|playwright` and `kete mcp presets` work? Kete flows in `kete/mcp-preset.ts` over an injected `IO` (`kete/mcp-preset-io.ts`; `add` dispatches by name, `playwright` takes no flags and only writes the config entry, `addPlaywright`), routed from upstream's `commands/handlers/mcp/add.ts:27-42` (marked) when the name is a preset and no `--url`/command is given; flags `KeteCommands.mcpPresetParams` spread into upstream's `mcp add` spec (`commands/commands.ts:252`), `presets` registered at `:255` and `index.ts:63`. See the `mcp-presets` card.
- How does `--offline` work? `kete/offline-startup.ts` (imported at `index.ts:5`, right after the env bridge) calls `KeteCliOffline.apply` (`kete/offline.ts:55`): env, `--offline` in argv, or `kete.offline` in the global config files turns it on (`flagged`, `kete/offline.ts:37`, reads `--offline=<v>`/`--offline <v>` with the parser's truthy/falsy values: `--offline=false` and `--offline false` are off, an unknown value is on; `offline-startup.test.ts` pins it against the real parser) and sets `OPENCODE_OFFLINE`, `OPENCODE_DISABLE_MODELS_FETCH` and `OPENCODE_DISABLE_AUTOUPDATE` before any module reads env. The flag is also a registered global flag (`kete/commands.ts:22`, `framework/runtime.ts:86`) so the parser accepts it. See the `local-models` card.
- Which commands refuse offline? `login`, `sync` (not `--status`/`--approve`), `upgrade`, `models pull`: `KeteCliOffline.refused` (`kete/offline.ts:84`) prints the refusal and sets exit code 2. `updater.ts` `isDisabled` and `check()` also honour it.
- What changes in the server connection offline? `services/server-connection.ts` calls `KeteCliOffline.connection` (`kete/offline.ts:72`): always a private (`standalone`) server, `--server` refused.
- How does a command with subcommands get its handlers? A `{ $, sub }` map: `index.ts:98` (`models: { $, pull }`; `trust: { $, list, add, remove }` at `:82-87`), `framework/runtime.ts:43-76`; the spec side is `commands: [KeteCommands.modelsPull]` at `commands/commands.ts:348`.
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
  mode). Then `KeteJobStandalone.start` (`job.ts:171`, `kete/job-standalone.ts:205`) starts
  `kete serve --stdio --socket <0700 dir>/s` with the password and key on the child's fd 3; a start
  failure is `error` (1) carrying the child's last stderr line, and job mode never falls back to
  `ServerConnection.resolve`/TCP. The client is `OpenCode.make` with base `http://localhost` and
  `fetch({ unix })` (`job.ts:67-74,134-138`). Then `job.ts:165` passes `jobMode:
  KeteJobMode.enabled(process.env)` to `JobRun.run`: **cwd is the entrypoint's prepared worktree**
  (F1, `docs/tasks/2026-09-30-job-entrypoint/`). No git call at all (`repoRoot`/`headSha`/
  `worktreeAdd`/cleanup skipped, `job-run.ts:426-434,455-458,484`); `spec.branch` and `<cwd>/.git`
  are required (else exit 2 `refused`, before any session); the result says `isolated: true`,
  `worktree` = `directory` = cwd, `branch` = `spec.branch`. `job-git.ts:37`'s
  `KeteJobMode.refuseSpawn("git")` guard stays as defence in depth. See the `job-mode` card,
  `contracts.md` §6d, `docs/jobs.md` "Job mode".
- What are `kete serve`'s flags and where do they go? `commands/commands.ts:593-607` (`--hostname`,
  `--port`, `--cors`, `--service`, `--stdio`, and Kete's `--socket`, marked `:605`) →
  `commands/handlers/serve.ts:6-18` → `ServerProcess.run` (`server-process.ts`). `--socket <path>`
  is **job mode only**: `KeteJobServe.prepare` (`kete/job-serve.ts:105`, called at
  `server-process.ts:52` before anything else) refuses it outside job mode, and in job mode
  requires exactly `--stdio --socket` (no `--port`/`--hostname`), so the service, a TUI's standalone
  child and ACP refuse in a job. It then makes the process non-dumpable, reads `{v:1, password,
  gateway_key}` from `KETE_JOB_SECRETS_FD` and sets the in-memory key; the password replaces
  `Env.password` (`server-process.ts:95-105`) and `socket` reaches `ServerOptions.socket`
  (`:122`; `server-sdk` card).
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
  in `commands/commands.ts:18-30` aren't exported, so a command needing `--server`/`--standalone`
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
  (`packages/cli/src/commands/commands.ts:500`); nothing in the CLI reads YAML. `job-spec.ts`
  is the first JSON-spec-file parser of its kind here.
- Why does `kete job run` set an explicit session `title`? So upstream's own auto-title-generation
  doesn't make an extra, unscripted model request before the job's first real step — wasteful for
  an unattended run nobody reads the title of. `job-run.ts` truncates `spec.prompt` to 80 chars for
  it; `kete run`'s own `resolveSessionTarget` (`session-target.ts`) still lets upstream generate one.
- How does `kete upgrade` work, and what does it trust? `packages/cli/src/kete/upgrade.ts` (handler) over `KeteUpdater` (`kete/updater.ts`, ADR 0009): it fetches `SHA256SUMS` + `SHA256SUMS.sig` from `Brand.urls.releases` (latest: `releases/latest/download/`, a version: `releases/download/kete-v<v>/`), verifies the Ed25519 signature against `kete/update-keys.json` (`release-verify.ts`), reads the version from the signed archive names, downloads the archive for `KETE_TARGET` (a `build.ts` define), checks its SHA-256, runs `--version` on it, and renames it over the binary (Windows: rename aside + roll back). No pinned key → "unavailable"; Homebrew/npm/extension/source installs (`detect`, from the real path) are never replaced. `kete uninstall` stays disabled (`uninstall-disabled.ts`).
- Why doesn't `kete upgrade` animate in CI or over `ssh`? `packages/cli/src/kete/progress.ts` uses the spinner only when stdout is a TTY; otherwise one start line and one end line (a spinner writing to a pipe prints every frame).
- Why does `kete upgrade` say updates are unavailable? The binary predates the first pinned key (`kete-update-2026`, pinned 2026-10-04, PR #78; builds from `kete-v0.2.0-rc.4` on carry it), or it is a source/local build (`channel === "local"`).
- Where's the `KETE_*`→`OPENCODE_*` env bridge? `packages/cli/src/kete/env-bridge.ts`, imported first in `packages/cli/src/index.ts:4` (must stay the first import — runs before any other module reads `process.env`).
- How do I add a new top-level `kete` subcommand? Add a `Spec` to `packages/cli/src/kete/commands.ts`'s `specs` array (it's already spread at `packages/cli/src/commands/commands.ts:555`) and a handler entry in `packages/cli/src/index.ts`'s `Handlers` map.
- How do I build the `kete` binary? `bun run build --single --skip-install --skip-web-ui` in `packages/cli/` (CLAUDE.md §8) → `packages/cli/dist/cli-<os>-<arch>/bin/kete`; flags read at `packages/cli/script/build.ts:26,29,30`.
- What is `kete skill`? `add|list|update|remove` (specs `kete/commands.ts:169-204`, handlers `kete/skill.ts:62-79` registered in a marked `Handlers` block in `index.ts`): flows over an injected `Deps` in `kete/skill-flow.ts` (`add` `:385`, `list` `:424`, `remove` `:444`, `update` `:461`). Installs into `.kete/skills/<name>/` (or `--global`: `<config>/skills/`), pinned in `skills.lock.json` v1 (`roles-skills`, `contracts` cards). Exit 0 done, 1 failed, 2 refused (`skill-flow.ts:32`); nothing is written without a yes (`approve` `:147`); files read once, shown (scripts marked), written without the exec bit; `skill.install` org policy via `policyGate` `:132` (`sync` card).
- Can the CLI import `@opencode/core`? No (`cli/test/import-boundaries.test.ts`). So `skill-flow.ts:81` `match` mirrors core's `Wildcard.match` (case-insensitive only for git sources and on Windows; `policyGate(deps, source)` `:133`) and util's `KeteSkillSource.frontmatter` mirrors core's front-matter rules; keep them in step (`pitfalls`).
- Does `JobGit.run` give git an environment? Not unless asked: `env` is only read for job mode; the child inherits the parent's. `childEnv` (`job-git.ts:29,47`) is merged over `process.env` only when given; `kete skill` passes `GIT_TERMINAL_PROMPT=0` and `GIT_LFS_SKIP_SMUDGE=1` (`skill-flow.ts:186`) and disables hooks with `-c core.hooksPath=<empty dir>` (`:179`).

## Purpose
Kete-owned CLI surface: account sign-in (`login`/`logout`/`whoami`/`sync` against the Kete platform, distinct from upstream's provider-key `auth`), unattended job runs (`job run`), and Kete Code's own verified self-update (`kete upgrade`, ADR 0009) and a disabled `uninstall`. Everything here is a thin wrapper spliced into upstream's `packages/cli/src/index.ts` and `commands/commands.ts` command tree.

## Entry points
- `packages/cli/src/index.ts:4` — `import "./kete/env-bridge"` (side-effecting, must run first).
- `packages/cli/src/index.ts:33-121` — `Handlers` map: `upgrade` (`kete/upgrade.ts`), `uninstall`, `login`, `logout`, `whoami`, `sandbox`, `completion`, `bug`, `doctor`, `share`/`unshare` (`:44-45`, both from `kete/share.ts`), `terminal-setup`, `sync` and (nested) `job: { run }` (`:35-50`) route to `./kete/*` modules (each `kete_change`-marked); `trust`, `skill`, `models pull` are marked blocks further down.
- `packages/cli/src/index.ts:5,98` — `import "./kete/offline-startup"` (offline decision) and the `models: { $, pull }` handler map (`kete_change`).
- `packages/cli/src/index.ts:157` — `Effect.provide(KeteUpdater.layer)` (`kete_change`), replaces upstream's `Updater` service with the verified Kete updater.
- `packages/cli/src/commands/commands.ts:555` — `...KeteCommands.specs` spreads the `kete/commands.ts` specs (`login`/`logout`/`whoami`/`sync`/`sandbox`/`trust`/`skill`/`completion`/`bug`/`terminal-setup`/`doctor`/`share`/`unshare`/`job`) into the root command list (`kete_change`).
- `packages/cli/src/kete/commands.ts` — `Spec.make("login", …)` etc., and `Spec.make("job", {commands: [Spec.make("run", …)]})` for the nested command; the actual command definitions (params, descriptions).

## Key files
| File | Lines | Role |
| --- | --- | --- |
| `packages/cli/src/kete/env-bridge.ts` | 6 | Runs `KeteEnv.bridge(process.env)`; first import of the CLI entry point |
| `packages/cli/src/kete/commands.ts` | 294 | `Spec` definitions for the Kete top-level commands (`login` … `share`/`unshare` `:246,261`, `job run` `:271`), spread into `commands.ts`; owns a local `ServerParams` (`:11`, duplicated verbatim from upstream's unexported `commands/commands.ts:18`) for `share`/`unshare`/`job run`'s `--server`/`--standalone` |
| `packages/cli/src/kete/share.ts` / `share-flow.ts` | 82 / 115 | `kete share`/`unshare` handlers (`:66,76`, real deps incl. `KeteEnv.inAgentShell` `:24`) over the testable flow; see the `session-share` card |
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
| `packages/cli/src/kete/job-spec.ts` | 254 | `JobSpec.parse` — job spec v1 parse/validate, pure over injected `Deps` (`readFile`/`stat`/`realpath`); every error names the field path; `prompt_file` is confined to the spec's own directory via `realpath` on both sides (AC1, reviewer fix: path-traversal/symlink containment) |
| `packages/cli/src/kete/job-git.ts` | 90 | `JobGit.run`/`worktreeAdd`/`worktreeDiscard` — timeout-bounded, no-shell `git` via `node:child_process.execFile`; never throws on a non-zero exit, only on a missing `git` binary; in job mode `KeteJobMode.refuseSpawn("git")` runs first (`:36`), and `RunOptions.env` lets tests inject the flag without mutating `process.env` |
| `packages/cli/src/kete/job-connection.ts` | 28 | `JobConnection.resolve(args, env)` — pure: off is a no-op, on refuses `--server` and forces `standalone: true`; see the `job-mode` card |
| `packages/cli/src/kete/job-run.ts` | 900 | `JobRun.run` — the pure orchestration: validate → server-locality check → worktree+branch → session create with `kete.unattended` metadata → subscribe-before-prompt → wait → outcome/exit-code mapping → `--json`/text+summary output. Imports only `@opencode/client/promise`, `@opencode/schema/*`, `@opencode/util/kete/brand`, `node:*` (deliberately **not** `./job-spec.js`/`./job-git.js`, even for types — see the file's own header) so `packages/server/test/kete/job-run.test.ts` can import it directly against a real embedded server |
| `packages/cli/src/kete/job.ts` | 171 | The real handler: job-mode preflight, reads+parses the spec file, `KeteJobStandalone.start` (job mode) or `ServerConnection.resolve`, builds real `Deps` (client, `JobGit`, fs, clock, SIGINT), calls `JobRun.run` (with `jobMode`, `:165`), sets `process.exitCode` |
| `packages/cli/src/kete/job-preflight.ts` | 61 | `KeteJobPreflight.run` — non-dumpable, gateway key from `KETE_JOB_GATEWAY_KEY_FD`, env secrets dropped, refusals |
| `packages/cli/src/kete/job-standalone.ts` | 309 | `KeteJobStandalone.start` — socket dir, child spawn with secrets on fd 3 (`additionalFds`), stderr forwarding, ready-line check, cleanup |
| `packages/cli/src/kete/job-serve.ts` | 170 | `KeteJobServe.prepare` — `kete serve`'s job-mode checks and secrets read |
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
- `Handlers` map entries and `commands.ts` edits keep their `kete_change` markers (`packages/cli/src/index.ts:35-50,70,81-99,157`; `commands.ts:2,6-7,31-58,63-64,69,86,101,183,265,285,288,348,418,421,555,605`; `handlers/serve.ts:15`; `server-process.ts:4,22,31,51-58,102-104,122,194`).
- In job mode no TCP listener may exist and no secret may be in an environment: keep
  `KeteJobServe.prepare` the first thing in `processEffect`, and `job.ts`'s "no fallback" guard
  (`:129-131`).
- `kete auth` (upstream, provider keys) and `kete login` (Kete account) stay distinct commands; each `--help` text cross-references the other (`commands.ts:183`).
- Per docs/upstream-patches.md "Account sign-in": when syncing upstream, check it hasn't added its own top-level `login`/`logout`/`whoami` command — the spread at `commands.ts:555` would then collide. Same check now applies to `job` (docs/upstream-patches.md "Jobs").
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
- `kete skill` runs on a repository-controlled `.kete`: `scopeFor` (`skill-flow.ts:113`) and `targetFor` (`:124`, both re-run after the confirmation question) refuse symlinks and paths resolving outside the project; keep that if you touch the install path. `collect` (`:238`, realpath-checks each directory, opens O_NOFOLLOW|O_NONBLOCK) accepts regular, non-hard-linked files only, max 256 files / 10 MiB.
- `job-preflight.ts`/`job-serve.ts`/`job-standalone.ts` take injectable `Deps`/options (env,
  dumpable, descriptor reader, command) — tests use them instead of mutating `process.env` or
  calling `prctl`.
- The updater must never download upstream OpenCode binaries, run a package manager or an installer, or install anything whose `SHA256SUMS` signature (pinned key) and archive checksum didn't verify (CLAUDE.md §9 "Updates", ADR 0009). Its tests inject `Deps`; the real `extract` shells out to `tar` (System32 `tar.exe` on Windows), classified `client-only` in `core/test/kete/job-spawn-sites.test.ts`.
- `KETE_TARGET` is undefined in a source run (`bun run dev`): `install` then refuses with "doesn't know its release target"; source runs are `channel: local` and never get that far.
- `account-io.ts`'s service reload only fires if a `kete serve` is *already* running; signing in never starts one — don't assume `login` always leaves a live server picking up the new account.
- The CLI can't import `core` (per `account-flow.ts` header comment), so account storage logic lives in `@opencode/util/kete/account`, not `core`'s config/credential system — don't move it there. `job-spec.ts`/`job-run.ts` follow the same rule: the job policy schema lives in `@opencode/schema/kete/unattended`, not `core`, so the CLI can validate it without importing core.
- `job run` only works when the server is on this machine (D1): a non-loopback `--server` exits `2` before anything is created; a project's `commands.start` setup script never runs for a job (only `POST /api/worktree` runs it, and jobs bypass that endpoint) — if a project needs setup, the prompt has to do it, under the job's own policy. A `permission.asked` from a **subagent** of the job (not the root session) isn't recognized as the runtime-bug case — see the `unattended` card's Gotchas and `docs/jobs.md` "Known gaps".
- Building without `--skip-install` runs `bun install` for every target platform's native packages (CLAUDE.md §8) — slow; use `--skip-install` for local iteration.
