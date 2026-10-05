# Spec: Unattended secret hygiene (tool environment, project config trust)

- Task: `2026-10-05-unattended-secret-hygiene` · Size: medium · Created: 2026-10-05
- Status: agreed <!-- user pre-approved the recommended decisions below (2026-10-05) -->

## Goal
Close two gaps the Harness step's security review found (2026-10-05): (A) shell commands the agent
runs inherit every secret in the runtime's environment, and (B) in `kete job run` a repository's
own config can redirect providers, add MCP servers or load plugins. Interactive use keeps working
as before, minus Kete's own credentials in agent shells.

## Decisions (recommended, pre-approved)
- **A1. Tool environment.** A Kete module, `packages/core/src/kete/tool-env.ts`, computes the
  environment of a subprocess the agent's shell tool starts:
  - **Always** removed: Kete's own credentials — any `KETE_*` or `OPENCODE_*` name (the env bridge
    maps one to the other) ending in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`
    (`OPENCODE_GATEWAY_KEY`, `OPENCODE_API_KEY`, `OPENCODE_PASSWORD`, `OPENCODE_SERVER_PASSWORD`,
    `OPENCODE_SSH_ASKPASS_TOKEN`, …) plus `KeteJobSecrets.environmentSecrets`. Not removed:
    non-secret names that merely contain those words (`OPENCODE_JOB_MAX_OUTPUT_TOKENS`,
    `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, `*_KEY_FD`).
  - **Unattended runs only** (session family carries `kete.unattended`, ADR 0008, or job mode):
    also removed are provider and generic credentials — names ending in `_API_KEY`, `_APIKEY`,
    `_KEY`, `_TOKEN`, `_SECRET`, `_SECRET_KEY`, `_PASSWORD`, `_PASSWD`, `_PAT`, `_CREDENTIALS`,
    `_PRIVATE_KEY`, `_ACCESS_KEY`, bare `TOKEN`/`API_KEY`/`PASSWORD`/`SECRET`, plus explicit names
    the provider plugins read that don't follow the pattern (`AWS_ACCESS_KEY_ID`,
    `AWS_BEARER_TOKEN_BEDROCK`, `AWS_SESSION_TOKEN`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`,
    `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN`,
    `AWS_WEB_IDENTITY_TOKEN_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`). A test derives the list
    from the bundled models.dev snapshot: every provider `env` name that is a credential must be
    removed (non-secret names such as regions, project IDs and hosts are listed explicitly in the
    test and kept).
  - **Allowlist:** `kete.unattended.passEnv: ["NPM_TOKEN", …]` (config) keeps named variables in
    unattended runs. It never re-admits Kete's own credentials. Matching is exact on POSIX and
    case-insensitive on Windows; pattern matching is case-insensitive everywhere.
  - **Interactive sessions** keep the user's environment (they approve each command), minus Kete's
    own credentials.
  - **Wiring:** a marked edit in `core/src/shell.ts` (`create`) applies the always-removed set to
    every shell; a marked edit in `core/src/tool/plugin/shell.ts` (the shell tool's `before`
    callback, which has the session) applies the unattended set. The PTY (`core/src/pty.ts`) and
    the persistent-PTY daemon are user terminals, not agent-commanded; LSP servers, formatters and
    stdio MCP servers are started by the runtime from config, not by the agent — all noted, not
    changed. Job mode's tool runner keeps its own allowlist on top.
- **B1. Project config trust in `kete job run`.** Before the run contacts the server (so no
  project MCP server or plugin is loaded), `kete job run` reads the project config the runtime
  would load — `kete.json`/`kete.jsonc` and `.kete/kete.json(c)` in every directory from the run's
  directory up to the repository root (only the run's directory outside a repository; above the
  repository is the machine owner's, not the repository's), and `.kete/plugin(s)/` — and refuses
  (outcome `refused`, exit 2) when it sets any of: `providers`/`provider` (any entry: baseURL,
  apiKey, headers, options), `mcp` (any server), `plugins`/`plugin`, a `.kete/plugin(s)/` code
  directory, `enterprise`, `share`/`autoshare` other than `disabled`/`false`, `kete.integrations`,
  `kete.platform`, or `kete.unattended` (so a repository can't widen `passEnv`). An unparseable file
  also refuses. The message names each file and key. `--trust-project-config` or
  `KETE_TRUST_PROJECT_CONFIG=1` skips the check. The check runs again on the job's worktree before
  the session is created (the worktree is built from the last commit, which can differ from the
  working tree). Global/user config (`~/.config/kete/`, `KETE_CONFIG`, `KETE_CONFIG_CONTENT`) is
  unaffected; synced org policy still applies on top. Job mode skips the check: its server never
  loads project config (`Config.configured({project: false})`).

## Scope
- New: `core/src/kete/tool-env.ts`, `cli/src/kete/job-project-config.ts`; schema
  `ConfigKete.Unattended` (`kete.unattended.passEnv`) + protocol/client regenerate.
- Marked upstream edits: `core/src/shell.ts`, `core/src/tool/plugin/shell.ts`.
- Kete-owned edits: `cli/src/kete/job-run.ts`, `job.ts`, `commands.ts`.
- Modules: `unattended`, `job-mode`, `permissions`, `config-kete`, `cli`, `harness-plugin` cards.
- Docs: `docs/jobs.md` (unattended runs), `docs/local-models.md` note, harness plugin README
  residual risks, `docs/upstream-patches.md`.

## Out of scope
- A runtime-side (core) check of project config for unattended sessions created by other clients
  through the API (only `kete job run` creates them today) — residual, documented.
- Secrets in files the command can read (`~/.aws/credentials`, key files) and `{file:…}`/`{env:…}`
  substitution in non-guarded project config fields (e.g. `instructions`) — residual, documented.
- Project-config `formatter`/`lsp`/`commands` that run commands — repository code the run may
  already execute through allowed build commands; documented.

## Acceptance criteria
- [ ] AC1: in an unattended session, an allowed `printenv`-style command shows neither provider
  keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`) nor Kete keys
  (`OPENCODE_GATEWAY_KEY`), but non-secret variables survive.
- [ ] AC2: in an interactive session, provider keys are visible, `OPENCODE_GATEWAY_KEY` and
  `OPENCODE_SERVER_PASSWORD` are not.
- [ ] AC3: `kete.unattended.passEnv` keeps a named variable in an unattended run; it can't re-admit
  a Kete credential.
- [ ] AC4: Windows: keys compared case-insensitively (`Anthropic_Api_Key` removed, `passEnv` matches
  any case) — unit tests with `platform: "win32"`.
- [ ] AC5: every credential name in the bundled models.dev snapshot is removed in unattended mode.
- [ ] AC6: `kete job run` refuses when project config sets a guarded key, naming file and keys, and
  before any server call; `--trust-project-config` / `KETE_TRUST_PROJECT_CONFIG=1` allow it; config
  above the repository root, and non-guarded keys, don't refuse; the worktree is re-checked and
  cleaned up on refusal.
- [ ] AC7: docs and cards updated; upstream edits marked and recorded.

## Risks and constraints
- Security: fail closed (unparseable config refuses; Kete credentials never re-admitted).
- Compatibility: builds in unattended runs that need a token lose it until listed in `passEnv`
  (documented). Interactive behaviour changes only for Kete's own credentials.
- Schema: new optional `kete.unattended` config field (additive) → protocol/client regenerate.
- Upstream: two marked edits, recorded in `docs/upstream-patches.md`.
