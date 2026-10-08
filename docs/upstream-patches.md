# Upstream patches

Persistent Kete Code edits to upstream OpenCode files. Every edit to an upstream
source file carries a `kete_change` marker (see CLAUDE.md §4). Files that cannot
hold comments (`.txt` prompts, `.json`) are listed here instead.

Upstream baseline: see `.opencode-version`.

To find every marked edit: `git grep -n kete_change -- packages`.

---

## Rebrand (feature/rebrand)

The product identity lives in one Kete-owned module,
`packages/util/src/kete/brand.ts` (imported as `@opencode/util/kete/brand`).
Upstream files read from it instead of hard-coding "opencode".

### Mechanisms (Kete-owned, no markers needed)

| File                                          | Purpose                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/util/src/kete/brand.ts`             | Names, directory names, config filenames, env prefix, URLs (`urls.*` are `undefined` TODOs until Kete Code has a domain) |
| `packages/util/src/kete/env.ts`               | `KETE_*` → internal `OPENCODE_*` environment bridge (rules in the file header)                                           |
| `packages/cli/src/kete/env-bridge.ts`         | Runs the bridge; first import of the CLI entry point                                                                     |
| `packages/cli/src/kete/updater.ts`            | `Updater` implementation (ADR 0009): public releases only, signed `SHA256SUMS` (pinned Ed25519 key) + archive checksum, no downgrade, atomic swap; package-manager installs are told to use their manager |
| `packages/cli/src/kete/release-verify.ts`, `update-keys.json` | Signature and `SHA256SUMS` verification; the pinned update keys (empty → updates unavailable)          |
| `packages/cli/src/kete/upgrade.ts`            | `upgrade`/`update` handler on top of the Kete updater                                                                    |
| `packages/cli/src/kete/uninstall-disabled.ts` | `uninstall` handler: deletes nothing, prints what to remove (Homebrew/npm commands or the binary path)                   |

**Env bridge.** Upstream reads about 55 `OPENCODE_*` variables directly from
`process.env` in about 22 files. Instead of patching each read, the CLI entry
point runs `KeteEnv.bridge(process.env)` before any other module is evaluated.
In a top-level process it drops every inherited `OPENCODE_*` variable, moves
each `KETE_X` to `OPENCODE_X`, and sets `KETE_ENV_BRIDGED=1`. Child processes
inherit the bridged values. Consequences for future merges:

- New upstream `OPENCODE_X` variables automatically become `KETE_X`. No patch is needed.
- `OPENCODE_*` names are internal plumbing only. User-facing text must name the
  `KETE_*` variable (`KeteEnv.publicName()`).
- A value the runtime hands to a child process must use the `KETE_` name if the
  parent might not be bridged. See `standalone.ts` below.
- Only the CLI entry point (`packages/cli/src/index.ts`) runs the bridge. Other
  hosts that embed `core`/`server` directly (e.g. `packages/desktop`) still read
  `OPENCODE_*` and are not rebranded yet.

### Upstream source edits

**Identity and paths**

| File                                                          | Change                                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `util/src/global.ts`                                          | XDG directory name `opencode` → `Brand.appDirectory` (`~/.config/kete`, `~/.local/share/kete`, …)                       |
| `util/src/observability/logging.ts`                           | Log filename prefix → `Brand.filePrefix` (`kete-<channel>.log`)                                                         |
| `util/src/observability.ts`, `util/src/observability/otlp.ts` | Default OTEL client/service name → `Brand.cliName` (only sent when the user configures an OTLP endpoint)                |
| `cli/src/database-path.ts`                                    | Database filename prefix → `Brand.filePrefix` (`kete-<channel>.db`)                                                     |
| `core/src/app.ts`                                             | Default app name and User-Agent prefix → `Brand.cliName` (`kete/<channel>/<version>/<client>`, sent to model providers) |

**Config discovery**

| File                                                                | Change                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `core/src/config/discovery.ts`                                      | Config filenames → `Brand.configFiles`; `.opencode` → `Brand.projectDirectory` (`.kete`) |
| `core/src/config.ts`                                                | Default global config write target → `kete.jsonc`                                        |
| `tui/src/util/config-directories.ts`, `tui/src/plugin/discovery.ts` | TUI theme/plugin discovery uses `.kete`                                                  |
| `cli/src/commands/handlers/mcp/add.ts`                              | `kete mcp add` writes to `kete.json[c]` / `.kete/kete.json[c]`                           |
| `core/src/plugin/plan.ts`                                           | Plan-mode scratch directory `~/.opencode/plan` → `~/.kete/plan`                          |

**Entry point, binary, updater**

| File                                   | Change                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/src/index.ts`                     | Imports the env bridge first; the `upgrade` handler and the `Updater` layer are swapped for the Kete-owned verified updater (`kete/upgrade.ts`, `KeteUpdater.layer`), `uninstall` for `kete/uninstall-disabled.ts` (dependency injection at the existing seam) |
| `cli/src/commands/handlers/default.ts` | No update UI in the TUI while `Brand.updatesAvailable` is false (it is `true` since ADR 0009)                                                                                     |
| `cli/src/commands/commands.ts`         | `upgrade`/`uninstall` descriptions name Kete Code (`uninstall`: "not yet available")                                                                                              |
| `cli/script/build.ts`                  | Compiled binary name, `OPENCODE_CLI_NAME` define and `--user-agent` → `Brand.cliName`; `KETE_TARGET` define (the release target `kete upgrade` downloads, e.g. `linux-x64-baseline`) |
| `tui/src/component/dialog-update.tsx`, `tui/test/component/dialog-update.test.tsx` | The update dialog's four "OpenCode" strings → `Brand.displayName` (the test expects "Kete Code") |
| `cli/package.json`                     | **No marker possible (JSON):** `bin.opencode` → `bin.kete`                                                                                                                        |
| `cli/bin/opencode.cjs`                 | npm launcher: runs the `kete` binary; override variable `KETE_BIN_PATH` (the launcher runs before the bridge)                                                                     |
| `cli/src/services/standalone.ts`       | Private-server lease password is handed to the child as `KETE_PASSWORD`, so the bridge in the child always applies it                                                             |

**User-facing text** (help, usage hints, titles, errors)

`cli/src/commands/commands.ts`, `cli/src/server-process.ts`, `cli/src/mini.ts`,
`cli/src/mini-host.ts`, `cli/src/commands/handlers/pair.ts`,
`cli/src/commands/handlers/stats.ts`, `cli/src/services/service-config.ts`,
`cli/src/services/server-connection.ts`, `cli/src/services/update-preflight.tsx`,
`cli/src/acp/event.ts`, `cli/src/acp/service.ts`, `cli/src/acp/agent.ts`,
`cli/src/config/schema.ts`, `server/src/process.ts`, `server/src/routes.ts`,
`core/src/mcp/client.ts`, `core/src/tool/plugin/webfetch.ts`,
`core/src/tool/plugin/websearch.ts`, `core/src/pty.ts`, `core/src/shell.ts`,
`tui/src/app.tsx`, `tui/src/attention.ts`, `tui/src/logo.ts`,
`tui/src/mini/*` (splash, runtime.lifecycle, footer.permission, footer.prompt),
`tui/src/component/*` (error-component, dialog-pair, terminal-pane, devtools-bar),
`tui/src/feature-plugins/system/stats.tsx`, `tui/src/routes/session/permission.tsx`,
`tui/src/util/*` (error, error-details, presentation).

Notable behaviour changes among these:

- `cli/src/config/schema.ts`: `SchemaURL` is `Brand.urls.configSchema`, which is
  **undefined (TODO)**. New `cli.json` files are written without `$schema`
  (`JSON.stringify` drops the undefined key).
- `tui/src/app.tsx`: the "Open docs" command is hidden while `Brand.urls.docs` is undefined.
- `tui/src/component/error-component.tsx`: "Copy report" copies the plain-text
  report instead of a pre-filled upstream GitHub issue URL.
- `core/src/pty.ts`, `core/src/shell.ts`: agent terminals get `KETE_TERMINAL=1`
  in addition to upstream's `OPENCODE_TERMINAL=1`.
- `core/src/tool/plugin/webfetch.ts`: User-Agent `…KeteCode-User/1.0` (no URL);
  the Cloudflare-challenge retry sends `kete`.
- `tui/src/logo.ts`: the left half of the wordmark reads "kete" (placeholder
  art); the small mark is a "k". Mono splash mark is `[K]`.

**Template-literal markers.** In `core/src/oauth/page.ts`, strings inside the
HTML/JS templates can't carry inline comments without leaking them into the
page, so each affected function (`renderCard`, `renderDocument`,
`bootstrapScript`) is wrapped in a `kete_change start` / `end` block. The upstream SVG wordmark
constant is no longer rendered; a text wordmark (`Brand.displayName`) is shown.

**Prompt files (no marker possible, `.txt`).** First-line identity changed from
OpenCode to Kete Code:

- `core/src/session/runner/prompt/system.txt`
- `core/src/plugin/system-prompt/gpt.txt`
- `core/src/plugin/system-prompt/gpt-astra.txt`
- `core/src/plugin/system-prompt/kimi.txt`
- `core/src/plugin/system-prompt/meta.txt` (also the section heading "Tool Use - Kete Code Specifics")
- `core/src/plugin/system-prompt/trinity.txt`
- `core/src/plugin/command/initialize.txt`: "Kete Code sessions" and `kete.json`

### Built-in skills (feature/kete-skill)

Upstream's built-in `opencode` skill teaches OpenCode's config paths, commands and
docs, and its `report` skill files GitHub issues. Both would mislead the model
after the rebrand, so a Kete-owned plugin replaces them instead of editing
upstream's markdown (which therefore never conflicts on sync):

