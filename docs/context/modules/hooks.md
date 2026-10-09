---
module: hooks
paths: [packages/core/src/kete/hooks.ts, packages/core/src/kete/hooks/*, packages/schema/src/config/kete.ts]
verified-at: bc9125516c
---
## Quick answers
- Where are hooks configured? `kete.hooks` (`ConfigKete.Hooks`/`Hook`/`HookEvents` in `schema/src/config/kete.ts`): six events, each a list of `{command, match?, timeout?}`. Read from **every** config document (not `Config.latest`), user (under the global config dir) vs project, like the sandbox settings (`hooks/settings.ts`).
- How are they wired? One internal plugin (`kete.hooks`, `core/src/kete/hooks.ts:107`, registered after `KeteLsp` in `pre`, `core/src/plugin/internal.ts:308`): PreToolUse = `tool.execute.before` (`:255`, the only hook that may fail → `Tool.Error`), PostToolUse = `tool.execute.after` (`:271`), UserPromptSubmit = `session.prompt` (`:296`, appends to the prompt text; can't block — session hooks can't fail), SessionStart = `session.created` event → `ctx.session.synthetic`, Stop = `session.execution.*` events, Notification = `permission.asked` and `form.created` (not the trust form).
- Trust? Project hooks need the user's trust: fingerprint = sha256 of every project hook's event/match/timeout/command (`hooks/settings.ts` `fingerprint`); store `hooks-trust.json` in `Global.state` keyed by the repository's real path (`hooks/trust.ts`, atomic, 500 entries, 0600). Asked through a `Form` (metadata `kind: kete.hooks.trust`) at the first PreToolUse/PostToolUse/UserPromptSubmit/SessionStart; one shared question per fingerprint; "no" is remembered in memory. Stop/Notification and unattended sessions (`KeteUnattendedPolicy.resolve`) never ask.
- Off switches: job mode (plugin returns at once); a policy `{"action":"permission","resource":"hooks:<event>|hooks:*","effect":"deny"}` from `experimental.policies` or `ManagedPolicy`; `kete job run` refuses a repository's `kete.hooks` without `--trust-project-config` (`cli/src/kete/job-project-config.ts`), and even then untrusted project hooks are skipped (unattended).
- Sandbox? No: hooks run with the user's permissions, outside the OS sandbox (documented, like git hooks); Kete credentials stripped (`KeteToolEnv.withoutKeteCredentials`). Spawned through `Environment.spawner` (`hooks/run.ts`, classified `seam`).

## Purpose
User-configured shell commands around the agent loop (block, add context, notify), without writing a plugin.

## Entry points
- `KeteHooks.Plugin` / `make(deps)` (`core/src/kete/hooks.ts:107`).

## Key files
| File | Role |
| --- | --- |
| `packages/core/src/kete/hooks.ts` | plugin: selection with trust and policy (`select`, `:184`), running, event wiring |
| `packages/core/src/kete/hooks/settings.ts` | collect per document, fingerprint, `match`, policy check |
| `packages/core/src/kete/hooks/run.ts` | shell spawn, stdin JSON, bounded output, timeout, `interpret` (exit 0/2/other, JSON) |
| `packages/core/src/kete/hooks/trust.ts` | trust store |
| `packages/cli/src/kete/job-project-config.ts` | `kete.hooks` is a guarded key for `kete job run` |

## Data flow
Event → `select` (config entries → policy → user + project; project → trust store → form) → `run` each in order → outcomes → block (`Tool.Error`) / context appended / synthetic message / nothing.

## Data and APIs used
- Config documents, `ManagedPolicy`, `Form`, `Session` (unattended lookup), `Global.state`, `Environment.spawner`, plugin event stream.

## Rules that must not break
- Project hooks never run untrusted; any change to them asks again; unattended runs never ask.
- PreToolUse fails closed (error/timeout blocks); other events never fail the session.
- Nothing in job mode.

## Testing
- `bun run test ./test/kete/hooks.test.ts` in `packages/core/` (real `/bin/sh` commands; skipped on Windows); `bun test test/kete/job-project-config.test.ts` in `packages/cli/`.

## Changes
- 2026-10-10 created (wave 1a, `docs/tasks/2026-10-10-wave1a`). Config schema change: protocol and client regenerated.

## Gotchas
- A test's fake `event.subscribe` must give each subscriber every event (`PubSub`), as the real host does: the plugin subscribes twice.
- UserPromptSubmit context is appended to the user's prompt text (visible); there's no way to block a prompt from a session hook.
