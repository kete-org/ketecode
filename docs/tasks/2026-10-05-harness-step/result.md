# Result: Kete Code step for Harness CI/CD pipelines

## What changed
- `packages/kete-harness-plugin/` (new): `src/{main,settings,task,run,git,cloud,outputs}.ts`, `Dockerfile`,
  `gitconfig`, `scripts/{build,smoke}.sh`, `test/` (unit + integration, fakes in `test/fixtures/`), `README.md`.
- `bun.lock`: the new workspace package.
- `.github/workflows/kete-harness-plugin.yml` (new): path-filtered tests + multi-arch image build, no push.
- `.github/workflows/kete-release.yml`: `harness-plugin-image`, `harness-plugin-publish`; `publish` needs it and records the digest.
- `.github/workflows/kete-build.yml`: runs the package's tests.
- `docs/integrations/harness.md` ("Pipeline step"), `docs/release.md` (channel, one-time GHCR setup, CI steps).
- `docs/context/`: new `modules/harness-plugin.md`, INDEX row, repo-map, commands; `kete-tools-ci` Quick answer; `job-image` re-verified.
- No upstream files touched.

## Checks
| Check | Result |
|---|---|
| `bun run test` (package, 38 tests, run mode from source) | pass |
| `bun run typecheck` (package) and `bun turbo typecheck` (pre-push hook) | pass |
| `bun run lint` | pass |
| `bun run --cwd packages/kete-tools upstream:check` | pass |
| actionlint (new + changed workflows) | pass |
| shellcheck `scripts/*.sh` | pass |
| `stale-cards` / `card-check` | pass |
| CI on PR #7: `kete-harness-plugin` (tests on the built kete, amd64 image both modes end to end, arm64 image smoke) and `kete-build` | pass (runs 37265625224, 37265625186) |

## Acceptance criteria
- [x] AC1 — `test/settings.test.ts`: missing budget/timeout/task, invalid modes/presets/limits/keys, allow rules, push names.
- [x] AC2 — `test/run.test.ts`: real `kete job run` against `test/fixtures/fake-model.ts`; outputs in both files, audit artifact with the run's limits, redacted summary, push to a new branch, refusal to push to `main` (before any model call) and to an existing branch.
- [x] AC3 — `test/cloud.test.ts`: fake platform; success with PR link, budget → 2, failed/timed out → 1, refused create → 2, retries with one idempotency key, wait limit → cancel + exit 1.
- [x] AC4 — `kete-harness-plugin.yml` builds amd64 (+ both modes end to end in the image) and arm64 (QEMU); release jobs push and cosign-sign on tags only (manual runs build and test only).
- [x] AC5 — README, `docs/integrations/harness.md`, lint, typecheck, tests, `upstream:check`.

## Security review fixes
All in `packages/kete-harness-plugin` (commits `12e3ad75b1`, `ff2ccc88e4`), each with tests:
1. **No hard-coded platform URL** (`settings.ts`): `PLUGIN_BASE_URL` required in cloud mode and with the gateway; `KETE_PLATFORM_URL` only when set.
2. **Push can't be redirected or run commands** (`git.ts`): `remote.origin.url` read and validated before the run; commit + push from a fresh temp repo (own config, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<devNull>`, alternates for the objects), pinned `-c` keys, one protocol allowed. `test/git.test.ts` plants sshCommand, credential.helper, insteadOf/pushInsteadOf, pushurl, fsmonitor, a required filter, hooks and an include: nothing runs, nothing goes elsewhere.
3. **Keys out of the agent's environment** (`run.ts` `keteEnv`). Finding: kete's shell tool passes the whole server `process.env` to every command (`core/src/shell.ts`), and outside job mode nothing scrubs provider keys, `KETE_GATEWAY_KEY` or the endpoint key (job mode's descriptor key needs the root helper). Fix: each key in a 0600 file in a 0700 temp dir outside the workspace, referenced as `{file:...}` from `KETE_CONFIG_CONTENT` (gateway: `providers.kete.settings.apiKey`), deleted after the run; the step makes itself non-dumpable on Linux. `test/run.test.ts` has the model run an allowed `printenv`: the output reaches the model, the key doesn't. Residual risk (README): allowed commands that run repository code can still read the file, and a repository's `.kete/` config is read by kete.
4. **Cloud cancel** (`cloud.ts`, `main.ts`): SIGTERM/SIGINT → abort → `POST …/cancel` (10 s) → `step_cancelled`; also after repeated status failures; a failed cancel is reported.
5. **PLUGIN_ALLOW**: `external_directory`, `webfetch`, `websearch` need `PLUGIN_ALLOW_UNSAFE=true`; wildcard-only `shell` resources refused; documented that allow/task must not come from untrusted PR data.
6. **Exact preset rules** (`task.ts` `presetCommands`): e.g. `git diff <base>...HEAD`; tests that `git tag -d x`, `git diff --output=f`, `git logfoo` (and redirections) aren't allowed.
7. **Literal secret masking** (`secrets.ts`): known values (≥ 8 chars, plus JSON-escaped) → `[REDACTED]` before `KeteRedact`, in log lines, outputs, summary, result, audit copy, git output and the log tail; tested with non-shaped tokens.
Nits: `Outputs.writeArtifact` (unlink + `wx`, no write through a symlink), case-insensitive protected branches, code-shaped platform error codes only, other-mode settings refused.

| Check | Result |
|---|---|
| `bun run test` (package, 60 tests) / `bun run typecheck` | pass |
| `bun turbo typecheck`, `bun run lint`, `upstream:check` | pass |
| `stale-cards` / `card-check` | pass |
| shellcheck `scripts/*.sh` | not installed locally; runs in CI (`kete-harness-plugin` workflow) |
| actionlint | no workflow changed |

## Cards updated
- New `harness-plugin`; `kete-tools-ci` (Quick answer for the workflow and release jobs); `job-image` (verified-at only).

## Metrics
- Agents used: one build agent (no subagents)
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: ~2 h
