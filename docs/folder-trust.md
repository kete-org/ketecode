# Folder trust

A repository's own configuration (`kete.json`, `kete.jsonc` and `.kete/` in the folder you open, or
in a folder above it) is written by whoever wrote the repository. Some of its settings can run code
on your computer or send your prompts and keys somewhere else. So **Kete Code holds those settings
back until you say you trust the folder.** Everything else in it loads as usual.

## What is held back

Until the folder is trusted, these settings from its project configuration don't apply:

| Setting | Why |
| --- | --- |
| `mcp` | local MCP servers run commands; remote ones receive your data |
| `providers` (`provider`) | a base URL, API key or headers send prompts and keys elsewhere |
| `plugins` (`plugin`) and code in `.kete/plugin/` or `.kete/plugins/` | plugin code runs inside Kete Code |
| `share` (unless `"disabled"`), `autoshare`, `enterprise` | sharing sends sessions to a service |
| `kete.integrations`, `kete.platform`, `kete.unattended`, `kete.hooks` | integrations, the platform URL, unattended-run settings and [hooks](hooks.md) |
| `formatter` (unless `false`) | formatters run programs, and the built-in ones run tools installed in the project |
| `shell` | the shell every command runs in |
| `worktree` | where worktrees, and their setup script, are created |
| `skills` URLs and git `references` | they are fetched when they load (local paths still load) |
| shell commands in commands: ``!`…` `` in a command's template (`.kete/command(s)/**/*.md`, or `commands` in the config) | they run on your computer when you use the command; until you trust the folder, the command still works but its shell commands don't run (the prompt says so) |
| `{env:…}` and `{file:…}` in any value | they read your environment and files; until you trust the folder they are left as written |
| `experimental.policies` statements that allow | a repository's allow would outrank a deny set for you; its deny statements still apply |
| `enabled_providers` (older key) | it becomes an allow for each provider it lists; `disabled_providers` still applies, and both are part of what you trust, so changing either asks again |
| permission rules that loosen | see below |

**Permission rules.** In the project's `permissions` (and the older `permission` and `tools` keys),
in each agent's `permissions` in its config, and in the front matter of its agent files
(`.kete/agent(s)/**/*.md`, `.kete/mode(s)/*.md`):

- every `allow` rule is held back;
- an `ask` rule is held back when its action overlaps a `deny` rule from your global configuration
  (or your organization's), because rules are applied last-match-wins and the project's `ask` would
  otherwise turn your `deny` into a question;
- every other `deny` and `ask` rule still applies, so a repository can always make things stricter.

**Commands that run shell commands, once trusted.** Each ``!`…` `` in a command still goes through
the same permission check as the agent's shell commands (your permission mode, rules and policies
apply) and runs in the [OS sandbox](sandbox.md), from the folder you opened; it can't `cd` out of the
workspace. A command file that changes after you trust the folder, or a new one with shell commands,
doesn't run its shell commands until you trust the folder again. This applies to your own global
commands too, except the trust part.

**Still loaded, trusted or not:** `AGENTS.md` and other instructions, agents, commands (without their
shell commands, above), local skills
and references, the model, LSP settings that turn things off, sandbox settings that tighten it, and
every other setting. Your global configuration (`~/.config/kete/`), `KETE_CONFIG`, `KETE_CONFIG_CONTENT` and
your organization's settings are yours and are never held back.

A folder whose project configuration sets none of the above never asks.

**Your own `kete` settings stay in force.** Kete Code reads the last `kete` object it loads as a
whole, so a project's `kete` object would otherwise replace yours. Whether the folder is trusted or
not, `kete.offline: true` in your configuration stays on even if the project says `false`, and your
`kete.integrations`, `kete.platform` and `kete.unattended` apply whenever the project doesn't set its
own (or it is held back).

**The terminal UI's own plugins.** TUI plugins in a project's `.kete/plugins/` run inside the
terminal UI, so it loads them only when the runtime, asked about the terminal UI's own folder, says
the folder is trusted and its plugin files are the ones that were trusted (the terminal UI checks the
files itself just before loading them). It loads them as soon as you trust the folder. A local
plugin the runtime reports in its own plugin list (a project's `.kete/plugins/` or a project-configured
local plugin with a TUI part) is checked the same way: the terminal UI loads it only when the runtime
vouches for its files as they are now; plugins in your global plugin directory, local plugins your
global configuration names and npm packages aren't affected.

## The question

The first time Kete Code loads a folder that has something held back, it asks once:

> **Trust this folder?** The project configuration in "/path/to/repo" can run code on this machine
> or send data elsewhere. Until you trust this folder, Kete Code holds back: …

The list names each setting as it would load: local MCP server commands and the names of their
environment variables, remote MCP URLs, provider packages, endpoints, environment variable names and
the names of their headers (never a key or header value), plugin specs and plugin directories, each
project hook command, formatter commands, the shell, the worktree directory, skills URLs, git
references, policy allow statements, each environment variable and file a `{env:…}` or `{file:…}`
would read, and each held-back permission rule. Control, bidi and zero-width characters are shown
escaped (`\u{202E}`), so the text can't hide or reorder anything. If something is too long to show
in full, the question offers only "Not now": review the configuration and trust the folder with
`kete trust add`, which prints everything.

