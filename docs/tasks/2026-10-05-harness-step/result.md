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
| CI `kete-harness-plugin` / `kete-build` on PR #7 | see the PR |

## Acceptance criteria
- [x] AC1 — `test/settings.test.ts`: missing budget/timeout/task, invalid modes/presets/limits/keys, allow rules, push names.
- [x] AC2 — `test/run.test.ts`: real `kete job run` against `test/fixtures/fake-model.ts`; outputs in both files, audit artifact with the run's limits, redacted summary, push to a new branch, refusal to push to `main` (before any model call) and to an existing branch.
- [x] AC3 — `test/cloud.test.ts`: fake platform; success with PR link, budget → 2, failed/timed out → 1, refused create → 2, retries with one idempotency key, wait limit → cancel + exit 1.
- [x] AC4 — `kete-harness-plugin.yml` builds amd64 (+ both modes end to end in the image) and arm64 (QEMU); release jobs push and cosign-sign on tags only (manual runs build and test only).
- [x] AC5 — README, `docs/integrations/harness.md`, lint, typecheck, tests, `upstream:check`.

## Cards updated
- New `harness-plugin`; `kete-tools-ci` (Quick answer for the workflow and release jobs); `job-image` (verified-at only).

## Metrics
- Agents used: one build agent (no subagents)
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: ~2 h
