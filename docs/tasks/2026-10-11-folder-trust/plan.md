# Plan: Folder trust on first run (A10)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large task: approval needed before building.** The plan edits upstream files (marked seams in
> `core/src/config.ts`, `core/src/config/plugin/source.ts`, `core/src/config/plugin/agent.ts`,
> `cli/src/commands/commands.ts`, `cli/src/index.ts`, `cli/src/run/run.ts`, `cli/src/run/noninteractive.ts`,
> `app/src/composer/composer.tsx`), adds contracts (form kind `kete.folder.trust`, `kete trust`,
> `kete run --trust-project-config`, the state file `folder-trust.json`) and is a security change. It changes
> no server endpoint, protocol type or config schema, so `packages/protocol` and `packages/client` are not
> regenerated.
>
> **Revised 2026-10-11** after the maintainer's decisions (handoff.md): the runtime gate holds back an extended
> set (formatter commands, `shell`, `worktree`, loosening permission rules, including those in project agent
> files); `kete job run` keeps its own, unchanged list. ACP, `kete job run` and the CHANGELOG questions are
> settled as the plan already had them.

## Cards read
- docs/context/modules/config-kete.md (verified-at 006573bd58, stale: no)
- docs/context/modules/hooks.md (verified-at f3d1b962ee, stale: no)
- docs/context/modules/permissions.md (verified-at 006573bd58, stale: no)
- docs/context/modules/sandbox.md (stale: no)
- docs/context/modules/server-sdk.md (stale: no)
- docs/context/modules/cli.md (verified-at f3d1b962ee, stale: no)
- docs/context/modules/vscode-extension.md (verified-at f3d1b962ee, stale: no)
- docs/context/modules/web-app.md (verified-at 006573bd58, stale: no)
- docs/context/modules/jetbrains-plugin.md (stale: no)
- docs/context/pitfalls.md, docs/context/commands.md, CLAUDE.md

## Design summary (read before the steps)
- **Gate in config loading (fail closed).** `Config.layer`'s `load` (`core/src/config.ts:195-239`) passes its
  full entry list through a Kete location service, `KeteFolderTrust.Service`. Project-level documents are
  the ones from `sources.direct` and from `sources.project` directories (`load`'s `direct` and
  `projectSupplementary`). Wellknown, global, explicit (`KETE_CONFIG`) and content documents belong to the
  machine's owner and are never gated. When the trust root isn't trusted for the current fingerprint, every
  project document loses its runtime-guarded values (next bullet) and the gate records the project `.kete/`
  directories as held back for plugins and agent permissions. MCP, providers, share, enterprise, formatter,
  shell, worktree, permission, `kete.*` readers and hooks see only
  gated entries, so nothing guarded can start before trust. Plugin directories are held back in
  `ConfigPluginSource.scan` (`core/src/config/plugin/source.ts:121-135`), which asks the service. Agent
  markdown files still load from the same `Directory` entries, but `ConfigAgentPlugin`'s `loadEntry`
  (`config/plugin/agent.ts:40-50`) asks the service to strip their loosening rules. Commands, skills and
  instructions load unchanged.
