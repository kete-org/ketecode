# Kete Code

Use this guide for work involving Kete Code itself: configuring and customizing
it, extending it with plugins, and building integrations with its SDK, clients,
and API.

## What Kete Code is

Kete Code is an AI coding agent built on OpenCode V2 (MIT). The agent runtime,
configuration model, plugin API, SDK, and HTTP API are OpenCode V2's, with the
Kete Code differences listed below. The command is `kete`.

## Documentation and the name mapping

Kete Code does not have its own documentation site yet. For detailed reference
(configuration fields, plugins, the SDK, clients, and the HTTP API), use the
OpenCode V2 documentation at <https://opencode.ai/v2/docs/> (index:
<https://opencode.ai/v2/llms.txt>) as the upstream reference. Fetch the page for
the topic before answering, and translate every name with this table. Never give
the user an OpenCode path, file name, command, or variable from those pages
unchanged.

| OpenCode docs say                                       | In Kete Code use                                |
| ------------------------------------------------------- | ----------------------------------------------- |
| `opencode <command>`                                    | `kete <command>`                                |
| `~/.config/opencode/` (or `$XDG_CONFIG_HOME/opencode/`) | `~/.config/kete/` (or `$XDG_CONFIG_HOME/kete/`) |
| `~/.local/share/opencode/`                              | `~/.local/share/kete/`                          |
| `opencode.json` / `opencode.jsonc`                      | `kete.json` / `kete.jsonc`                      |
| `.opencode/` project directory                          | `.kete/`                                        |
| `OPENCODE_<NAME>` environment variable                  | `KETE_<NAME>`                                   |
| "OpenCode" (the product)                                | "Kete Code"                                     |

Kete Code reads only the names in the right-hand column. The OpenCode names on
the left are ignored, so configuration written with them silently has no effect.

Use only the V2 documentation (`/v2/docs/`); `https://opencode.ai/docs/`
documents OpenCode V1. Do not fetch `https://opencode.ai/config.json` to learn
configuration shapes: it may describe V1. If the V2 documentation is missing or
contradicts this guide, trust this guide for Kete Code behavior and say what is
uncertain.

## Kete Code differences from OpenCode

- **No `$schema` URL yet.** Kete Code has not published a configuration schema.
  Do not add `"$schema": "https://opencode.ai/config.json"` to Kete Code files.
- **Updates:** `kete upgrade` is not available yet; it reports that and makes no
  changes. Do not suggest OpenCode's install scripts or packages as a way to
  update Kete Code.
- **OpenCode Zen is opt-in.** The hosted OpenCode Zen provider (`opencode`) is
  not enabled by default. A user who wants it connects it with `kete auth login`,
  sets its API key, or adds a `providers.opencode` entry to the configuration.
  For other providers, use `kete auth login` or `providers` configuration as in
  the OpenCode docs.
- **Kete Model Gateway.** The `kete` provider offers the models a Kete gateway
  allows (for example `kete/claude-sonnet-4-5`). The simplest setup is
  `kete login`, which signs in to a Kete Code account in the browser and configures
  the gateway, key and platform URL; `kete whoami` shows the account and `kete logout`
  signs out. A signed-in account takes precedence over hand configuration. To
  configure by hand instead, set the gateway root URL with `providers.kete.settings.baseURL` or `KETE_GATEWAY_URL`, and the Kete API
  key with `kete auth login` ("Kete Code Gateway"), `providers.kete.settings.apiKey`
  (e.g. `"{file:~/.config/kete/gateway-key}"`), or `KETE_GATEWAY_KEY`. Only models on
  the gateway's allowlist are listed; others are rejected by the gateway. Don't use
  `KETE_API_KEY` for the gateway: it is OpenCode Zen's key. `kete.runtime.type` (or
  `KETE_RUNTIME_TYPE`) tells the platform where this runtime runs — `local` (the default),
  `kete_cloud` or `enterprise_private`. With a platform URL
  (`kete.platform.url` or `KETE_PLATFORM_URL`), gateway models use Kete's prices from the
  platform, so session cost and `kete.budget.session` match what Kete charges. The
  session sidebar then also shows the Kete credit balance, and warns when it is low or
  used up (the gateway rejects requests once the balance reaches zero).
