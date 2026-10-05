---
module: harness-plugin
paths: [packages/kete-harness-plugin/**, .github/workflows/kete-harness-plugin.yml]
verified-at: 4e44ac2eba
---

## Quick answers
- What is it? The Kete Code step for Harness CI/CD pipelines: a Drone-compatible **Plugin** step image (`ghcr.io/kete-org/kete-harness-plugin`), settings as `PLUGIN_*` env. `run` mode = `kete job run` in the workspace; `cloud` mode = `POST /api/v1/jobs` + poll. User guide: `docs/integrations/harness.md` "Pipeline step"; settings table: the package README.
- Why TypeScript + `bun build --compile`, not Go like `kete-job-entrypoint`? It reuses `KeteRedact` (`@opencode/util/kete/redact`) and the repo's Bun toolchain, and CI and dev machines have no Go requirement; one ~60 MB binary per arch (`scripts/build.sh`, `--target=bun-linux-<x64|arm64>`).
- How does run mode reach a model? Exactly one of: `kete_api_key` + `gateway_url` → `KETE_GATEWAY_KEY`/`KETE_GATEWAY_URL` (+ `KETE_PLATFORM_URL` = `base_url`); BYOK provider settings → `ANTHROPIC_API_KEY` etc. (`settings.ts` `providerKeys`); `model_url` → a custom provider `endpoint` (`aisdk:@ai-sdk/openai-compatible`, tools on) via `KETE_CONFIG_CONTENT`, its key referenced as `{env:PIPELINE_MODEL_ENDPOINT_KEY}` (`run.ts` `keteEnv`).
- Why isn't the endpoint key in a `KETE_*` variable? kete's env bridge renames `KETE_*` to `OPENCODE_*` at startup, so a `{env:KETE_…}` config reference would resolve empty (found by the integration test).
- Why `--standalone`? So no background service outlives the step; `kete job run` starts its own server child and stops it.
- Where does the push go? Only to a branch that doesn't exist on `origin` (`git push --force-with-lease=refs/heads/<b>: origin HEAD:refs/heads/<b>`, empty expectation = must not exist), never to the target/default/current branch, `main` or `master` (`git.ts` `protectedBranches`, checked before the run and again before the push), hooks off, only for a `completed` run. Clone credentials: `DRONE_NETRC_*` written to a 0600 `.netrc` in a temporary HOME for that one git process.
- How does fix-build give the agent the log? Its last 48 KB, redacted, go into the prompt (`task.ts` `readLogTail`): the agent's worktree is elsewhere and an external read would be denied by the unattended policy. The path must resolve (symlinks too) inside the workspace.
- What does the agent's environment contain? The step's env minus `PLUGIN_*`, `DRONE_NETRC_*` and any name `KeteRedact.isSecretKey` flags, plus the model access and `KETE_DISABLE_AUTOUPDATE=1` (`run.ts` `sanitize`/`keteEnv`).
- How are the integration tests offline? Run mode: `test/fixtures/fake-model.ts` (SSE chat completions on 127.0.0.1, scripts a `write` tool call then an answer with a fake secret) and a local bare remote; kete is `KETE_TEST_BIN` or a source wrapper (`BUN_OPTIONS=--config=packages/cli/bunfig.toml` so its server child finds the preload). Cloud mode: `test/fixtures/fake-platform.ts`, in-process with a fake clock. The tests must spawn the step asynchronously (the fakes share the test's event loop).

## Purpose
Spec `docs/tasks/2026-10-05-harness-step/spec.md`: a Harness pipeline can fix a failing build, review a change or write release notes, in its own container or as a Kete cloud job, with a budget, a time limit and a clear outcome (exit 0/1/2, `KETE_OUTCOME`, `KETE_SUMMARY`, `KETE_BRANCH`, `KETE_JOB_URL`).

## Entry points
- `packages/kete-harness-plugin/src/main.ts:20` `main` — settings → mode → `Outputs.write` → exit code; the image's `ENTRYPOINT`.
- `src/run.ts:69` `Run.run`, `src/cloud.ts:57` `Cloud.run`.
- `scripts/build.sh` (compile + stage + `docker build`), `scripts/smoke.sh <image> [--full]`.
- `.github/workflows/kete-harness-plugin.yml`; release jobs `harness-plugin-image` / `harness-plugin-publish` in `.github/workflows/kete-release.yml` (`kete-tools-ci` card).

## Key files
| File | What |
|---|---|
| `src/settings.ts` | `parse` (`:231`), `allow` (`:167`), `modelAccess` (`:323`), `defaultBaseURL` (`:71`), API limits |
| `src/task.ts` | `presetAllow` (`:16`), `build` (`:46`), `readLogTail` (`:96`) |
| `src/run.ts` | spec, `spawnKete` (`:304`, timeout + SIGTERM forwarding), `copyAudit`, `commitAndPush`, `outputDirectory` (`:207`) |
| `src/git.ts` | `protectedBranches` (`:42`), `commitAll` (`:60`), `pushNew` (`:101`) |
| `src/cloud.ts` | create with `Idempotency-Key`, retries, poll backoff, cancel at the wait limit, `parseJob` (`:267`) |
| `src/outputs.ts` | `exitCode` (`:24`), `oneLine` (`:41`), `write` (`:60`) |
| `Dockerfile` | trixie-slim (same digest as the job image), git, ripgrep, CA roots, uid 1000, both binaries root 0755 |

## Data flow
Run: settings → prompt + allow rules → `job.json` (0600, temp dir) → `kete job run <spec> --json --standalone` in the workspace → result v1 → `kete-output/{audit.jsonl,result.json,summary.md}` → optional commit + new-branch push → outputs. Cloud: settings → `POST /api/v1/jobs` (Bearer key, `Idempotency-Key`, retries on network/429/5xx) → job URL `<base_url>/jobs/<id>` → `GET /api/v1/jobs/{id}` every 5 s growing ×1.5 to 30 s → terminal status or `timeout + 15 min` (then `POST …/cancel`) → `summary.md` + outputs.

## Data and APIs used
`kete job run` and its result v1 / exit codes (`docs/jobs.md`); the platform's job user routes (`docs/platform/jobs-v1.md`, `contracts.md`); `KeteRedact`; Harness/Drone env (`DRONE_WORKSPACE`, `HARNESS_WORKSPACE`, `DRONE_OUTPUT`, `HARNESS_OUTPUT`, `DRONE_TARGET_BRANCH`, `DRONE_REPO_BRANCH`, `DRONE_NETRC_*`).

## Rules that must not break
- Never print a setting's value; refusals name the setting. Every output and summary text goes through `KeteRedact`.
- Never relax ADR 0008: no `--auto`, no permission bypass; allow rules only from presets and `PLUGIN_ALLOW`; `question`/`budget` refused.
- Never push to an existing, target or default branch, never run repository hooks.
- Budget and time limit are required in both modes; cloud limits mirror the API (25 USD, 120 min).
- No secret in the image; the release pushes exactly the images it tested (artifact checksum), signs and verifies them.

## Testing
`bun run test` in the package (38 tests: settings, outputs, task, env, cloud integration, run integration ~15 s from source); `bun run typecheck`; CI also runs `scripts/smoke.sh --full` on the amd64 image (both modes inside the image) and the plain smoke on arm64 under QEMU. Not tested: a real Harness runner, real GHCR push/sign (tags only), a real platform (cloud jobs not yet live).

## Changes
- `docs/tasks/2026-10-05-harness-step/` — the package, its workflow, the release jobs, `kete-build` suite, docs.

## Gotchas
- The image runs as uid 1000; a root-owned clone makes `.git` unwritable and the step refuses (exit 2) with a `runAsUser` hint.
- `default base_url` is `https://app.ketecode.ai` (spec decision), while `brand.ts` `urls.platform` is still undefined; change both together if the domain changes.
- vLLM's own discovery marks models `tools: false`; the step's `endpoint` provider defaults tools on, so a model that can't call tools fails at the endpoint, not silently.