| File                            | Purpose                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/src/kete/skill.ts`        | Removes the `opencode` and `report` skills and adds `kete` ("Kete Code") and a Kete `report`; re-registers the inherited `opencode` tool namespace with a Kete description (the namespace ID is part of the tool API and stays) |
| `core/src/kete/skill/kete.md`   | Kete facts (paths, `KETE_*`, commands, differences) plus a name-mapping table for using OpenCode's V2 docs as the upstream reference                                                                                            |
| `core/src/kete/skill/report.md` | Drafts bug reports; never files them in OpenCode's repository; publishes only to `Brand.urls.issues` once it exists                                                                                                             |

Upstream edit: `core/src/plugin/internal.ts` registers `KeteSkillPlugin.Plugin`
last in the `pre` list, after `SkillPlugin` and `OpenCodeTools` whose output it
replaces. Keep it after both when upstream reorders that list.

### Hosted defaults (feature/disable-zen-default)

Upstream force-enables the `opencode` (Zen) provider with the shared "public" key
when the user has no credentials, so prompts go to opencode.ai without an explicit
choice, and it promotes Zen and Go in login and onboarding. Kete Code keeps both
available only through an explicit opt-in (`kete auth login`, an API key in the
environment, or a `providers.opencode` config entry).

| File                      | Purpose                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `core/src/kete/hosted.ts` | Switches for inherited hosted-service defaults: `anonymousOpencodeZen = false`, with the opt-in paths |

**Upstream source edits**

| File                                         | Change                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `core/src/plugin/provider/opencode.ts`       | The anonymous auto-enable is gated on `KeteHosted.anonymousOpencodeZen`           |
| `cli/src/commands/handlers/auth/login.ts`    | Zen and Go are not listed first, and Zen has no "recommended" hint                |
| `cli/src/commands/handlers/auth/shared.ts`   | Go is not sorted first; the server's provider order is kept                       |
| `tui/src/component/dialog-integration.tsx`   | The connect dialog does not promote Zen or Go                                     |
| `tui/src/feature-plugins/sidebar/footer.tsx` | No "includes free models" onboarding; the footer asks to connect a model provider |

**Upstream test edits.** `core/test/plugin/provider-opencode.test.ts` (anonymous access
is off by default), `cli/test/auth.test.ts` (provider order),
`tui/test/cli/cmd/tui/integration-options.test.ts` (dialog order) and
`tui/test/feature-plugins/sidebar-footer.test.tsx` (footer text). The default itself
is pinned by `core/test/kete/hosted.test.ts`.

When syncing, review new upstream features for other opencode.ai endpoints,
telemetry or providers enabled by default, and add a switch to `hosted.ts`.

### Gateway client (feature/kete-gateway)

The `kete` provider offers the models a Kete Model Gateway allows, each on its native
gateway route (ADR 0004). It is a Kete-owned plugin, `core/src/kete/gateway.ts`.

Upstream edit: `core/src/plugin/internal.ts` registers `KeteGateway.Plugin` in the `pre`
list after the catalog (`ModelsDevPlugin`) and provider plugins, because gateway models
copy their source provider's catalog definitions. Keep it after both when upstream
reorders that list.

### Session budget (feature/session-budget)

`kete.budget.session` (USD) pauses a session before its next model request once its
recorded cost reaches the budget, using the `budget` permission. Approving allows another
budget-sized amount. The logic is Kete-owned: `core/src/kete/budget.ts` (the check),
`core/src/kete/budget-rule.ts` (a plugin that adds a `budget: ask` rule to every built-in
agent, because `build` starts with an `*` allow rule that would otherwise approve `budget`
silently), and the config schema `schema/src/config/kete.ts`.

| File                                    | Change                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `schema/src/config.ts`                  | Adds the `kete` section (`ConfigKete.Info`)                                                                                             |
| `core/src/config/normalize.ts`          | Passes the `kete` section through normalization (unlisted top-level keys are dropped)                                                   |
| `core/src/plugin/internal.ts`           | Registers `KeteBudgetRule.Plugin` after `AgentPlugin` and before the `post` config plugins, so configuration rules still win            |
| `core/src/session/runner/llm.ts`        | Builds the checker in the runner layer, adds its `Config` and `Permission` nodes, and calls it in `runStep` before the step-limit check |
| `protocol/openapi.json`                 | **Generated (no marker possible):** the `kete` config section. Regenerate with `bun run generate` in `packages/protocol`                |
| `client/src/promise/generated/types.ts` | **Generated (no marker possible):** the `kete` config type. Regenerate with `bun run generate` in `packages/client`                     |

On sync, keep the check in `runStep` at the step boundary, before the model request is
prepared; it must stay inside the step loop so retries and compaction don't bypass it. If
upstream adds a top-level config key list elsewhere, `kete` must be in it too.

### Credit balance (feature/kete-balance)

With a platform URL, the gateway provider polls `GET /api/v1/me` every minute and
publishes the balance as the `kete` integration's metadata (`balance_micros`,
`currency`, `organization`). A Kete-owned TUI plugin, `tui/src/kete/balance.tsx`, shows
it in the session sidebar and warns when credit is low or used up.

| File                               | Change                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/src/effect/integration.ts` | `IntegrationRef` gains `metadata?` (type only): core already stores and publishes integration metadata, but the plugin-facing type hid it |
| `tui/src/plugin/builtins.ts`       | Registers `KeteBalance` after `SidebarContext`, so the balance appears under the session's context and cost                               |

### Web UI branding (feature/rebrand-web-ui)

The web UI (`packages/app`: the chat the CLI serves, also shown in the VS Code extension)
reads "Kete Code". Text is rebranded at runtime so upstream's ~66 locale files stay untouched:
`app/src/kete/brand-text.ts` rewrites every dictionary when it loads. It keeps what really
is OpenCode's (OpenCode Zen/Go/Console/Free, opencode.ai links, the `OPENCODE_*` variables the
runtime passes to scripts) and replaces two statements a word swap would make false (the
trademark notice, and "includes free models"). `app/src/kete/wordmark.tsx` is a placeholder
wordmark until Kete Code has a designed logo.

| File                                                                                                                     | Change                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `app/src/runtime/i18n/language.tsx`                                                                                      | `brandDictionary` applied to the base and loaded dictionaries                                    |
| `app/index.html`                                                                                                         | Title "Kete Code"; placeholder SVG favicon                                                       |
| `app/src/new-session/wordmark.tsx`, `app/src/servers/connect/screen.tsx`                                                 | Kete wordmark in place of OpenCode's; `kete pair` in the pairing hint                            |
| `app/src/shell/titlebar/windows-menu.tsx`                                                                                | Desktop menu heading                                                                             |
| `app/src/settings/about/about.tsx`                                                                                       | The opencode.ai website link is shown only once `Brand.urls.docs` exists                         |
| `app/vite.config.ts`, `app/src/entry.tsx`                                                                                | About shows the Kete release version (`OPENCODE_VERSION` from the release build)                 |
| `app/src/providers/catalog/order.ts`, `app/src/providers/connect/dialog.tsx`, `app/src/settings/providers/providers.tsx` | OpenCode Go/Zen listed after the other popular providers, without a "Recommended" tag (ADR 0003) |
| `app/src/providers/catalog/order.test.ts`                                                                                | Asserts the new order                                                                            |

Not yet rebranded: the PWA/app icons (`packages/desktop/icons`, raster), which need the
designed logo. About keeps OpenCode's colophon and credits, as attribution.

### Account sign-in (feature/kete-login)

`kete login` signs in to a Kete Code account through the platform's browser flow
(`docs/platform/cli-login-v1.md`), `kete logout` revokes and forgets the key, and
`kete whoami` shows the account. `kete auth` stays upstream's command for model
provider keys; both `--help` texts point at the other.

| File                                   | Purpose                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `util/src/kete/secret-store.ts`        | OS credential stores through OS tools (macOS `security`, Linux `secret-tool`, Windows PowerShell + Credential Manager), file fallback |
| `util/src/kete/account.ts`             | `account.json` (non-secret details) plus the key's store; shared by the CLI and core, since the CLI may not import core               |
| `cli/src/kete/cli-login.ts`            | PKCE, the 127.0.0.1 callback listener, and the `/api/v1/cli/*` calls                                                                  |
| `cli/src/kete/account-flow.ts`         | The login, logout and whoami flows over injected I/O                                                                                  |
| `cli/src/kete/{commands,login,logout,whoami,account-io}.ts` | Command specs and handlers                                                                                       |
| `core/src/kete/gateway.ts`             | A signed-in account's gateway URL, key and platform URL take precedence over hand configuration                                        |
| `util/src/kete/brand.ts`               | `urls.platform` (undefined until Kete Code has a production platform URL)                                                              |

**Upstream source edits**

| File                           | Change                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `cli/src/commands/commands.ts` | Imports and spreads `KeteCommands.specs`; the `auth` description points to `kete login`     |
| `cli/src/index.ts`             | Handler map entries for `login`, `logout` and `whoami`                                      |

Upstream test edit: `cli/test/auth.test.ts` expects the new `auth` description.

When syncing, check that upstream has not added its own top-level `login`, `logout` or
`whoami` command; the spread would then produce a duplicate.

### VS Code extension (feature/vscode-extension)

The extension bundles `kete` per platform and runs its own `kete serve --stdio` on 127.0.0.1, a
random port and a per-session password (`packages/kete-vscode`, Kete-owned). The server gains
Host/Origin checks, and the web UI gains a bridge to the editor that does nothing outside the
extension's frame.

| File                                                 | Purpose                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `server/src/kete/local-guard.ts`                     | Rejects a `Host` that isn't an IP literal, `localhost`, the bound name or `KETE_SERVER_ALLOWED_HOSTS` (DNS rebinding), and an `Origin` that isn't the server's own, `--cors`, or the desktop app's schemes |
| `app/src/kete/vscode-host.tsx`, `vscode-messages.ts` | Opens the workspace folder, adds editor context to the prompt, and asks the extension to open diffs            |
| `cli/src/kete/{commands,account-flow,whoami}.ts`     | `kete whoami --format json` (local state only) for the extension's account display                             |

