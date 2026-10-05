# Repository map

Bun + Turborepo monorepo, upstream OpenCode's layout (never rename or move upstream packages,
CLAUDE.md §2). Kete-owned code is in bold. Module cards are in `modules/`.

## Engine packages (upstream, `@opencode/*`)

| Path | Holds | Kete code here | Card |
|---|---|---|---|
| `packages/core/` | agent loop, sessions, tools, providers, permissions, config, plugins, worktrees | **`src/kete/`**: gateway, sync, roles, skills, budget, permissions, subagents, worktrees, stale-write, workflows, attribution, hosted | most cards |
| `packages/core/src/plugin/internal.ts` | the built-in plugin list — where Kete plugins are registered (marked) | — | conventions.md |
| `packages/schema/` | config and protocol schemas | **`src/config/kete.ts`** (the `kete` config section) | config-kete |
| `packages/util/` | global paths, logging, process, fs | **`src/kete/`**: brand, env bridge, account, secret store, runtime registration, sync client/contract/cache | brand-env, account-login, sync, runtime-registration |
| `packages/cli/` | CLI entry point and commands; builds the `kete` binary | **`src/kete/`**: login/logout/whoami/sync, `job run` (job mode: cwd is the prepared worktree), env bridge import, verified updater (`kete upgrade`, ADR 0009) | cli, account-login, job-mode |
| `packages/server/` | HTTP server | **`src/kete/local-guard.ts`**, **`script/kete/isolated-test.ts`** | server-sdk |
| `packages/tui/` | terminal UI | **`src/kete/`**: balance, theme | gateway, ui-branding |
| `packages/protocol/`, `packages/client/`, `packages/sdk/` | HTTP API definition, generated `openapi.json` and clients | — (generated; never hand-edit) | server-sdk |
| `packages/plugin/` | plugin API types (Effect and Promise) | — | conventions.md |
| `packages/app/` | web UI (also framed in VS Code and JetBrains IDEs) | **`src/kete/`**: brand text, wordmark, editor bridge (`ide-host.ts`, `vscode-host.tsx`) | ui-branding, vscode-extension, jetbrains-plugin |
| `packages/ui/` | UI kit and themes | **`src/theme/kete/`** (violet default theme) | ui-branding |
| `packages/ai/`, `codemode/`, `session-ui/`, … | upstream libraries Kete doesn't change | — | — |
| `packages/console/`, `desktop/`, `stats/`, `web/`, `services/www/` | upstream products Kete doesn't ship | — | — |

## Kete packages

| Path | Holds | Card |
|---|---|---|
| **`packages/kete-vscode/`** | VS Code extension (`ketecode.kete-code`): bundled binary, own local server, chat, sessions, review, MCP view | vscode-extension |
| **`packages/kete-jetbrains/`** | JetBrains plugin (`ai.ketecode.kete-code`, Kotlin/Gradle, built in CI): bundled binary, own local server, JCEF chat, context, review, diagnostics tool | jetbrains-plugin |
| **`packages/kete-tools/`** | upstream sync, upstream:check, verify, release, role-check | kete-tools-ci |
| **`packages/kete-harness-plugin/`** | the Kete Code step for Harness pipelines: Plugin step image (`ghcr.io/kete-org/kete-harness-plugin`), its TypeScript entrypoint (Bun-compiled), `run`/`cloud` modes, fakes and tests, `scripts/build.sh`/`smoke.sh` | harness-plugin |
| **`packages/kete-root-helper/`** | Go module: the cloud-job root helper (second-user tool spawner, protocol v1) and its scripts/tests; Linux-only, not shipped in the CLI or VS Code binaries — ships in the (future) job container image | root-helper |
| **`packages/kete-egress/`** | Go module: the cloud-job egress proxy (`kete-egress serve`) and nftables ruleset generator (`kete-egress nft`), config/control/log v1 contract in its README; Linux-only, ships in the (future) job container image, not the CLI or VS Code binaries | egress |
| **`packages/kete-job-host/`** | Go module: the self-hosted job host agent (`kete-job-host enroll|run|doctor`), job-host-v1 client (signed requests, HPKE open), desired-state loop, deadline killer, `Driver` interface, the `firecracker` driver (jailer, host nftables table, image fetch + cosign verification, rootfs per digest), the guest kernel (`kernel/`), packaging (`packaging/`), KVM tests (`internal/kvmtest`), fake driver, fake platform and shared test vectors (`testdata/job-host-v1/`); Linux-only root service on Kete-operated hosts, not in the CLI, VS Code or job image; `dedicated` driver P5 | job-host |
| **`packages/kete-job-entrypoint/`** | Go module: the cloud job's root entrypoint (machine setup, firewall and proxy, helper, claim, clone, `kete job run`, report, safe bundle, uploads); machine-config/callbacks/bundle contract in its README; fake platform and fake `kete` for its integration suite; Linux-only, ships in the (future) job image | job-entrypoint |

## Other

| Path | Holds |
|---|---|
| `CLAUDE.md` | Kete rules (wins over upstream's `AGENTS.md`, which stays unchanged) |
| `docs/architecture.md`, `docs/adr/` | architecture and Kete ADRs 0001–0004 |
| `docs/platform/` | copies of platform contracts (login, sync) and requests to the platform |
| `docs/upstream-patches.md` | every persistent edit to an upstream file, by feature |
| `docs/upstream-sync.md`, `docs/release.md` | runbooks |
| `docs/context/`, `docs/tasks/` | this knowledge base; task folders and `metrics.md` |
| `.claude/` | agents, task skills, settings; `.kete/` holds the generated Kete copies |
| `scripts/agent/` | stale-cards, card-check, check-summary, task-new, kete-agents |
| **`.github/workflows/kete-build.yml`, `kete-release.yml`, `kete-root-helper.yml`, `kete-egress.yml`, `kete-job-entrypoint.yml`, `kete-job-host.yml`** | Kete CI and releases (every inherited upstream workflow stays disabled); `kete-root-helper.yml` is path-filtered to the Go root helper and its TypeScript client; `kete-egress.yml` to `packages/kete-egress/`; `kete-job-entrypoint.yml` to the entrypoint, helper and egress modules; `kete-job-host.yml` to `packages/kete-job-host/` |
| `.opencode-version` | the upstream release this fork is synced to |
