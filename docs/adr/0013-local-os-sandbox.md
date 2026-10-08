# 0013. Local OS sandbox for the agent's shell commands

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

The permission system (`docs/permissions.md`, PRs #20 and #22) is a guard, not a sandbox: it reads
each command before it runs and asks before risky ones, but whatever it lets run has the user's full
access. Its defaults let the project's test, build, lint and typecheck commands run without asking,
because that is the core loop. The maintainer accepted the residual risk that an edited ordinary
test file plus `npm test` runs arbitrary code without a prompt, on the condition that an OS sandbox
contains it: such code must not be able to rewrite Kete Code's configuration (a written permission
rule raises the agent's own permissions), plant git hooks or `core.fsmonitor` (code that runs
outside any sandbox the next time git runs), read credentials, or send data off the machine.

Cloud and self-hosted jobs already run in their own sandbox (ADR 0005, the root helper and egress
proxy). Interactive sessions on a developer's machine had none. The runtime must stay usable for the
real loop — installs, tests, builds, git — on macOS, Linux and Windows, with no heavy dependencies
(CLAUDE.md §11), and must stay mergeable with upstream OpenCode (CLAUDE.md §4).

## Decision

1. **Every shell command the agent runs through the shell tool runs in an OS sandbox by default**
   (`kete.sandbox.mode: "auto"`), outside job mode. Other spawns (the user's own terminal and `!`
   commands, MCP servers, formatters, language servers, the runtime's own git) are not sandboxed.
2. **Mechanisms:** macOS uses `sandbox-exec` with a Seatbelt profile generated per command; Linux
   uses bubblewrap (`bwrap`) when it is installed and works. No Landlock helper in v1. Windows has
   no sandbox in v1. A one-time probe decides availability.
3. **Filesystem:** reads are broad. Writes are allowed only in the workspace (the project's worktree
   root), temp directories, a curated list of package-manager and build caches (configurable, can
   be turned off) and `kete.sandbox.allowWrite`. Never writable, even inside the workspace: Kete
   Code's configuration (`.kete/`, `kete.json(c)` at any depth on macOS; `.kete/`, `.claude/`,
   `.agents/`, `kete.json(c)` where configuration is looked up), git's code-running internals
   (`.git/config`, `config.worktree`, `hooks/`, `info/attributes`, `commondir`, `gitdir`, also in
   submodules and linked worktrees, the `.git` entry itself, and `core.hooksPath`), and Kete Code's
   own directories. **`.git` stays writable otherwise**, so `git add`, `commit`, `branch`, `stash`
   and `checkout` work: only the files through which git runs commands are protected. This blocks
   the fsmonitor/hooks escalation while keeping normal git usable.
4. **Credentials are not readable**: `~/.ssh` (except `known_hosts` and `config`), cloud CLIs'
   credentials, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`, the GitHub CLI's,
   keychains, Kete Code's config, data, state and log directories (except this project's shell
   output). A workspace's `.env` stays readable (tests load it) and governed by permission rules.
5. **Network is allowed only for commands a person approved** (`kete.sandbox.network:
   "approved"`): the permission check asked and was allowed, every part matched a saved "Always
   allow", or an unattended run's policy allowed it. Everything else — including the test and build
   commands the defaults allow without asking — reaches only this machine (macOS: loopback and the
   machine's own addresses, Unix sockets in the workspace and temp; Linux: the sandbox's own
   loopback). The model can ask for network (`sandbox: "network"`) or to run outside the sandbox
   (`sandbox: "off"`) for one command; both are new permission actions (`sandbox_network`,
   `sandbox_off`) that **always ask**, can't be saved, can't be pre-approved by a rule (repository
   config can carry rules), are blocked in Plan mode and denied in unattended runs.
6. **Fallback:** where no sandbox works, commands run unsandboxed and this is visible: a warning when
   the runtime starts, an "Unsandboxed" footer in the TUI, `kete sandbox` (exit 1). With
   `kete.sandbox.mode: "required"` they are refused instead. Every unsandboxed command passes a
   `sandbox_off` permission check (reason `disabled` or `unavailable`, which doesn't ask), so an
   **organization policy that denies `sandbox_off` requires the sandbox**.
7. **Who can loosen:** only the user — the global config (`~/.config/kete/`) and `KETE_SANDBOX` (an
   invalid value fails closed as `required`). A repository's config may only tighten (`mode`,
   `network`, `caches: false`, `denyRead`, `denyWrite`); loosening there is ignored and reported.
8. **Upstream seams:** three marked edits — the shell tool (input field, approval metadata, the
   sandbox decision, cleanup, a notice), `shell.ts` (the spawned command line), the TUI's and web
   UI's permission prompt text — plus registering a guarded internal plugin. Everything else is in
   `core/src/kete/sandbox*`.

## Consequences

- The accepted residual risk of `docs/permissions.md` is contained on macOS and on Linux with
  bubblewrap: an edited test can damage the workspace (it is the workspace) but can't escalate
  through Kete Code's configuration or git, can't read the listed credentials and can't exfiltrate
  over the network without a person approving a command.
- **Known gaps, accepted for v1:**
  - Linux protects Kete configuration names only in the directories configuration is looked up from
    (the location and its writable parents), and git internals only of the workspace's own git
    directory (not nested repositories); missing ones get a short-lived placeholder.
  - Writable caches can be poisoned (a Go build cache entry, a bun or pip cache entry) and used by a
    later build outside the sandbox. `kete.sandbox.caches: false` removes them.
  - A planted embedded bare repository, `.vscode` or `.idea` settings, and other files that other
    tools run later aren't protected.
  - Approved commands get network for their whole run, including scripts they start (an approved
    `npm install` runs package lifecycle scripts with network). There is no per-host allowlist (it
    needs a proxy; jobs have one, ADR 0005).
  - `sandbox-exec` is deprecated by Apple; it still ships and works on macOS 26. If Apple removes
    it, macOS falls back to unsandboxed (visible) until a replacement exists.
  - Windows has no sandbox.
- Some workflows break inside the sandbox and need `sandbox: "off"` or configuration: `git push`
  over SSH with keys not in an agent, `git config` writes, `npm install` from a private registry
  (add `~/.npmrc` to `allowRead`), `ps` and other setuid tools on macOS, `open`/AppleScript, Docker,
  and on Linux background processes started with `&` (they end with the command; use background
  mode) and dev servers started without network (they are unreachable from the host).
- Revisit when Landlock can be used without a native helper, when a Windows mechanism is chosen
  (AppContainer or a restricted token), and when per-host network allowlists are needed locally.
