# Hooks

Hooks run your own shell commands at fixed points of the agent loop: check a command before it
runs, run a check after an edit, add the current ticket to every prompt, record when the agent
finishes. They are configured under `kete.hooks` in `kete.json` / `kete.jsonc`, and they run in
Kete Code's [OS sandbox](sandbox.md) like the agent's own shell commands.

```jsonc
// ~/.config/kete/kete.jsonc
{
  "kete": {
    "hooks": {
      "PreToolUse": [
        { "match": "shell", "command": "~/.config/kete/hooks/check-command.sh", "timeout": 10 }
      ],
      "Stop": [
        { "command": "~/.config/kete/hooks/log-turn.sh" }
      ],
      "Notification": [
        // Desktop notifications need things the sandbox denies: an explicit escape (global config only).
        { "command": "osascript -e 'display notification \"Kete Code needs you\"'", "sandbox": false }
      ]
    }
  }
}
```

Like every `kete` setting, the whole `kete` object of the highest-priority file normally wins (it
isn't merged field by field). Hooks are different: Kete Code reads `kete.hooks` from **every**
config file, global and project, and runs them all (yours first).

## Events

| Event | Runs | Can |
| --- | --- | --- |
| `PreToolUse` | before a tool runs (`match` selects tools) | **block** the call, with a reason the agent sees |
| `PostToolUse` | after a tool ran, successfully or not (`match` selects tools) | add context after the tool's result |
| `UserPromptSubmit` | when a prompt is sent | add context to the prompt (appended, visible in the conversation); it can't block the prompt |
| `SessionStart` | when a session is created | add context (a message at the start of the session) |
| `Stop` | when the agent finishes its turn (succeeded, failed or interrupted) | — |
| `Notification` | when Kete Code needs you: a permission prompt or a question | — |

Each entry:

| Field | |
| --- | --- |
| `command` | required; the shell command |
| `match` | tool events only: a tool name, `*` wildcards, several separated by `\|`; every tool when left out |
| `timeout` | seconds, 1–600, default 60 |
| `network` | `true` gives the hook network access inside the sandbox (default: none) |
| `sandbox` | `false` runs the hook **outside** the sandbox — a sandbox escape, honoured only in your global config |

Hooks of one event run one after another, in config order. At most eight `Stop`/`Notification`
hooks run at once; more are skipped (and logged).

## The sandbox

Every hook runs in the OS sandbox with the same rules as the agent's shell commands: it can write
the workspace, temp directories and toolchain caches, can't write Kete Code's configuration or git's
hooks and config, can't read credentials (`~/.ssh`, `~/.aws`, …), and has **no network** unless the
entry sets `network: true`.

- `sandbox: false` takes a hook out of the sandbox, with your full access. Only your global config
  can do that, and never when a policy denies `sandbox_off` (an organization requiring the sandbox).
- Where there is no active sandbox (you turned it off, Linux without `bwrap`, Windows), your global
  hooks run unsandboxed (unless a policy denying `sandbox_off` forbids it — then they don't run) and
  **project hooks don't run** unless your global config sets `"kete": { "hooks": { "unsandboxed": true } }`
  (still subject to that policy). When the sandbox is `required` but unavailable, no hook runs.
- A hook that runs workspace code — `npx …`, `npm run …`, `make`, `./scripts/…` — runs whatever the
  repository (or the agent's last edit) put there. Inside the sandbox that is contained; with
  `sandbox: false` or without a sandbox it is a full escape. Keep such hooks sandboxed.
- A `PreToolUse` hook that isn't allowed to run blocks the call, saying why.

## What a hook gets

The command runs in the project directory: `sh -c` on macOS and Linux; on Windows it is one line of
a temporary batch file run by `cmd.exe /d /c` (batch rules apply: write `%%` for a literal `%`). The
environment is yours without Kete Code's own credentials (`KETE_*` keys and tokens), plus
`KETE_HOOK_EVENT`, `KETE_PROJECT_DIR` and `KETE_HOOK_INPUT` (a private temp file holding the event
JSON, removed afterwards); on Windows also `NoDefaultCurrentDirectoryInExePath=1`, so programs are
never looked up in the current directory. The event comes as JSON on stdin:

```json
{
  "event": "PreToolUse",
  "session_id": "ses_…",
  "cwd": "/path/to/project",
  "tool": "shell",
  "tool_input": { "command": "npm publish" }
}
```

- `PreToolUse` gets the tool input **in full**. An input larger than 4 MiB isn't sent
  (`"tool_input": null, "tool_input_truncated": true`) and the call is blocked, since the hook
  couldn't check it.
- `PostToolUse` adds `tool_result`: `{ "status": "completed", "output": "…" }` or
  `{ "status": "error", "error": "…" }`, cut at 32 KiB with `"truncated": true`; its `tool_input` is
  cut at 32 KiB.
- `UserPromptSubmit` adds `prompt`, `Stop` adds `status`, `Notification` adds `kind`
  (`permission`/`question`) and `message`.

## What a hook returns

| The command… | Means |
| --- | --- |
| exits 0, prints nothing | fine, carry on |
| exits 0, prints text | that text is context for the agent (where the event can add context) |
| exits 0, prints a JSON object | `{"decision": "deny", "reason": "…"}` blocks (PreToolUse); `{"context": "…"}` adds context; `{"decision": "allow"}` carries on |
| exits 2 | **blocks** (PreToolUse): stderr (or stdout) is the reason the agent sees |
| exits with another code, times out, or can't start | an error: logged; for **PreToolUse the call is blocked** (fail closed), naming the hook |

Context and reasons are cut at 8 KiB and escaped (`<`, `>`, `&`) inside the `<hook>` block the agent
reads; stdout is read up to 64 KiB, stderr up to 16 KiB.

## Hooks from a repository

A repository's `kete.json` or `.kete/` can define hooks too — and so could run code on your
computer as soon as you open it. So **project hooks run only after you trust them**: the first time
one would run in a session, Kete Code shows every project hook (commands JSON-quoted, so nothing is
hidden; which ones get network) and the repository files they run, and asks.

- Your answer is remembered for that repository and exactly those hooks: event, match, timeout,
  `network`, `sandbox`, the command, **and the contents of every repository file a command names**
  (its program and any argument that is a file in the repository, e.g. `scripts/hook.sh`). If any of
  that changes, you're asked again. "Don't run them" holds until Kete Code restarts.
- Trusted repositories are recorded in `hooks-trust.json` in Kete Code's state directory (delete an
  entry to be asked again).
- A project command with control characters (other than tab) or text-reordering (bidi) characters
  is refused outright; you aren't asked.
- `sandbox: false` in a project's config is ignored (logged); its hooks stay sandboxed.
- `Stop` and `Notification` hooks never ask; project ones run only once trusted.
- Unattended runs (`kete job run`) never ask: project hooks run only if you trusted those exact
  hooks before, interactively. `kete job run` refuses a repository whose config sets `kete.hooks`
  unless you pass `--trust-project-config` (and even then, untrusted project hooks are skipped).
- Cloud, self-hosted and review jobs run no hooks at all.
- Hooks from your global config (`~/.config/kete/`) run without asking: you wrote them.

Changing hook configuration is itself protected: the agent's edits to `.kete/` and `kete.json(c)`
always ask (see [Permissions](permissions.md)), and sandboxed commands can't write them.

## Turning hooks off

An organization, or your global config, can turn hooks off with a policy statement:

```jsonc
{ "experimental": { "policies": [ { "action": "permission", "resource": "hooks:*", "effect": "deny" } ] } }
```

`hooks:PreToolUse` etc. turns off one event. Such statements in a project's config are ignored (a
repository can't switch off your own hooks); Kete Code logs that it ignored them.

## Limits

- Windows: hooks run unsandboxed there (no OS sandbox yet), so project hooks need the opt-in above.
  The batch-file command line is unit-tested but hasn't been verified on a real Windows machine.
- A slow `PreToolUse` hook slows every matching tool call; keep them fast and set a `timeout`.
- Hooks are separate from TypeScript plugins, which can do more; hooks need no code in the runtime.