**Upstream source edits**

| File                                                    | Change                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `server/src/process.ts`                                 | `KeteLocalGuard.middleware` wraps the served app, outside CORS and auth                           |
| `app/src/app.tsx`                                       | Mounts `KeteVSCodeShell` in the router root                                                        |
| `app/src/session/route.tsx`, `app/src/new-session/route.tsx` | Mount `KeteVSCodeBridge` inside the composer providers                                        |
| `app/src/session/review/view.tsx`                       | Selecting a file in the review (or a diff in the timeline) also calls `openDiff`                  |

**Behaviour change.** Upstream accepted cross-origin requests from any `http://localhost:*` or
`127.0.0.1:*` page and from `https://*.opencode.ai` (still password-protected). Kete Code accepts
only the server's own origin and origins passed with `--cors`; run the web UI's dev server with
`--cors http://localhost:<port>`. Upstream test edit: `server/test/process.test.ts` passes
`http://localhost:3000` with `cors` and expects 403 for an untrusted origin.

### Branding cleanup and provider attribution (chore/branding-cleanup)

| File                                   | Purpose                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `util/src/kete/brand.ts`               | `urls.website` (undefined until Kete Code has a site) and `attribution` (the values sent to providers)    |
| `util/src/kete/wordmark.ts`            | The Kete Code logo (the mark beside the name) as a self-contained SVG; its bars equal `app/src/kete/mark.tsx`'s `MARK_RECTS` (`core/test/kete/oauth-page.test.ts`) |
| `tui/src/kete/mark.tsx`                | The mark as half-block pixel art (`KeteMark`) and `KeteLogo`: the mark beside upstream's wordmark when the terminal is at least 56×12 |
| `core/src/kete/attribution.ts`         | Replaces upstream's OpenCode attribution header values with Kete Code's (below)                           |
| `tui/src/kete/theme.ts`, `theme.json`  | The default theme is `kete`; `opencode` is an alias. `theme.json` is upstream's `assets/v2/opencode.json` with violet #7C3AED as the interactive hue; regenerate it when an upstream sync changes that asset |

**Upstream source edits**

| File                                                        | Change                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `core/src/oauth/page.ts`                                    | Renders the Kete logo; OpenCode's unused SVG wordmark removed. The card's top edge uses `--oc-brand`, Kete Code's violet (#6E47F5 light, #A38CFA dark); the logo's name and ink bars use the strong text colour |
| `tui/src/routes/home.tsx`                                   | One import line: the home screen's `Logo` is `KeteLogo` (`tui/src/kete/mark.tsx`), which wraps upstream's `Logo` |
| `core/src/plugin/internal.ts`                               | Registers `KeteAttribution.Plugin` after the provider plugins (next to `KeteGateway`)                 |
| `tui/src/theme/index.ts`                                    | Registers the default theme under `kete` as well as `opencode`, loading its colours from `kete/theme.json` |
| `tui/src/context/theme.tsx`, `tui/src/mini/theme.ts`, `tui/src/component/dialog-config.tsx` | Default and fallback `kete`; a configured or saved `opencode` maps to `kete` (unless a custom theme is named `opencode`) |
| `tui/src/component/dialog-theme-list.tsx`                   | The picker hides the `opencode` alias                                                                  |
| `cli/src/commands/handlers/stats.ts`                        | The footer shows `Brand.urls.website` instead of `opencode.ai`, and is omitted until the site exists   |
| `ui/src/theme/default-themes.ts`, `ui/src/theme/context.tsx` | The default web theme (`oc-2`) is `ui/src/theme/kete/theme.ts`: upstream's `oc-2.json` with violet as its primary, interactive and v2 accent colours, named "Kete Code". `oc-2.json` itself is untouched |
| `core/src/worktree.ts`                                      | The worktree setup script (`commands.start`) also gets `KETE_WORKTREE_BASE` and `KETE_WORKTREE_PATH`; the `OPENCODE_` names stay for existing scripts. The web UI's hints show the Kete names (`app/src/kete/brand-text.ts`) |

**Provider attribution.** Upstream's provider plugins stay untouched. `KeteAttribution` runs after
them and replaces only their exact default values, so a value a user configured is kept. The
documentation checked for each provider:

| Provider (plugin) | Header | Upstream | Kete Code | Notes |
| --- | --- | --- | --- | --- |
| OpenRouter, Vercel, Kilo, LLM Gateway, ZenMux, NVIDIA | `HTTP-Referer` | `https://opencode.ai/` | `Brand.urls.website`; **not sent** while undefined | Optional app attribution, no registration. Without a referer OpenRouter lists no app page; requests are unaffected |
| same | `X-Title` | `opencode` | `Kete Code` | Display name (OpenRouter, Vercel, ZenMux); undocumented for Kilo and LLM Gateway |
| LLM Gateway | `X-Source` | `opencode` | the website's host; **not sent** while undefined | Documented source header; a malformed value fails the request with 400, so only a plain host is ever sent. Without it LLM Gateway uses the User-Agent (`kete/…`) |
| NVIDIA | `X-BILLING-INVOKE-ORIGIN` | `OpenCode` | `KeteCode` | Not officially documented; used as a free-form app-origin value by many clients. A user-set value still wins |
| Cerebras | `X-Cerebras-3rd-Party-Integration` | `opencode` | `kete-code` | "Track integration usage and provide better support"; self-chosen values, no registration |

**Deliberately unchanged, and why**

- **OpenAI `originator: "opencode"`** (`plugin/provider/openai.ts`, ChatGPT sign-in). The ChatGPT
  backend's behaviour depends on the originator (available models and context limits; reports of
  "model not found" for unfamiliar values). `opencode` is the value this flow is known to work with.
  Change it only after testing a Kete value against the live backend with a ChatGPT account.
- **`x-opencode-project`, `x-opencode-session`, `x-opencode-client`** (`session/model-request.ts`).
  The Kete Model Gateway forwards only `content-type`, `accept`, `user-agent` and provider version
  headers (kete-code-platform `apps/gateway/src/config/providers.ts`), so these reach a provider
  only with the user's own key. The client value is already `kete` (from Brand). Renaming them is an
  upstream protocol change; revisit if a provider starts showing them.
- **MCP OAuth client identity** (`mcp/oauth.ts`: `CLIENT_METADATA_URL =
  https://opencode.ai/oauth/opencode/client.json`, `client_uri: https://opencode.ai`). Servers that
  support client ID metadata documents identify the client from that URL, so a consent screen may
  name OpenCode. Changing it needs a Kete-hosted client metadata document on Kete's own domain;
  pointing at a URL Kete doesn't serve would break MCP sign-in.
- **Model catalog** (`models-dev.ts`: `https://models.opencode.ai`, with a bundled snapshot as
  fallback). A functional data source, not attribution. Mirroring it is a separate decision.

