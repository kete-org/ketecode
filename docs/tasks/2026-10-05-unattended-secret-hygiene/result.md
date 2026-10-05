# Result: Unattended secret hygiene

## What changed
- `packages/core/src/kete/tool-env.ts` (new): `isKeteCredential`, `isCredential`, `filter`,
  `withoutKeteCredentials`, `forSession`. Every shell command loses Kete's own credentials (any
  `KETE_*`/`OPENCODE_*` name ending in `_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD`, plus
  `KeteJobSecrets.environmentSecrets`). In an unattended run (`kete.unattended`, an undecodable
  policy included, or job mode), commands also lose anything that looks like a credential, except
  names in `kete.unattended.passEnv`.
- Upstream, marked: `core/src/shell.ts` (`create` applies the always-on filter) and
  `core/src/tool/plugin/shell.ts` (the `before` callback applies `forSession`). Both are recorded in
  `docs/upstream-patches.md`.
- `packages/schema/src/config/kete.ts`: added `kete.unattended.passEnv`, then regenerated
  `protocol/openapi.json` and `client/src/promise/generated/types.ts`.
- `packages/cli/src/kete/job-project-config.ts` (new) and `job-run.ts`, `job.ts`, `commands.ts`:
  - `kete job run` refuses (exit 2) when repository config sets `providers`/`provider`, `mcp`,
    `plugins`/`plugin`, `.kete/plugin(s)/` code, `enterprise`, `share`/`autoshare` other than off,
    or `kete.integrations`/`platform`/`unattended`. It also refuses when a config file can't be
    parsed or the check itself fails.
  - The check runs before the server is contacted, and again on the job's worktree, which is
    cleaned up if that check refuses.
  - `--trust-project-config` or `KETE_TRUST_PROJECT_CONFIG=1` skips the check. Job mode also skips
    it, because its server never loads project config.
- Docs:
  - `docs/jobs.md`: new sections "Secrets in an unattended run" and "Repository config in an
    unattended run", plus updates to the steps and exit codes.
  - Also updated: `docs/local-models.md`, `docs/integrations/harness.md`, and the harness plugin
    README (rules and residual risks; the step keeps its key files).
- Cards updated: unattended, cli, config-kete, harness-plugin, server-sdk, job-mode, permissions,
  local-models. verified-at was bumped on the stale ones.
- New tests:
  - `core/test/kete/tool-env.test.ts`: 11 tests.
  - `core/test/kete/tool-env-shell.test.ts`: 3 tests. They fail without the shell edits.
  - `cli/test/kete/job-project-config.test.ts`: 11 tests.
  - `cli/test/kete/job-run.test.ts`: 6 new tests.

## Decisions taken beyond the brief
- The project-config check walks up to the repository root, not the filesystem root. Directories
  above the repository belong to the machine owner.
- The guarded keys also cover plugins, `.kete/plugin(s)/`, `enterprise`/sharing, `kete.platform`
  (gateway pricing and balance calls) and `kete.unattended` (so a repository can't widen
  `passEnv`).
- The always-on filter applies to every `Shell.create`, including a user's `!` commands.
- The PTY and the persistent-PTY daemon are left as they are: they are user terminals.
  LSP servers, formatters and stdio MCP servers are started by the runtime, not commanded by the
  agent; this is documented.

## Residual risks (documented)
- An unattended session that another client creates through the API isn't covered by B1. Only
  `kete job run` creates such sessions today.
- Not covered:
  - secrets in files an allowed command can read;
  - `{file:}`/`{env:}` in settings that aren't guarded;
  - project `formatter`/`lsp`/`commands` settings.

## Checks
| Check | Result |
|---|---|
| core `bun run test ./test/kete` | PASS 410, 11 skip, 0 fail |
| core `tool-shell`, `shell`, `shell-retention`, `session-shell` tests | 97 pass, 6 fail; the same 6 fail on main (process-substitution and compound-syntax approval cases in `tool-shell.test.ts`) |
| cli `bun test ./test/kete` | PASS 275, 1 skip, 0 fail |
| util `bun test ./test/kete` | PASS 267, 14 skip, 0 fail |
| server `bun run test ./test/kete/job-run.test.ts` (end to end, real inspector) | PASS 8/8 |
| kete-harness-plugin `bun run test` | PASS 60, 1 skip, 0 fail |
| typecheck util, schema, core, cli, server | PASS |
| protocol + client `generate`, then `check:generated` (both) | PASS |
| root `bun run lint` | PASS (0 warnings, 0 errors) |
| `upstream:check` | PASS |
| `stale-cards.mjs` / `card-check.mjs` | all current / clean |

`bun run --cwd packages/kete-tools verify --base main`:

| Package | Typecheck | Tests (HEAD) | Tests (main) | New failures |
|---|---|---|---|---|
| util | ok | 317 pass / 0 fail | 317 / 0 | 0 |
| server | ok | 98 / 0 | 98 / 0 | 0 |
| core | ok | 5868 / 30 | 5854 / 30 | 0 |
| tui | ok | 1407 / 0 | 1407 / 0 | 0 |
| cli | ok | 567 / 0 | 550 / 0 | 0 |
