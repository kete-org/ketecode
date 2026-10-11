# Handoff: Folder trust on first run (A10)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-11 planner
Done: plan.md written (Large; upstream edits in 7 files, new contracts, security change). Cards current
(`stale-cards.mjs`: all current).

Docs enough: no — missing: where project config is classified and where plugin directories are loaded
(opened `core/src/config.ts` `load`/`loadFile`, `core/src/config/discovery.ts`, `core/src/config/plugin/source.ts`
`scan`, `core/src/plugin/source-directory.ts`).
Docs enough: no — missing: how a location reacts to a config change (opened `core/src/plugin/supervisor.ts:205-215`:
plugins reactivate on config `Event.Updated`; `core/src/location-service-map.ts`, `location-services.ts`).
Docs enough: no — missing: Form is location-scoped and how the `"global"` owner is routed
(`core/src/form.ts`, `server/src/middleware/form-location.ts`).
Docs enough: no — missing: `kete run` uses the shared background service by default and spawns a child for
`--standalone` (`cli/src/services/server-connection.ts:23-55`, `standalone.ts`), and it cancels `"global"` forms
when exclusive (`cli/src/run/noninteractive.ts:185-193,711`).
Docs enough: no — missing: ACP only cancels its own sessions' forms, not `"global"` ones (`cli/src/acp/event.ts:179`).
Docs enough: no — missing: hooks trust select/fingerprint internals (`core/src/kete/hooks.ts:173-395`).
Docs enough: no — missing: util has no jsonc-parser and cli doesn't depend on `@opencode/core` (package.json files),
so the shared guarded list goes in util and takes parsed documents.

Decisions:
- Gate in `Config.load` (fail closed), with the prompt raised by a Kete location service and the reload done
  through Config's own `requestReload`, so no location invalidation and no internal-plugin edits are needed.
- Fingerprint over pre-substitution raw values; paths are relative to the working-tree top; plugin dirs are
  hashed with caps.
- Linked worktrees share the main root only when git's back-link verifies.
- Run-only trust uses a private server and the `OPENCODE_TRUST_RUN_PARENT` == ppid rule; the server never
  reads `KETE_TRUST_PROJECT_CONFIG`.

Open questions (maintainer, before build):
1. Security: project `formatter`/`lsp` commands, `shell`, the `worktree` setup script and `permissions`
   loosening are not in the approved guarded list, but they run code or widen access. Extend the list in this task?
2. AC9 says ACP cancels the trust form. In fact ACP leaves `"global"` forms alone: the form stays pending,
   guarded settings stay held back and the warning goes to the log. Is that acceptable as written?
3. With the flag, `kete job run` now uses a private server. Without it, guarded settings in a parent
   directory above the repository are now held back. Is that an acceptable reading of AC8?
4. There's no root CHANGELOG. Release notes go in at release time; is that OK?