- **Managed agents.** When signed in, the agents the user's organization defines on the
  Kete Code platform are synced (at startup, every 5 minutes, after `kete login`, and on
  `kete sync`). Their descriptions end with "Managed by <organization>". A managed agent
  replaces a local agent with the same name, and its permissions come from the
  organization. Edit managed agents in the Kete portal, not in local files; `kete sync`
  fetches changes immediately. "Agent budget reached" means the agent used its monthly budget:
  an organization admin raises it in the portal. "Agent unavailable" means the organization
  paused or changed it; it disappears after the next sync. Skills and MCP servers those agents use are synced too.
  A synced MCP server that runs a command on the user's machine stays off until the user
  approves it with `kete sync --approve <key>` (never approve it on their behalf); `kete sync`
  lists what each server needs, and OAuth servers sign in with `kete mcp auth <key>`.
- **Session budget.** `{ "kete": { "budget": { "session": 5 } } }` pauses a session
  before its next model request once it has spent $5, and asks through the `budget`
  permission. Approving allows another $5. The permission rule
  `"permissions": [{ "action": "budget", "resource": "*", "effect": "deny" }]` stops the
  session instead (for scripts and CI), and `"effect": "allow"` turns the prompt off. Note that
  `kete run --dangerously-skip-permissions` auto-approves permissions that aren't explicitly
  denied, including `budget`; `--auto` doesn't.
- **Permission modes and safe defaults.** By default Kete Code edits files in the workspace and runs
  read-only and test/build commands without asking; any other shell command, web fetch/search and
  every high-risk command (`git push`, `reset --hard`, deletes, package installs, network tools,
  containers/cloud/deploy tools, databases, `sudo`, credentials, writes outside the workspace,
  commands it can't parse) asks first. A session's mode (`kete.permissionMode`: `default`,
  `accept-edits`, `auto`, `ask`, `plan`) changes that: `auto` stops asking except for high-risk
  commands, `ask` asks before every edit, command and web request, `plan` blocks edits and any
  command that changes something. Users switch with `kete --permission-mode <mode>`, `<leader>p` or
  `/mode` in the terminal UI, or the editor's mode toggle; a rule in `permissions` that names the
  action (e.g. `{ "action": "shell", "resource": "git push origin feature/*", "effect": "allow" }`)
  overrides the defaults. Editing Kete Code's own configuration, agents or skills (`.kete/`,
  `kete.json`) or `.git` always asks; editing build/test entry points (`package.json`, `Makefile`,
  `*.config.*`, `conftest.py`, …) asks, and the next test or build command after that asks once.
  Don't try to work around a prompt by writing permission rules or moving work into scripts. This
  is a guard, not a sandbox. Never suggest `--dangerously-skip-permissions` except for throwaway
  environments. When a command is refused in Plan mode, tell the user to switch modes rather than
  working around it.
- **Unattended runs.** A session family marked unattended (session metadata `kete.unattended`, set
  once at creation and never removable afterward — `kete job run` sets it) never waits on a person:
  every permission that would ask is denied instead, with the reason "unattended run: not allowed
  by this run's policy" (or "unattended run: no one to answer questions" for the `question` tool),
  unless the run's policy allows it in advance. The metadata value is
  `{ "version": 1, "allow": [{ "action": "shell", "resource": "bun test*" }], "budget": 5, "timeout": 30 }`:
  `allow` is an optional list of rules the run may proceed on without asking (it can never allow
  `question` or `budget`, and never overrides a `deny`); `budget` (USD) and `timeout` (minutes) are
  the run's own spending and time limits. The run refuses to start without a budget and a time
  limit, from either the policy or `kete.budget.session` / an explicitly set `kete.subagents.timeout`
  — the run's timeout bounds the whole family, not just individual subagents, and it is stopped once
  reached. A subagent (including a worktree subagent) of an unattended session is unattended too.
  In every unattended run, editing Kete configuration (`.kete/`, `kete.json`/`kete.jsonc`, the
  global config directory) is always denied, whatever the policy or the agent's own rules say.