- **Trust this folder** remembers your answer and reloads the folder's configuration with
  everything, straight away: MCP servers start and plugins load. It also trusts the folder's current
  [project hooks](hooks.md), so you aren't asked about them separately.
- **Not now** keeps holding them back until Kete Code restarts. Then it asks again.

The question appears in the terminal UI (on the home screen and in a session) and in the chat panel
of VS Code and JetBrains, above the message box. Several sessions or windows in the same repository
share one question.

**What you trust is what you reviewed.** Trust is stored for the folder's *trust root* (below)
together with a fingerprint of everything held back: the values of those settings in every project
configuration file that applies, the `{env:…}` and `{file:…}` each file uses, the contents of any
file a held-back setting reads through `{file:…}`, the contents of the plugin directories and of
any local plugin a project file configures, and every agent file. If any of that changes (a different MCP command, a new plugin file, an edited plugin or
agent file, a changed script an MCP command reads), you're asked again. Changing anything else
(instructions, the model, a theme) doesn't ask. Values are fingerprinted before `{env:…}`
substitution, so rotating a secret in your environment doesn't ask again, and no secret is ever
stored.

A configuration file that can only be read after substitution (for example `"port": {env:PORT}`,
unquoted) can't be checked, so a folder that has one can't be trusted. Nor can one with a `{env:…}`
or `{file:…}` anywhere but inside a string value (in a comment, a property name or between values),
or a `{file:…}` whose path comes from `{env:…}`: substituting those could change what the file sets.

**What loads is what you reviewed.** A `{file:…}` is filled in from the very contents Kete Code
checked, never read a second time, and each configuration file is checked once filled in: if
substitution changed anything but the values the tokens sit in (say an environment variable holding
a `"` that adds a setting), the folder isn't trusted and the question says why. Plugin code (a
`.kete/plugin(s)/` directory, its `node_modules` included, or a local plugin a project file
configures) and agent files are checked again just before they load: if they changed since the folder
was trusted, they don't load and you're asked again.

## Trust roots

- Inside a git repository, the trust root is the repository's top folder: trusting it covers every
  folder inside it. A linked worktree (`git worktree add`) shares its main repository's trust root,
  but only when git's own record of the worktree points back at it, so a crafted `.git` file can't
  borrow another repository's trust.
- Outside a repository, the trust root is the folder itself.
- Paths are resolved first: opening a repository through a symlink is the same as opening it
  directly. A folder whose name merely starts with a trusted one (`/work/repo-evil` next to
  `/work/repo`) is a different folder.
- **Your home directory and the root of the file system can never be trusted.** Opening Kete Code
  there offers only "Not now", with the reason; open a project folder instead.
- A folder with more than 5,000 plugin and agent files to check, or more than 50 MiB of them, can't
  be fingerprinted and so can't be trusted (for example a plugin directory with its own
  `node_modules`).
- On Windows, trust roots are compared without regard to case. On macOS, paths are compared as the
  file system reports them after resolving symlinks.

## `kete trust`

```text
kete trust                     # list trusted folders (same as `kete trust list`)
kete trust list --format json
kete trust add [path]          # trust a folder (default: the current directory)
kete trust remove [path]       # stop trusting it, and its project hooks
```

`kete trust add` shows what it is trusting and refuses your home directory, the root of the file
system and a folder too large to fingerprint (exit code 2). A running Kete Code applies a change
from `kete trust` the next time that folder's configuration loads (restart it, or change a
configuration file).

Trusted folders are stored in `folder-trust.json` in Kete Code's state directory, outside any
project, written with permissions only you can read. A store that can't be read or doesn't make
sense trusts nothing.

## Scripts, CI and other clients

- **`kete run`** never asks. In an untrusted folder it holds the settings back and prints one line
  naming them:

  ```text
  Warning: this folder isn't trusted, so Kete Code held back its project settings: MCP server "tools": runs ["node","./mcp.js"]; … Trust it with `kete trust add`, or for this run only with --trust-project-config.
  ```

  `kete run --trust-project-config` (or `KETE_TRUST_PROJECT_CONFIG=1`) trusts the folder for that
  run only and stores nothing. It runs on a private server instead of the background service, so
  the trust can't leak to other sessions; it can't be combined with `--server`.
- **`kete job run`** keeps its own, unchanged check of the repository's configuration
  ([jobs](jobs.md)): it refuses a repository that sets providers, MCP servers, plugins or Kete
  integration settings unless you pass `--trust-project-config`, which now also runs it on a
  private server that trusts the folder for that run. With `--server`, the server you connect to
  applies its own folder trust. Cloud, self-hosted and review jobs load no project configuration at
  all; if a job's runtime finds project configuration anyway, it holds it back like any other
  untrusted folder.
- **ACP** (editors that talk to `kete acp`) doesn't show the question: settings stay held back and a
  warning naming them goes to the log. Trust the folder with `kete trust add` first.

## After updating

Nothing was migrated: after this update every folder with any of these settings asks once,
including folders you used before. Answer once per repository (or run `kete trust add` there).
