# Hooks

Hooks run your own shell commands at fixed points of the agent loop: check a command before it
runs, run a linter after an edit, add the current ticket to every prompt, send a desktop
notification when Kete Code needs you. They are configured under `kete.hooks` in `kete.json` /
`kete.jsonc`.

```jsonc
// ~/.config/kete/kete.jsonc
{
  "kete": {
    "hooks": {
      "PreToolUse": [
        { "match": "shell", "command": "~/.config/kete/hooks/check-command.sh", "timeout": 10 }
      ],
      "PostToolUse": [
        { "match": "edit|write|patch", "command": "npx --no-install eslint --quiet --format unix . || true" }
      ],
      "Notification": [
        { "command": "osascript -e 'display notification \"Kete Code needs you\"'" }
      ]
    }
  }
}
```

Like every `kete` setting, the whole `kete` object of the highest-priority file wins (it isn't
merged field by field), except for hooks and the sandbox: Kete Code reads `kete.hooks` from **every**
config file, global and project, and runs them all (yours first).

## Events

| Event | Runs | Can |
| --- | --- | --- |
| `PreToolUse` | before a tool runs (`match` selects tools) | **block** the call, with a reason the agent sees |
| `PostToolUse` | after a tool ran, successfully or not (`match` selects tools) | add context after the tool's result |
| `UserPromptSubmit` | when a prompt is sent | add context to the prompt (appended, visible in the conversation) |
| `SessionStart` | when a session is created | add context (a message at the start of the session) |
| `Stop` | when the agent finishes its turn (succeeded, failed or interrupted) | — |
| `Notification` | when Kete Code needs you: a permission prompt or a question | — |

Each entry: `command` (required), `match` (tool events only: a tool name, `*` wildcards, several
separated by `|`; every tool when left out), `timeout` in seconds (1–600, default 60). Hooks of
one event run one after another, in config order.

## What a hook gets

The command runs in the project directory in `sh -c` (macOS, Linux) or `cmd.exe /d /s /c`
(Windows), with these variables added to your environment: `KETE_HOOK_EVENT`, `KETE_PROJECT_DIR`,
and `KETE_HOOK_INPUT` (a private temp file holding the same JSON, removed afterwards).
Kete Code's own credentials (`KETE_*` keys and tokens) are removed. The event comes as JSON on
stdin:

```json
{
  "event": "PreToolUse",
  "session_id": "ses_…",
  "cwd": "/path/to/project",
  "tool": "shell",
  "tool_input": { "command": "npm publish" }
}
```

`PostToolUse` adds `tool_result` (`{ "status": "completed", "output": "…" }` or
`{ "status": "error", "error": "…" }`), `UserPromptSubmit` adds `prompt`, `Stop` adds `status`,
`Notification` adds `kind` (`permission`/`question`) and `message`. Tool input and output are cut at
32 KiB.

## What a hook returns

| The command… | Means |
| --- | --- |
| exits 0, prints nothing | fine, carry on |
| exits 0, prints text | that text is context for the agent (where the event can add context) |
| exits 0, prints a JSON object | `{"decision": "deny", "reason": "…"}` blocks (PreToolUse); `{"context": "…"}` adds context; `{"decision": "allow"}` carries on |
| exits 2 | **blocks** (PreToolUse): stderr (or stdout) is the reason the agent sees |
| exits with another code, times out, or can't start | an error: logged; for **PreToolUse the call is blocked** (fail closed), naming the hook |

Context and reasons are cut at 8 KiB; stdout is read up to 64 KiB, stderr up to 16 KiB.

## Hooks from a repository

A repository's `kete.json` or `.kete/` can define hooks too — and so could run code on your
computer as soon as you open it. So **project hooks run only after you trust them**: the first time
one would run in a session, Kete Code lists every project hook command and asks. Your answer is
remembered for that repository and those exact commands (event, match, timeout and command); if any
of them changes, you're asked again. "Don't run them" holds until Kete Code restarts. Trusted
repositories are recorded in `hooks-trust.json` in Kete Code's state directory (delete an entry to
be asked again).

- `Stop` and `Notification` hooks never ask; project ones run only once trusted.
- Unattended runs (`kete job run`) never ask: project hooks run only if you trusted those exact
  hooks before, interactively. `kete job run` refuses a repository whose config sets `kete.hooks`
  unless you pass `--trust-project-config` (and even then, untrusted project hooks are skipped).
- Cloud, self-hosted and review jobs run no hooks at all.
- Hooks from your global config (`~/.config/kete/`) run without asking: you wrote them.

Changing hook configuration is itself protected: the agent's edits to `.kete/` and `kete.json(c)`
always ask (see [Permissions](permissions.md)).

## Turning hooks off

An organization (or your own config) can turn hooks off with a policy statement:

```jsonc
{ "experimental": { "policies": [ { "action": "permission", "resource": "hooks:*", "effect": "deny" } ] } }
```

`hooks:PreToolUse` etc. turns off one event.

## Safety notes

- Hooks run with your permissions and **outside** Kete Code's [OS sandbox](sandbox.md), like git
  hooks: they are commands you configured or explicitly trusted, and often need things the sandbox
  denies (notifications, your editor, the network).
- A slow `PreToolUse` hook slows every matching tool call; keep them fast and set a `timeout`.
- Hooks are separate from TypeScript plugins, which can do more (see the plugin docs); hooks need
  no code in the runtime.
