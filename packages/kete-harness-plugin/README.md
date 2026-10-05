# kete-harness-plugin

The Kete Code step for Harness CI/CD pipelines: a Harness CI **Plugin** step image
(`ghcr.io/kete-org/kete-harness-plugin`, Drone-compatible, so settings arrive as `PLUGIN_*`
environment variables). It fixes a failing build, reviews a change or writes release notes, either
inside the pipeline's own container (`run` mode: `kete job run`, ADR 0008) or by starting a Kete
cloud job (`cloud` mode: `POST /api/v1/jobs`, `docs/platform/jobs-v1.md`). Every run has a budget,
a time limit and a clear outcome.

User guide with pipeline YAML: [`docs/integrations/harness.md`](../../docs/integrations/harness.md#pipeline-step).

| File | What |
|---|---|
| `src/main.ts` | entrypoint: settings → mode → output variables → exit code |
| `src/settings.ts` | `PLUGIN_*` parsing and validation (refusals name the setting, never its value) |
| `src/task.ts` | presets (`fix-build`, `review`, `release-notes`), the prompt and allow rules |
| `src/run.ts` | `run` mode: job spec, `kete job run --json --standalone`, artifacts, the agent's environment |
| `src/git.ts` | commit the run's worktree and push it to a **new** branch only |
| `src/cloud.ts` | `cloud` mode: create the job, poll with backoff, cancel at the wait limit |
| `src/outputs.ts` | exit codes and the `$DRONE_OUTPUT`/`$HARNESS_OUTPUT` variables |
| `Dockerfile`, `gitconfig` | the image (Debian slim pinned by digest, git, ripgrep, CA roots, `kete`, uid 1000) |
| `scripts/build.sh` | compiles the entrypoint with Bun for linux/<arch>, stages the context, `docker build` |
| `scripts/smoke.sh` | tests a built image; `--full` runs both modes in it against the local fakes |
| `test/` | unit tests, `cloud` against a fake platform, `run` driving a real `kete job run` against a fake OpenAI-compatible model |

## Settings

| Setting | Mode | Meaning |
|---|---|---|
| `mode` | both | `run` (default) or `cloud` |
| `task` | both | what Kete Code should do; with a preset, extra instructions |
| `preset` | both | `fix-build` (needs `log`), `review`, `release-notes` |
| `log` | both | `fix-build`: the failed step's log, a path inside the workspace; its last 48 KB go into the prompt, redacted |
| `base` | both | `review`/`release-notes`: the ref to compare with (default: `origin/<target branch>` / the latest tag) |
| `budget` | both | **required**: USD for the whole run (cloud: at most 25) |
| `timeout` | both | **required**: minutes (`30`, `30m`, `2h`; cloud: at most 120) |
| `allow` | both | extra rules the run may proceed on without asking: JSON `[{"action","resource"}]` or `action:resource` lines (`shell:bun test*`); `question` and `budget` never |
| `agent` | both | agent name (run) or slug (cloud, **required**) |
| `push_branch` | both | run: a NEW branch name, or `true` for the run's own `kete/job/<hex>`; cloud: `true` or a suffix for `kete/job/<suffix>` |
| `output_dir` | both | workspace-relative directory for `summary.md`, `result.json`, `audit.jsonl` (default `kete-output`) |
| `kete_api_key` | both | a Kete API key (Harness secret): cloud mode, or run mode through the gateway |
| `gateway_url` | run | the Kete Model Gateway address (with `kete_api_key`) |
| `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, `openrouter_api_key`, `deepseek_api_key` | run | BYOK provider keys (Harness secrets) |
| `model` | run | `provider/model`; with `model_url`, the model id that endpoint serves |
| `model_url`, `model_api_key` | run | an OpenAI-compatible endpoint (https, or http on a private network) |
| `git_author_name`, `git_author_email` | run | the commit's author (default `Kete Code`) |
| `base_url` | both | the Kete platform (default `https://app.ketecode.ai`) |
| `project`, `repo` | cloud | **required**: the Kete project id and the connected repository's id |
| `base_ref`, `open_pr`, `idempotency_key` | cloud | as in `POST /api/v1/jobs`; `open_pr` needs `push_branch` |

Exactly one kind of model access is accepted in run mode.

## Outputs

Exit code `0` success, `1` failure, `2` refused (settings, policy, budget, a push to an existing or
protected branch). Output variables (`$DRONE_OUTPUT` and `$HARNESS_OUTPUT`, one line each, redacted):
`KETE_OUTCOME` (`kete job run`'s outcome, the cloud job's outcome or status, or `refused`,
`push_refused`, `push_failed`, `time_limit`, `error`), `KETE_SUMMARY` (the final answer, cut to
2000 bytes), `KETE_BRANCH` (the branch pushed, else empty), `KETE_JOB_URL` (cloud mode).

## Rules that must not break

- Secrets come only from settings (Harness secrets) and are never printed; refusals name the
  setting, never the value. Output text is redacted with `KeteRedact` (`@opencode/util/kete/redact`).
- The agent's process tree starts without `PLUGIN_*`, `DRONE_NETRC_*` or any secret-looking
  variable; it gets only the model access it needs (`Run.keteEnv`).
- Pushes go only to a branch that doesn't exist on the remote (`--force-with-lease=<ref>:`), never
  to the target, default, current, `main` or `master` branch (refused before the run), never with
  repository hooks. Only a `completed` run is pushed.
- `kete job run`'s unattended policy (ADR 0008) is never relaxed: the step only adds allow rules the
  user configured or a preset needs, and never passes `--auto`.

## Build and test

```sh
bun run test            # unit + integration (run mode uses KETE_TEST_BIN, else kete from source)
bun run typecheck
bash scripts/build.sh --arch amd64 --kete <linux kete> --tag kete-harness-plugin:amd64
bash scripts/smoke.sh kete-harness-plugin:amd64 --full   # Linux host network
```

CI: `.github/workflows/kete-harness-plugin.yml` (path-filtered; builds and tests both images, pushes
nothing); the release's `harness-plugin-image` and `harness-plugin-publish` jobs (`docs/release.md`).
