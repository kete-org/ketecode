# Permissions and permission modes

Every tool call Kete Code makes goes through allow / ask / deny permissions. This page covers what
Kete Code does without asking by default, the five permission modes, how to switch between them in
each client, and how you and your organization can loosen or tighten the defaults.

**This is a guard, not a sandbox.** Kete Code reads each command before it runs and asks before the
risky ones, but anything it is allowed to run — a test, a build, a script — runs with your user's
full access. A local sandbox is planned; until then, use `ask` mode or a throwaway environment for
work you don't trust.

## The default: safe for interactive work

In an interactive session (the terminal UI, `kete run`, the VS Code and JetBrains extensions and the
web UI), with no mode chosen, Kete Code:

| Runs without asking | Asks first |
| --- | --- |
| Reading and searching files, listing, LSP, todos | Reading `.env` files, anything outside the workspace (upstream's own rules) |
| Editing files in the workspace | Editing a build or test entry point (below), and **always** editing Kete Code's own configuration or `.git` (below) |
| Read-only commands: `ls`, `cat`, `head`, `grep`/`rg`, `find` (without `-delete`/`-exec rm`), `git status`/`diff`/`log`/`show`/`branch`, `jq`, simple `sed -n '…p'` / `sed 's/a/b/g'`, … | Any other shell command that may change something: `git commit`, `mkdir`, `cp`, `node script.js`, `npm start`, writing a file with `>`, `sed -i`, … |
| The project's own test, build, lint and typecheck commands: `npm test`, `npm run build`, `bun run typecheck`, `pnpm lint`, `cargo test`, `go test`, `pytest`, `tsc`, `make test`, `./gradlew test`, … | Web fetches and web searches |
| | **High-risk commands, always** (below) |

Test and build commands are allowed because running them is the core loop. They run the project's
code: a test file, a `conftest.py` or a package script can do anything. To stop the agent from
quietly turning "run the tests" into "run anything", Kete Code asks before an edit to a file that
decides what those commands run, and after such an edit it asks once before the next test or build
command. These **build and test entry points** are: `package.json`, lockfiles, `Makefile`/`*.mk`,
`justfile`, `Taskfile*`, `build.rs`, `pyproject.toml`, `setup.py`/`setup.cfg`, `conftest.py`,
`tox.ini`, `noxfile.py`, `*.config.{js,cjs,mjs,ts,cts,mts}` (Vite, Vitest, Jest, ESLint, …),
`.npmrc`, `.yarnrc*`, `bunfig.toml`, `deno.json(c)`, `.envrc`, Gradle and Maven build files,
`Gemfile`/`Rakefile`, `.github/workflows/**` and `.husky/**`, plus `turbo.json`, `nx.json`,
`project.json`, `lerna.json`, `composer.json`, `Cargo.toml`, `.cargo/config`, `go.mod`/`go.work`,
Gradle/Maven wrappers (`gradlew`, `mvnw`, `.mvn/**`), `Package.swift`, `CMakeLists.txt`, Bazel files,
Babel/ESLint/Mocha/Prettier rc files, `jest.config.json`, `vitest.workspace.*`, test setup files
(`jest.setup.*`, `vitest.setup.*`, `global-setup.*`), `pytest.ini`, `phpunit.xml`, `.rspec`,
`spec_helper.rb`, `karma.conf.js`, `manage.py`, `node_modules/**`, `sitecustomize.py`, `*.pth`,
`.pre-commit-config.yaml`, `lefthook.yml`, `.vscode/tasks.json`, `.mise.toml`, `.gitmodules`,
`.gitattributes`, CI files (`.gitlab-ci.yml`, `Jenkinsfile`), and the instruction files `AGENTS.md`
and `CLAUDE.md` (they ask, but don't count as a build change). Package-manager writes such as
`npm pkg set` or `npm config set` are high-risk and count as a build change too. Kete Code checks the
real path of an edit, so a symlink in the repository (`cfg -> .git`, or a dangling
`notes.json -> .kete/kete.jsonc` whose target doesn't exist yet) doesn't get around these rules; a
symlink chain it can't follow counts as protected.
The "build changed" note is kept in the running runtime's memory per session family: restarting
the runtime forgets it.

**Accepted residual risk (decided 2026-10-08).** Ordinary source and test files are not on the list,
so an edited test file can run any code the next time the tests run, without a prompt. Asking before
the first build after *any* edit would break the edit-and-test loop, so this risk is accepted for
now. Containment comes from the local OS sandbox (Wave 0b, the next task), which must block writes
to the protected paths and network access for build and test commands. Until then, use `ask` mode
for work you don't trust.

**Kete Code's own configuration and git's internals always ask** in every mode (Plan blocks them),
even when a rule allows edits: `.kete/**` (config, agents, skills, plugins, commands),
`kete.json`/`kete.jsonc`, the global config and data directories (`~/.config/kete`,
`~/.local/share/kete`) and `.git/**` (hooks and config run commands). Otherwise an agent could write
itself a permission rule. Shell commands that write there (`echo … > .kete/kete.json`,
`git config …`) are high-risk.

**High-risk commands** ask in every mode except Plan, which blocks them:

- Git: `git push` (any), `reset --hard`, `clean`, `checkout -- <file>` / `checkout .`, `restore`,
  `branch -D`, `stash drop`, `git rm`, `git config` (set), `git -c …` / `--config-env`, any force flag
- Deleting or moving files: `rm`, `rmdir`, `unlink`, `mv`, `find -delete`, `xargs rm`, `dd`, …;
  `chmod -R`/`chown -R`
- Package installs, removals and publishing: `npm`/`pnpm`/`yarn`/`bun` `install`/`add`/`remove`/
  `publish`, `npx`/`bunx`, `pip install`, `uv add`, `uv run` (it syncs the environment), `poetry
  add`, `cargo add`/`install`, `go get`, `brew`, `apt`, `gem`, …; package scripts named like
  `deploy`, `release`, `publish`, `migrate`, `db:*`, `prod`, `clean`, …
- Network clients: `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, …; code from a URL (`deno test https://…`)
- Containers, cloud, infrastructure and deployment: `docker`, `podman`, `kubectl`, `helm`,
  `terraform`, `pulumi`, `aws`, `gcloud`, `az`, `vercel`, `fly`, `gh`, `supabase`, …
- Databases and migrations: `psql`, `mysql`, `mongosh`, `redis-cli`, `prisma migrate`/`db push`,
  `drizzle-kit push`, `rails db:*`, `manage.py migrate`, …
- `sudo` and other privilege escalation; system services and settings (`systemctl`,
  `launchctl`, `crontab`, …); `alias`/`function` definitions
- Credentials and secrets: `.env` and key files (also through globs like `.env*` or brace
  expansion), `~/.ssh`, `~/.aws`, `printenv`/`env`, `jq env`, `ps e`, `%VAR%`, `$env:`, `env:`, keychains
- Commands that run another program the classifier can't see: `rg --pre`, `git grep -O`,
  `bat --pager`, `fd --exec=…`
- Leaving the workspace: `cd` alone, `cd -`, `cd ..`, `pushd +1` or `cd /elsewhere` (also inside
  subshells, loops, functions and conditions — the shell tool's own directory check now treats a
  `cd` with no target as going home, and one it can't know — `-`, `+N`, `~user`, a variable, a glob,
brace expansion, or any target under `CDPATH=…` — as going anywhere; PowerShell's `Set-Location`
with no path or `-` too); `CDPATH=…`; writing outside the
  workspace (`> /etc/…`, `>> ~/.bashrc`); build output into protected paths (`go build -o
  .git/hooks/…`, `tsc --outDir .kete`)
- Anything the classifier can't check: command substitution (`$(…)`, backticks), subshells,
  heredocs, a command named by a variable or built with brace expansion, unbalanced quotes

How commands are read: the shell tool splits a command line into its commands (pipes, `&&`, `;`,
loops, `$(…)`), and each one is checked, plus the whole line for directory changes; the line asks if
any part does. Kete Code also unwraps `sudo`, `env`, `timeout`, `nohup`, `time`, `xargs`,
`find -exec`, `sh -c "…"`, `bash -c`, `eval` and `cmd /c`, reads backslashes both the POSIX way
(`r\m` is `rm`) and the Windows way, ignores quoted text (`git commit -m "don't git push"` is just a
commit) and treats `NAME=value` prefixes as changing what a command does.

## Permission modes

| Mode | Edits | Read-only and test/build commands | Other commands | High-risk commands | Web fetch/search |
| --- | --- | --- | --- | --- | --- |
| `default` | run (entry points ask) | run | ask | ask | ask |
| `accept-edits` | run (entry points ask) | run | ask | ask | ask |
| `auto` | run | run | run | **ask** | run |
| `ask` | ask | ask | ask | ask | ask |
| `plan` | **blocked** | read-only run, test/build blocked | blocked | blocked | ask |

Edits to Kete Code's configuration and `.git` ask in every mode but Plan, which blocks them.

- **`accept-edits`** is the same as `default` today, because the default already edits without
  asking; it exists for clients that offer that name.
- **`auto`** is not a bypass: high-risk commands still ask. But it only sees the literal command:
  `node -e …`, `python -c …` or a script the agent wrote can do anything you can, including the
  high-risk things. Web fetches run without asking, so a page's content and the URL you fetch can
  carry data out; use `default` when that matters.
- **`ask`** asks even when a rule or an earlier "Always allow" would allow the request.
- **`plan`** is enforced by the runtime: no edit and no command that changes anything runs, even
  one a rule allows. Only reading and searching, questions, skills, read-only commands, web
  requests (asked), MCP resource reads and subagents (which run in Plan mode too) are available;
  MCP tools and worktrees are blocked, because the runtime can't tell a read-only MCP tool from one
  that changes things. The clients' Plan also switches to the read-only **Plan** agent for its
  planning prompt.

A subagent follows its root session's mode (the root-most session that has one). Unattended runs
(`kete job run`, cloud jobs) don't use these defaults: they keep their own fail-closed policy
([ADR 0008](adr/0008-unattended-runs-fail-closed.md)).

### Choosing a mode

| Client | How |
| --- | --- |
| Terminal UI | `kete --permission-mode <mode>` for new sessions (and the one `--continue`/`--session` resumes); `<leader>p` or `/mode` cycles Default → Auto → Ask → Plan for the open session. The prompt's status row shows any mode but Default. |
| `kete run` | `kete run --permission-mode <mode> "…"`. `kete run` can't answer prompts: a request that asks is rejected and the run stops. |
| `--auto` | Same as `--permission-mode auto`. |
| `--dangerously-skip-permissions` | The explicit bypass: the client approves every request that isn't denied, high-risk ones included. Only for throwaway environments. (`--yolo` is a hidden alias, and the terminal UI's "auto accept" setting does the same.) |
| VS Code, JetBrains, web UI | The **Default / Auto / Ask / Plan** toggle next to send. In VS Code the shield in the chat's title bar switches between Ask and Default, and `kete.chat.askBeforeEdits` makes new chats start in Ask; JetBrains has the same default-mode setting. |
| Runtime default | `KETE_PERMISSION_MODE=<mode>` for sessions that don't set one (the extensions set it from their setting). |

A session's mode is its `kete.permissionMode` metadata, so every client shows and changes the same
value. Clients change it by reading the session's metadata, merging the key and writing the whole
metadata back (the server replaces metadata whole), so two clients changing *other* metadata keys of
the same session at the same moment can overwrite each other's change; the mode itself is re-read
and shown after every write.

## Loosening and tightening the defaults

The defaults only apply where nothing more specific was said. Any rule that names the action wins
over them (except in `ask` and `plan` modes, and except for Kete Code's configuration and `.git`):

```jsonc
// .kete/kete.jsonc or ~/.config/kete/kete.jsonc
{
  "permissions": [
    { "action": "shell", "resource": "git push origin feature/*", "effect": "allow" },
    { "action": "shell", "resource": "docker compose up*", "effect": "allow" },
    { "action": "edit", "resource": "package.json", "effect": "allow" },
    { "action": "webfetch", "resource": "https://docs.example.com/*", "effect": "allow" },
    { "action": "shell", "resource": "terraform *", "effect": "deny" }
  ]
}
```

A rule `{ "action": "*", "resource": "*", "effect": "allow" }` looks the same as upstream's
built-in catch-all, so it does **not** turn the defaults off; name the action (`"shell"`, `"edit"`,
`"webfetch"`) instead.

An agent's own `permissions` and a session's rules count the same way. Web fetches follow redirects themselves: a redirect to another site asks first, like a new fetch.

Answering **Always allow**
to a prompt saves an approval for the project, with limits: it isn't offered for high-risk
commands or for commands that run anything or write files their arguments don't show (`bash`,
`node`, `python`, `java`, `npx`, `env`, `xargs`, `sudo`, `go run`, `cargo run`, `poetry run`,
`bundle exec`, `tmux`, `vim`, `tar`, `unzip`, `patch`, `git apply`, `npm pkg`, …), and a saved approval never covers a high-risk command — only a configured rule can.
For a web fetch it covers that site (scheme, host and port), not every URL.

Tightening always wins: a `deny` rule is decided before any mode runs, and your organization's
policies (synced from the Kete platform) and `experimental.policies` in config are applied after
the mode, so they can deny what a mode or rule would allow. No mode turns `ask` or `deny` into
`allow`.

## Upgrading from earlier versions

- Interactive sessions now ask before shell commands that can change things, before web requests
  and always before high-risk commands. Before, everything but `.env` reads and paths outside the
  workspace ran without asking.
- **`kete run` in scripts and CI** stops at the first command that needs approval (it rejects the
  prompt and ends the run). Use `--permission-mode auto` for trusted automation that should only
  stop at high-risk commands, configured `permissions` rules for the specific commands it needs, or
  `--dangerously-skip-permissions` in a throwaway environment. For unattended jobs, use
  `kete job run` and its policy.
- **`--auto` no longer approves everything**: it is the `auto` mode, so high-risk commands still
  ask (and are rejected in `kete run`). The old behaviour is `--dangerously-skip-permissions`.
- Plan is now enforced by the runtime as a mode, not only by the Plan agent's prompt.

## Reference

- Runtime: `packages/core/src/kete/permission-mode.ts` (modes and defaults),
  `packages/core/src/kete/shell-risk.ts` (command classification, protected paths, entry points),
  shared names in `packages/util/src/kete/permission-mode.ts`.
- Knowledge-base card: `docs/context/modules/permissions.md`.
