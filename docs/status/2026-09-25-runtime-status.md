# Kete Code runtime status: 2026-09-25

This was a read-only audit of `kete-org/ketecode` `main` at `4a3a5cfe94`. It ran in a
detached worktree, and nothing in the repository was changed.

Two open PRs would change some results. They are **not** counted as done here:
- #18: VS Code chat panel and extension settings
- #19: web UI rebrand

Legend: ✅ proven · ⚠️ works, with a gap · ❌ missing · ❓ not provable from the repo

## Summary

| # | Item | Status | Evidence | Action needed |
|---|---|---|---|---|
| 1 | Upstream pin and remote | ✅ | `.opencode-version` = `v2.0.16`. `git remote -v`: `upstream https://github.com/anomalyco/opencode.git (fetch)` and `upstream no_push (push)` | None |
| 2 | Distance from upstream | ✅ | `v2.0.16` is an ancestor of `main`; `main` is 48 commits ahead (25 non-merge). After `git fetch upstream --tags`, the newest release tag is still `v2.0.16` | None; sync when a release lands |
| 3 | `kete_change` marker check | ⚠️ | `bun packages/kete-tools/src/check.ts` → `upstream checks passed` (136 upstream files differ, 124 checked line by line). No unmarked edits. **It isn't run by any workflow**: `kete-build.yml` only lints, typechecks and builds | Add `upstream:check` to `kete-build` (seconds, no secrets) |
| 4 | `docs/upstream-patches.md` consistency | ✅ | All 76 changed upstream non-test files are listed, by path or by glob (e.g. `tui/src/mini/*`, `tui/src/util/*`). The 60 test files are covered by the "Upstream test edits" section | None |
| 5 | NOTICE and LICENSE | ✅ | `LICENSE` is identical to upstream (`git diff v2.0.16 HEAD -- LICENSE` is empty; "Copyright (c) 2025 opencode"). `NOTICE` credits OpenCode, its URL, MIT licence and copyright | None |
| 6 | CLAUDE.md §8 commands | ⚠️ | `bun run lint` → 0 warnings, 0 errors. `bun turbo typecheck` → 37/37 tasks pass. `verify --base v2.0.16` → typecheck OK in util, server, core, tui and cli, with **0 new test failures**. Test counts: util 60/0, server 59/0, core 5488/30, tui 1387/0, cli 306/0. The 30 core failures also fail on `v2.0.16`: 23 ripgrep (search tools, `Ripgrep`) and 7 shell syntax (`ShellTool`), all machine-dependent. Every referenced script exists | Add the missing SDK regeneration command to §8 (`bun run generate` in `packages/protocol`, then `packages/client`). §12 lists "lint" for `kete-vscode`, which has no lint script (root `oxlint` covers it) |
| 7 | CI workflows | ✅ | Active: `kete-build.yml` (PRs and pushes to `main`) and `kete-release.yml` (`kete-v*` tags, manual). 27 upstream workflows are `disabled_manually`. The last upstream run was at 2026-09-24T17:54Z, before the first `kete-build` run (20:43Z); none has run since | None |
| 8 | Branding | ⚠️ | `Brand`: `cliName="kete"`, `appDirectory="kete"`, `projectDirectory=".kete"`, `configFiles=["kete.json","kete.jsonc"]`, `envPrefix="KETE_"`. Installed 0.1.0: `kete v0.1.0`; `debug paths` shows `~/.config/kete` and `~/.local/share/kete`; `OPENCODE_LOG_LEVEL` is ignored. Tests: `cli/test/kete/cli.test.ts` ("ignores OPENCODE_CONFIG_DIR", "--help … never OpenCode"), `core/test/kete/config-discovery.test.ts`, `util/test/kete/env.test.ts` (8 tests). No `.opencode` / `opencode.json` config fallback | **Still visible**, see the list after this table: the OAuth callback page, the default theme name, and the web UI on `main`. Provider attribution headers are a policy decision |
| 9 | Self-update | ✅ | `cli/src/index.ts:116` provides `UpdaterDisabled`; `upgrade` and `uninstall` map to `kete/*-disabled`; `Brand.updatesAvailable = false`. `cli/test/kete/updater-disabled.test.ts` has 3 tests. The upstream updater code and TUI update dialog still exist but aren't reachable | Replace with a verified Kete update channel later |
| 10 | Hosted services | ✅ | **Sharing:** none in V2 (only an unused `share_url` column; `autoshare` is migrated). **Zen:** off by default (`core/src/kete/hosted.ts` `anonymousOpencodeZen = false`, `core/test/kete/hosted.test.ts`, ADR 0003). **Go:** only by opt-in (TUI no longer promotes it; the web UI still does on `main`, fixed in #19). **Telemetry:** no analytics SDK in the engine; OTLP only when configured; web-UI Sentry only when `VITE_SENTRY_DSN` is set at build (`app/src/entry.tsx:52`), which Kete's release doesn't set. **`$schema`:** `Brand.urls.configSchema` is `undefined`, so none is written | Web-UI Go/Zen promotion: merge #19 |
| 11 | Providers | ✅ | **BYOK:** built-in providers via `kete auth login` or environment keys (upstream). **Local:** Ollama (`core/src/plugin/provider/ollama.ts`, `test/plugin/provider-ollama.test.ts`), LM Studio, and any OpenAI-compatible endpoint via `providers.<id>.settings.baseURL`. **Gateway:** the Kete-owned `kete` provider (`core/src/kete/gateway.ts`, ADR 0004, 10 tests in `core/test/kete/gateway.test.ts`), configured with `providers.kete.settings.baseURL` or `KETE_GATEWAY_URL`, and a key from `kete auth login`, `providers.kete.settings.apiKey` or `KETE_GATEWAY_KEY`. It discovers each route's allowlist and uses the native per-provider routes; built-in providers are not overridden | None |
| 12 | `kete login` | ❌ | No `login` command (`kete --help` subcommands: upgrade, uninstall, acp, api, debug, auth, mcp, plugin, models, stats, mini, run, session, service, reload, pair, serve). No PKCE against the platform, no `/api/v1/cli/token` or `/cli/authorize` client, no keychain use (`git grep` across the engine packages finds only the GitLab and OpenAI provider OAuth). Credentials are stored as JSON in SQLite (`core/src/credential/sql.ts`, `credential.value`); the gateway key sits in a `{file:}` file. No platform logout | Build milestone 2 (below) |
| 13 | `/api/v1/me`, `/api/v1/models` | ⚠️ | Only in `core/src/kete/gateway.ts`: `:221` (models, prices) and `:254` (me, balance published as `kete` integration metadata, shown in the TUI sidebar by `tui/src/kete/balance.tsx`). Both need a hand-configured platform URL and key. Without them no calls are made ("publishes no balance without a platform URL", `gateway.test.ts`); with an invalid key, the last known values are kept and a warning is logged | Feed both from `kete login` once it exists |
| 14 | Extension bundles `kete` and uses `kete serve` via the SDK | ❌ | `packages/kete-vscode/src/extension.ts` on `main` opens a terminal and runs `kete` from `PATH` (`sendText`). No bundled binary, no `serve`, no SDK client. #18 adds a chat that frames the CLI's web UI (still no bundled binary or SDK) | Implement per CLAUDE.md §6 |
| 15 | Login state, chat, edits, diff review | ❌ | On `main`: three commands (`kete.openTerminal`, `kete.openNewTerminal`, `kete.addFilepathToTerminal`) and 5 unit tests (file-reference formatting). #18 adds a chat panel (upstream's web UI, which has diff review) and gateway settings; it was verified in a real VS Code instance but isn't merged | Merge #18 and #19, then decide whether an iframed web UI meets milestone 3 or a native chat is required |
| 16 | Packaging and publishing | ⚠️ | ID `ketecode.kete-code`, version `0.0.1`, `engines.vscode ^1.94.0`, public APIs only (terminal, commands). A `.vsix` is built by `kete-release` (`kete-code-0.1.0.vsix` is on the **draft** release `kete-v0.1.0`). **Not published**: `vsce show ketecode.kete-code` → "not found"; Open VSX API → "Extension not found". No publish config or tokens. Fork compatibility isn't tested (❓) | Create the `ketecode` publisher and Open VSX namespace; add a publish step; test in Cursor/VSCodium |
| 17 | Cross-platform | ⚠️ | CI and releases run on `ubuntu-latest` only (`kete-build.yml:27`, `kete-release.yml:28`). The release cross-compiles 12 targets but smoke-tests only `linux-x64`. The only Windows-specific Kete test is `util/test/kete/env.test.ts` ("treats OPENCODE_* case-insensitively (Windows environment names)"). Manual macOS arm64 runs (`kete v0.1.0`, VS Code e2e) are evidence from this session, not from the repo (❓). Upstream's Windows unit job (`test.yml`) is disabled | Add a macOS and a Windows smoke job to `kete-release` (run the binary, `--version`, `debug paths`), which is cheap and only runs on tags |
| 18 | Agent discovery and extension point | ✅ | Built-ins come from `core/src/plugin/agent.ts` (`opencode.agent` plugin). Config agents come from `core/src/config/plugin/agent.ts`: config `agents`, plus `{agent,agents}/**/*.md` and `{mode,modes}/*.md` files in config directories. Any plugin can add or modify agents with `ctx.agent.transform` (`plugin/src/effect/agent.ts`: `list/get/update/remove`); `core/src/kete/budget-rule.ts` already does this without upstream edits (one registration line in `plugin/internal.ts`). External plugins can also be declared in config (`plugins`, `schema/src/config.ts:100`) | None: a Kete-owned plugin can load platform agents |
| 19 | Provider request headers | ✅ | Requests are built in `core/src/session/model-request.ts` (`LLM.request`, headers at ~`:240-248`). Custom headers: `providers.<id>.headers` and per-model or variant `headers` in config (`schema/src/config/provider.ts:32,38,43`), and plugin hooks `session` `model.request` / `http.request` (`plugin/src/effect/session.ts:144-145`), as used by `plugin/provider/github-copilot.ts` | None. Note that every request also sends `x-opencode-project`, `x-opencode-session` and `x-opencode-client` |

### Item 8: remaining user-visible or outward OpenCode identity on `main`

User-visible:
- **Web UI** (`packages/app`: title, wordmark, about 70 strings, Go/Zen promotion). Fixed in **#19**, not merged.
- **OAuth callback page:** `core/src/oauth/page.ts:266` renders OpenCode's wordmark (`aria-label="OpenCode"`) in the browser after a provider or MCP OAuth sign-in.
- **Default TUI theme** is named `opencode` (`tui/src/theme/index.ts:29,38`), which shows in the theme picker.

Not visible, sent outward:
- **Provider attribution headers** credit OpenCode:
  - `HTTP-Referer: https://opencode.ai/` / `X-Title: opencode`: `openrouter.ts`, `vercel.ts`, `kilo.ts`, `llmgateway.ts`, `nvidia.ts` (plus `X-BILLING-INVOKE-ORIGIN: OpenCode`), `zenmux.ts`.
  - `X-Cerebras-3rd-Party-Integration: opencode`: `cerebras.ts`.
  - `originator: "opencode"`: `openai.ts:265,399`, likely required by the ChatGPT-subscription OAuth flow; changing it needs testing.
- **Session headers** on every request: `x-opencode-*` (`model-request.ts:246-248`).

Unreachable or inaccurate but harmless:
- **Upstream updater and upgrade/uninstall handlers**, and the TUI update dialog: replaced or hidden.
- **`cli/src/services/retained-image.ts:63`:** matches upstream's Windows install path `~/.opencode/bin/opencode.exe`.

## Verdicts

- **Milestone 1 (working core): complete, with gaps.**
  - Done: the fork is healthy (pin, remote, markers, patches doc, licence). Lint, typecheck and tests show no regressions against upstream. Branding, disabled updates, opt-in hosted services and the three provider paths (BYOK, local, gateway) are all proven.
  - Gaps: the marker check doesn't run in CI; there's visible OpenCode branding in the OAuth page and the web UI (#19); the attribution headers are a policy decision; and there's no Windows/macOS evidence in CI.
- **Milestone 2 (self-serve): incomplete.**
  - Missing: `kete login` (PKCE, localhost callback, `/api/v1/cli/token`), keychain storage, and logout.
  - Present: platform `/me` and `/models` are used for balance and prices, but only with a hand-configured URL and key.
- **Milestone 3 (VS Code extension): incomplete.**
  - On `main` it's a terminal launcher. There's no bundled binary, `kete serve`, SDK connection, login state, chat or diff review, and nothing is published.
  - #18 adds a working chat (the web UI in a webview) and gateway settings. It's unmerged, and its architecture differs from CLAUDE.md §6 (bundled binary plus `kete serve`, with the SDK).

## Blockers for milestone 4 (platform-managed agents)

1. **Phase order:** CLAUDE.md §7 says not to start a later phase while an earlier one is unreliable, and milestones 2 and 3 are incomplete.
2. **No platform identity in the runtime:** platform-managed agents need the runtime to know which user and organisation it belongs to. That's `kete login` plus stored credentials (milestone 2). Today the only link is a hand-configured gateway key.
3. **No agent endpoint on the platform:** `kete-code-platform` `docs/platform-api.md` §3 lists agent and skill registries and config sync as "Not in v1". A `feature/registries` branch exists there, but the runtime has no contract to consume yet.
4. **Not blockers:**
   - The runtime extension point already exists: a Kete-owned plugin can add agents with `ctx.agent.transform` (item 18).
   - Headers for gateway or platform auth can be added through config or hooks (item 19).

## Prioritised gaps

1. **Milestone 2 `kete login`:**
   - PKCE browser flow with a localhost callback, and `/api/v1/cli/token` exchange.
   - Store the key in the OS keychain (Keychain, Credential Manager, Secret Service), not plaintext.
   - Configure the gateway and platform URLs from the response (`gateway_url`).
   - `kete logout` calling `/api/v1/cli/logout`.
2. **Milestone 3 decision and merge:** merge #19 (web UI rebrand) and #18 (chat and settings). Decide whether the iframed web UI meets milestone 3; if not, bundle `kete` and connect through the SDK per §6. Then add login state from item 1.
3. **Publish the extension:** Marketplace publisher `ketecode` and Open VSX namespace, a publish step in `kete-release`, and a check in one VS Code fork. Publish the `kete-v0.1.0` release, which is still a draft.
4. **Run the marker check in CI:** add `bun run --cwd packages/kete-tools upstream:check` to `kete-build.yml`.
5. **Remaining branding:** the OAuth callback page wordmark (`core/src/oauth/page.ts`) and the default theme name `opencode`.
6. **Cross-platform evidence:** macOS and Windows smoke jobs in `kete-release` (`--version`, `debug paths`), which are cheap and run on tags only.
7. **Attribution headers:** decide whether Kete traffic should identify as Kete Code to OpenRouter, Vercel, Kilo, LLM Gateway, NVIDIA, ZenMux and Cerebras. Keep `originator` for OpenAI OAuth unless it's proven safe to change.
8. **CLAUDE.md §8:** add the SDK regeneration commands, and fix the `kete-vscode` "lint" check in §12.

## How this was produced

- **Worktree:** `origin/main` at `4a3a5cfe94`, detached, with `bun install --frozen-lockfile`.
- **Commands:**
  - `git fetch upstream --tags`
  - `bun packages/kete-tools/src/check.ts`
  - `bun run lint`
  - `bun turbo typecheck`
  - `bun run --cwd packages/kete-tools verify --base v2.0.16` (typecheck plus tests on `main` and on `v2.0.16`)
  - `gh workflow list --all` and `gh run list`
  - `vsce show` and the Open VSX API
  - read-only `git grep` across the engine packages
- **Binary checks:** used the installed release `kete v0.1.0` with a throwaway `HOME`.