**Remaining "OpenCode"/"opencode" strings** (the audit's search, repeated after these changes) that
a user could see or that leave the machine:

| Where | Why it stays |
| --- | --- |
| `cli/src/services/updater.ts`, `cli/src/commands/handlers/{upgrade,uninstall}.ts` | Unreachable: `upgrade` maps to `kete/upgrade.ts`, `uninstall` to `kete/uninstall-disabled.ts`, and the `Updater` service is `KeteUpdater.layer` (`dialog-update.tsx`'s strings are branded since ADR 0009) |
| `core/src/plugin/provider/opencode.ts` ("OpenCode Web Search", Console errors) | Names OpenCode's own hosted services, which are opt-in (ADR 0003) |
| `core/src/tool/plugin/opencode.ts`, `core/src/plugin/skill.ts`, `plugin/skill/{opencode,report}.md` | Replaced at runtime by `kete/skill.ts` (namespace text and skills) |
| `core/src/kete/skill/kete.md` | Deliberately points the model at OpenCode's V2 docs as the upstream reference, with a name mapping |
| `core/src/v1/config/config.ts` | Descriptions in the V1 config schema (links to OpenCode's V1 docs); not shown in the CLI or TUI |
| `core/src/mcp/client.ts` (`_meta: { "ai.opencode/sessionID" }`) | Protocol metadata key sent to MCP servers; renaming would be an upstream protocol change |
| `cli/src/services/retained-image.ts` | Recognises upstream's Windows install path, so an OpenCode install isn't mistaken for Kete's |
| `tui/src/theme/assets/*.json` (`$schema`) | Bundled data, never displayed |
| `tui/src/context/keymap.tsx` (`command.opencode`), plugin/package IDs, `OPENCODE_*` | Internal identifiers (CLAUDE.md §5) |
| Items listed above as deliberately unchanged | See above |

### Platform-managed agents (feature/agent-sync)

Agents the organization manages on the platform are synced from `GET /api/v1/sync`
(`docs/platform/sync-v1.md`) and loaded after the config agents.

| File                                          | Purpose                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `util/src/kete/sync/{contract,client,cache,sync}.ts` | The v1 schemas, the request with If-None-Match, the per-organization cache (atomic writes), one sync. In `util` because the CLI may not import core |
| `core/src/kete/sync/plugin.ts`                | Loads the cache, syncs at startup and every 5 minutes, maps managed agents, adds the gateway's agent headers (`session` `model.request` hook) |
| `cli/src/kete/sync.ts`, `cli/src/kete/account-flow.ts` | `kete sync`; `kete login` syncs once; `kete logout` removes the organization's cache   |

**Upstream source edits**

| File                               | Change                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `core/src/plugin/internal.ts`      | Registers `KeteAgentSync.Plugin` in `post` right after `ConfigSkillPlugin` (so also after `ConfigAgentPlugin` and `ConfigCompatibilityPlugin`): a managed agent or skill replaces a local one with the same slug |
| `core/src/config/plugin/agent.ts`  | Exports `expandPermissions`, so managed agents get the local global rules expanded exactly as local agents do |
| `cli/src/index.ts`                 | Handler for `sync`                                                                               |

**Gateway agent errors (feature/agent-request-tagging), no upstream edits.** The same plugin
handles the gateway's agent errors through `session` hooks scoped to the `kete` provider:
`http.response` recognises `x-kete-error-code` (`kete_agent_budget_exceeded`,
`kete_agent_paused`, `kete_agent_not_found`, `kete_agent_model_not_allowed`), replaces only the
error body's `message` with Kete's text, adds `x-should-retry: false`, and for the three 403 codes
starts one (debounced) sync; the `retry` hook vetoes retries. The UIs show the error message, so
no client changes. When syncing upstream: check that `x-should-retry` is still honoured
(`session/runner/retry.ts`) and that the executor still reads `error.message` from JSON error bodies.

**Skills and MCP servers (feature/skill-mcp-sync), no further upstream edits.** Sync v1's `skills`
and `mcp_servers` are handled by the same plugin: skill files are written to
`<config>/managed/<org>/skills/<slug>/` (`util/src/kete/sync/skills.ts`: SHA-256 verified,
re-downloaded only when changed, paths confined to the skill folder, scripts never executable)
and registered with `ctx.skill.transform`; servers are registered with `ctx.mcp.transform`
(`core/src/kete/sync/mcp.ts`, statuses in `util/src/kete/sync/mcp-status.ts`): stdio servers stay
disabled until `kete sync --approve <key>` approves their exact command
(`util/src/kete/sync/approvals.ts`), `api_key`/`service_account` servers stay disabled until the
contract says how a key is sent, and SSE servers are registered with a warning (the MCP client
speaks Streamable HTTP only). Agents that aren't managed get `ask` for a managed server's tools
their own rules would allow silently; denials are never loosened.

When syncing upstream: keep `KeteAgentSync.Plugin` after `ConfigAgentPlugin` and `ConfigSkillPlugin`, and check that the
contract's permission actions still match the runtime's tool names (`shell`, `edit`, …; MCP tools as
`<server>_<tool>`, `McpTool.name`).

### Permission modes (feature/vscode-permission-modes)

`core/src/kete/permission-mode.ts` asks before edits, shell commands and web fetches in sessions whose
metadata has `kete.permissionMode: "ask"` (subagent sessions inherit it); sessions without the key use
`KETE_PERMISSION_MODE`. It runs on the `permission` `evaluate` hook, which the permission service only
reaches when nothing denied the request, and only turns `allow` into `ask`.

| File                          | Change                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| `core/src/plugin/internal.ts` | Registers `KetePermissionMode.Plugin` in `pre`, after `KeteBudgetRule` |

When syncing upstream: check that `Permission` still returns `deny` before triggering the `evaluate`
hook (`test/kete/permission-mode-service.test.ts`), and that the tool actions are still `edit`, `shell`,
`webfetch` and `websearch`. The modes were extended by "Safe defaults and permission modes" below.

### Safe defaults and permission modes (feature/safe-defaults-modes)

Upstream's default agent allows every action (`"*": allow`). `core/src/kete/permission-mode.ts` now
layers Kete Code's safe defaults on the same `evaluate` hook instead of editing
`schema/src/agent.ts`: when an allowed request's only matching rule is that catch-all, the
session's mode (`default`, `accept-edits`, `auto`, `ask`, `plan`; shared list in
`util/src/kete/permission-mode.ts`) decides whether it still asks. Shell commands are classified by
`core/src/kete/shell-risk.ts` (read / build / other / high). Explicit rules (agent, config, session,
saved "always" approvals) are kept except in `ask` and `plan` modes. It still only tightens, and
unattended families keep their own policy. User guide: `docs/permissions.md`.

| File                                         | Change                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `cli/src/commands/commands.ts`               | `--permission-mode <mode>` flag; `--auto` describes the `auto` mode; `--dangerously-skip-permissions` is documented (no longer hidden) |
| `cli/src/commands/handlers/default.ts`, `run.ts` | `--auto` → `auto` mode (`kete/permission-mode.ts`'s `fromFlags`); only `--dangerously-skip-permissions`/`--yolo` make the client approve everything |
| `cli/src/run/run.ts`                         | `RunCommandInput.permissionMode`; sets it on the session before the first prompt                                        |
| `tui/src/context/args.tsx`                   | `Args.permissionMode`                                                                                                    |
| `tui/src/app.tsx`                            | Calls `useKetePermissionModeCommands()` (cycle command, `/mode`, resumed-session mode)                                  |
| `tui/src/config/keybind.ts`                  | `permission.mode.cycle` bound to `<leader>p`                                                                             |
| `tui/src/component/prompt/index.tsx`         | New sessions are created with the mode's metadata; the status row gets the mode                                         |
| `tui/src/component/prompt/metadata.tsx`      | Shows the session's permission mode (not for Default); the client-side bypass's label is now `auto-accept`              |
| `core/src/tool/plugin/shell.ts`              | Passes the whole command line as `metadata.command` (the defaults' `cd` check); `save` is empty — no "Always allow" — when a command is high-risk or runs anything (`KeteShellRisk.saveable`) |
| `core/src/tool/plugin/webfetch.ts`           | `save` is the URL's origin (`kete/web-host.ts`) instead of `*`, so "Always allow" covers one site; fetches with `redirect: "manual"` and follows redirects in `kete/web-redirect.ts`, asking before a hop to another origin |
| `core/src/shell/parse.ts`                    | Both scanners add `KeteShellDirectory.implicit*` directories for a `cd`/`pushd` (POSIX, and PowerShell `Set-Location`) with no or an unknown target — `-`, `+N`, `~user`, variables, globs, brace expansion, `CDPATH` — (home, or the filesystem root), so `external_directory` asks |
| `core/test/tool-webfetch.test.ts`            | Expects the per-origin `save`                                                                                           |
| `core/src/plugin/internal.ts`                | Comment on the existing `KetePermissionMode.Plugin` line updated                                                        |

When syncing upstream: check that upstream's default agent still starts with `{ action: "*",
resource: "*", effect: "allow" }` (the "catch-all" the safe defaults key on, `catchAll()` in
`permission-mode.ts`) — if upstream adds its own shell or web defaults, revisit; that the shell tool
still asks once per parsed command (`tool/plugin/shell.ts`, `shell/parse.ts`); and that the TUI's
`<leader>p` is still free; that `ShellParse` still excludes `cd` from the asked resources (the
`metadata.command` line check covers it) and that `$((…))` still parses; that the web fetch tool
still asks with the requested URL as its resource.

### Starter role agents (feature/local-role-agents)

`core/src/kete/roles.ts` adds Code Reviewer, QA and Docs Writer (subagents) and Security and DevOps
(primary) when the user is **not** signed in to a Kete organization, mirroring the platform's
built-in agents; signed in, the organization's synced agents decide. Config agents with the same id
still win (they load later).

| File                          | Change                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `core/src/plugin/internal.ts` | Registers `KeteRoles.Plugin` in `pre`, before `KeteBudgetRule` (so they get its rule) |

### Subagent controls (feature/subagent-controls)

`core/src/kete/subagents.ts` adds a subagent timeout (`kete.subagents.timeout`, minutes, default 60)
and a limit on running subagents per session (`kete.subagents.max_concurrent`, default 4), and stops a
session's running subagents when the user stops the session.

| File                                  | Change                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `core/src/session/subagent-job.ts`    | Wraps each subagent job's work in `KeteSubagents.bound` (timeout; `make` now needs `Config.Service`). A cancelled subagent's completion notice is delivered with `resume: false`, so it no longer restarts a parent the user stopped |
| `core/src/tool/plugin/subagent.ts`    | Asks `KeteSubagents.admit` for a place before creating or continuing a child, binds it to the child, and releases it when the call ends (`Effect.scoped`) |
| `core/src/plugin/internal.ts`         | Registers `KeteSubagents.Plugin` in `pre`, after `KetePermissionMode`: on `session.execution.interrupted` with reason `user`, stops the session's running subagents |

### Subagent worktrees (feature/subagent-worktrees)

`core/src/kete/worktrees.ts` runs a subagent in its own git worktree on a new branch
`kete/agent-<slug>` when the subagent tool gets `worktree: true`. The worktree is created through the
upstream Worktree service (listed, named and set up like any other) from the parent's last commit;
`core/src/kete/git.ts` runs the git commands the upstream Git service doesn't expose. The finished
subagent's answer ends with the branch and how to merge it (`KeteSubagents.bound`); one that changed
nothing has its worktree and branch removed. The plugin wraps the `git` worktree strategy so a
detached worktree whose commits no ref holds is only removed with force, refuses `session_move`
calls into another session's agent worktree, and removes clean worktrees of deleted sessions.

| File                                 | Change                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `core/src/session.ts`                | `Session.create` accepts a `location` together with `parentID`; an explicit location wins over the parent's (upstream types children as always inheriting it) |
| `core/src/tool/plugin/subagent.ts`   | `worktree` input; asks the `worktree` permission, creates the worktree before the child and creates the child in it, tells the child where it works; refuses to continue a child whose worktree was removed |
| `core/src/plugin/internal.ts`        | Registers `KeteWorktrees.Plugin` in `pre`, after `KeteSubagents`                                                                        |

### Subagent security (fix/subagent-security)

- `core/src/kete/permission-ceiling.ts`: a subagent can't do more than any agent above it. Each
  permission decision for a child session is capped at what every ancestor session's agent would
  get (deny < ask < allow); saved approvals count for ancestors as for the child. Only tightens.
- `core/src/kete/session-move.ts`: the model's `session_move` tool moves only the current session
  or its subagents, asks `external_directory` for a destination outside the repository, and
  explains a refused move into a subagent's worktree.
- `core/src/kete/worktree-name.ts`: a worktree name is one path segment.
- `core/src/kete/subagents.ts` `subtaskCheck`: slash-command subtasks get the nesting-depth limit
  and are refused when the parent's agent is denied `subagent` for that agent.

| File                               | Change                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `core/src/worktree.ts`             | `create` refuses a name that isn't one path segment (`Worktree.OperationError`)                          |
| `core/src/session/move.ts`         | `move` refuses a destination inside another session's subagent worktree (`DestinationUnavailableError`), for the tool, UI and HTTP API alike; depends on `KV` |
| `core/src/config/plugin/command.ts` | Subtasks run `KeteSubagents.subtaskCheck` before creating the child                                     |
| `core/src/plugin/internal.ts`      | `PermissionSaved` in the plugin services; registers `KetePermissionCeiling.Plugin` and `KeteSessionMove.Plugin` after `KeteWorktrees` |

### Unattended runs (feature/unattended-policy)

ADR 0008: a session family marked unattended (session metadata `kete.unattended`, set once at
creation and never removable) never waits on a person: a `permission.evaluate` result of `ask` is
denied unless the run's policy allows it in advance, and a prompt is refused without both a
spending budget and a time limit. The contract, decode and the guards live apart from the plugins
so `session/session.ts` can import them without a cycle:

**Known limitation:** if the root session's row is gone while descendants remain (no current code
path does this: `Session.remove` deletes children first and `create` requires the parent row), the
family stays unattended with its policy, but the time limit is measured from the oldest surviving
member and the budget sums only its subtree. Permissions are unaffected.

**Invariant: every session in the family carries its own copy of `kete.unattended`.** A plain
child already inherits it (`session.ts` `create`'s `metadata: input.metadata ?? parent?.metadata`);
`KeteUnattendedPolicy.inheritMetadata` closes the remaining gap — a caller that supplies its own
`metadata` at creation (a worktree subagent, `kete/worktrees.ts:227`, or any future one) still gets
the parent family's `kete.unattended` forced onto it. `resolve` then only needs to walk `parentID`
upward as a defensive fallback (a session created before this invariant existed): unattended if the
session itself or any resolvable ancestor carries the key, root-most one wins. Critically, a broken
chain (a missing ancestor — `session_v2.parent_id` has no FK, and `session/execution/restart.ts`
treats one as real — or one past 32 hops) **before any session is found** means **interactive**,
not fail-closed: an ordinary session with incomplete ancestry must not be swept into "unattended,
refuse everything". A broken chain **after** a session was found still fails closed, using that
session's value.

| File | Purpose |
| --- | --- |
| `core/src/kete/unattended-policy.ts` | The `kete.unattended` contract (versioned, strict decode), root resolution (fail closed on a decode failure, unknown version, missing ancestor or a chain past 32), `allows` (never `question`/`budget`), and the metadata/permissions guards. No session or permission service imports (type imports only) |
| `core/src/kete/unattended.ts` | Two plugins (below), `limits` (the run's budget/timeout vs. `kete.budget.session`/an explicit `kete.subagents.timeout`), and `check`/`make` for the runner seam |
| `core/src/kete/run-checks.ts` | Replaces `KeteBudget` at the runner seam: an interactive family gets `KeteBudget` unchanged, an unattended family gets `KeteUnattended.check` instead |

**Two evaluate hooks, because hook order is plugin order.** `KeteUnattended.PolicyPlugin`
(`kete.unattended.policy`) runs early, right after `KeteBudgetRule` and before `KetePermissionMode`:
it ignores a saved "always" approval (D3, recomputed the way `permission-ceiling.ts`'s ceiling
ignores them for ancestors), then turns an `ask` the policy allows into `allow`. `KeteUnattended.Plugin`
(`kete.unattended`) runs last in `post`, after `ConfigPolicyPlugin`, so it sees every other hook's
tightening: any `ask` still standing becomes `deny` — it never produces `allow`. `KetePermissionCeiling`'s
`Lookup` gained `policy(sessionID)`, so a subagent's ancestors get the family's policy allows the same
way they already get saved approvals (`core/src/kete/permission-ceiling.ts`).

| File | Change |
| --- | --- |
| `core/src/plugin/internal.ts` | Registers `KeteUnattended.PolicyPlugin` in `pre` after `KeteBudgetRule` and before `KetePermissionMode`; `KeteUnattended.Plugin` in `post`, last (after `ConfigPolicyPlugin`); both IDs added to `guarded` so repository config can't remove them |
| `core/src/session.ts` | `create`'s `metadata` field calls `KeteUnattendedPolicy.inheritMetadata(parent?.metadata, input.metadata)` instead of `input.metadata ?? parent?.metadata`, so a child created with its own metadata still carries the parent family's `kete.unattended` |
| `core/src/session/session.ts` | `setMetadata` keeps the fetched session and calls `KeteUnattendedPolicy.guardMetadata` (refuses adding, changing or dropping `kete.unattended`, D1: as a defect, not a typed error); `setPermissions` calls `guardPermissions` (D2: refuses changing a session's `permissions` while its family is unattended — a `permissions` rule could otherwise widen the run's policy mid-run) |
| `core/src/session/runner/llm.ts` | The existing `kete_change` lines that wired `KeteBudget` now wire `KeteRunChecks` (same shape; no new lines) |

**Audit log (feature/audit-log, ADR 0008).** Every unattended run leaves a local, append-only
`<data dir>/audit/<root session id>.jsonl` (`core/src/kete/audit.ts`; redactor:
`util/src/kete/redact.ts`). D1: the audit hooks are installed from inside
`KeteUnattended.Plugin`'s own effect (`KeteAudit.install(ctx, ...)`, called right after it
registers its late `evaluate` hook) rather than as a separate plugin registered in
`plugin/internal.ts` — hooks run in registration order (`plugin/hooks.ts`), so this still sees the
family's final permission decision, at the cost of riding on `kete.unattended`'s plugin id instead
of its own. **No new upstream edit**: `plugin/internal.ts`'s `pre`/`post` lists and `guarded` set are
unchanged. `run-checks.ts` (already a Kete-owned seam, no upstream edit) calls `KeteAudit`'s `begin`
before `KeteUnattended.check` for an unattended family, refusing the step if the log can't be
written. `kete/audit.ts` only takes a **type-only** import of `kete/unattended.ts` (`Limits`), and
`kete/unattended.ts`'s `Plugin` passes a `stopReason` closure into `KeteAudit.install` rather than a
`KeteUnattended.Lookup` value, so the two modules don't form a runtime import cycle. The per-run
byte cap and the per-root append mutex both live in one process's `WriterState` (in memory, keyed by
root id) — they don't coordinate across multiple `kete serve` processes writing the same root's
file (not expected today: one server per workspace), and a write failure only stops the run after
the failing hook's `Effect.logError` + `sessions.interrupt(root)` complete, so a tool call already
in flight when the failure happens can finish (and go unaudited) before the interrupt takes effect.

When syncing upstream: keep `KeteUnattended.PolicyPlugin` before `KetePermissionMode` and
`KeteUnattended.Plugin` last in `post` — an evaluate hook that loosens must run before every hook that
can tighten, or the late hook's "any ask becomes deny" would deny a policy-allowed request tightened
by something registered after the policy hook. Check that `Permission` still returns `deny` before
triggering `evaluate` (`denied()` in `core/src/permission.ts`, so a rule's `deny` never reaches
either hook) and that session hooks still can't fail (`core/src/plugin/hooks.ts`: only `tool`
`execute.before` may) — if that changes, the required-limit and deadline checks could move from the
runner step (`session/runner/llm.ts`) into a `session` `prompt` hook instead. Also keep `create`'s
`metadata` line forcing `kete.unattended` onto a child's own metadata — dropping it reopens the gap
`inheritMetadata` closes (a child could shed the flag by supplying its own metadata at creation).

### Jobs (feature/job-run)

`kete job run <spec.json>` (ADR 0005) runs a job unattended from a JSON spec file: the CLI creates
its own git worktree and branch with `git worktree add -b` (D1 — never `POST /api/worktree`, so no
project `commands.start` setup script runs outside the job's own policy and audit), starts a
session there with `kete.unattended` metadata, waits for it to finish, and reports the outcome. See
`docs/jobs.md` for the spec, the `--json` result contract, and exit codes.

| File | Purpose |
| --- | --- |
| `schema/src/kete/unattended.ts` | `AllowRule`/`Policy` (moved here from `core/src/kete/unattended-policy.ts`, which now re-exports them — the CLI can't import core, and needs the identical schema to validate a job spec's `policy` field, `cli/test/import-boundaries.test.ts`), the stop-message builders (`refused`, `timeLimit`, `budget`, `auditUnavailable`) and `classify(message)`, shared by the runtime and the CLI so their text and their reading of it never drift apart |
| `core/src/kete/unattended-policy.ts` | Adds `configTarget(action, resources, {globalConfig})`: pure, string-only, whether an `edit` resource or (best-effort) a `shell` command text targets Kete configuration — a `.kete/` path segment, a `kete.json`/`kete.jsonc` filename, or the global config directory |
| `cli/src/kete/job-spec.ts`, `job-git.ts`, `job-run.ts`, `job.ts` | Spec parsing, a timeout-bounded no-shell `git`, the pure run orchestration, and the real handler (Kete-owned, no markers) |

**D2, the config-edit deny.** `core/src/kete/unattended.ts`'s `applyLate` (the last `evaluate` hook,
`KeteUnattended.Plugin`) now checks `KeteUnattendedPolicy.configTarget` **first**, before its
existing "any ask becomes deny": in an unattended family, editing Kete configuration is denied even
when an earlier hook already produced "allow" (from the agent's own rules or the run's policy) —
the only case this whole plugin ever turns an "allow" into "deny", everywhere else it only ever
tightens an "ask". `applyLate` gained a third parameter (`{globalConfig}`, from `Global.Service`,
already yielded in `Plugin`'s effect) — no upstream edit, `unattended.ts` is Kete-owned.

**Only upstream edit:** `cli/src/index.ts`'s `Handlers` map (a `// kete_change start/end` block,
next to the other Kete entries): `job: { run: () => import("./kete/job") }`. It's the only
registration seam for a CLI handler (`Runtime.handlers`/`Runtime.run` read this map directly); no
plugin or config hook reaches it. `cli/src/kete/commands.ts`'s `specs` (already spread into
`commands/commands.ts` by feature/kete-login) gained the `job run` command — no further upstream
edit.

**job-run.ts's import boundary.** `packages/server/test/kete/job-run.test.ts` imports
`cli/src/kete/job-run.ts` directly (a relative path, not a package import) to run it against a real
embedded server with a fake model — this works under `tsgo -b` without adding `packages/cli` to
`server/tsconfig.json`'s `references` (confirmed: `packages/cli` isn't a composite project, and
`tsgo -b` doesn't require a `references` entry for a plain relative import, only for build-order
tracking). To keep that import cheap and side-effect-free from the server's perspective,
`job-run.ts` itself imports only `@opencode/client/promise`, `@opencode/schema/*`, `@opencode/util/*`,
`node:*` and `effect` — never another `cli/src/*` module (not even `job-spec.ts`/`job-git.ts`;
their types are duplicated structurally in `job-run.ts` instead, and `job.ts` wires the real
modules in as `Deps`).

