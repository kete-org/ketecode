# CLAUDE.md — kete-code

Kete Code is an AI coding agent that is growing into an AI engineering platform.
This repo is the **execution plane**: the agent runtime, the `kete` CLI, the SDK, and
the editor extensions. The **control plane** (portal, platform API, model gateway,
billing, database) lives in the separate `kete-code-platform` repo.

The runtime is a fork of [OpenCode](https://github.com/anomalyco/opencode) (MIT).
Staying able to merge future OpenCode releases is a strategic requirement.
**Use OpenCode as the foundation, not as the boundary of Kete Code.**

**Start with `docs/context/INDEX.md`** (knowledge base: module cards, commands, contracts,
pitfalls) before exploring code, and delegate lookups to the `scout` agent. Medium and large
tasks use `/task-new`, `/task-plan`, `/task-build`, `/task-review`, `/task-close`
(task folders in `docs/tasks/`); small ones don't need a folder.

Full architecture, reasoning, and future direction: `docs/architecture.md`. Read the
relevant sections before architectural or cross-cutting changes. Items there marked
"eventually" or "future" are direction, not current tasks. ADRs live in `docs/adr/`;
don't reverse an accepted ADR — write a superseding one.

`AGENTS.md` is upstream OpenCode's and is loaded as well. Where the two conflict, this
file wins: the default branch and PR target is `main`, not `v2`, and branch names follow
Git hygiene in §12 (`feature/*`, `fix/*`, …). Leave `AGENTS.md` unchanged so upstream
syncs don't conflict on it.

---

## 1. Which repo does this belong in?

Ask: **does this execute engineering work, or centrally manage the Kete platform?**

| Belongs in `kete-code` | Belongs in `kete-code-platform` |
|---|---|
| file editing, terminal, git | portal, organizations, teams, RBAC |
| agent, skill, and workflow execution | skills marketplace, MCP registry |
| MCP client, model-provider clients | model gateway, central model credentials |
| Kete Gateway client, local models | usage accounting, budgets, billing, plans |
| login, registration, config-sync clients | authentication backend, audit logs, admin |
| VS Code / JetBrains extensions, sandbox | cloud orchestration control plane |

Never implement control-plane responsibilities here.

---

## 2. Repository layout

Follow upstream OpenCode's layout. **Never rename, move, or restructure upstream
packages** — that turns every upstream merge into conflicts.

Upstream v2 splits the engine across several packages (all `@opencode/*`):

- `packages/cli/` — CLI entry point and commands; builds the `kete` binary
  (`script/build.ts`).
- `packages/core/` — agent loop, tools, sessions, providers, permissions, config.
- `packages/server/` — HTTP server. `packages/tui/` — terminal UI.
- `packages/util/` — shared utilities (global paths, logging). No internal deps.
- `packages/<pkg>/src/kete/` — Kete-owned code inside an upstream package. New engine
  features go here. Product identity lives in `packages/util/src/kete/brand.ts`
  (import `@opencode/util/kete/brand`); never hard-code "opencode"/"kete" names.
- `packages/sdk/` — generated SDK. Never hand-edit generated files.
- `packages/kete-vscode/` — VS Code extension.
- `packages/kete-*` — other Kete-owned packages.
- `packages/kete-tools/` — upstream sync tooling, upstream-hygiene checks, and local
  verification (see `docs/upstream-sync.md`).

Tooling is **Bun + Turborepo**, inherited from upstream. Do not switch package managers.

---

## 3. Architecture rules

- **One runtime, thin clients.** CLI/TUI, VS Code, and JetBrains are all clients of a
  local `kete serve` process over HTTP + SSE via the SDK. Never build agent logic into
  an extension.
- **Runtime → Platform API, never → database.** The runtime talks to
  `kete-code-platform` only through its versioned API (`/api/v1/...`). Never connect
  the runtime to Supabase or any platform database.
- **Model access has two modes, both required:** direct (BYOK, local models via Ollama,
  vLLM, or any OpenAI-compatible endpoint) and gateway (Kete Model Gateway, through the
  `kete` provider on the gateway's native per-provider routes; ADR 0004). Never make the gateway or portal a hard dependency
  for local use. The runtime holds only a gateway *client*.
- **No provider assumptions.** Never write `if model == "claude"` in business logic —
  use provider and model capabilities. Provider-specific logic stays in adapters.
- **Execution location is explicit.** Local is the only mode today, but don't assume it:

  ```ts
  type RuntimeType = "local" | "kete_cloud" | "enterprise_private";
  ```

- **Platform independent.** Runtime core never depends on Vercel, Cloudflare, Supabase,
  AWS, Azure, or GCP. Integrations go through adapters.
- **Don't over-engineer future abstractions** (sandboxes, multi-agent, workflows).
  Leave clean seams; build them when a task requires them.

---

## 4. Upstream-first rule (critical)

OpenCode already has an agent loop, sessions, tools, providers, MCP, permissions, and
config. **Before creating any new engine, manager, or config system, find the upstream
equivalent and extend it.** The component names in `docs/architecture.md` §18 are
conceptual, not a build list.

When behavior must change, prefer in order:

1. configuration
2. upstream plugins, extension points, and event hooks
3. Kete-owned modules, adapters, and wrappers in `src/kete/` or `packages/kete-*`
4. dependency injection at an existing seam
5. **only then** a minimal edit to the upstream file

**Every edit to an upstream file carries a `kete_change` marker:**

```ts
const x = 1 // kete_change

// kete_change start
...
// kete_change end
```

Paths with `kete` in the name need no markers. Never reformat or refactor upstream code
you aren't changing. Follow upstream conventions inside upstream-derived areas. Record
non-obvious persistent patches in `docs/upstream-patches.md`.

**Upstream sync:** pin in `.opencode-version`; sync on an `upstream/vX.Y.Z` branch, never
directly on `main`; build, run upstream tests, run Kete tests, open a PR. Never copy
individual OpenCode files by hand. Keep sync PRs separate from feature work. Use
`bun run --cwd packages/kete-tools upstream:sync vX.Y.Z --verify`; the runbook is
`docs/upstream-sync.md`.

**Licensing:** never remove OpenCode's copyright notices, license files, or attribution,
and don't obscure the project's ancestry.

---

## 5. Branding and configuration

- Binary `kete`; npm scope `@ketecode`; extension ID `ketecode.kete-code`.
- Config: global `~/.config/kete/`, project `./.kete/`. No fallback to `.opencode`.
- User-facing text says "Kete Code" or `kete`, never "OpenCode" or "Kilo". Inherited
  internal identifiers stay as they are.
- Precedence: platform policy → organization → project → user → workspace. For
  security policy, the more restrictive setting wins.
- Never hard-code endpoints, credentials, org IDs, model names, or deployment URLs.
  Use typed configuration. Local development never needs production credentials.

---

## 6. Editor integrations

- **VS Code extension:** bundles the CLI binary and spawns `kete serve`. Published to
  both the **VS Code Marketplace** and **Open VSX**, so it must work in VS Code forks
  (Cursor, Windsurf, VSCodium). Use only public extension APIs.
- **JetBrains:** later, same client model. Both must behave consistently.

---

## 7. Current milestone and build order

The first milestone is a reliable local loop:

```text
$ kete
> Build a Next.js customer management application using Supabase.
```

Kete inspects the workspace, plans, branches when appropriate, edits files, installs
dependencies with permission, runs commands, builds, tests, diagnoses and fixes
failures, re-runs tests, reviews the diff, and summarizes honestly.

Order (details in `docs/architecture.md` §102):

1. OpenCode foundation: build and test upstream unchanged, branding, sync process
2. Runtime MVP: CLI, files, terminal, git, models (BYOK, local, gateway), MCP, skills
3. VS Code extension: chat, editing, sessions, diff review, publish to both marketplaces
4. Platform integration: `kete login`, runtime registration, config/agent/skill sync, policies
5. Advanced agents → 6. multi-agent and worktrees → 7. cloud runtime → 8. enterprise runtime

Do not start a later phase while an earlier one is unreliable.

---

## 8. Build and dev

> These follow upstream conventions. Verify against `package.json` after each upstream
> merge and update this section if they change.

- Toolchain: Bun (version pinned in root `package.json` `packageManager`), then `bun install`
- Dev (CLI): `bun run dev` from the repo root
- Typecheck: `bun turbo typecheck` (all), or `bun run typecheck` inside one package
  · Lint: `bun run lint`
- Tests: `bun run test` inside each package (`packages/{util,core,server,tui,cli}`) —
  never from the root. `core`'s and `server`'s scripts isolate HOME/XDG (the runtime reads the
  developer's Kete account otherwise); don't bypass them with bare `bun test` there. Web UI: `bun run test:unit` in `packages/app/` (sets the required
  `--conditions=solid --preload ./happydom.ts`).
- Single test: `bun run test ./test/path/to/file.test.ts` inside `packages/core/`;
  `bun test ./test/path/to/file.test.ts` in the other packages
- Kete tests live in `packages/<pkg>/test/kete/`
- Before opening a PR: `bun run --cwd packages/kete-tools verify --base main` (typecheck
  + tests, reporting only failures that `main` does not have) and
  `bun run --cwd packages/kete-tools upstream:check`.
- CI (`.github/workflows/kete-build.yml`, PRs and pushes to `main`) stays within GitHub's free
  minutes: lint, typecheck and a binary build; `upstream:check`; and every Kete-owned test
  (`packages/*/test/kete`, `packages/kete-tools/test`, `packages/kete-vscode/test`,
  `packages/app/src/kete`). The engine packages' full suites run locally (`verify`, above),
  not in CI. Releases (`kete-release.yml`) smoke-test the Linux binary before publishing;
  manual runs can add macOS and Windows (`all_platforms`). Every inherited upstream
  workflow stays disabled.
- Build the binary (current platform, no web UI): `bun run build --single --skip-install
  --skip-web-ui` in `packages/cli/` → `dist/cli-<os>-<arch>/bin/kete`. Without
  `--skip-install` the script runs `bun install` for every platform's native packages.
- Release: tag `kete-vX.Y.Z` (bare `vX.Y.Z` tags are upstream OpenCode's); CI publishes the
  GitHub Release and, for stable versions, the extension to the VS Code Marketplace and Open VSX
  (`docs/release.md`). Only a maintainer tags a release. Never push upstream's tags to `origin`. Never run
  upstream's `packages/cli/script/publish*.ts` or enable `publish.yml`: they publish to
  OpenCode's npm packages, Homebrew tap and image registry.
- After changing server endpoints (`packages/server/src/`), the protocol, or schema types they
  expose (e.g. the config schema): `bun run generate` in `packages/protocol` (writes
  `openapi.json`), then `bun run generate` in `packages/client` (writes
  `src/*/generated/`). Commit both; never hand-edit generated files.
- Extension (`packages/kete-vscode/`): `bun run build`, `bun run typecheck`, `bun run test`;
  lint is the root `bun run lint`

---

## 9. Security rules

**Never weaken authentication, authorization, permission checks, workspace
restrictions, secret handling, TLS verification, input validation, or sandboxing to
make a feature work.** Fix the design instead.

- **Permissions:** build on upstream's allow / ask / deny permission system. High-risk
  operations need explicit policy: deleting files, system files, `git push`, force push,
  `reset --hard`, package installs, Docker, migrations, production databases,
  infrastructure, deployment, credential access, external network requests.
- **Workspace boundary:** access to a workspace never implies access to `~/.ssh`,
  `~/Documents`, `~/Downloads`, or other repositories. Guard against path traversal.
- **Git:** agent work happens on feature branches. Never force-push or merge to
  protected branches without explicit authorization.
- **Secrets:** never expose secrets to a model unnecessarily. Treat `.env` and
  credential files specially; redact secrets from tool output before it goes to a model,
  and from logs, telemetry, and errors. Store long-lived credentials in OS-native
  storage (Keychain, Credential Manager, Secret Service), never plaintext config.
- **MCP servers and plugins** are trust boundaries. Being configured doesn't make them
  trusted; validate responses and scope their permissions.
- **Privacy:** code leaves the machine only as model context to the configured
  provider. Telemetry never contains source code, prompts, or secrets.
- **Updates:** `kete update` verifies artifact integrity. Never run unverified binaries.
- **Auth:** use standard protocols. Never invent cryptography.

---

## 10. Reliability and honesty

- **No hidden failures:** never swallow errors, skip failing tests, disable checks,
  return success after failure, or ignore invalid configuration.
- **No fake implementations** — hard-coded success, fake API calls, mock auth, dummy
  persistence, silent fallbacks — outside tests or clearly labelled prototypes.
- **Report status truthfully:** distinguish planned, attempted, completed, failed, and
  requires-approval. Never claim an operation succeeded when it didn't.
- Network calls, tools, and subprocesses have timeouts, bounded retries, and support
  cancellation that propagates safely.
- Structured errors and logs with correlation IDs (`session_id`, `agent_run_id`,
  `tool_call_id`). No raw stack traces to users in production builds.
- No global mutable state. Assume multiple agents may run concurrently; protect files,
  git state, sessions, and caches (use worktrees or isolated workspaces).

---

## 11. Engineering constraints

- **Cross-platform:** macOS, Windows, and Linux. Use path utilities, never hardcoded
  separators or shell-specific syntax. Test paths, line endings, process spawning, and
  PTY behavior on Windows.
- **Constrained environments:** many users have slow or unreliable connections and
  modest hardware. Prefer streaming and resumable operations, small payloads, bounded
  session history and logs, and no heavy background work by default.
- **Context efficiency:** never send whole repositories to a model. Use search,
  indexing, relevant-file selection, summaries, and caching.
- **Offline:** with a local model and cached config, core coding works during platform
  outages — but offline mode never bypasses policy.
- **File edits:** prefer minimal diffs; don't rewrite whole files unnecessarily.

---

## 12. How to work on a task

1. Understand the requirement.
2. Inspect the relevant code. **Search before assuming something doesn't exist.**
3. Check whether OpenCode already provides it (§4).
4. Confirm it belongs in this repo (§1) and identify security implications (§9).
5. Design the smallest clean extension. No large unrequested refactors.
6. Implement, add or update tests, run the checks below.
7. Review your diff and report what changed, including any upstream edits.

**Checks before saying done:**

| Area | Checks |
|---|---|
| Engine / CLI | in each touched package (`packages/{util,core,server,tui,cli}`): `bun run typecheck`, `bun run test` or targeted tests |
| VS Code extension | from `packages/kete-vscode/`: `bun run typecheck`, `bun run test` (lint: root `bun run lint`) |
| Web UI | from `packages/app/`: `bun run typecheck`, `bun run test:unit` |
| Kete tooling | from `packages/kete-tools/`: `bun run typecheck`, `bun run test` |
| Cross-package | `bun run lint`, `bun turbo typecheck` |
| Upstream files touched | every edit has a `kete_change` marker: `bun run --cwd packages/kete-tools upstream:check` |
| API, protocol or schema changed | regenerated `packages/protocol/openapi.json` and `packages/client/src/*/generated/` (§8) |

If a check can't be run, say which and why. Done also means error handling, security,
docs, and backward compatibility were considered. Security-sensitive changes need tests
for workspace escape, path traversal, permission bypass, secret leakage, and token
handling as applicable.

**Code style:** strict TypeScript; no `any` or unsafe assertions without a documented
reason; discriminated unions; validate all external input (API and MCP responses,
config, model output, tool input, env vars). Small modules, explicit interfaces.

**Dependencies:** check upstream first; add only if maintained, secure, MIT-compatible,
cross-platform, and small. Never for trivial code.

**Contracts:** once released, CLI commands, config files, agent and skill formats,
plugin APIs, MCP config, SDK and runtime APIs are contracts. Semantic versioning;
breaking changes need a major version and a migration path. The runtime is versioned
independently of the platform.

**Git hygiene:** branches `feature/*`, `fix/*`, `chore/*`, `docs/*`, `upstream/*`, merged
by PR. Focused PRs — don't mix features, refactors, dependency upgrades, and formatting.
Conventional commit messages, e.g. `feat(runtime): add platform registration client`.
