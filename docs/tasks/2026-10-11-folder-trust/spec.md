# Spec: Folder trust on first run (A10)

- Task: `docs/tasks/2026-10-11-folder-trust` · Size: large · Created: 2026-10-11
- Status: approved (maintainer, 2026-10-11: D1 "safe parts only", D2 "ask once everywhere"; Milestone A
  approved for build with merge-when-green and a security review, 2026-10-10)
- Plan item: A10 in `docs/parity-plan.md`

## Goal
Opening `kete` in a folder never runs code or sends data somewhere because of that folder's own config
until the person has said they trust it. Today a cloned repo's `kete.json` or `.kete/` can start local MCP
servers, load plugins, and point providers at other endpoints with no prompt (only hooks ask).

## Today (verified 2026-10-11)
- Project config is discovered by walking up from the directory to the filesystem root
  (`core/src/config/discovery.ts:34-74`) and merged above the global config (`core/src/config.ts:195-239`).
- Code-executing or data-redirecting project settings load without asking: plugins (`plugin(s)` keys,
  `.kete/plugin(s)/`), local MCP servers (`mcp`), provider `baseURL`/`apiKey`/headers (`provider(s)`),
  `share`/`autoshare`, `enterprise`, `kete.integrations`/`platform`/`unattended`. Hooks already have a trust
  prompt (`core/src/kete/hooks/trust.ts`, `hooks.ts:199-225`).
- `kete job run` already refuses repos that set exactly these keys unless `--trust-project-config`
  (`cli/src/kete/job-project-config.ts:74-128`: `guardedKeys` and the plugin-directory check). Job mode loads
  no project config at all.
- A session-less prompt path exists: forms owned by the `"global"` sentinel
  (`schema/src/form.ts:122-128`), rendered on the TUI home route (`tui/src/routes/home.tsx:38,110-116`).

## Scope
Module cards: `config-kete`, `hooks`, `permissions`, `sandbox`, `server-sdk`, `cli`, `vscode-extension`,
`web-app`, `jetbrains-plugin`.

1. **One list of guarded settings.** Move `guardedKeys` and the plugin-directory check out of
   `job-project-config.ts` into a shared Kete module both the runtime and `kete job run` use, so the two can't
   drift.
