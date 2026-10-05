---
module: harness-plugin
paths: [packages/kete-harness-plugin/**, .github/workflows/kete-harness-plugin.yml]
verified-at: ff2ccc88e4
---

## Quick answers
- What is it? The Kete Code step for Harness CI/CD pipelines: a Drone-compatible **Plugin** step image (`ghcr.io/kete-org/kete-harness-plugin`), settings as `PLUGIN_*` env. `run` mode = `kete job run` in the workspace; `cloud` mode = `POST /api/v1/jobs` + poll. User guide: `docs/integrations/harness.md` "Pipeline step"; settings table: the package README.
- Why TypeScript + `bun build --compile`, not Go like `kete-job-entrypoint`? It reuses `KeteRedact` (`@opencode/util/kete/redact`) and the repo's Bun toolchain, and CI and dev machines have no Go requirement; one ~60 MB binary per arch (`scripts/build.sh`, `--target=bun-linux-<x64|arm64>`).
- How does run mode reach a model? Exactly one of: `kete_api_key` + `gateway_url` + `base_url` → `providers.kete.settings.apiKey` + `KETE_GATEWAY_URL`/`KETE_PLATFORM_URL`; BYOK provider settings → `providers.<anthropic|openai|google|openrouter|deepseek>.settings.apiKey` (`settings.ts` `providerKeys`); `model_url` → a custom provider `endpoint` (`aisdk:@ai-sdk/openai-compatible`, tools on). All via `KETE_CONFIG_CONTENT`, every key as `{file:<temp>/keys/<provider>}` (`run.ts` `keteEnv`).
- Why are keys files, not environment variables? kete's shell tool gives every command the server's whole `process.env` (`core/src/shell.ts` `create`: `...process.env`), and outside job mode nothing removes keys from it (job mode's descriptor key, `KETE_JOB_GATEWAY_KEY_FD`, needs the root helper). So keys go into 0600 files in a 0700 temp dir outside the workspace (refused if `TMPDIR` is inside it), deleted after the run; `{file:}` is expanded when kete loads config (`core/src/config/variable.ts`). Residual: an allowed command running repo code can read the file (path is in `KETE_CONFIG_CONTENT`) — README "Residual risks". `test/run.test.ts` has the model run an allowed `printenv` and checks the key never reaches it.
- Is there a default `base_url`? No (CLAUDE.md §5): required in cloud mode and with the gateway; otherwise `KETE_PLATFORM_URL` is set only when given.
- Why `--standalone`? So no background service outlives the step; `kete job run` starts its own server child and stops it.
- Where does the push go? To the `remote.origin.url` read and validated before the run (`git.ts` `originURL`/`validateRemote`: https, http to loopback, ssh/scp-like, local path/`file://`; no `::` transports, no password, exactly one value), only to a branch that doesn't exist there (`--force-with-lease=refs/heads/<b>:`), never to the target/default/current branch, `main` or `master` (`protectedBranches`/`isProtected`, lower-cased, checked before the run and again before the push), only for a `completed` run. `publish` commits in a fresh temp repo (`git init --template=`, `GIT_DIR` there, `GIT_WORK_TREE` = the run's worktree, `GIT_ALTERNATE_OBJECT_DIRECTORIES` = the workspace's objects, `shallow` copied) with `read-tree`/`add -A`/`write-tree`/`commit-tree`, so the workspace repo's config is never read; every call has `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<os.devNull>`, no inherited `GIT_*`, pinned `-c` keys (`safe.directory=*`, hooks, fsmonitor, pager, sshCommand, credential.helper, ext/fd), and the push allows only the remote's protocol. Clone credentials: `DRONE_NETRC_*` in a 0600 `.netrc` in a temp HOME for the push only. `test/git.test.ts` plants sshCommand/credential.helper/insteadOf/pushurl/fsmonitor/filter/hooks/include and checks nothing runs or goes elsewhere.
- How are secrets kept out of what the step prints? `secrets.ts` `redactor`: every `PLUGIN_*` key/secret setting and `DRONE_NETRC_PASSWORD` value (≥ 8 chars, plus its JSON-escaped form) → `[REDACTED]`, then `KeteRedact.text`; main wraps the logger with it and passes it to outputs, summary, `result.json`, the audit copy, git output and `readLogTail`. On Linux main also calls `Dumpable.disable()` (prctl) so `/proc/<step>/environ` isn't readable by the agent's processes (warning, not fatal, on failure).
- What do the presets allow? Exact commands for their base (`task.ts` `presetCommands`: e.g. `git diff <base>...HEAD`, `git log --oneline <base>..HEAD`; without a base `git diff HEAD~1`, `git tag --list`, ...), never prefixes (`git diff*` would allow `--output=<file>`). Base = `PLUGIN_BASE`, else `origin/<target>` (review) or `Git.latestTag` (release-notes), only if `isBranchName`. The prompt lists them. `PLUGIN_ALLOW` refuses `external_directory`/`webfetch`/`websearch` without `PLUGIN_ALLOW_UNSAFE=true` and a wildcard-only `shell` resource; settings of the other mode are refused (`runOnly`/`cloudOnly`).
- What happens when a cloud-mode step is cancelled? main turns SIGTERM/SIGINT into an `AbortSignal` (cloud mode only; run mode's `spawnKete` forwards signals to kete); `Cloud.run` wakes from its sleep, calls `POST …/cancel` (`cancelTimeoutMs`, 10 s) and finishes `step_cancelled` (exit 1). Six failed status requests also cancel (best effort; a failed cancel says the job may still run).
- How does fix-build give the agent the log? Its last 48 KB, redacted, go into the prompt (`task.ts` `readLogTail`): the agent's worktree is elsewhere and an external read would be denied by the unattended policy. The path must resolve (symlinks too) inside the workspace.
- What does the agent's environment contain? The step's env minus `PLUGIN_*`, `DRONE_NETRC_*` and any name `KeteRedact.isSecretKey` flags, plus `KETE_CONFIG_CONTENT` (file references, no key), `KETE_GATEWAY_URL`/`KETE_PLATFORM_URL` when used, and `KETE_DISABLE_AUTOUPDATE=1` (`run.ts` `sanitize`/`keteEnv`).
- How are the integration tests offline? Run mode: `test/fixtures/fake-model.ts` (SSE chat completions on 127.0.0.1, scripts a `write` tool call — or a `shell` call with `{shell}` — then an answer with a fake secret; records each request body) and a local bare remote; kete is `KETE_TEST_BIN` or a source wrapper (`BUN_OPTIONS=--config=packages/cli/bunfig.toml` so its server child finds the preload). Cloud mode: `test/fixtures/fake-platform.ts`, in-process with a fake clock. The tests must spawn the step asynchronously (the fakes share the test's event loop).

## Purpose
Spec `docs/tasks/2026-10-05-harness-step/spec.md`: a Harness pipeline can fix a failing build, review a change or write release notes, in its own container or as a Kete cloud job, with a budget, a time limit and a clear outcome (exit 0/1/2, `KETE_OUTCOME`, `KETE_SUMMARY`, `KETE_BRANCH`, `KETE_JOB_URL`).

## Entry points
- `packages/kete-harness-plugin/src/main.ts:22` `main` — redactor → settings → mode → `Outputs.write` → exit code; the `import.meta.main` block (non-dumpable, cloud-mode signal → abort) is the image's `ENTRYPOINT`.
- `src/run.ts:76` `Run.run`, `src/cloud.ts:71` `Cloud.run`.
- `scripts/build.sh` (compile + stage + `docker build`), `scripts/smoke.sh <image> [--full]`.
- `.github/workflows/kete-harness-plugin.yml`; release jobs `harness-plugin-image` / `harness-plugin-publish` in `.github/workflows/kete-release.yml` (`kete-tools-ci` card).

## Key files
| File | What |
|---|---|
| `src/settings.ts` | `parse` (`:268`), `allow`/`rule` (`:193`/`:233`), `modelAccess` (`:368`), `providerKeys`, `runOnly`/`cloudOnly`, `unsafeActions`, API limits |
| `src/task.ts` | `presetCommands` (`:22`), `presetAllow` (`:49`), `presetBase` (`:72`), `build` (`:81`), `readLogTail` (`:135`) |
| `src/run.ts` | spec, `keteEnv` (`:315`, key files), `spawnKete` (`:351`, timeout + SIGTERM forwarding), `copyAudit`, `commitAndPush`, `outputDirectory` (`:235`) |
| `src/git.ts` | `environment` (`:59`), `protectedBranches`/`isProtected` (`:96`/`:116`), `latestTag`, `validateRemote` (`:132`), `originURL` (`:159`), `publish` (`:196`) |
| `src/cloud.ts` | create with `Idempotency-Key`, retries, poll backoff, cancel at the wait limit / on abort / after failed polls, `errorCode` (`:67`), `parseJob` (`:336`) |
| `src/outputs.ts` | `exitCode` (`:26`), `oneLine` (`:43`), `write` (`:62`), `writeArtifact` (`:76`) |
| `src/secrets.ts` | `isSecret`, `values`, `redactor` (`:44`), `json` |
| `src/dumpable.ts` | `disable` (prctl via `bun:ffi`, Linux only) |
| `Dockerfile` | trixie-slim (same digest as the job image), git, ripgrep, CA roots, uid 1000, both binaries root 0755 |

## Data flow
Run: settings → prompt + allow rules → `job.json` (0600, temp dir) → `kete job run <spec> --json --standalone` in the workspace → result v1 → `kete-output/{audit.jsonl,result.json,summary.md}` → optional commit + new-branch push → outputs. Cloud: settings → `POST /api/v1/jobs` (Bearer key, `Idempotency-Key`, retries on network/429/5xx) → job URL `<base_url>/jobs/<id>` → `GET /api/v1/jobs/{id}` every 5 s growing ×1.5 to 30 s → terminal status or `timeout + 15 min` (then `POST …/cancel`) → `summary.md` + outputs.

## Data and APIs used
`kete job run` and its result v1 / exit codes (`docs/jobs.md`); the platform's job user routes (`docs/platform/jobs-v1.md`, `contracts.md`); `KeteRedact`; Harness/Drone env (`DRONE_WORKSPACE`, `HARNESS_WORKSPACE`, `DRONE_OUTPUT`, `HARNESS_OUTPUT`, `DRONE_TARGET_BRANCH`, `DRONE_REPO_BRANCH`, `DRONE_NETRC_*`).

## Rules that must not break
- Never print a setting's value; refusals name the setting. Every printed line, output and artifact goes through the `Secrets` redactor (known values, then `KeteRedact`).
- No model key in the agent's environment; key files stay outside the workspace and are deleted after the run.
- The push never reads the workspace repository's config and only goes to the origin URL read before the run.
- No hard-coded platform address (CLAUDE.md §5).
- Never relax ADR 0008: no `--auto`, no permission bypass; allow rules only from presets and `PLUGIN_ALLOW`; `question`/`budget` refused.
- Never push to an existing, target or default branch, never run repository hooks.
- Budget and time limit are required in both modes; cloud limits mirror the API (25 USD, 120 min).
- No secret in the image; the release pushes exactly the images it tested (artifact checksum), signs and verifies them.

## Testing
`bun run test` in the package (60 tests: settings, outputs, task, env, secrets, git hardening, dumpable, cloud integration, run integration ~20 s from source); `bun run typecheck`; CI also runs `scripts/smoke.sh --full` on the amd64 image (both modes inside the image) and the plain smoke on arm64 under QEMU. Not tested: a real Harness runner, real GHCR push/sign (tags only), a real platform (cloud jobs not yet live).

## Changes
- `docs/tasks/2026-10-05-harness-step/` — the package, its workflow, the release jobs, `kete-build` suite, docs; then the security review fixes (result.md "Security review fixes").

## Gotchas
- The image runs as uid 1000; a root-owned clone makes `.git` unwritable and the step refuses (exit 2) with a `runAsUser` hint.
- `safe.directory=*` is pinned on the step's git calls: system config (the image's `/etc/gitconfig`) is off for them, and the workspace is usually cloned by another user. `/etc/gitconfig` is still what lets `kete` itself use the workspace.
- `KETE_*` names are renamed to `OPENCODE_*` by kete's env bridge at startup, so `printenv` in a run shows `OPENCODE_CONFIG_CONTENT` etc., and a `{env:KETE_…}` config reference would resolve empty.
- vLLM's own discovery marks models `tools: false`; the step's `endpoint` provider defaults tools on, so a model that can't call tools fails at the endpoint, not silently.