When syncing upstream: check that upstream hasn't added its own top-level `job` command (the
spread in `commands/commands.ts` would then collide) or its own `Handlers.job` entry (same file,
same block).

### Parallel safety (feature/parallel-safety)

- `core/src/kete/stale-write.ts`: a `write` can't overwrite an existing file unless the file still
  matches the version its session last read or wrote (SHA-256 fingerprints from the session's
  reads, writes, edits and patches; files over 5 MiB aren't tracked). Tool hooks only.
- `core/src/kete/subagents.ts`: background subagents recovered after a restart get a timeout
  (`watchRecovered`); `kete.subagents.worktree: "background"` runs background subagents whose agent
  may edit in their own worktree unless the call says otherwise.
- `core/src/kete/worktrees.ts`: an agent-created worktree asks the `shell` permission for the
  project's setup script (`commands.start`) before creating the worktree.

| File                               | Change                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `core/src/tool/plugin/subagent.ts` | Whether to isolate comes from `KeteSubagents.worktree` (the input, else the setting); passes the tool call to `isolate` |
| `core/src/plugin/internal.ts`      | `Project` in the plugin services; registers `KeteStaleWrite.Plugin`                       |

### Workflows (feature/workflows)

`core/src/kete/workflows.ts` adds the `workflow` tool, which runs a workflow configured under
`kete.workflows` (docs/architecture.md §67). Each step runs through the `subagent` tool, so it gets
every subagent check, limit and worktree option. Steps whose earlier steps have finished run at the
same time, up to `kete.subagents.max_concurrent`; a step can use `{{input}}` and earlier answers
(`{{steps.<id>}}`), or continue an earlier step's session (and worktree). Invalid workflows are
refused with every problem listed. The tool is registered only while workflows are configured. The Security
and DevOps starter roles are now `mode: "all"`, so a workflow step (or the default agent) can hand
work to them.

| File                          | Change                                         |
| ----------------------------- | ---------------------------------------------- |
| `core/src/plugin/internal.ts` | Registers `KeteWorkflows.Plugin`               |

### Isolated server tests (chore/isolate-server-tests)

The server's tests start the real runtime, whose Kete plugins read the developer's account and
would sync with and register at their platform. `server/script/kete/isolated-test.ts` runs them
with a throwaway HOME and XDG directories and without credentials in the environment, like
`core/script/test.ts`.

| File                  | Change                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `server/package.json` | **No marker possible (JSON):** `test` runs `script/kete/isolated-test.ts` instead of `bun test --only-failures` (which it passes through) |

### Open source (chore/open-source-readiness, ADR 0010)

| File | Change |
| --- | --- |
| `.github/CODEOWNERS` | `* @magbotta` added; upstream's two owner lines commented out (kept for syncs) |
| `.github/ISSUE_TEMPLATE/config.yml` | Contact links: Kete's private security reporting and support email instead of OpenCode's Discord |
| `.github/ISSUE_TEMPLATE/bug-report.yml` | The version field asks for the Kete Code version (`kete --version`); its `id` is unchanged |
| `.gitignore` | Ignores `docs/status/` (local status reports, never committed) |

Kete's own public-facing files are new and Kete-owned: `.github/README.md`, `SECURITY.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (GitHub shows them instead of upstream's root files, which
stay untouched).