2. **Trust store.** `folder-trust.json` in the global state directory (outside any project's reach): keyed by
   the trust root's real path, holding the fingerprint that was trusted. Atomic write, mode 0600, capped
   entries; an unreadable or malformed file means nothing is trusted. Shares the shape and code of the hooks
   trust store where possible.
3. **Trust root and fingerprint.** The trust root is the git repository root containing the directory, or
   the directory itself outside a repository (real paths, symlinks resolved). The fingerprint covers the
   guarded settings in every project-level config document that applies (their values, including MCP
   commands and provider endpoints) and the contents of `.kete/plugin(s)/`. If the fingerprint changes, the
   folder asks again: trust is for what was reviewed.
4. **Untrusted: safe parts only (D1).** When the trust root is not trusted for the current fingerprint, the
   runtime loads project config as today except the guarded settings and plugin directories, which are held
   back. `AGENTS.md`, agents, commands, skills, LSP disables, sandbox tightening and every other setting
   still load. A folder with no guarded settings never asks.
   Guarded set (decided 2026-10-11 under D1's principle, handoff.md): also project formatter commands,
   `shell`, the worktree setup script, and permission rules that loosen (allow); deny/ask rules still apply.
   `kete job run` keeps its own, unchanged list.
5. **The prompt.** At the first request for an untrusted location that holds back something, the runtime
   raises one session-less form (`"global"` owner, kind `kete.folder.trust`) listing exactly what is held
   back: each setting by name, local MCP server commands, provider endpoints, plugin files. Answers: Trust
   (store it and reload the location with everything), Not now (keep holding back for this server's
   lifetime, ask again next start). Trusting a folder also trusts its current project hooks, so there's one
   question, not two.
6. **Never trusted.** The home directory and the filesystem root can't be stored as trusted (the prompt
   offers "Not now" and explains why); use a project folder instead.
7. **Non-interactive.** `kete run` never asks: guarded settings are held back with a one-line warning naming
   them, unless `--trust-project-config` or `KETE_TRUST_PROJECT_CONFIG=1` (the flag `kete job run` already
   has) trusts for that run only. Job mode is unchanged (no project config).
8. **Every client shows the prompt.** The TUI (home route already lists `"global"` forms; the session route
   must too). The web UI shared by VS Code and JetBrains renders forms only for sessions today
   (`SessionQuestionDock`); it gains a session-less form view so the trust prompt (and MCP elicitations
   without a session) show. ACP cancels every form (`cli/src/acp/event.ts:179`), so under ACP an untrusted
   folder behaves like `kete run`: held back, with the warning in the log.
9. **Manage it.** `kete trust` lists trusted folders; `kete trust add [path]` and `kete trust remove [path]`
   change them (same rules: real paths, never home or root). `/doctor` (A4) will report the current folder's
   trust state.
10. **Ask once everywhere (D2).** Nothing is migrated: after the update, every folder with guarded settings
    asks once, including folders used before.
11. **Docs:** `docs/folder-trust.md` (user guide), `docs/permissions.md` and `docs/hooks.md` cross-links,
    `docs/upstream-patches.md`, context cards.

## Out of scope
- Changing how far config discovery walks (it stays to the filesystem root; the fingerprint covers every
  project document found, so a parent folder's config is part of what is trusted).
- Org policy that forces or forbids trust (platform side; later).
- Treating `AGENTS.md`, agents, commands or skills as guarded (prompt content, not code execution; D1).

## Acceptance criteria
- [ ] AC1: in an untrusted repo whose `kete.json` defines a local MCP server, a plugin and a provider
  `baseURL`, none of them is started or used, and `AGENTS.md`, agents, commands and skills from the repo still
  load (core test with a fixture repo).
- [ ] AC2: the first request for that location raises exactly one `kete.folder.trust` form listing the MCP
  command, the plugin file and the provider endpoint; a second concurrent request doesn't raise another.
- [ ] AC3: answering Trust stores the trust root's real path and fingerprint, reloads the location, and the
  MCP server and plugin then load; after a restart, no prompt.
- [ ] AC4: changing a guarded value (e.g. the MCP command) after trusting asks again; changing a non-guarded
  value (e.g. a theme) does not.
- [ ] AC5: a folder with no guarded settings never asks.
- [ ] AC6 (security): a symlink into a trusted repo resolves to the same trust root; a sibling directory
  whose path shares a prefix with a trusted one (`/a/repo` vs `/a/repo-evil`) is not trusted; the home
  directory and `/` can't be stored; a project can't write the trust store (it lives in the global state
  directory, 0600); an unreadable or malformed store trusts nothing.
- [ ] AC7: `kete run` in an untrusted repo starts no project MCP server or plugin, prints the warning, and
  with `--trust-project-config` loads them for that run without storing trust.
- [ ] AC8: `kete job run` uses the shared guarded list and behaves exactly as before (existing tests pass).
- [ ] AC9: the TUI shows the prompt on the home screen and in a session; the web UI (VS Code, JetBrains)
  shows session-less forms, including this one; choosing Trust in either works (client tests). Under ACP the
  form is cancelled and guarded settings stay held back.
- [ ] AC10: trusting a folder also trusts its current project hooks (no second prompt); declining leaves
  project hooks skipped as today.
- [ ] AC11: `kete trust list|add|remove` work and refuse home and `/`.
- [ ] AC12: typecheck and tests pass in every touched package; `upstream:check` passes with every upstream
  edit listed; a security review of the diff finds no bypass; the built binary checked in a real terminal
  with a fixture repo.

## Risks and constraints
- **Security (§9) — the point of the task.** The gate must sit before anything guarded can start: before
  MCP servers spawn and plugins load. Fail closed everywhere (unknown state = untrusted). Security tests per
  AC6. The trust store path is never derived from project config.
- **Upstream merges (§4):** the gate is in config loading and location boot, both upstream. Keep the edit to
  one marked seam that calls a Kete-owned module; record it in `docs/upstream-patches.md`.
- **Contracts:** new form kind `kete.folder.trust`, new CLI command `kete trust`, new state file. If a
  server or protocol type changes, regenerate `packages/protocol` and `packages/client` (§8).
- **Behaviour change:** after the update every folder with guarded settings asks once (D2); the CHANGELOG
  and release notes say so.
- **Offline:** works with no network; trust is local.
- **Cross-platform:** real-path resolution and home detection on Windows (drive roots, `%USERPROFILE%`),
  case-insensitive paths on macOS and Windows.
