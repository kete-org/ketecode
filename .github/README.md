<p align="center">
  <img src="../assets/brand/kete-logo-512.png" alt="Kete Code" width="96" height="96">
</p>

<h1 align="center">Kete Code</h1>

<p align="center"><strong>One agent. Any model. Every editor.</strong></p>

<p align="center">
  <a href="https://github.com/kete-org/kete-releases/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/kete-org/kete-releases?label=release&color=6e47f5"></a>
  <a href="https://www.npmjs.com/package/@ketecode/cli"><img alt="npm" src="https://img.shields.io/npm/v/@ketecode/cli?color=6e47f5"></a>
  <a href="https://github.com/kete-org/ketecode/actions/workflows/kete-build.yml"><img alt="CI" src="https://github.com/kete-org/ketecode/actions/workflows/kete-build.yml/badge.svg"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ketecode.kete-code"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/ketecode.kete-code?label=VS%20Code&color=6e47f5"></a>
  <a href="https://open-vsx.org/extension/ketecode/kete-code"><img alt="Open VSX" src="https://img.shields.io/open-vsx/v/ketecode/kete-code?label=Open%20VSX&color=6e47f5"></a>
  <a href="../NOTICE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-6e47f5"></a>
</p>

<p align="center">
  <a href="https://ketecode.ai">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="https://github.com/kete-org/kete-releases/releases">Releases</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

Kete Code is an AI coding agent for your terminal and editor. It reads your project, plans the
change, edits files, runs your builds and tests with your permission, and tells you honestly what
it did. Use Claude, GPT, Gemini, a local model or any OpenAI-compatible endpoint, with your own
keys or through one Kete account.

