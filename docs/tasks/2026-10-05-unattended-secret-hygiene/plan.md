# Plan: Unattended secret hygiene

Brief plan (medium task, built in one session). Spec: `spec.md` (agreed).

## Steps
1. Schema: `ConfigKete.Unattended` (`passEnv`) in `packages/schema/src/config/kete.ts`; regenerate
   `packages/protocol` and `packages/client`.
2. A1: `packages/core/src/kete/tool-env.ts` (`isKeteCredential`, `isCredential`, `filter`,
   `withoutKeteCredentials`, `forSession`). Marked edits: `core/src/shell.ts` (always-on filter in
   `create`), `core/src/tool/plugin/shell.ts` (unattended filter in the `before` callback).
3. A1 tests: `core/test/kete/tool-env.test.ts` (rules, win32, models.dev snapshot, `forSession`),
   `core/test/kete/tool-env-shell.test.ts` (real shell tool: unattended, interactive, `passEnv`).
4. B1: `packages/cli/src/kete/job-project-config.ts` (`guardedKeys`, `directories`, `inspect`,
   `trusted`); `job-run.ts` (`Deps.inspectProjectConfig`, `Input.trustProjectConfig`, check before
   `location.get` and on the worktree before `session.create`); `job.ts` wiring; `commands.ts`
   `--trust-project-config`; fakes in `cli/test/kete/job-run.test.ts` and
   `server/test/kete/job-run.test.ts`.
5. B1 tests: `cli/test/kete/job-project-config.test.ts`, new `job-run.test.ts` describe.
6. Docs: `docs/jobs.md` (two sections + steps + exit codes), `docs/local-models.md`,
   `docs/integrations/harness.md`, harness README, `docs/upstream-patches.md`; cards.

## Verification
| AC | Command |
|---|---|
| AC1–AC3 | `cd packages/core && bun run test ./test/kete/tool-env-shell.test.ts` |
| AC4, AC5 | `cd packages/core && bun run test ./test/kete/tool-env.test.ts` |
| AC6 | `cd packages/cli && bun test ./test/kete/job-project-config.test.ts ./test/kete/job-run.test.ts`; `cd packages/server && bun run test ./test/kete/job-run.test.ts` |
| AC7 | `bun run --cwd packages/kete-tools upstream:check`; `node scripts/agent/card-check.mjs`; `node scripts/agent/stale-cards.mjs` |
| all | core `bun run test ./test/kete`, cli/util `bun test ./test/kete`, harness plugin `bun run test`, typecheck util/schema/core/cli, `check:generated`, `bun run lint`, `verify --base main` |
