# Spec: Local OS sandbox for agent shell commands (Wave 0b)

- Task: `2026-10-08-local-sandbox` · Size: large · Created: 2026-10-08
- Status: approved (pre-approved by the maintainer with the recommended options, part of the competitive program)

## Goal
Every shell command the agent runs in an interactive (or local unattended) session runs inside an OS
sandbox, so the residual risk accepted in `docs/permissions.md` (an edited test + `npm test` runs
arbitrary code without a prompt) is contained. Job mode keeps its own sandbox.

## Scope
Modules: permissions, config-kete, cli, ui-branding/TUI footer, web-app (prompt text), new `sandbox` card.
- macOS: `sandbox-exec` with a per-command Seatbelt profile. Linux: bubblewrap when installed and
  working. Windows: no sandbox in v1, shown as unsandboxed.
- Filesystem: broad reads; writes only in the workspace, temp dirs, curated caches, `allowWrite`.
  Never writable: Kete configuration, git's code-running internals (config, hooks, attributes,
  commondir/gitdir, the `.git` entry, `core.hooksPath`), Kete's own dirs. Credential paths unreadable.
- Network: only for commands a person approved (prompt allowed, saved Always allow, unattended
  policy); otherwise this machine only.
- Escapes: per-command `sandbox: "network" | "off"` on the shell tool → `sandbox_network` /
  `sandbox_off` permission actions that always ask; Plan blocks; unattended denies.
- Settings `kete.sandbox.{mode,network,caches,allowWrite,allowRead,denyRead,denyWrite}` and
  `KETE_SANDBOX`; only the user (global config, env) can loosen; projects only tighten. Org policy
  denying `sandbox_off` requires the sandbox.
- Fallback: unavailable → warn at start, TUI footer, `kete sandbox`; `required` → refuse.
- Status: `kete.sandbox` RPC, `kete sandbox` command, TUI footer indicator.

## Out of scope
Landlock helper, Windows sandbox, per-host network allowlist (proxy), sandboxing MCP servers /
formatters / LSP / the user's own commands, VS Code status-bar indicator.

## Acceptance criteria
- [x] AC1: writes inside the workspace and normal git (add/commit/branch) work sandboxed (macOS, Linux).
- [x] AC2: writes to `.git/config`, `.git/hooks/*`, renaming `.git`, `kete.jsonc`, `.kete/**`, `.claude/**` are blocked; no placeholder is left behind.
- [x] AC3: `~/.ssh` keys are unreadable (known_hosts readable); writes outside the workspace blocked.
- [x] AC4: network is blocked for unapproved commands and allowed after `sandbox: "network"`.
- [x] AC5: `sandbox: "off"` runs unsandboxed; requested escapes always ask (Plan denies).
- [x] AC6: Seatbelt profile can't be injected through paths; control characters refused.
- [x] AC7: linked worktrees commit into the common dir whose config/hooks stay protected; `core.hooksPath` protected.
- [x] AC8: project config can't loosen; invalid `KETE_SANDBOX` fails closed.
- [x] AC9: status visible: `kete sandbox`, TUI footer, start-up warning.

## Risks and constraints
Security-critical (CLAUDE.md §9); upstream edits minimal and marked (§4); cross-platform (§11);
CI minutes (bubblewrap install adds ~20 s to kete-checks). Gaps accepted in ADR 0013.