This repository is the open-source runtime: the agent, the `kete` CLI and the editor extensions,
under the MIT License and [built on OpenCode](#built-on-opencode). The Kete portal, model gateway
and other hosted services are run separately and are not part of it.

```text
$ kete
> add rate limiting to POST /api/upload, 10 requests a minute per key

  read   src/app/api/upload/route.ts
  edit   src/lib/rate-limit.ts            +38
  edit   src/app/api/upload/route.ts      +6 −1
  ask    run `npm test -- rate-limit`?    allow
  ✓ 3 passed · 2 files changed · ready for review
```

## Install

```sh
curl -fsSL https://ketecode.ai/cli/install | sh          # macOS and Linux
irm https://ketecode.ai/cli/install.ps1 | iex            # Windows (PowerShell)
brew install kete-org/tap/kete                           # Homebrew
npm install -g @ketecode/cli                             # npm (Node.js 20+)
```

The install scripts check the release's Sigstore signature and SHA-256 checksums before installing
anything, and never ask for sudo or administrator rights. On Alpine, run `apk add libstdc++ libgcc`
first. `kete upgrade` updates in place and verifies every download against a pinned signing key.
Options (`KETE_VERSION`, `KETE_INSTALL_DIR`, …) are on [ketecode.ai/install](https://ketecode.ai/install).

### In your editor

| Editor | Install |
|---|---|
| **VS Code** | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ketecode.kete-code), or `code --install-extension ketecode.kete-code` |
| **Windsurf, Cursor, VSCodium** | [Open VSX](https://open-vsx.org/extension/ketecode/kete-code): search "Kete Code" in the Extensions view |
| **JetBrains IDEs** (IntelliJ IDEA, PyCharm, WebStorm, GoLand, … 2024.3+) | coming to the JetBrains Marketplace; until then, the per-OS plugin zips on [the releases](https://github.com/kete-org/ketecode/releases/latest) install with **Settings → Plugins → ⚙ → Install Plugin from Disk…** |

The editor extensions include the `kete` runtime (the JetBrains Marketplace build downloads it on
first use, after asking, and verifies its signature before running it), so there is nothing else to
install.

## Get started

```sh
cd your-project
kete                              # interactive session in this directory
kete run "explain the auth flow"  # one-shot, prints the answer
kete auth login                   # add a model provider key (Anthropic, OpenAI, Google, …)
kete login                        # or sign in to a Kete account to use the gateway
```

### Shell completions

Tab completion for `kete`'s commands and flags. `kete completion` prints these lines; add the one for
your shell, then open a new shell:

| Shell | Where | Line |
| --- | --- | --- |
| bash | `~/.bashrc` | `eval "$(kete completion bash)"` |
| zsh | `~/.zshrc`, after `compinit` | `eval "$(kete completion zsh)"` |
| fish | run once | `kete completion fish > ~/.config/fish/completions/kete.fish` |
| PowerShell | `$PROFILE` (Windows PowerShell 5.1 or PowerShell 7) | `kete completion powershell \| Out-String \| Invoke-Expression` |

`kete --completions <bash|zsh|fish>` prints the same bash, zsh and fish scripts. Completions cover
commands, subcommands and flags, not values such as session IDs or model names.

## What it does

- **Works in your repository.** Searches and reads only the files that matter, edits across
  files, runs commands, builds and tests, diagnoses failures and tries again, then summarizes the
  diff.
- **Asks before it acts.** Every tool goes through allow / ask / deny permissions. By default
  Kete Code edits files in your workspace and runs read-only and test/build commands, and asks
  before any other command, before web requests, and always before high-risk ones: `git push`,
  `reset --hard`, deletes, package installs, network tools, containers, cloud and deploy tools,
  databases, `sudo` and credentials. Switch modes with `--permission-mode` or `<leader>p` in the
  terminal UI: **auto** (stops asking except for high-risk commands), **ask** (approve every edit
  and command) or **plan** (read-only). Edits to its own configuration and `.git` always ask. It's
  a guard, not a sandbox: what it runs runs with your access. See
  [Permissions](../docs/permissions.md).
- **Plans first when you want it to.** The `plan` agent drafts an approach without touching files;
  the default `build` agent carries it out. Starter role agents (Code Reviewer, QA, Docs Writer,
  Security, DevOps) cover common jobs, and subagents can work in parallel in their own git
  worktrees.
- **Shows its plan.** For multi-step work the agent keeps a task list you can watch in the
  terminal UI, the web UI and the editors ([Task list](../docs/todo.md)).
- **Checks its edits.** After each edit, errors from your language servers (TypeScript, Python,
  Go, Rust) go back to the agent, with the servers sandboxed and offline ([LSP](../docs/lsp.md)).
- **Hooks.** Shell commands at points of the agent loop: block a tool call, add context, notify
  you. A repository's hooks run only after you trust them ([Hooks](../docs/hooks.md)).
- **Any model.** Your own provider keys, local models through Ollama, vLLM or any
  OpenAI-compatible server, or the Kete gateway with one sign-in and readable per-request usage.
  The gateway and portal are never required for local use.
- **Extensible.** MCP servers (`kete mcp`), skills, plugins and multi-step workflows.
- **One runtime, every surface.** The terminal UI, the VS Code and JetBrains extensions and other
  clients all talk to the same local `kete` server, so a session started in one continues in
  another.
- **Unattended and cloud runs.** `kete job run` runs an agent unattended within a budget and a time
  limit, failing closed on anything not allowed. Cloud jobs on Kete's infrastructure or on your own
  servers ([self-hosted job hosts](../docs/job-hosts.md)) are in preview.

Your code leaves your machine only as model context for the provider you configured. OpenCode's
hosted services are off by default.

## Local models

Run models on your own machine or network with Ollama, LM Studio or vLLM, no account needed:

```sh
ollama serve                          # Kete finds it on its default port
kete models pull qwen2.5-coder:7b     # pull through your Ollama, then it's listed
OLLAMA_HOST=192.168.1.20 kete         # a GPU box on your LAN (or KETE_OLLAMA_HOST)
kete --offline                        # local models only, no other network calls
```

The model picker groups them under **Local**, marks models that can't call tools, shows their
context size, and tells you when a server you set up can't be reached. Offline mode keeps
enforcing your organization's cached policy. Details: [docs/local-models.md](../docs/local-models.md).

## Integrations

Built-in MCP presets connect a session to tools your team already uses, read-only or ask-first by
default, with credentials in your OS credential store:

```sh
kete mcp presets                      # what's available
kete mcp add harness                  # Harness (read-only unless --write)
kete mcp add slack --client-id <id>   # Slack (needs an approved Slack app)
```

Details: [Harness](../docs/integrations/harness.md), [Slack](../docs/integrations/slack.md).

## Configuration

Global settings live in `~/.config/kete/`, project settings in `.kete/` at the repository root.
Environment variables use the `KETE_` prefix. Organizations on the Kete platform can manage
agents, skills, MCP servers and policies centrally; `kete sync` pulls them, and for security policy
the stricter setting always wins.

## Repository

| Path | What's there |
|---|---|
| `packages/cli` | the `kete` command and binary build |
| `packages/core` | agent loop, tools, sessions, providers, permissions, config |
| `packages/server`, `packages/tui`, `packages/app` | HTTP server, terminal UI, web UI (used by VS Code) |
| `packages/kete-vscode` | the VS Code extension (also Windsurf, Cursor, VSCodium via Open VSX) |
| `packages/kete-jetbrains` | the JetBrains plugin (IntelliJ Platform, Kotlin) |
| `packages/kete-job-*`, `packages/kete-egress`, `packages/kete-root-helper` | cloud job image, entrypoint, egress proxy, tool sandbox helper, self-hosted job host |
| `packages/kete-tools` | release, distribution, upstream sync and repository checks |
| `docs/` | [architecture](../docs/architecture.md), [ADRs](../docs/adr/), [release](../docs/release.md), [knowledge base](../docs/context/INDEX.md) |

Kete-specific code lives in `src/kete/` inside upstream packages, or in `packages/kete-*`.

## Build from source

Requires [Bun](https://bun.sh) (the version pinned in `package.json` `packageManager`).

```sh
bun install
bun run dev [directory]                                          # run the CLI from source
cd packages/cli && bun run build --single --skip-install --skip-web-ui   # → dist/cli-<os>-<arch>/bin/kete
```

Typecheck with `bun turbo typecheck`, lint with `bun run lint`, and run tests with `bun run test`
inside a package. [`CLAUDE.md`](../CLAUDE.md) is the rulebook for changes: architecture rules,
security rules and the checks to run.

## Built on OpenCode

Kete Code is a fork of [OpenCode](https://github.com/anomalyco/opencode) (MIT) and keeps tracking
it ([`.opencode-version`](../.opencode-version), [`docs/upstream-sync.md`](../docs/upstream-sync.md)).
Changes to upstream files are marked `kete_change` and listed in
[`docs/upstream-patches.md`](../docs/upstream-patches.md). OpenCode's own README is
[`README.md`](../README.md) at the repository root.

## Newlines in the prompt

Shift+Enter, Alt+Enter and Ctrl+J insert a newline. Ctrl+J works in every terminal; Shift+Enter works
in terminals that report it (kitty, WezTerm, Ghostty, Alacritty, foot). Run `kete terminal-setup` (or
`/terminal-setup`) to see what yours needs. In VS Code, Cursor, Windsurf and VSCodium it offers to add
one keybinding to the editor's `keybindings.json`; it asks first and keeps a backup. For iTerm2,
Apple Terminal, Windows Terminal and tmux it prints the setting to change.

## Installing skills

`kete skill add <source>` installs a skill from a git repository (`owner/repo`, any git URL, with
`--ref` and `--path` for a tag or subfolder) or a local folder into `.kete/skills/`, or into your
global config with `--global`. It shows every file first, with scripts marked, and asks before writing
anything; nothing in the skill runs at install and files are written without the executable bit. The
exact commit and each file's hash go into `skills.lock.json`, so `kete skill update` shows what
changed. `kete skill list` and `kete skill remove` manage them. Skills synced from your organization
are read-only, and an organization policy can limit where skills come from.

## Committing and opening pull requests

`/commit [notes]` asks the agent to commit the current changes. It stages only the files that belong
together, leaves secrets and build output out, writes the message in the repository's own style and
never pushes. On `main` it asks whether to create a branch first. `/pr [base] [draft]` pushes the
branch and opens a pull request with `gh` (or a merge request with `glab`), with a title and
description built from all of the branch's commits. Without either CLI it gives you the text and the
link instead. Every git and `gh` command they run asks or is allowed under your permission settings,
like any other command (`git push` asks unless your rules allow it). A `commit` or `pr` command in your own or the
project's commands replaces the built-in one.

## Checking your setup

Run `kete doctor`, or `/doctor` in the terminal UI, when something doesn't work as expected. It checks
the install (and whether several `kete` executables are on your PATH), that the runtime answers, every
config file (one with a syntax error or invalid settings is otherwise ignored without a word), whether
this folder is trusted and what is held back, your account, model providers and the model new sessions
use, MCP servers, the OS sandbox and the terminal, each with how to fix it. It changes nothing and makes
no network request beyond the local runtime. `kete doctor --format json` prints the checks as JSON; the
exit code is 1 when a check failed.

## Reporting a problem

Run `kete bug "what went wrong"`, or `/feedback` (also `/bug`) in the terminal UI. Both build a
report for you to review: version and channel, OS, terminal, shell, install method, whether you're
signed in (yes or no), the model providers and MCP servers in use (names and states only), the
permission mode, the sandbox and offline state, and the last 200 lines of the log with only
diagnostic fields kept. Keys, tokens, emails, IDs, URL query strings, environment values, prompts,
file contents and session messages are left out or masked, and your home directory shows as `~`. Log
messages and errors keep only their first line (no stack traces), cut short, with other absolute paths
shown as `<path>` and JSON payloads as `<data>`.

`kete bug` prints the report, saves it to a file only you can read, and asks before opening a
pre-filled [GitHub issue](https://github.com/kete-org/ketecode/issues) form in your browser;
`kete bug --print` (or no terminal) only prints and saves. Opening the form sends this report to
GitHub in the link; it becomes public only when you submit the issue. The `/feedback` dialog offers
Open issue, Copy, Save and Cancel. If Kete Code crashes, the crash screen can copy the report or open
the issue too.

**Security problem?** Don't open a public issue; report it privately:
[GitHub security advisories](https://github.com/kete-org/ketecode/security/advisories/new) ([SECURITY.md](SECURITY.md)).

## Contributing, security, license

- [Contributing](CONTRIBUTING.md): issues and pull requests are welcome; please read it first.
- [Security](SECURITY.md): report vulnerabilities privately, never in a public issue.
- [Code of conduct](CODE_OF_CONDUCT.md).
- License: MIT. OpenCode's code is under its original [license](../LICENSE); Kete Code's code is
  under the MIT License stated in [`NOTICE`](../NOTICE).
