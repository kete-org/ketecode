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
| permission rules that loosen | see below |

**Permission rules.** In the project's `permissions` (and the older `permission` and `tools` keys),
in each agent's `permissions` in its config, and in the front matter of its agent files
(`.kete/agent(s)/**/*.md`, `.kete/mode(s)/*.md`):

- every `allow` rule is held back;
- an `ask` rule is held back when its action overlaps a `deny` rule from your global configuration
  (or your organization's), because rules are applied last-match-wins and the project's `ask` would
  otherwise turn your `deny` into a question;
- every other `deny` and `ask` rule still applies, so a repository can always make things stricter.

**Still loaded, trusted or not:** `AGENTS.md` and other instructions, agents, commands, skills, the
model, LSP settings that turn things off, sandbox settings that tighten it, and every other
setting. Your global configuration (`~/.config/kete/`), `KETE_CONFIG`, `KETE_CONFIG_CONTENT` and
your organization's settings are yours and are never held back.

A folder whose project configuration sets none of the above never asks.

## The question

The first time Kete Code loads a folder that has something held back, it asks once:

> **Trust this folder?** The project configuration in "/path/to/repo" can run code on this machine
> or send data elsewhere. Until you trust this folder, Kete Code holds back: …

The list names each setting: local MCP server commands, remote MCP URLs, provider endpoints and the
names of their headers (never a key or header value), plugin specs and plugin directories, formatter
commands, the shell, the worktree directory, and each held-back permission rule.

- **Trust this folder** remembers your answer and reloads the folder's configuration with
  everything, straight away: MCP servers start and plugins load. It also trusts the folder's current
  [project hooks](hooks.md), so you aren't asked about them separately.
- **Not now** keeps holding them back until Kete Code restarts. Then it asks again.

The question appears in the terminal UI (on the home screen and in a session) and in the chat panel
of VS Code and JetBrains, above the message box. Several sessions or windows in the same repository
share one question.

**What you trust is what you reviewed.** Trust is stored for the folder's *trust root* (below)
together with a fingerprint of everything held back: the values of those settings in every project
configuration file that applies, the contents of the plugin directories, and the agent files that
carry permission rules. If any of that changes (a different MCP command, a new plugin file, an edited
plugin), you're asked again. Changing anything else (instructions, the model, a theme) doesn't ask.
Values are fingerprinted before `{env:…}` substitution, so rotating a secret in your environment
doesn't ask again, and no secret is ever stored.

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
  all.
- **ACP** (editors that talk to `kete acp`) doesn't show the question: settings stay held back and a
  warning naming them goes to the log. Trust the folder with `kete trust add` first.

## After updating

Nothing was migrated: after this update every folder with any of these settings asks once,
including folders you used before. Answer once per repository (or run `kete trust add` there).