- **Two guarded lists, one module (spec 4, decision 1).** `util/src/kete/folder-trust.ts` exports
  `JOB_GUARDED`/`guardedKeys(doc)` (today's `kete job run` list, moved verbatim, behaviour unchanged) and the
  larger runtime list used by the gate: the job list plus
  - `formatter`, unless it only disables (`false`, or an object whose every entry is exactly
    `{disabled: true}`). `formatter: true` counts: built-in formatters run project-local binaries
    (`core/src/formatter/builtins.ts` via `config/plugin/formatter.ts:28-53`, `Config.latest`).
  - `shell` (whole key; `config/plugin/shell.ts:16`, `Config.latest`).
  - `worktree` (whole key): `worktree.directory` decides where worktrees are created, and so where the setup
    script runs; it can point at `~/…` (`config/plugin/worktree.ts`). The setup script itself
    (`commands.start`) is not project config: it is a project-row field set through the project update API
    (`core/src/project.ts:216-228`) and is asked for as a shell permission before a subagent worktree runs it
    (`kete/worktrees.ts:189-196`). Nothing else to gate there.
  - Loosening permission rules: every rule with effect `allow` in a project document's `permissions`, in
    `agents.<id>.permissions`, and in project agent markdown files (`.kete/{agent,agents,mode,modes}/*.md`
    frontmatter, decoded by `config/plugin/agent.ts`). Rules are last-match-wins (`permission.ts:88-92`
    `findLast`), so a project `ask` placed after a machine `deny` would turn the deny into an ask. The gate
    therefore also holds back a project `ask` rule when any machine-level document (global, wellknown,
    explicit, content) has a `deny` rule whose action overlaps it (`Wildcard.match` in either direction). All
    other `deny` and `ask` rules still apply. Legacy v1 keys (`permission`, `agent`, `mode`) are covered
    because stripping works on the normalized `info` (`config/normalize.ts:180`), and the fingerprint reads
    the raw keys.
  - LSP needs nothing (its commands and env already count only from the global config).
- **Trust takes effect without a restart.** On Trust, the service stores trust and emits on `changes()`.
  Config subscribes and calls its own `requestReload` (`config.ts:247`). The reload re-runs the gate, which
  now passes, and publishes `Event.Updated`. The plugin supervisor reactivates on that event
  (`core/src/plugin/supervisor.ts:213`), so plugins and the MCP/provider config plugins pick up the full
  config. A process-wide global node (`KeteFolderTrustMemory`) holds the "Not now" set, the pending
  questions and a trusted-roots PubSub, so every location under the same root reloads and asks once.
- **The prompt.** The service raises the form itself (it depends on `Form.node`) in a fiber forked into its
  location scope the first time a gate result holds something back. Owner: `"global"`. Metadata:
  `{kind: "kete.folder.trust"}`. There is one shared question per trust root and fingerprint. Answers are
  `trust` and `later`. A home or `/` root, an unfingerprintable folder (over the caps) or an unresolvable
  root offers `later` only, with the reason. A cancelled or unanswered form counts as Not now.
- **Trust root.** Resolve the real path, then find the nearest ancestor with a `.git` entry. A `.git`
  *file* (linked worktree) maps to the main working tree only if git's back-link
  `<commondir>/worktrees/<name>/gitdir` points back to this `.git` file. Otherwise the worktree's own
  top-level is the root, so a forged `.git` file can't borrow another repository's trust. Without a
  repository, the root is the directory itself. Store keys are exact real paths, lowercased on Windows,
  and compared by equality only (never by prefix).
- **Fingerprint.** sha256 of a canonical JSON with
  `{v:1, documents:[{path, guarded:{key: rawValue}}], plugins:[{path, files:[{path, sha256}]}], agents:[{path, sha256}]}`.
  For permissions, `guarded` holds the raw `permission`/`permissions` values and each raw `agents`/`agent`/`mode`
  entry's `permission(s)` sub-value (whole value, deny rules included, so the reviewed set is what's hashed).
  `agents` hashes every project agent markdown file whose text contains both `permission` and `allow`
  (case-insensitive; no YAML parser needed, so util and CLI compute it identically). The same text test
  decides whether agent files count as held back (a superset of what the agent seam strips; fail closed).
  Raw values are the pre-substitution JSONC values, so a rotated `{env:…}` secret doesn't re-ask and
  no secret is ever stored. Paths are relative to the working-tree top when inside it, else absolute.
  Plugin directories are hashed recursively, following symlinks with a cycle guard. Caps are 5,000
  files or 50 MiB; over a cap, there's no fingerprint and the folder can't be trusted (fail closed).
  The core gate and the CLI compute it with the same util function.
- **Run-only trust.** `kete run`/`kete job run` with `--trust-project-config` or `KETE_TRUST_PROJECT_CONFIG=1`
  force a private standalone server, as offline mode does (`KeteCliOffline.connection`). They set
  `OPENCODE_TRUST_RUN_PARENT=<own pid>` for it. The server honours that only when it equals
  `process.ppid`, so a background service that inherits the variable never trusts everything. The
  plain `KETE_TRUST_PROJECT_CONFIG` is never read by the server. Nothing is stored.
- **Hooks (AC10).** `kete.hooks` is a guarded key, so untrusted project hooks never reach the hooks
  plugin. On Trust, the service also writes the hooks trust entry, computed from the ungated entries by the
  same function the hooks plugin uses. Trusting the folder therefore raises no second question.

