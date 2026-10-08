---
module: sandbox
paths: [packages/core/src/kete/sandbox.ts, packages/core/src/kete/sandbox/*, packages/schema/src/kete/sandbox.ts, packages/cli/src/kete/sandbox.ts, packages/tui/src/kete/sandbox-status.tsx]
verified-at: 62cd364869
---

## Quick answers
- What runs in the sandbox? Only the shell tool's commands (`core/src/tool/plugin/shell.ts`), outside job mode. The user's `!` commands, PTY, MCP servers, formatters, LSP and the runtime's own git are unchanged (no plan attached → `KeteSandboxPlans.wrap` returns the command as is).
- Which mechanism? macOS `/usr/bin/sandbox-exec` with a generated Seatbelt profile (`sandbox/seatbelt.ts`); Linux `bwrap` (`sandbox/bubblewrap.ts`); probed once per process (`sandbox/probe.ts`, `KeteSandbox.availability`). Windows: unavailable.
- How is network decided? `kete.sandbox.network` "approved" (default): network iff the shell request's metadata carries `kete.sandbox.approved`, set by `KetePermissionMode.apply` (final effect "ask", or every part saved) and `KeteUnattended.applyPolicy` (policy allowed). `sandbox: "network"` asks `sandbox_network`.
- How does an org require the sandbox? A policy denying `sandbox_off`: every unsandboxed command asserts it (reason `disabled`/`unavailable` doesn't ask; `requested` always asks).
- Why can't a repository turn it off? `KeteSandboxSettings.resolve` lets only documents under the global config dir and `KETE_SANDBOX` loosen; project documents only tighten (`ignored` lists the rest).
- Where are Linux placeholders? `KeteSandboxResolve.Placeholders` (`shared`): missing `.kete`/`.claude`/`.agents` (empty dirs) and `kete.json(c)` (`{}` mode 000) in the config search path, counted, removed when unchanged.

## Purpose
Contain the agent's shell commands (ADR 0013, `docs/sandbox.md`): writes only to workspace/temp/caches, never Kete configuration or git's code-running internals; no credential reads; network only when a person approved. The permission system stays the first layer.

## Entry points
- `KeteSandbox.make(deps).prepare(invocation, request, ask)` — called from the shell tool's `before` callback after `KeteToolEnv.forSession`.
- `KeteSandboxPlans.wrap(invocation, file, args)` — called by `core/src/shell.ts` at the spawn.
- `KeteSandbox.Plugin` (`kete.sandbox`, guarded, `pre` after `KetePermissionMode.Plugin`): escape hook + `kete.sandbox` RPC `status`.
- `kete sandbox` (`cli/src/kete/sandbox.ts`), TUI footer (`tui/src/kete/sandbox-status.tsx`).

## Key files
| File | Role |
| --- | --- |
| `packages/core/src/kete/sandbox.ts` | decision (`prepare`), `notice`, `decide`, `status`, plugin |
| `packages/core/src/kete/sandbox/settings.ts` | `kete.sandbox` + `KETE_SANDBOX` precedence |
| `packages/core/src/kete/sandbox/resolve.ts` | policy from the machine: real paths, git layout, hooksPath, caches, credentials, placeholders |
| `packages/core/src/kete/sandbox/seatbelt.ts` | profile (paths only as `-D` params), Mach allowlist |
| `packages/core/src/kete/sandbox/bubblewrap.ts` | bwrap argument list |
| `packages/core/src/kete/sandbox/actions.ts` | `sandbox_off`, `sandbox_network`, approval mark |
| `packages/core/src/kete/sandbox/plans.ts` | per-invocation plan (WeakMap), `wrap`, `validate` |
| `packages/core/src/kete/sandbox/probe.ts` | availability check (kete-guard spawn) |
| `packages/schema/src/kete/sandbox.ts` | RPC definition and `Status` |

## Data flow
1. Shell tool `prepare` asserts `shell` with a metadata object; hooks may mark it approved; `KeteSandbox.remember` keeps it.
2. `sandbox.prepare`: job mode → nothing; settings; off → assert `sandbox_off` (disabled); unavailable → refuse if required, else assert (unavailable); `request === "off"` → assert (requested, asks).
3. Network = settings + approval mark, or `sandbox_network` asked.
4. `KeteSandboxResolve.resolve` → `Policy`; `KeteSandboxPlans.validate` then `attach`.
5. `shell.ts` spawns `KeteSandboxPlans.wrap(...)`; after the command the tool releases placeholders and appends `notice` when the failure looks like the sandbox.

## Data and APIs used
- Config `kete.sandbox` (`schema/src/config/kete.ts` `Sandbox`), env `KETE_SANDBOX` (internal `OPENCODE_SANDBOX`).
- Plugin RPC `kete.sandbox` via `POST /api/rpc/:rpcID/:method` (no new endpoint).
- Permission actions `sandbox_off`, `sandbox_network` (free-form; org policies can name them).

## Rules that must not break
- Requested escapes always ask (every mode, rules and saved approvals ignored), Plan denies, unattended ends denied; `save: []`.
- No path text in the Seatbelt profile; paths must be absolute without control characters (`checkPath`).
- Project config never loosens; invalid `KETE_SANDBOX` = required.
- Never runs in job mode; probe and resolve are classified in the job spawn/fs allowlists.
- `kete.sandbox` plugin stays in `guarded`.

## Testing
- `bun run test ./test/kete/sandbox.test.ts` (unit), `./test/kete/sandbox-policy.test.ts` and `./test/kete/sandbox-shell.test.ts` (real sandbox; skip when unavailable unless `KETE_SANDBOX_TESTS=required`, as in CI) inside `packages/core/`.
- `bun test test/kete/sandbox.test.ts` in `packages/cli/`; `bun test test/kete/sandbox-status.test.ts` in `packages/tui/`.
- Linux locally: Docker as root with `apt install bubblewrap` (unprivileged bwrap needs userns; Ubuntu 24.04 AppArmor blocks it).

## Changes
- 2026-10-08 created (feature/local-sandbox, ADR 0013).

## Gotchas
- Seatbelt's `(remote ip "localhost:*")` also matches the machine's own LAN addresses.
- Apple's xcrun shims (/usr/bin/git) write to `/private/var/folders/*/*/T` whatever TMPDIR says; those dirs are writable.
- Seatbelt matches resolved paths: `.GIT/config` on a case-insensitive volume is still denied.
- Path rules apply parent first (bwrap mounts and Seatbelt rules sorted by depth): Kete worktrees live in the hidden, read-only data directory and must stay writable workspaces (found by the harness run-mode test in CI).
- Linux file placeholders are masked with /dev/null and listed in a copy of `info/exclude` bound over the real one: git's `add -A` refuses character devices (and a non-root git can't read a mode-000 file), found in CI.
- bwrap: processes started with `&` die with the command (PID namespace); without network the host's loopback is unreachable.
- The isolated test HOME lives in macOS's per-user temp dir (writable in the sandbox): tests use `/Users/Shared` as an "outside" path there.