## 2026-10-11 maintainer decisions (relayed by the main session)
Answers to the planner's open questions. Q1 follows the maintainer's D1 principle ("hold back anything that can
run code or send data elsewhere"); Q2–Q4 follow the approved spec's fail-closed intent.
1. Extend the runtime trust gate's guarded set with: project `formatter` commands, `shell`, the `worktree`
   setup script, and project permission rules whose effect loosens (allow). Project deny/ask rules still apply.
   LSP needs nothing (commands/env already count only from the global config). `kete job run` keeps its
   current guarded list (job mode loads no project config; don't start refusing repos that set formatter or
   permissions). So: one shared module exporting the job list and the (larger) runtime trust list.
2. ACP: the `"global"` form stays pending, guarded settings stay held back, warning to the log — acceptable
   (fails closed). Update AC9's wording in the result, not the behaviour.
3. `kete job run`: private server with the flag; without it, guarded settings above the repo are now held
   back too — acceptable (stricter).
4. No root CHANGELOG: release notes at release time (`docs/release.md`); `docs/folder-trust.md` carries the
   behaviour change.

## 2026-10-11 planner (revision)
Done: plan.md revised for the maintainer decisions. Cards re-checked (`stale-cards.mjs`: all current). Now
8 upstream files (added `core/src/config/plugin/agent.ts`); 61 rows in the file table.

Docs enough: no — missing: config key shapes and readers for the extended set (opened `schema/src/config.ts`,
`schema/src/config/{formatter,worktree}.ts`, `schema/src/permission.ts`, `core/src/config/plugin/{formatter,shell,worktree,agent}.ts`).
Docs enough: no — missing: rule precedence (opened `core/src/permission.ts:88-95`, `findLast`: last match wins).
Docs enough: no — missing: where the worktree setup script comes from (`core/src/project.ts:216-228`,
`core/src/worktree.ts:242`, `core/src/kete/worktrees.ts:189`): it's a project-row field set through the API,
not project config.
Docs enough: no — missing: project agent markdown files carry `permissions` (and legacy `permission`) in
frontmatter, decoded by `ConfigAgentPlugin` after config load (`config/plugin/agent.ts:40-50,177-216`).

Decisions (implementing decision 1):
- Shared util module exports the job list (unchanged, `kete job run` only) and the larger runtime list.
- `formatter` is held back unless it only disables (`formatter: true` enables built-ins that run
  project-local binaries). `shell` and `worktree` are held back whole. "The worktree setup script" maps to
  `worktree.directory` (where worktrees and the script run); the script itself isn't in project config.
- Loosening permission rules = `allow` rules in project `permissions`, `agents.*.permissions` and project
  agent markdown files (new marked seam in `config/plugin/agent.ts`). Because rules are last-match-wins, a
  project `ask` overlapping a machine-level `deny` (by action, `Wildcard.match` either way) is also held back;
  other deny/ask rules apply. Maintainer may veto this reading of "deny/ask still apply".
- Agent markdown files count as guarded by a text test ("permission" and "allow"), hashed by content, so
  util, CLI and core fingerprints agree without a YAML parser in util.

Open (not blocking): project `skills`/`instructions` URLs, `references` git URLs and agent `request.headers`
still reach the network or providers from an untrusted folder; outside the decided set, listed as a risk
for a follow-up.

## 2026-10-11 implementer
Done: steps 1–15 built; checks run (see the end of this entry). Not committed.

Files changed (Kete-owned, new): `util/src/kete/{folder-trust,trust-store,folder-trust-store}.ts`,
`core/src/kete/folder-trust.ts`, `core/src/kete/folder-trust/{memory,form}.ts`,
`cli/src/kete/{folder-trust,trust}.ts`, `app/src/kete/{global-forms.ts,global-form-dock.tsx}`,
tests `util/test/kete/folder-trust.test.ts`, `core/test/kete/folder-trust.test.ts`,
`cli/test/kete/{trust,folder-trust-run}.test.ts`, `app/src/kete/global-forms.test.ts`,
`docs/folder-trust.md`.
Changed (Kete-owned): `core/src/kete/hooks.ts`, `core/src/kete/hooks/{settings,trust}.ts`,
`core/test/kete/job-fs-sites.test.ts`, `cli/src/kete/{commands,job,job-project-config}.ts`,
`app/src/kete/panel.css`, `kete-tools/src/lib.ts` + test (`docs/folder-trust.md` is Kete-owned),
`docs/{hooks,permissions,upstream-patches}.md`, `kete-vscode/CHANGELOG.md` (new "Unreleased").
Upstream (all marked, recorded under "Folder trust" in docs/upstream-patches.md): `core/src/config.ts`,
`core/src/config/plugin/{source,agent}.ts`, `core/src/plugin/internal.ts`, `core/script/test.ts`,
`cli/src/commands/commands.ts`, `cli/src/commands/handlers/run.ts`, `cli/src/index.ts`,
`cli/src/run/{run,noninteractive}.ts`, `app/src/composer/composer.tsx`.
No server endpoint, protocol or schema type changed: protocol/client not regenerated (confirmed).

Deviations from plan.md (each fail-closed or forced; reviewer please confirm):
1. **formatter disable-only = `false` only.** The plan exempted an object whose entries are all
   `{disabled: true}`, but `config/plugin/formatter.ts` turns on every built-in formatter for any
   truthy `formatter` (object included) before removing the disabled ones, so that object would run
   project-local binaries. Held back instead.
2. **Legacy `tools` counts as a permission key** (top level and in v1 agents): normalize.ts migrates
   `tools: {x: true}` to allow rules; without it a folder whose only loosening was `tools` wouldn't
   ask or be fingerprinted. Agent-file text test also matches front matter with `tools` + `true`.
3. **"Held back" is decided from the strip result on the normalized info** (plus plugin dirs and
   agent files), not from raw keys, so a folder with only deny/ask rules never asks. The fingerprint
   still covers raw values (whole permission values) of every guarded key, as planned.
4. **Agent/plugin seams fail closed in the "clear" state too:** `pluginsAllowed` and
   `agentDocuments` pass project dirs only when trusted (a plugin added between gate and scan can't
   load; stripping is a no-op when nothing loosens).
5. **Import cycle:** `projectHooksTrust`/`repositoryKeyOf` live in `kete/hooks/settings.ts`, not
   `hooks.ts` (folder-trust → hooks.ts → shell → config cycled). `select` uses them; hooks tests green.
6. **Agent seam uses `Effect.serviceOption`** (and `KeteFolderTrust` was added to plugin/internal.ts
   services + requirements, as step 7 anticipated). A hard `yield*` broke typechecking of upstream
   tests that run ConfigAgentPlugin with a minimal context; in a runtime location it is always present.
7. **Hooks store schema moved to util** (`KeteTrustStore.hooks`) so `kete trust remove` can forget
   project hooks without the CLI depending on core; same file and format.
8. **Run-trust for the core suite:** `core/script/test.ts` sets `OPENCODE_TRUST_RUN_PARENT` to its
   own pid (the test child is its direct child), otherwise every upstream fixture with guarded
   project config (shell, providers, mcp, permissions, hooks) is held back. The folder-trust test
   builds the service with `configured({env: {}, ppid: 0})`. Server's isolated test script was not
   changed (see verify result below).
9. `--trust-project-config` is applied in `cli/src/commands/handlers/run.ts` (where
   `ServerConnection.resolve` is), not `run/run.ts`; run.ts prints the warning.
10. Web UI: upstream `SessionQuestionDock` replies via session routes without a location, so the
    Kete dock renders global forms itself (single-choice forms answerable; others dismissable) and
    replies through `data.session.form.reply/cancel` with the location. Component file is
    `global-form-dock.tsx` (logic in `global-forms.ts`, test `global-forms.test.ts`: bun can't
    compile Solid JSX in unit tests).
11. Fingerprint paths are realpath'd before being made relative (macOS `/var` vs `/private/var`,
    symlinks), so core and the CLI agree.