- **Unattended jobs.** `kete job run <spec.json>` runs a job from a JSON spec file: a prompt (or
  `prompt_file`), optional `agent`/`model`, the `policy` above, and an optional `branch` name. It
  creates its own git worktree and branch (from the current directory's committed `HEAD`, so
  uncommitted changes aren't included) and starts the session there, so it never touches the
  working checkout; a directory that isn't a git repository runs the job in place instead. See
  `docs/jobs.md` for the spec fields, the `--json` result shape, and exit codes.
- **Job mode.** A build with `KETE_JOB_MODE=1` set (the cloud-job runtime image; not the default
  local install) refuses every tool that would start a process — the shell tool, MCP servers,
  formatters, git-backed features — until its second-user tool runner exists, ignores the repo's
  own configuration and plugins entirely, disables every MCP server, allows only the `kete`
  provider's models, and requires every session to be unattended. In a job, kete's file tools never
  follow a symbolic link or leave the working tree (a path through a link, `..` or an absolute path
  outside it is refused: "Job mode: refused to follow a symbolic link or leave the working tree"),
  so read and edit files by their real paths inside the worktree. See `docs/jobs.md` "Job mode".
- **Unattended audit log.** Every unattended run leaves a local, append-only record of what it did —
  tool calls, permission decisions (including denies and their reason), model steps, file changes
  and shell commands — at `<data dir>/audit/<root session id>.jsonl` (one JSON Lines file per run,
  mode 0600; a subagent's lines go to its root's file). Secrets are redacted and fields/lines are
  truncated before anything is written; past a per-run size cap, detail stops and a single
  `truncated` line is written while permission and run lines keep being recorded. If the log can't
  be written, the run stops instead of continuing unaudited. Interactive sessions write nothing.
  Locally nothing uploads the log. In a cloud job (job mode) there is no file: the log goes only to
  the job's audit pipe, which the job's entrypoint stores and uploads.
- **Subagent limits.** `{ "kete": { "subagents": { "timeout": 60, "max_concurrent": 4 } } }`
  (the defaults): a subagent running longer than `timeout` minutes is stopped and reported to
  its parent as failed (`0` means no limit), and a session can have at most `max_concurrent`
  subagents running at once. Stopping a session also stops its running subagents,
  including background ones.
- **Subagent worktrees.** The subagent tool's `worktree: true` runs a new subagent in its own
  git worktree (under Kete's data directory) on a new branch `kete/agent-<name>`, starting from
  the last commit; uncommitted changes aren't included. Use it for parallel subagents that edit
  files. The subagent is told to commit its work there; when it finishes, its answer ends with
  the branch, how many commits it made, and how to review and merge it. A subagent that changed
  nothing has its worktree and branch removed. Clean worktrees of deleted sessions are removed
  later; branches with commits are always kept. Removing a detached worktree whose commits no
  branch or tag holds needs force.
- **Subagent permissions.** A subagent can never do more than the agents above it: a request
  the parent's agent would be denied is denied for the subagent, and one it would be asked
  about is asked about. `session_move` moves only the current session or its subagents, asks
  before moving outside the repository, and can't move into another session's subagent worktree.
- **Stale writes.** `write` refuses to overwrite an existing file this session hasn't read, or
  that changed since it last read it (another agent or the user edited it): read the file again,
  then write it, or use `edit` for a partial change.
- **Automatic worktrees.** `{ "kete": { "subagents": { "worktree": "background" } } }` runs every
  background subagent that may edit files in its own worktree unless the call passes
  `worktree: false` (default `"never"`). A worktree starts from the last commit, so uncommitted
  changes aren't in it. The project's worktree setup script asks the `shell` permission first.
- **Workflows.** `kete.workflows` defines reusable workflows the `workflow` tool runs, for example:
  `{ "kete": { "workflows": { "feature": { "description": "Plan, build, then review", "steps": [
  { "id": "plan", "agent": "explore", "prompt": "Find what {{input}} touches and plan it" },
  { "id": "build", "agent": "general", "after": ["plan"], "worktree": true, "prompt": "Build this plan: {{steps.plan}}" },
  { "id": "review", "agent": "code-reviewer", "continue": "build", "prompt": "Review the changes" },
  { "id": "security", "agent": "security", "continue": "review", "prompt": "Review the changes for security" } ] } } } }`.
  Each step runs as a subagent (all subagent checks and limits apply); steps whose `after` steps
  have finished run at the same time; `{{input}}` is what the workflow works on and
  `{{steps.<id>}}` an earlier step's final answer; `continue` resumes an earlier step's session and
  worktree. A failed step skips the steps after it. Agents used as steps must be subagents or
  `mode: "all"` (Security and DevOps are).
- **Environment variables** use the `KETE_` prefix, e.g. `KETE_CONFIG_DIR`,
  `KETE_CONFIG_CONTENT`, `KETE_LOG_LEVEL`, `KETE_PASSWORD`.

## Configuration

Kete Code's server and project configuration is JSON or JSONC:

- Global: `~/.config/kete/kete.json(c)`.
- Project: `kete.json(c)` or `.kete/kete.json(c)` in any directory, including
  nested packages in a monorepo.

Project discovery searches the current directory and every ancestor up to the
filesystem root. Direct `kete.json(c)` files merge from the farthest ancestor to
the current directory, then `.kete/kete.json(c)` files do the same, so every
`.kete` configuration overrides every direct one. Global configuration has
lower precedence than discovered project documents.

Definitions live next to the configuration, in `~/.config/kete/` or a project's
`.kete/`: `agents/`, `commands/`, `skills/`, `plugins/`, and `themes/`. Skills
in `.claude/skills/` and `.agents/skills/` (project and home) are also loaded.
Project instructions come from `AGENTS.md` files, plus the global
`~/.config/kete/AGENTS.md`.

Common fields include `model`, `default_agent`, `permissions`, `agents`,
`commands`, `plugins`, `providers`, `mcp`, `skills`, `instructions`,
`references`, `formatter`, and `lsp`. Do not guess field names or shapes: fetch
the V2 configuration guide (<https://opencode.ai/v2/docs/config>) and its topic
pages, and preserve unrelated settings when editing a file.

## CLI and TUI settings

Terminal preferences are separate from the configuration above. They live only
in the global `~/.config/kete/cli.json` (or `$XDG_CONFIG_HOME/kete/cli.json`);
there is no project-local CLI configuration. `KETE_CLI_CONFIG_CONTENT` merges
inline JSON over it. Most preferences can also be changed in the TUI with
`Ctrl+P` → **Open settings**. For the full list of settings and keybindings, use
<https://opencode.ai/v2/docs/cli/config> and
<https://opencode.ai/v2/docs/cli/keybinds>. Never guess a command ID or key
syntax, and do not put these settings in `kete.json`.

## MCP servers

Configure MCP servers under `mcp.servers`. Prefer the CLI, which preserves
unrelated configuration. Use `--global` for a service the user wants everywhere;
omit it for project-local configuration.

```sh
kete mcp add <name> --global --url <remote-url>
kete mcp list
```

Remote servers use OAuth by default. If `kete mcp list` reports that a server
needs authentication, tell the user to run `/mcps`, select the server, and sign
in. Do not run `kete mcp auth` through the shell tool: its authorization link can
be hidden in background output. Report the server as configured but awaiting
sign-in until its status says it is connected. Never write a secret into
configuration; use an environment substitution such as `{env:MCP_API_KEY}`.

## Plugins, clients, SDK, and API

These are OpenCode V2's, unchanged. Fetch the relevant guide before answering
and apply the name mapping:

- Plugins: <https://opencode.ai/v2/docs/build/plugins> (TUI plugins:
  <https://opencode.ai/v2/docs/build/plugins/cli>; RPC:
  <https://opencode.ai/v2/docs/build/plugins/rpc>).
- Client: <https://opencode.ai/v2/docs/build/client>.
- SDK: <https://opencode.ai/v2/docs/build/sdk>.
- HTTP API: <https://opencode.ai/v2/docs/api>. The running server serves its
  OpenAPI document at `/openapi.json`.

For local API requests, use the built-in command, which handles discovery and
authentication:

```sh
kete api get /api/info
kete api post /api/example --data '{"key":"value"}'
```

## The background service

Kete Code uses a client-server architecture: the TUI connects to a background
Kete Code service that owns sessions, configuration, plugins, permissions, and
tool execution. It is discovered or started automatically. If it is stuck:

```sh
kete service restart
kete service status
```

## Troubleshooting

- Check the service with `kete service status` and the API with
  `kete api get /api/info`.
- Compare with `kete --standalone`, which runs the TUI with a private server, to
  isolate shared-service problems.
- Logs are in `~/.local/share/kete/log/` (`kete.log`, or `kete-<channel>.log`
  for development builds). Filter `role=cli` for client startup and
  `role=server` for sessions, providers, plugins, permissions, and tools.
- Run one reproduction with `KETE_LOG_LEVEL=DEBUG` when normal logs are not
  enough.
- Do not delete or edit the database, service registration, or service
  configuration while diagnosing. Back up persistent data before inspecting it.
- Redact API keys, authorization headers, prompts, file contents, and other
  sensitive data before sharing diagnostics.

To report a Kete Code bug, use the `report` skill.