### MCP presets (feature/mcp-presets)

`kete mcp add harness|slack` and `kete mcp presets` (docs/integrations/). The catalogue
(`schema/src/kete/mcp-presets.ts`) expands a preset to an ordinary `mcp.servers` entry plus top-level
`permissions` rules, written into the same file upstream's `kete mcp add` writes; nothing about a
preset is special at runtime. Stored secrets: config holds `{kete-secret:mcp:<name>}` and the runtime
resolves it from the OS secret store when it spawns a local server (`core/src/kete/mcp-secrets.ts`,
`util/src/kete/mcp-secret.ts`; only `mcp:` entries resolve, only to a local server whose name owns the
entry and whose definition matches the fingerprint stored with the secret; such a server runs in
`<data>/mcp-servers/<name>` instead of the project directory). Offline mode skips the presets
(`core/src/kete/offline.ts`, Kete-owned). Slack's OAuth uses upstream's remote-MCP OAuth unchanged with
`oauth.client_id` (PKCE, no secret written).

| File | Change |
| --- | --- |
| `cli/src/commands/commands.ts` | `mcp add` takes `KeteCommands.mcpPresetParams` (`--write`, `--org`, `--project`, `--base-url`, `--client-id`, `--new-key`) and its description mentions presets; `mcp presets` subcommand (`KeteCommands.mcpPresets`) |
| `cli/src/commands/handlers/mcp/add.ts` | A preset name without `--url` or a command routes to `kete/mcp-preset.ts`; preset flags on any other server are an error (`presetInput` helper at the end of the file) |
| `cli/src/index.ts` | `mcp.presets` handler → `kete/mcp-presets-command.ts` |
| `core/src/mcp/client.ts` | Before a local server's spawn, `KeteMcpSecrets.prepare` resolves stored-secret references (refusing a definition the secret wasn't stored for) and picks the `cwd` (upstream's for servers without a secret); marked block + two marked lines + import |

**Sync checklist:** if upstream changes how `McpStdio.make` gets its environment, or adds its own
secret references to MCP config, move the `KeteMcpSecrets.prepare` call with it (both `cwd` and
`environment` must come from it). If upstream adds an
`mcp add` flag named like a preset flag, or a `presets` subcommand, the spread/registration collides.

### Upstream test edits

55 upstream test files and `core/script/test.ts` were updated so their fixtures
and assertions read `Brand` values. Examples: fixture paths (`kete.json`,
`.kete/`), expected directories, help text, terminal titles, User-Agents, and
subprocess environments (`KETE_*`). Each changed line is marked.

One recorded HTTP fixture has no marker (`.json`):
`core/test/fixtures/recordings/session-runner/openai-chat-streams-text.json`. Its
recorded system prompt reads "running in Kete Code".

`core/test/worktree.test.ts` also checks the `KETE_WORKTREE_*` setup-script variables.

`core/test/session-create.test.ts` no longer expects a type error for a child session with its own
`location` (see Subagent worktrees).

### Merge notes

- Most conflicts will be single marked lines. Re-apply them by pointing the
  literal at `Brand`.
- If upstream adds new `.opencode` / `opencode.json` literals, config discovery
  will silently miss them. After each sync, run
  `git grep -nE '"\.opencode"|opencode\.jsonc?' -- packages/*/src` and review
  any new hits.
- If upstream adds user-facing "OpenCode" strings, run
  `git grep -n 'OpenCode' -- packages/{cli,core,server,tui,util}/src` after each sync.

## Tooling (chore/upstream-sync)

`packages/kete-tools` and `packages/kete-vscode` are Kete-owned. Adding them as workspaces changes one upstream file:

| File       | Change                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun.lock` | **No marker possible (lockfile):** `packages/kete-tools` and `packages/kete-vscode` workspace entries. `upstream:sync` regenerates the lockfile, so this never conflicts |

## Chat panel design (docs/tasks/2026-09-29-chat-panel-design)

The chat panel's redesigned empty state, header and composer (Kete brand tokens, the Auto/Ask/Plan
permission-mode toggle) are Kete-owned (`packages/app/src/kete/`, `packages/kete-vscode/`). Seven
upstream files carry marked edits so the panel can render and wire into them; everything else
(tokens, CSS, components, the bridge) needs no upstream change.

| File                                                     | Change                                                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/new-session/view.tsx`                  | Renders `KetePanelHeader`/`KeteEmptyState`/`KeteCliHint` in place of the placeholder wordmark, wraps them in `KeteNewSessionLayout` (`data-kete="panel-stack"`) so panel.css can split a scrolling area (hero, tip, notices, CLI hint) from a footer pinned to the bottom (composer, project/workspace row); stops rendering `NewSessionTips` on this screen (its absolute bottom-4 popup would overlap the now-truly-pinned footer) — its definition and schemas are kept, still covered by `runtime/persistence/consumers.test.ts` |
| `packages/app/src/composer/composer.tsx`                 | Passes `KeteCommandsButton`/`KeteModeToggle` into `ComposerEditor`'s new `kete` slot                                                                                        |
| `packages/app/src/composer/editor/editor.tsx`             | An optional `kete?: { start, end }` prop (the toolbar has no other extension point) and a `kete-effort` class panel.css hides under 380px                                  |
| `packages/app/src/new-session/composer-adapter.ts`        | `session.create`'s `metadata` carries a new session's chosen permission mode (`KeteModeDraft`), the only race-free place to set it before the first tool call              |
| `packages/client/src/solid/data.ts`                       | `Data["session"].create`'s input type gains an optional `metadata` field (its body already forwarded `...payload`, including `metadata`, unchanged)                        |
| `packages/app/src/settings/about/about.tsx`               | A credit for the wordmark's bundled font (Bricolage Grotesque, SIL OFL 1.1), linking its licence text (commit d8db0ac466)                                                   |
| `packages/app/index.html`                                 | Favicon: the Kete mark (`mark.tsx`'s `MARK_RECTS`) as a data-URI SVG, in place of the "k" placeholder (commit d8db0ac466)                                                    |

## Job mode, part 1 (feature/job-tool-isolation)

Job mode (`KETE_JOB_MODE`, docs/jobs.md "Job mode"): a fail-closed build for the cloud-job runtime
image, ahead of a second-user root helper that isn't written yet. Everything Kete-owned lives under
`kete/` paths (`util/src/kete/job-mode.ts`, `util/src/kete/tool-runner.ts`,
`core/src/kete/job-request.ts` and `job-request/*.ts`, `core/src/kete/job-plugin.ts`,
`server/src/kete/job-server.ts`, `cli/src/kete/job-connection.ts`) and needs no markers. Two
upstream files carry marked edits:

| File                             | Change                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/routes.ts`            | Import, and `...KeteJobServer.replacements(options)` appended after `...overrides` in `build`'s replacement list — job mode must stay **last**, so it wins over every other replacement (the workerd profile's own `CrossSpawnSpawner.node` replacement is the precedent for this seam) |
| `core/src/plugin/internal.ts`     | Import, `KeteJobPlugin.Plugin` registered in `post` immediately **before** `KeteUnattended.Plugin` (which must stay last), and its id added to the existing marked `guarded` block |

Also, **no marker possible (JSON):** `server/package.json` gained `@opencode/ai` as a direct
dependency (it was already a transitive one through `@opencode/core`) — `kete/job-server.ts` needs
`RequestExecutor.Service`'s tag directly to build the job-mode request-executor node. `bun.lock`'s
matching change is the mechanical `bun install` output of that dependency. `bun install` after any
upstream sync that changes `@opencode/ai`'s own exports.

The process seam is upstream's own `ChildProcessSpawner` service (Effect), which ~20 existing spawn
sites already funnel through (`CrossSpawnSpawner.node`, `AppProcess`, `Environment.spawner`); job
mode replaces it with a fail-closed stub instead of adding a new one. `PersistentPty`'s and
`Formatter`'s own upstream `Interface`s are copied structurally to build their job-mode refusing/
no-op layers (no upstream edit — `Layer.succeed` against the existing service tag).

**Sync checklist**, on top of the usual one:

- Re-run `packages/core/test/kete/job-spawn-sites.test.ts` (AC1): a new upstream spawn site (a new
  tool, a new VCS backend, a new formatter) needs classifying in its allowlist, or the test fails
  with "classify this spawn site."
- Re-check `server/src/routes.ts` `build`'s replacement order: `...KeteJobServer.replacements(options)`
  must stay the last entry. An upstream reorder here would silently drop job mode's restrictions.
- Re-check `core/src/plugin/internal.ts`'s `post` list: `KeteJobPlugin.Plugin` must stay immediately
  before `KeteUnattended.Plugin`, which must stay last.
- If upstream adds a new gateway-shaped wire protocol (a new `@opencode/ai` protocol route), add a
  `core/src/kete/job-request/<family>.ts` adapter and a `family()` case in `job-request.ts`, or that
  route is refused outright in job mode (fail closed, not a bug — but worth a deliberate decision).

## Job mode, piece A1 (feature/job-socket-server)

In a cloud job, `kete`'s own server listens on a unix socket in a private directory, the per-run
password and the gateway key travel by descriptor, both `kete` processes are non-dumpable, and the
`?auth_token=` query credential is refused (docs/jobs.md "Job mode"). Kete-owned code needs no
markers: `server/src/kete/socket-listen.ts`, `server/src/kete/constant-time.ts`,
`cli/src/kete/{dumpable,job-serve,job-preflight,job-standalone}.ts`, `util/src/kete/job-secrets.ts`,
`core/src/kete/gateway.ts`. `cli/src/services/standalone.ts` is **not** edited: job mode's child is
a Kete sibling (`cli/src/kete/job-standalone.ts`) reusing upstream's `selfCommand()` and
`CrossSpawnSpawner`. Seven upstream files carry marked edits:

| File | Change | Why no seam |
| --- | --- | --- |
| `server/src/options.ts` | `socket` field in `ServerOptions` | the only way options reach `ServerProcess.start` |
| `server/src/process.ts` | Import; `bound` uses `KeteSocketListen.bind(options.socket)` when `socket` is set, else upstream's `listen` | `listen`/`bind` are private and TCP-only |
| `server/src/auth.ts` | Import; the password is compared with `KeteConstantTime.equal` instead of `===` (everywhere, not only in job mode) | the comparison itself is the defect |
| `server/src/middleware/authorization.ts` | Import; `credentialFromRequest` returns the empty credential when `?auth_token=` is present in job mode | credential extraction is private to this file |
| `cli/src/server-process.ts` | Import; `Options.socket`; `KeteJobServe.prepare` block at the top of `processEffect`; the password comes from it in job mode; `socket` passed to `start` | the password is read and the server started inside `processEffect`, with no hook between |
| `cli/src/commands/commands.ts` | `serve`'s `--socket` flag (job mode only) | `serve`'s Spec is upstream |
| `cli/src/commands/handlers/serve.ts` | Passes `socket` to `ServerProcess.run` | maps flags to `ServerProcess.run` |

**Sync checklist**, on top of the usual one:

- `server/src/process.ts`: if upstream changes `listen`/`bind`'s returned shape (`{ http, server,
  scope }`) or how `start` uses it, mirror it in `server/src/kete/socket-listen.ts` `bind`.
- `cli/src/server-process.ts`: `KeteJobServe.prepare` must stay before `Env.password` is read and
  before anything listens; a new `ServerProcess.run` mode must be refused by it in job mode. Don't
  auto-format the password ternary there: its original branches are deliberately not re-indented
  under the new outer level, and reformatting would change unmarked upstream lines.
- `server/src/middleware/authorization.ts`: a new credential source (another query parameter, a
  cookie) needs the same job-mode refusal; `server/src/auth.ts`: keep the constant-time compare.
- If upstream's `services/standalone.ts` changes how it spawns or reads its ready line, check
  whether `cli/src/kete/job-standalone.ts` should follow.

## Job mode, piece A3 (feature/job-file-confinement)

`openat2` confinement of `kete`'s own working-tree access and the entrypoint-owned audit pipe
(docs/jobs.md "Job mode"). **No upstream file is edited**: the confinement is three `LayerNode`
replacements in the Kete-owned `server/src/kete/job-server.ts` (`Environment.node` →
`core/src/kete/job-files.ts`, `FSUtil.node` → `util/src/kete/job-fs-util.ts`,
`FileSystemSearch.node` → `configured({ fff: false })`), and the audit sink is a storage seam inside
the Kete-owned `core/src/kete/audit.ts`.

**Sync checklist**, on top of the usual one:

- `FSUtil.Interface` (`util/src/fs-util.ts`) or effect's `FileSystem`: a new method fails
  `util/test/kete/job-fs-util.test.ts`'s exhaustiveness check; classify it (routed, refused or
  delegated) in `job-fs-util.ts`.
- `Environment.FilesImpl` (`core/src/environment/files.ts`): a new method must be implemented by
  `KeteJobFiles.driver` (else `execDefaults` would run it through the tool runner);
  `core/test/kete/job-files.test.ts` asserts all methods are overridden, and
  `job-files-linux.test.ts` runs the shared conformance suite against the job driver.
- A new in-process `node:fs`/`Bun.file`/`FileSystem` site in `core`/`server` fails
  `core/test/kete/job-fs-sites.test.ts`; classify it.
- If upstream changes `Environment.node`'s or `FSUtil.node`'s tag or deps, re-check the
  replacements in `job-server.ts`.

## Local models (feature/local-models)

Remote and LAN Ollama / LM Studio / vLLM hosts, a status RPC, models without tools, and offline mode
(`docs/tasks/2026-10-04-local-models`, `docs/local-models.md`). Kete-owned code needs no markers:
`util/src/kete/offline.ts`, `schema/src/kete/local-models.ts`, `core/src/kete/{local-hosts,
local-models,offline}.ts`, and the offline no-ops in `core/src/kete/{gateway,run-checks}.ts` and
`core/src/kete/sync/plugin.ts`. `schema/src/config/kete.ts` (`kete.offline`) is Kete-owned too.
Kete-owned CLI code: `cli/src/kete/{offline,offline-startup,models-pull,models-list}.ts` and the offline
refusals in `cli/src/kete/{login,sync,upgrade,updater}.ts`. Kete-owned client code: the shared picker
rules `util/src/kete/local-picker.ts`, TUI `tui/src/kete/{local-models.ts,local-offer.tsx,local-status.tsx}`,
web `app/src/kete/{local-models.ts,local-ui.tsx}` and the panel wiring in `app/src/kete/{panel.tsx,
panel.css,composer-controls.tsx}`.

| File | Change | Why no seam |
| --- | --- | --- |
| `core/src/plugin/provider/{ollama,lmstudio,vllm}.ts` | Import; the exported plugin is `make(KeteLocalHosts.origin("<id>"))` instead of `make()` (1 line each) | `origin` is the plugins' only host input apart from config (which still wins); the instances are built at module load |
| `core/src/plugin/provider/{ollama,lmstudio,vllm}.ts` | Import of `KeteOffline` (core); one marked line at the start of `discover`: `if (yield* KeteOffline.blocks(config, current.baseURL)) return undefined` (offline mode on and the base URL isn't on this machine or a private network: no discovery request, no API key sent; checked on every tick, so a project `kete.offline` counts) | discovery is closure-private and runs on the plugin's own timer; no hook can stop its requests |
| `core/src/plugin/provider/ollama.ts` | Marked block in `make`: a second `ctx.event` subscription clears this host's discovery cache entry and calls `refresh()` on `rpc.kete.local-models.rediscover` | the discovery cache and `refresh` are closure-private; no hook triggers them |
| `core/src/plugin/internal.ts` | Imports; `KeteLocalModels.Plugin` and `KeteOffline.Plugin` in `post` after `ConfigPolicyPlugin`, before `KeteJobPlugin`; `KeteOffline.Plugin.id` in `guarded` | internal plugins can only be registered here; repository config must not be able to remove offline mode |
| `core/src/session/runner/llm.ts` | The existing marked `checks({...})` call also passes `model: loaded.model` | the runner check needs the resolved model; no hook can fail a step |
| `core/src/session/runner/model.ts` | Import; `ModelUnavailableError.message` appends `KeteOffline.unavailableHint()` (empty unless offline) | a model removed by offline mode fails here, before any Kete code runs |
| `core/src/plugin/provider/opencode.ts` | Imports (`Config`, core `KeteOffline`, `Option`); `Effect.serviceOption(Config.Service)` (an optional lookup, so the plugin's declared requirements and upstream's tests stay unchanged); `load` reads `KeteOffline.active(config)` (env flag or `kete.offline` as loaded now; env flag only without config) and returns the last snapshot instead of fetching the Console config while offline | the plugin's own network call; no switch exists |
| `cli/src/index.ts` | `import "./kete/offline-startup"` inside the existing marked first-import block (right after the env bridge); `Handlers.models` becomes `{ $, pull }` (marked block) | offline mode must be decided before any module reads the environment, and only the entry point runs first; the handler map is the only place a subcommand's handler is registered |
| `cli/src/framework/runtime.ts` | Import; `Command.withGlobalFlags([PrintLogs, KeteCommands.Offline])` | global flags are registered only here; the flag's value is acted on before parsing (`kete/offline-startup.ts`), this makes the parser accept `--offline` on every command and shows it in help |
| `cli/src/commands/commands.ts` | `models` spec gains `commands: [KeteCommands.modelsPull]` (1 line) | the command tree has no extension point for a subcommand of an upstream command |
| `cli/src/services/server-connection.ts` | Import; `resolve` runs its input through `KeteCliOffline.connection` first (offline: private server; `--server` refused) | the connection choice is made only here; the background service may have been started online and a remote server's mode can't be checked |
| `cli/src/commands/handlers/models.ts` | Import; the output lines come from `KeteModelsList.lines(models, isTTY)` (local models get `tools:/vision:/ctx:` on a TTY; piped output unchanged) | the handler builds its lines inline; no hook |
| `tui/src/component/dialog-model.tsx` | Imports; `useKeteLocalStatus()`; each model's category/provider name/description/footer go through `dialogFields` (local models: "Local" group, "no tools" and context badges); the options end with `unreachableOptions(...)` (one row per unreachable local server; selecting shows the hint) | the dialog builds its options inline; no slot or hook adds rows or badges |
| `tui/src/plugin/builtins.ts` | Import and register `KeteLocalStatus` after `KeteBalance` (the "Offline" footer indicator) | built-in TUI plugins are registered only here |
| `tui/src/app.tsx` | Import; `useKeteLocalModels()` once in `App` (first-run offer; once-per-session no-tools notice) | the offer needs the app's model selection, dialog and toast, which no plugin API exposes |
| `tui/test/fixture/tui-client.ts` | Answers `POST /api/rpc/kete.local-models/status` with an empty status | the fixture fails on any unexpected request, and the model dialog now asks for status |
| `app/src/providers/models/select-dialog.tsx` | Imports; `<KeteLocalBadges>` after the Latest badge in the dialog rows and menu rows; local group titles in the menu via `groupTitle`; `<KeteLocalUnreachable />` above the dialog's model list | the picker has no extension point for badges, group titles or extra rows |
| `app/src/providers/models/provider-group.tsx` | Import; a group's title goes through `groupTitle` ("Local · Ollama") | the section header builds the title inline |

**Sync checklist**, on top of the usual one:

- `plugin/provider/{ollama,lmstudio,vllm}.ts`: the `make(origin)` signature and `configured()` (config
  `baseURL` over `origin`) are what `KeteLocalHosts` and the status probe (`core/src/kete/local-models.ts`
  `target`) mirror; if upstream changes endpoint paths (`/api/tags`, `/api/show`, `/api/v1/models`,
  `/health`, `/v1/models`), update the probe.
- `session/runner/llm.ts`: `checks` must still be called before every step with the resolved model.
- `plugin/host.ts`: plugin event streams must keep passing `rpc.*` events through (rediscovery).
- `cli/src/index.ts`: `./kete/offline-startup` must stay the import right after `./kete/env-bridge`.
- `cli/src/services/server-connection.ts`: every connection must still go through `resolve` (offline
  forces `--standalone` there).
- `tui/src/component/dialog-model.tsx`: if upstream restructures the options, keep the Local group,
  badges and unreachable rows (tests: `tui/test/kete/local-models.test.tsx`).
- `app/src/providers/models/select-dialog.tsx`: if the rows or the list container move, keep the badges
  and the unreachable lines next to them.

## Unattended secret hygiene (fix/unattended-secret-hygiene)

Commands the agent runs don't see Kete's own credentials, and in an unattended run no credentials at
all (`docs/tasks/2026-10-05-unattended-secret-hygiene`, `docs/jobs.md` "Secrets in an unattended run").
The rules live in the Kete-owned `core/src/kete/tool-env.ts`; `kete.unattended.passEnv` is in the
Kete-owned `schema/src/config/kete.ts`. `kete job run`'s project-config trust check is Kete-owned
(`cli/src/kete/job-project-config.ts`, `job-run.ts`, `job.ts`, `commands.ts`) and touches no upstream file.

| File | Change | Why no seam |
| --- | --- | --- |
| `core/src/shell.ts` | Import; `create`'s `env` spreads `KeteToolEnv.withoutKeteCredentials(sessionEnvironment ?? process.env)` instead of the raw environment (1 marked line) | the `shell.create.before` hook runs after the environment is built but carries no session, and a plugin hook could be removed by config; the always-on part needs no session |
| `core/src/tool/plugin/shell.ts` | Import; a marked block building the `KeteToolEnv.Lookup` (session getter, `kete` config); one marked line in the `before` callback: `invocation.env = yield* KeteToolEnv.forSession(...)` after `prepare` | only the shell tool knows the session a command belongs to at spawn time (`ShellCreateBefore` has no session ID) |

**Sync checklist:** if upstream renames `Shell.create`'s `env` construction or the shell tool's `before`
callback, keep both calls: the first on every shell, the second with the tool's `context.sessionID`. If
upstream adds another agent-driven way to spawn commands (a new tool), route its environment through
`KeteToolEnv.forSession` too. Test: `core/test/kete/tool-env-shell.test.ts`.

## Local OS sandbox (feature/local-sandbox)

The agent's shell commands run in `sandbox-exec` (macOS) or `bwrap` (Linux) — ADR 0013,
`docs/sandbox.md`, `docs/tasks/2026-10-08-local-sandbox`. The logic is Kete-owned
(`core/src/kete/sandbox.ts`, `core/src/kete/sandbox/*`, `schema/src/kete/sandbox.ts`,
`schema/src/config/kete.ts`, `cli/src/kete/sandbox.ts`, `tui/src/kete/sandbox-status.tsx`); the
approval mark is set in the Kete-owned `permission-mode.ts` and `unattended.ts`.

| File | Change | Why no seam |
| --- | --- | --- |
| `core/src/shell.ts` | Import; `const sandboxed = KeteSandboxPlans.wrap(invocation, invocation.shell, args)` and `ChildProcess.make(sandboxed.file, sandboxed.args, …)` (2 marked lines) | the `shell.create.before` hook can change the shell and command but not the spawned program and its arguments; the plan is keyed by the invocation object, so commands the shell tool didn't plan (the user's `!` commands) are unchanged |
| `core/src/tool/plugin/shell.ts` | Imports; input field `sandbox` (`"network" \| "off"`); a marked block creating the sandboxer (needs `Global`, `Location`); the permission check's metadata held in a variable and `KeteSandbox.remember(invocation, metadata)` (the hooks mark a person's approval on it); in `before`, `sandbox.prepare(invocation, context.sessionID, …)` with a `permission.assert` for `sandbox_off`/`sandbox_network`; release of Linux placeholders on error and after the command; a marked block appending the sandbox notice to the output | only the shell tool knows the session, the permission outcome and the command's cwd at spawn time |
| `core/src/plugin/internal.ts` | Import; `KeteSandbox.Plugin` in `pre` after `KetePermissionMode.Plugin`; `KeteSandbox.ApprovalPlugin` last in `post` (after `KeteUnattended.Plugin`); both ids in `guarded` | internal plugin registration list; guarded so repository config can't remove the hook that makes requested escapes ask |
| `tui/src/util/permission.ts` | A marked block: prompt title and lines for `sandbox_off`/`sandbox_network` (the command and what approving means) | the presentation switch has no extension point; otherwise the prompt says only "Call tool sandbox_off" |
| `app/src/runtime/i18n/en.ts` | Two marked keys: `settings.permissions.tool.sandbox_{off,network}.description` | the web/VS Code/JetBrains permission dock reads its description from these keys |
| `core/test/tool-shell.test.ts` | Two marked lines: `Global.node`, `Location.node` in the shell plugin's test deps | the shell tool now requires them |

**Sync checklist:** if upstream changes how `Shell.create` spawns (`ChildProcess.make` arguments) or
the shell tool's `before` callback / permission metadata, keep: the wrap at the spawn, `remember`
after the shell permission check, `prepare` after `KeteToolEnv.forSession`, and the release. If
upstream adds another agent-driven command tool, route it through `KeteSandbox` too. Tests:
`core/test/kete/sandbox*.test.ts` (the integration ones run the real sandbox; CI installs bubblewrap).