12. `core/test/kete/job-fs-sites.test.ts` allowlist: added util `folder-trust.ts` (off-in-job) and
    `trust-store.ts` (data-dir); removed `core/src/kete/hooks.ts` and `hooks/trust.ts` (no longer
    touch fs).

Open questions / follow-ups:
- CLI `inspect` doesn't read machine-level deny rules, so `kete run`'s warning won't name an `ask`
  held back only because it overlaps a global deny (the runtime still holds it back).
- Residual unguarded paths from the plan's risks stand (skills/instructions URLs, references, agent
  `request.headers`).
- Web dock: MCP elicitations with non-choice fields can only be dismissed there.
13. `server/script/kete/isolated-test.ts` (Kete-owned) got the same run trust as core's script: verify
    showed 4 new server failures without it (fixtures with project MCP/plugins/config); after it,
    server is 101 pass / 0 fail, as on main.

Checks (2026-10-11):
- typecheck: util, core, cli, tui, app, kete-tools, server — PASS.
- util `bun run test` 356 pass / 0 fail; kete-tools 59/0; cli 609/0; tui 1442/0; app `test:unit` 1015/0;
  server 101/0 (after item 13).
- core `bun run test`: 6906 pass / 30 fail — the 30 are the known machine-dependent failures
  (23 ripgrep, 7 shell syntax), same set on main per verify ("new failures 0").
- core folder-trust.test.ts 12/0; hooks.test.ts 28/0; util folder-trust.test.ts 26/0; cli trust +
  folder-trust-run 13/0; job-project-config + job-run 52/0.
- root `bun run lint`: 0 warnings, 0 errors. `upstream:check`: passed.
- `verify --base main`: new failures only in server (fixed by item 13; server re-run green, verify not
  re-run in full).
- Binary built (`--single --skip-install --skip-web-ui`) and checked by hand with isolated HOME/XDG
  and KETE_OFFLINE=1 on a fixture repo: `kete run` prints the held-back warning (MCP command,
  provider endpoint, plugin dir); `--trust-project-config` prints none and stores nothing;
  `--trust-project-config --server` refused; `kete trust add` (home refused, exit 2; repo stored),
  `list`, `list --format json`, `remove` work; after `add`, `kete run` prints no warning. The TUI and
  web prompts weren't exercised by hand (no model configured in the isolated env); covered by tests.
- Not run: the reviewer/upstream-guard security review (separate step).

## 2026-10-11 implementer (security-review fixes)
Done: every finding from the security review fixed on `feature/folder-trust`, one regression test each
(core `test/kete/folder-trust.test.ts` "Security review fixes" block, util `test/kete/folder-trust.test.ts`
"security review fixes", cli `test/kete/trust.test.ts`, new tui `test/kete/folder-trust.test.ts`).

- **C2 (TUI project plugins):** new `kete.folder.trust` plugin RPC (`schema/src/kete/folder-trust.ts`,
  `core/src/kete/folder-trust/rpc.ts`, registered in `plugin/internal.ts`; served by the existing
  `/api/rpc` route, so no endpoint/protocol change and nothing regenerated). `status` reads the config
  first, then answers `{ trusted }` (true only for store/run/job trust); `changed` is emitted after every
  `config.updated`. The TUI (`tui/src/kete/folder-trust.ts`, marked seam in `plugin/context.tsx`) passes
  project `.kete/plugins` directories to discovery only when the RPC says trusted; error, timeout,
  malformed answer or an older runtime = untrusted. It asks only when a project plugin directory has
  entries (an unreadable one counts), and re-reconciles on a `changed` event that says trusted.
