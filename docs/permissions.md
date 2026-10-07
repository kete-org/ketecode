# Permissions and permission modes

Every tool call Kete Code makes goes through allow / ask / deny permissions. This page covers what
Kete Code does without asking by default, the five permission modes, how to switch between them in
each client, and how you and your organization can loosen or tighten the defaults.

## The default: safe for interactive work

In an interactive session (the terminal UI, `kete run`, the VS Code and JetBrains extensions and the
web UI), with no mode chosen, Kete Code:

| Runs without asking | Asks first |
| --- | --- |
| Reading and searching files, listing, LSP, todos | Reading `.env` files, anything outside the workspace (upstream's own rules) |
| Editing files in the workspace | |
| Read-only commands: `ls`, `cat`, `head`, `grep`/`rg`, `find` (without `-delete`/`-exec rm`), `git status`/`diff`/`log`/`show`/`branch`, `jq`, `sed -n`, … | Any other shell command that may change something: `git commit`, `mkdir`, `cp`, `node script.js`, `npm start`, writing a file with `>`, … |
| The project's own test, build, lint and typecheck commands: `npm test`, `npm run build`, `bun run typecheck`, `pnpm lint`, `cargo test`, `go test`, `pytest`, `uv run pytest`, `tsc`, `make test`, `./gradlew test`, … | Web fetches and web searches |
| | **High-risk commands, always** (below) |

**High-risk commands** ask in every mode except Plan, which blocks them:

- Git: `git push` (any), `reset --hard`, `clean`, `checkout -- <file>` / `checkout .`, `restore`,
  `branch -D`, `stash drop`, `git rm`, any force flag
- Deleting or moving files: `rm`, `rmdir`, `unlink`, `mv`, `find -delete`, `xargs rm`, `dd`, …;
  `chmod -R`/`chown -R`
- Package installs, removals and publishing: `npm`/`pnpm`/`yarn`/`bun` `install`/`add`/`remove`/
  `publish`, `npx`/`bunx`, `pip install`, `uv add`, `poetry add`, `cargo add`/`install`,
  `go get`, `brew`, `apt`, `gem`, …
- Network clients: `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, …
- Containers, cloud, infrastructure and deployment: `docker`, `podman`, `kubectl`, `helm`,
  `terraform`, `pulumi`, `aws`, `gcloud`, `az`, `vercel`, `fly`, `gh`, `supabase`, …
- Databases and migrations: `psql`, `mysql`, `mongosh`, `redis-cli`, `prisma migrate`/`db push`,
  `drizzle-kit push`, `rails db:*`, `manage.py migrate`, …
- `sudo` and other privilege escalation; system services and settings (`systemctl`,
  `launchctl`, `crontab`, …)
- Credentials: `.env` and key files, `~/.ssh`, `~/.aws`, `printenv`/`env`, keychains
- Writing outside the workspace (`> /etc/…`, `>> ~/.bashrc`, `cp x /usr/local/bin`)
- Anything the classifier can't check: command substitution (`$(…)`, backticks), subshells,
  heredocs, a command named by a variable, unbalanced quotes

How commands are read: the shell tool splits a command line into its commands (pipes, `&&`, `;`,
loops, `$(…)`), and each one is checked; the line asks if any part does. Kete Code also unwraps
`sudo`, `env`, `timeout`, `nohup`, `xargs`, `find -exec`, `sh -c "…"`, `bash -c`, `eval` and
`cmd /c`, ignores quoted text (`git commit -m "don't git push"` is just a commit) and treats
`NAME=value` prefixes as changing what a command does. This is a guard, not a sandbox: a project
script that the default allows (`npm test`, `make build`) runs whatever the project defines.

## Permission modes

| Mode | Edits | Read-only and test/build commands | Other commands | High-risk commands | Web fetch/search |
| --- | --- | --- | --- | --- | --- |
| `default` | run | run | ask | ask | ask |
| `accept-edits` | run | run | ask | ask | ask |
| `auto` | run | run | run | **ask** | run |
| `ask` | ask | ask | ask | ask | ask |
| `plan` | **blocked** | read-only run, test/build blocked | blocked | blocked | ask |

- **`accept-edits`** is the same as `default` today, because the default already edits without
  asking; it exists for clients that offer that name.
- **`auto`** is not a bypass: high-risk commands still ask.
- **`ask`** asks even when a rule or an earlier "Always allow" would allow the request.
- **`plan`** is enforced by the runtime: no edit and no command that changes anything runs, even
  one a rule allows. The clients' Plan also switches to the read-only **Plan** agent for its
  planning prompt.

A subagent follows its root session's mode. Unattended runs (`kete job run`, cloud jobs) don't use
these defaults: they keep their own fail-closed policy ([ADR 0008](adr/0008-unattended-runs-fail-closed.md)).

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
value.

## Loosening and tightening the defaults

The defaults only apply where nothing more specific was said. Any rule that names the action wins
over them (except in `ask` and `plan` modes):

```jsonc
// .kete/kete.jsonc or ~/.config/kete/kete.jsonc
{
  "permissions": [
    { "action": "shell", "resource": "git push origin feature/*", "effect": "allow" },
    { "action": "shell", "resource": "docker compose up*", "effect": "allow" },
    { "action": "webfetch", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "terraform *", "effect": "deny" }
  ]
}
```

An agent's own `permissions` and a session's rules count the same way, and so does answering
**Always allow** to a prompt (saved per project; for web fetches it covers every URL).

Tightening always wins: a `deny` rule is decided before any mode runs, and your organization's
policies (synced from the Kete platform) and `experimental.policies` in config are applied after
the mode, so they can deny what a mode or rule would allow. No mode turns `ask` or `deny` into
`allow`.

## Reference

- Runtime: `packages/core/src/kete/permission-mode.ts` (modes and defaults),
  `packages/core/src/kete/shell-risk.ts` (command classification), shared names in
  `packages/util/src/kete/permission-mode.ts`.
- Knowledge-base card: `docs/context/modules/permissions.md`.