## Files
| File | Read / change | Why |
|---|---|---|
| docs/tasks/2026-10-11-folder-trust/spec.md | read | requirements, ACs |
| packages/util/src/kete/folder-trust.ts | create | shared, pure (no jsonc dep; callers pass parsed docs): `JOB_GUARDED` + `guardedKeys(doc)` (moved verbatim from job-project-config, job list only) + the runtime list `runtimeGuarded(doc)` (job list + formatter/shell/worktree/permission values, raw shape incl. legacy keys) + `loosening(rules, machineDeny)` (allow, and ask overlapping a machine deny; pure, takes a `match(pattern, value)` function so core passes `Wildcard.match`) + `agentPermissionFiles(dir, fs)` (text test) + `guardedValues(doc)` + `describe(doc)` (display items: MCP local command/args or remote URL, provider endpoint-like string fields and header *names*, plugin specs, other keys by name; never apiKey/header values); `trustRoot(dir, fs)`; `neverTrusted(key, home)`; `storeKey(path, platform)`; `fingerprint(input, fs)` with caps; `RUN_TRUST_VARIABLE`, `runTrusted(env, ppid)`; `FORM_KIND = "kete.folder.trust"` |
| packages/util/src/kete/trust-store.ts | create | generic atomic, capped, 0600, fail-closed JSON store, factored out of hooks/trust.ts; `make(stateDir, file, entrySchema)` → `read/list/get/set/remove` |
| packages/util/src/kete/folder-trust-store.ts | create | `folder-trust.json` over trust-store.ts: `{version:1, folders: Record<key,{fingerprint, held: string[], trusted: number}>}`, 500 entries; `trusted/trust/remove/list` |
| packages/core/src/kete/hooks/trust.ts | change (Kete) | reuse util/trust-store.ts; same on-disk format (`hooks-trust.json` stays valid) |
| packages/core/src/kete/hooks.ts | read + change (Kete) | extract the project-hooks fingerprint part of `select` (`:340-395`: collect, `unsafeCommand`, `referencedFiles`, `fingerprint`, repository key `:186-187`) into an exported function the folder-trust service reuses; `select` calls it; behaviour unchanged |
| packages/core/src/kete/hooks/settings.ts | read | `collect`, `fingerprint`, `referencedFiles`, `inside` used by the extracted function |
| packages/core/src/kete/folder-trust.ts | create | `KeteFolderTrust` location service + node (deps `Global.node`, `FSUtil.node`, `Location.node`, `Form.node`, `KeteFolderTrustMemory.node`): `gate(entries, project, texts)`, `pluginsAllowed(dir)`, `agentDocuments(dir, documents)`, `changes()`, `status()`; prompt fiber; Trust → folder store + hooks trust + memory publish; logs one warning per root+fingerprint naming what's held back (the ACP and attached-client path); job mode (`KeteJobMode.enabled`) → pass-through |
| packages/core/src/kete/folder-trust/memory.ts | create | `KeteFolderTrustMemory` global node (`makeGlobalNode`): declined set, pending map, trusted-roots PubSub; per process, not module state |
| packages/core/src/kete/folder-trust/form.ts | create | builds the form fields and description (escaped plain text, bounded length, like hooks' `trustDescription`) and parses the answer |
| packages/core/src/config.ts | read + change (upstream, marked) | the seam: import; `const folderTrust = yield* KeteFolderTrust.Service`; record each project file's raw text in a per-layer `Map` in `loadFile` (`:137-144`); wrap `load`'s return (`:231-238`) with `folderTrust.gate(...)`; fork `folderTrust.changes()` → `requestReload`; add `KeteFolderTrust.node` to `configured()` deps (`:371`) |
| packages/core/src/config/discovery.ts | read | which paths are project sources (`direct`, `project`) |
| packages/core/src/config/plugin/source.ts | read + change (upstream, marked) | `scan` (`:121-135`) skips plugin-directory discovery for directories `pluginsAllowed` refuses; service yield in `layer`; `KeteFolderTrust.node` in `node` deps (`:93-97`) |
| packages/core/src/config/plugin/agent.ts | read + change (upstream, marked) | `loadEntry` (`:40-50`): for a `Directory` entry, pass decoded documents through `folderTrust.agentDocuments(entry.path, documents)`; yield the service in the plugin effect. Read `decode` (`:177-216`) for the document shape (`agents.<name>.permissions`) |
| packages/core/src/config/plugin/formatter.ts | read (`:25-55`) | `formatter` semantics (`Config.latest`, `true` enables built-ins, `disabled`) for the disable-only rule |
| packages/core/src/config/plugin/shell.ts, packages/core/src/config/plugin/worktree.ts | read | `shell` and `worktree.directory` readers (confirm whole-key hold-back is enough) |
| packages/core/src/permission.ts | read (`:88-95`) | `evaluate` is last-match-wins; `Wildcard` import path for the overlap check |
| packages/core/src/config/normalize.ts | read (`:170-215`, `:495-520`) | legacy `permission`/`agent`/`mode` migrate into `permissions`/`agents`, so stripping on `info` covers them |
| packages/schema/src/config.ts, packages/schema/src/permission.ts, packages/schema/src/config/formatter.ts | read | `Info` keys (`shell` `:30`, `permissions` `:55`, `formatter` `:67`, `worktree` `:103`), `Rule`/`Effect`, `ConfigFormatter.Entry` |
| packages/core/src/plugin/source-directory.ts | read | plugin dir names `plugin`/`plugins` (keep util's copy equal; test) |
| packages/core/src/plugin/supervisor.ts | read (`:205-215`) | confirms reload on `Event.Updated` |
| packages/core/src/form.ts | read | `ask`/`create` input, cancel semantics, `"global"` owner |
| packages/schema/src/form.ts | read (`:110-135`) | form field shapes, sentinel owner |
| packages/core/src/location.ts | read | `location.directory`, `location.project.directory` |
| packages/util/src/global.ts | read | `Global.Path.state`/`.config`/`.home`, `Global.Service` |
| packages/util/src/effect/app-node.ts | read | `makeLocationNode`/`makeGlobalNode` |
| packages/util/src/kete/job-mode.ts | read | `KeteJobMode.enabled` |
| packages/cli/src/kete/job-project-config.ts | change (Kete) | import `guardedKeys` (job list) from util and re-export it; behaviour identical (AC8); never the runtime list |
| packages/cli/src/kete/folder-trust.ts | create | CLI side: `inspect(dir)` (discover project files like `ConfigDiscovery`: walk to fs root, `Brand.configFiles` in each dir and its `.kete/`, skip the resolved global config dir; parse with jsonc-parser; runtime list; `agentPermissionFiles`; util fingerprint; store lookup); `warning(result)` one-liner; `connection(args, trusted)` (force standalone, set `OPENCODE_TRUST_RUN_PARENT`, refuse `--server` for `kete run`); `isTrustForm(form)` |
| packages/cli/src/kete/trust.ts | create | handler for `kete trust` / `trust list` / `trust add [path]` / `trust remove [path]` (refuse home, `/`, unfingerprintable; exit codes 0/1/2; `--format json` for list) |
| packages/cli/src/kete/commands.ts | change (Kete) | `trust` spec (`$` list + `list`/`add`/`remove`); exported `trustParams` (`--trust-project-config`, same text as `job run`'s at `:143`) |
| packages/cli/src/index.ts | change (upstream, marked) | `trust: { $, list, add, remove }` handlers (pattern `models: { $, pull }`, `:68-69`) |
| packages/cli/src/commands/commands.ts | change (upstream, marked) | spread `KeteCommands.trustParams` into the `run` spec params (`:376-379`) |
| packages/cli/src/run/run.ts | read + change (upstream, marked) | before resolving the server: `KeteFolderTrustCli.connection`; after the session exists: print `warning` to stderr when held back and not run-trusted |
| packages/cli/src/run/noninteractive.ts | read + change (upstream, marked) | leave `kete.folder.trust` forms alone (no cancel, no `formCancelled`) at `:185-193` and `:711` |
| packages/cli/src/services/server-connection.ts | read (`:23-55`) | how `standalone` is chosen; offline's precedent |
| packages/cli/src/services/standalone.ts | read | child spawn env (`extendEnv: true`) |
| packages/cli/src/kete/offline.ts | read (`:82-100`) | `connection` pattern to copy |
| packages/cli/src/kete/job.ts | read + change (Kete) | `--trust-project-config` also applies `KeteFolderTrustCli.connection` (private server + run trust); with `--server`, keep today's behaviour and warn that the attached server applies its own folder trust |
| packages/util/src/kete/env.ts | read | env bridge (`KETE_*` → `OPENCODE_*`, marker) |
| packages/app/src/kete/global-forms.tsx | create | `KeteGlobalFormDock`: sync and list `"global"` forms for the current location (same data store calls as the TUI: `data.session.form.list("global", location)`); render the first with upstream `SessionQuestionDock`; replies carry the location |
| packages/app/src/session/requests/session-question-dock.tsx | read | reuse; reply/cancel calls (`:244`, `:256`) and whether they carry location for `"global"` |
| packages/app/src/session/requests/model.ts | read (`:20-50`) | how session forms are synced |
| packages/client/src/solid/data.ts | read | `session.form.sync/list` signatures with a location (hand-written; no edit planned) |
| packages/app/src/kete/todo-dock.tsx | read | pattern: `useServer`/`useData`, event listen, route session id |
| packages/app/src/composer/composer.tsx | change (upstream, marked) | mount `<KeteGlobalFormDock />` next to `KeteTodoDock` (`:15`, `:29`; comment on its own line) |
| packages/tui/src/routes/session/index.tsx | read (`:200-210`) | confirm session route already lists `"global"` forms (no change) |
| packages/tui/src/routes/home.tsx | read (`:38`, `:110-116`) | confirm home lists them (no change) |
| packages/util/test/kete/folder-trust.test.ts | create | AC6 pure parts, fingerprint, store; job list equals the old list exactly; runtime list ⊇ job list; formatter disable-only rule; `loosening`; agent text test |
| packages/core/test/kete/folder-trust.test.ts | create | AC1-AC5, AC10 and the extended set (formatter/shell/worktree/permissions, agent markdown allow rules, ask-over-machine-deny) through the real `Config.layer` + `ConfigPluginSource` + `ConfigAgentPlugin` on temp fixture repos |
| packages/core/test/kete/hooks.test.ts | read | fixture and fake form patterns; must still pass |
| packages/core/test/kete/config-discovery.test.ts | read | how a real `Config` layer is built in tests |
| packages/cli/test/kete/trust.test.ts | create | AC11 |
| packages/cli/test/kete/folder-trust-run.test.ts | create | AC7: connection forcing, `--server` refusal, warning text, ppid rule, trust-form skip |
| packages/cli/test/kete/job-project-config.test.ts | read | must pass unchanged (AC8) |
| packages/app/src/kete/global-forms.test.tsx | create | AC9 web: renders a session-less form, Trust replies with location |
| docs/folder-trust.md | create | user guide |
| docs/permissions.md, docs/hooks.md | change | cross-links; hooks: one question when a folder is trusted |
| docs/upstream-patches.md | change | record every marked edit above under a "Folder trust" section |
| packages/kete-vscode/CHANGELOG.md | change | Unreleased: trust prompt in the panel; every folder with guarded settings asks once |
| docs/context/modules/*.md | read only | librarian updates after the build |

## Steps
1. **util shared module** (`util/src/kete/folder-trust.ts`). Move `guardedKeys` (and its helpers
   `isRecord`/`entries`) verbatim from `cli/src/kete/job-project-config.ts:63-84` as the job list
   `JOB_GUARDED` (top-level `providers`, `provider`, `mcp`, `plugins`, `plugin`, `enterprise`, `share` unless
   `"disabled"`, `autoshare` unless `false`; `kete.integrations|platform|unattended|hooks`). Add the runtime
   list on top of it (design summary: `formatter` unless disable-only, `shell`, `worktree`, raw
   `permission`/`permissions` and `agents|agent|mode.*.permission(s)`), `loosening`, `agentPermissionFiles`,
   `guardedValues`, `describe` (permission items as `action resource → allow`, formatter commands, shell path,
   worktree directory), `trustRoot`, `storeKey`, `neverTrusted`, `fingerprint`, `runTrusted` and `FORM_KIND`
   as in the design summary. All fs access goes through an
   injected interface (`realpath`, `lstat`/`stat`, `readFile`, `readDir`, `homedir`), like
   job-project-config's `Fs`. Document the header comment the same way.
2. **Stores.** Factor the read/atomic-write/cap logic of `core/src/kete/hooks/trust.ts` into
   `util/src/kete/trust-store.ts`. Re-point hooks/trust.ts at it, keeping its exported API and file format.
   Add `folder-trust-store.ts`. A missing, unreadable or malformed file, or a schema mismatch, means empty.
   The temp file is written with mode 0600, then renamed. Writes are serialized per process.
3. **Hooks extraction.** In `core/src/kete/hooks.ts`, move the project-hooks part of `select` (from
   `collect` through `fingerprint`, plus the repository key) into an exported
   `projectHooksTrust(entries, {globalConfig, repositoryKey, cwd})` that returns
   `{kind:"none"} | {kind:"refused", reason} | {kind:"ok", fingerprint, commands}`. `select` uses it.
   No behaviour change; hooks.test.ts must stay green.
4. **Core service** (`core/src/kete/folder-trust.ts`, `folder-trust/memory.ts`, `folder-trust/form.ts`):
   - `gate(entries, {documents, directories}, texts)`: classify entries; for project documents parse
     `texts.get(path)` with jsonc-parser (same options as `Config.parseInfo`), collect guarded values;
     list project `.kete/` directories' `plugin(s)` contents. Nothing guarded and no plugin files → pass
     through and set state "nothing held". Otherwise compute root and fingerprint; trusted if store says so,
     or run-trusted (`runTrusted(process.env, process.ppid)`), or job mode. If untrusted, return entries with
     runtime-guarded values removed from each project `Document`'s `info`: delete the job-list keys,
     `shell`, `worktree` and a non-disable-only `formatter`; filter `permissions` and every
     `agents.<id>.permissions` through `loosening` (machine deny rules collected from the non-project
     entries; `Wildcard.match`); drop a `permissions` array that ends up empty. Rebuild the `Document` the way
     `config.ts:143` builds one, and drop `kete` if it ends up empty. Record held-back directories, then
     start the prompt (once, via memory) and log the warning once. Any error inside the gate counts as
     untrusted, never as a pass-through.
   - `pluginsAllowed(dir)`: `true` unless `dir` is a recorded project directory and the state is untrusted.
     Before the first gate call, refuse project-looking dirs (fail closed).
   - `agentDocuments(dir, documents)`: unchanged documents unless `dir` is a recorded project directory and
     the state is untrusted (or no gate has run yet); then each document's `agents.<id>.permissions` goes
     through `loosening`. Any error returns the documents with every `allow` stripped.
   - Prompt: `form.ask({sessionID: "global", title, metadata: {kind: FORM_KIND}, fields: [decision]})`.
     `trust` writes the folder store, runs `projectHooksTrust` on the *ungated* entries, writes the hooks
     store when `ok`, then publishes the root to memory. `later`, cancel or error adds to the declined set.
     Use the same cast for the sentinel as `core/src/mcp/index.ts:82`.
   - `changes()`: a stream of memory publications for this service's root.
5. **Config seam** (`core/src/config.ts`, marked). Add an import line. Yield the service in `layer`. Add a
   `Map<string,string>` declared next to `reloadLock` (`:101`), filled in `loadFile` after
   `readFileStringSafe` (`:138`). Turn `load`'s `return [...]` into
   `return yield* folderTrust.gate([...], {documents: new Set(direct and project document paths), directories: new Set(project roots)}, texts)`.
   After `reloadLock.withPermit(reconcile(initial))` (`:328`), fork
   `folderTrust.changes().pipe(Stream.runForEach(() => requestReload))` scoped. Add `KeteFolderTrust.node`
   to `configured()` deps. Keep every edit inside `kete_change` markers. Reformat nothing.
6. **Plugin-source seam** (`core/src/config/plugin/source.ts`, marked). In `layer`, yield
   `KeteFolderTrust.Service` and pass it to `scan`. In `scan`, filter
   `entries.filter(directory)` by `pluginsAllowed(entry.path)`. Add `KeteFolderTrust.node` to `node` deps.
   Leave `empty` unchanged.
7. **Agent seam** (`core/src/config/plugin/agent.ts`, marked). Yield `KeteFolderTrust.Service` in the
   plugin effect (the plugin runs inside the location, which already provides the service through
   `Config`'s deps; if the plugin context can't see it, add it the way `source.ts`'s `node` does and note it
   in handoff). In `loadEntry`, wrap the `Effect.map(... documents.filter(...))` result for `Directory`
   entries with `folderTrust.agentDocuments(entry.path, …)`. Leave `decode`, `discover` and the
   transform unchanged.
8. **CLI shared list.** `job-project-config.ts` imports the job-list `guardedKeys` from
   `@opencode/util/kete/folder-trust` and re-exports it (decision 1: `kete job run` doesn't start refusing
   repos that set formatter, shell, worktree or permissions). Its header comment points at the util module.
9. **CLI helper** (`cli/src/kete/folder-trust.ts`) as in the Files table. `connection(args, trusted)`:
   if not trusted, return args unchanged. With `--server`, fail for `kete run` ("`--trust-project-config` needs
   a private server; drop `--server`"). Otherwise set `process.env.OPENCODE_TRUST_RUN_PARENT = String(process.pid)`
   and return `{...args, standalone: true}`. `warning` names held-back settings (≤ 200 chars, then "and N more")
   and suggests `kete trust add` or `--trust-project-config`.
10. **`kete run`** (marked edits). Add `trustParams` to the `run` spec in `commands.ts`. In `run/run.ts`,
   apply `connection` before `ServerConnection.resolve` (use `KeteJobProjectConfig.trusted(flag, env)`
   for the flag-or-env rule). Once the session/location exists, call `inspect(root)` and print the warning
   to stderr when held back and not run-trusted. In `noninteractive.ts`, skip forms where
   `isTrustForm(form)` in both cancel paths.
11. **`kete job run`** (`kete/job.ts`, Kete-owned). When trusted, apply `connection` (private server +
    run trust). Keep the `--server` path as today, with a stderr note. `inspectProjectConfig` behaviour is
    unchanged.
12. **`kete trust`** (`kete/commands.ts`, `kete/trust.ts`, `index.ts` marked). `list` (default) prints
    key, trusted date and held items, or JSON. `add [path]` resolves the root, refuses `neverTrusted`
    or an unfingerprintable folder, computes the fingerprint and stores it. `remove [path]` deletes the root
    key and the hooks trust for that repository. Paths default to cwd. The output says a running server
    applies the change the next time the folder's config loads.
13. **Web UI** (`app/src/kete/global-forms.tsx`, `composer.tsx` marked). Sync `"global"` forms for the
    current location on connect and on `form.created`/`form.*` events. Show the first one with
    `SessionQuestionDock`. If its reply/cancel can't carry the location for `"global"`, wrap the calls in the
    Kete component rather than editing the upstream dock (note it in handoff). Render text only, never
    markup. VS Code and JetBrains get this through the framed web UI, so they need no code change.
14. **Tests** (see Verification). Core fixture: a temp git repo with `kete.json` (local MCP
    `["node","./mcp.js"]`, `plugins`, `providers.x` with a base URL), `.kete/plugins/p.ts`, `AGENTS.md`,
    `.kete/agents/a.md`, `.kete/commands/c.md`, `.kete/skills/s/SKILL.md`, a theme or other non-guarded key, and a
    `kete.hooks` entry. Extended-set fixture: `formatter` with a command, `shell`, `worktree.directory`,
    `permissions` with one allow, one ask and one deny rule, a global-config deny overlapping the ask, and
    `.kete/agents/b.md` with `permissions: [{action: shell, resource: "*", effect: allow}]`; untrusted, none of the
    allow/overlapping-ask rules reach `Agent` permissions, the deny and the non-overlapping ask do, and a
    `formatter: false` project stays loaded and never asks. Isolate HOME/XDG through the package script. Answer forms through the real
    `Form` service.
15. **Docs.** Write `docs/folder-trust.md`: what's held back (the full runtime list, the permission rule semantics, and that
    `kete job run` keeps its own list), the prompt, home and `/`, `kete trust`,
    `kete run` and its flag, ACP, the one-time re-ask after the update (D2), Windows/macOS case notes, and
    that `kete trust remove` takes effect on next load. Add cross-links in `docs/permissions.md` and
    `docs/hooks.md`, a "Folder trust" section in `docs/upstream-patches.md` listing every marked edit, and an
    entry in the kete-vscode CHANGELOG.
16. **Checks.** Run the Verification table. Then `bun run --cwd packages/kete-tools upstream:check`,
    `bun run lint` and `bun run --cwd packages/kete-tools verify --base main`. Build the binary and check by hand
    in a real terminal against the fixture repo (AC12).

## Verification
| Criterion | Command (narrowest first; inside the package) |
|---|---|
| AC1 | core: `bun run test ./test/kete/folder-trust.test.ts -t "untrusted"` |
| Spec 4 extended set | util: `bun test ./test/kete/folder-trust.test.ts -t "runtime list"`; core: `bun run test ./test/kete/folder-trust.test.ts -t "extended"` |
| AC2 | core: `bun run test ./test/kete/folder-trust.test.ts -t "one form"` |
| AC3 | core: `bun run test ./test/kete/folder-trust.test.ts -t "trust reloads"` (asserts store + MCP/plugin operations after reload; a second layer build with the same store asks nothing) |
| AC4 | core: `bun run test ./test/kete/folder-trust.test.ts -t "fingerprint"`; util: `bun test ./test/kete/folder-trust.test.ts -t "fingerprint"` |
| AC5 | core: `bun run test ./test/kete/folder-trust.test.ts -t "nothing guarded"` |
| AC6 | util: `bun test ./test/kete/folder-trust.test.ts -t "security"` (symlink → same root, `/a/repo` vs `/a/repo-evil`, home and `/` refused, forged `.git` file, malformed/unreadable store, 0600; `storeKey` win32 lowercasing); core: `bun run test ./test/kete/folder-trust.test.ts -t "store"` |
| AC7 | cli: `bun test ./test/kete/folder-trust-run.test.ts`; manual with the built binary: `kete run` in the fixture repo, then with `--trust-project-config`, then `kete trust` shows nothing stored |
| AC8 | util: `bun test ./test/kete/folder-trust.test.ts -t "job list"`; cli: `bun test ./test/kete/job-project-config.test.ts ./test/kete/job-run.test.ts` |
| AC9 | app: `bun test --conditions=solid --preload ./happydom.ts ./src/kete/global-forms.test.tsx`; cli: `bun test ./test/kete/folder-trust-run.test.ts -t "trust form"`; TUI home/session by hand with the built binary (session route already lists `"global"` forms, `tui/src/routes/session/index.tsx:203`) |
| AC10 | core: `bun run test ./test/kete/folder-trust.test.ts -t "hooks"` then `bun run test ./test/kete/hooks.test.ts` |
| AC11 | cli: `bun test ./test/kete/trust.test.ts` |
| AC12 | `bun run typecheck` + `bun run test` (core), `bun test ./test/kete` + `bun run typecheck` (util, cli), `bun run typecheck` + `bun run test:unit` (app); root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main`; `bun run build --single --skip-install --skip-web-ui` in `packages/cli`, then a manual check; security review of the diff (reviewer + upstream-guard) |

## Risks
- **Permission semantics (interpretation of decision 1):** "deny/ask still apply" is kept, except a project
  `ask` that overlaps a machine `deny` is held back, because last-match-wins would otherwise loosen the deny.
  The overlap test is by action only and conservative (it may hold back a harmless ask). Logged in handoff.
- **Agent markdown text test:** any project agent file containing "permission" and "allow" counts as held
  back and is hashed, even if its rules turn out deny-only, so such a folder may ask when nothing is actually
  stripped. Fail closed; keeps util/CLI/core fingerprints identical without a YAML parser in util.
- **Residual unguarded network/code paths outside the approved set:** project `skills`/`instructions` URLs
  and `references` (git URLs) can still fetch from the network; agent `request.headers` still apply. Not in
  the decided set; flag for a follow-up rather than widen silently.
- **Plugin directories with `node_modules`:** the caps may make them untrustable (fail closed). The
  prompt and `kete trust add` say why. Tune the caps if real plugins hit them.
- **Linked worktrees:** the back-link check is new code. If git's layout differs (for example
  `core.worktree`), the worktree falls back to its own root, which is safe but asks once more.
- **`kete job run` outside job mode (accepted, decision 3):** with the flag it uses a private server; without
  it, guarded settings in a parent directory above the repository are now held back too (stricter).
- **Gate errors:** any error is treated as untrusted. A broken store therefore re-asks, but never loads
  guarded settings.
- **ACP (accepted, decision 2):** ACP leaves `"global"` forms alone (`cli/src/acp/event.ts:179` cancels only
  its sessions' forms). The trust form stays pending, guarded settings stay held back, the warning goes to
  the log. No ACP edit; result.md records AC9's ACP clause as "pending, held back" rather than "cancelled".
- **Release notes (accepted, decision 4):** no root CHANGELOG; notes are written at release
  (`docs/release.md`). `docs/folder-trust.md` and the kete-vscode CHANGELOG carry the one-time re-ask (D2).

## Cards to update after the build
- config-kete (gate seam in `Config.load`, job vs runtime guarded lists, held-back `kete` sub-keys, formatter/shell/worktree/permission rules)
- hooks (`kete.hooks` guarded by folder trust; `projectHooksTrust`; one question)
- cli (`kete trust`, `kete run --trust-project-config`, run-trust ppid rule, trust form skip, shared guarded list)
- server-sdk (`kete.folder.trust` global form; web UI now renders `"global"` forms)
- web-app (`KeteGlobalFormDock` in composer)
- vscode-extension, jetbrains-plugin (session-less forms shown via the web UI)
- permissions (project allow rules and ask-over-machine-deny held back when untrusted; agent seam in `config/plugin/agent.ts`), sandbox (unchanged; note project sandbox tightening still loads untrusted)
- New card or INDEX row: `folder-trust` (util/core/cli modules, store, fingerprint, root rules)