- **M1a:** the fingerprint (v2) hashes the contents of every `{file:…}` target used by a guarded value
  (`guardedFileTokens`: decided on the JSON-decoded token, hashing the raw path substitution actually
  reads, so an escape can't hide one); a non-regular target, or a path built from `{env:}`, has no
  fingerprint. It also covers each document's token list.
- **M1b:** a project document whose raw text doesn't parse but has substitution tokens makes the
  fingerprint unavailable; core and the CLI refuse to trust, and the question offers "Not now" with the
  reason. A document that parses neither way never loads, so it is ignored (as before).
- **M1c:** `agentFiles` returns every agent markdown file; all are hashed whole. Core decides which
  rules loosen on the YAML-decoded front matter (`ConfigMarkdown.parseOption` + `frontMatterRules`), so
  `"\x61llow"` is listed and held. The CLI (no YAML parser) keeps a broadened text test only for what it
  shows. Consequence: editing any agent file in a trusted folder that holds something back asks again.
- **M2:** `Config.load` now loads project files raw (tokens left literal) and hands `gate` a loader;
  only when the folder is trusted (store/run/job) are project files substituted, from the text the raw
  pass read (no second read, no TOCTOU). `{env:}`/`{file:}` use is itself a held item ("reads
  environment variable …", "reads file …"), so a folder that uses them asks; remote `skills` URLs and git
  `references` are held back (local ones load).
- **M3:** the question is built from the normalized config: core describes what `strip` removed
  (normalized MCP servers, so legacy top-level servers next to `mcp.servers` and a server named
  `timeout` both show), provider `package`/`env`/model packages, MCP environment variable names, each
  project hook command (match, network). The CLI's raw `describe` reads MCP the way the normalizer does.
- **M4 (choice):** overlay at the gate rather than changing every reader. `shield` rewrites each project
  document's `kete` object after gating, in every trust state: `offline` is true when the machine-level
  `kete` (last non-project document with one) says true; `integrations`, `platform`, `unattended` come
  from the machine level when the project doesn't set them (or they were held back). Why: it's one
  Kete-owned function at the one point every reader goes through (Config.latest in offline, run-checks,
  local-models, unattended, gateway, sync, shell…), so no reader can be missed and no upstream file
  changes; `hooks`, `sandbox` and `lsp` aren't overlaid because their readers already read every
  document by path (overlaying would make global hooks look like project hooks). Not covered (unchanged
  documented behaviour): `budget`, `subagents`, `workflows`, `runtime` are still masked by a project
  `kete` object.
- **minor1:** `safe` escapes `\p{Cc}\p{Cf}\p{Zl}\p{Zp}` (C0/C1 incl. U+009B, bidi, zero-width, BOM) in
  every item, the root path and the refusal; values are shown in full by `describe`. The form cuts long
  items/lists, and then (`trustable` false) offers "Not now" only and points to `kete trust add`, which
  prints everything (CLI output escaped too).
- **minor2:** job mode trusts only when no project document or directory loaded; otherwise normal check.
- **minor3:** with no service the agent seam strips loosening rules (deny-all machine denies) from every
  directory but the global config. Before the first gate, `machineDeny` is deny-all too.
- **minor4:** project `experimental.policies` allow statements are held back (deny statements kept),
  shown and fingerprinted.
- **minor5:** deny rules from the machine-level agent markdown files (global config directory) are
  machine denies.
- **minor6:** `readBounded` and `hashFile` stat (following symlinks) before reading; a non-regular file
  or one over the remaining byte cap is never read.

Files changed: util `src/kete/folder-trust.ts` + test; core `src/kete/folder-trust.ts`,
`src/kete/folder-trust/{form,rpc}.ts` (rpc new), `src/config.ts`, `src/config/plugin/agent.ts`,
`src/plugin/internal.ts` + test; schema `src/kete/folder-trust.ts` (new); cli `src/kete/{folder-trust,trust}.ts`
+ test; tui `src/kete/folder-trust.ts` (new), `src/plugin/context.tsx`, `test/kete/folder-trust.test.ts`
(new); `docs/folder-trust.md`, `docs/upstream-patches.md` (appended).

Open: CLI's agent-file list is still a text heuristic (display only; fingerprints agree with core).
`budget`/`subagents`/`workflows`/`runtime` masking by a project `kete` object is unchanged (documented
pitfall). A `{file:}` token used only by non-guarded values is fingerprinted by path, not content.
