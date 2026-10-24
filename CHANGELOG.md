# Changelog

What changed in the `kete` CLI and terminal UI, newest first. `kete` shows the notes for its version
once after an upgrade, and any time with `/release-notes`. The VS Code extension has its own
changelog (`packages/kete-vscode/CHANGELOG.md`).

## Unreleased

## 0.2.9

- **Gateway address follows your organization:** when the Kete Gateway moves to a new address, a
  signed-in `kete` picks it up from the platform and saves it, so you don't need to `kete login` again.
  The first command right after the move may still report a model as unavailable; the next one works.
- **`kete run --agent` uses the agent's model:** without `--model`, a session now runs its agent's own
  model instead of the default one. Managed agents on the gateway failed this way before.
- **Clearer error for a model an agent can't use:** the gateway's refusal now names the agent's model
  and the one the request used, instead of saying the agent was paused.

## 0.2.8

- **Share a session:** `/share` (or `kete share`) uploads a redacted copy of a session to the Kete
  portal for your organization to read, after showing what will be sent (secrets masked, no
  reasoning, no file contents). `/unshare` (or `kete unshare`) deletes it. You need `kete login`;
  `share: "disabled"` in config turns it off, and your organization can too. Details: `docs/sharing.md`.
- **Browser automation preset:** `kete mcp add playwright` sets up Microsoft's Playwright MCP server
  (pinned version, a fresh browser profile each session). Every browser action asks first, including
  snapshots and screenshots, since they can save files into the project. Offline mode now also skips
  any `@playwright/mcp` server you set up by hand. Details: `docs/integrations/playwright.md`.
- **NVIDIA models through the Kete Gateway:** when your organization's gateway serves NVIDIA
  (build.nvidia.com), its models appear under the `kete` provider like the others.
- **BytePlus models through the Kete Gateway:** managed agents your organization puts on BytePlus
  (ByteDance ModelArk) models now sync and run through the gateway as `kete/<model>`. Earlier
  versions don't receive those agents.

## 0.2.7

- **Security:** agent, command and skill markdown files only accept YAML front matter. Front matter in
  another language (such as `---js`) is no longer evaluated, so a repository's `.kete/` files can't run
  code when a folder opens (GHSA-m7hc-g593-r9wg). Update if you open repositories you don't trust.
- **Security (VS Code extension):** `kete.cliPath`, `kete.gateway.url` and `kete.platform.url` are
  machine settings; a repository's `.vscode/settings.json` can no longer set them (GHSA-43vv-qhh9-p4cv).
- **Security:** shell commands written into a slash command's markdown (``!`cmd` ``) ask permission
  like any other command the agent runs and run in the OS sandbox; a repository's own commands run
  none until you trust the folder (GHSA-3hxr-ggpq-r784).
- **Security:** symlinks in a repository can no longer reach files outside the workspace without
  asking. An `AGENTS.md` loads only when it really is a Markdown file inside the repository, and the
  file tools (read, write, edit, patch, glob, grep) ask before following a link to a file or folder
  outside it (GHSA-96qv-q98x-hrm4). Rules and saved approvals for folders outside the workspace now
  match the folder's real path: on macOS a rule for `/tmp/…` may need `/private/tmp/…`.
- **One first-run setup screen:** the first time you run `kete` with nothing set up (no provider key,
  no account, no model), one screen offers to sign in, use your own API key, or use a local model
  (Ollama, LM Studio, vLLM), or to skip. It shows once; `/setup` reopens it. The sidebar's "Connect
  provider" button and the "Connect an integration" prompt warning open it too. `kete run` with no
  model now says how to set one up.
- **`--add-dir` and `/add-dir`:** let a session work in folders outside the workspace without being
  asked each time: `kete --add-dir ../lib`, `kete run --add-dir ../lib "…"`, or `/add-dir <path>` in a
  session (`/add-dir remove <path>` drops one). Edits there still follow your permission mode, `deny`
  rules and organization policy; the folders are writable by the OS sandbox too, and last for the session.
  Your home folder, credential folders and the workspace itself can't be added.
- **Auto memory and `/remember`:** Kete can save notes for later sessions (your corrections and
  preferences, non-obvious project facts) with a `memory` tool, and `/remember <note>` saves one on
  request. Notes live in Kete's own state folder, not your repository: `MEMORY.md` per project and per
  user, loaded at the start of every session under a header that marks them as context, not
  instructions. Secrets are redacted before saving. `/memory` shows what is loaded. Off with
  `kete.memory.auto: false`; not available in unattended runs.
- **`CLAUDE.md` and `@path` imports:** where a folder has no `AGENTS.md`, its `CLAUDE.md` (or
  `.claude/CLAUDE.md`) is loaded, `~/.claude/CLAUDE.md` joins your global instructions, and nested
  `CLAUDE.md` files load when you read a file below them. `@path` lines in `AGENTS.md` and `CLAUDE.md`
  pull the named file in (five levels, size-capped; secrets and files outside the project and your user
  folders are skipped with a note). `kete.memory.claudeMd` and `kete.memory.imports` turn them off.
- **`kete skill add|list|update|remove`:** install a skill from a git repository (`https://…`, `git@…`,
  or `owner/repo` on GitHub) or a local folder. It shows every file in the skill, scripts marked, and asks
  before writing anything; nothing from the skill runs at install and its files are written without the
  executable bit. The commit and each file's hash go in `skills.lock.json`, so `kete skill update` shows
  what changed. `--global` installs for every project. Skills your organization syncs are never touched,
  and an organization policy can limit sources (`skill.install`).
- **`kete terminal-setup` and `/terminal-setup`:** make Shift+Enter insert a newline. It says what your
  terminal needs, and in VS Code, Cursor, Windsurf or VSCodium adds the keybinding for you after asking.
  Ctrl+J always works.
- **`/commit` and `/pr`:** commit the current changes with a message in your repository's style, and
  push the branch and open a pull request (GitHub `gh` or GitLab `glab`). Every git command still goes
  through your permission settings, and `git push` asks unless your rules allow it.
- **`kete doctor` and `/doctor`:** check your setup in one go: the install, the runtime, every config
  file (one with a syntax error or invalid settings used to be ignored silently), folder trust, your
  account, model providers and default model, MCP servers, the OS sandbox and the terminal, each with how
  to fix it. Read-only; `--format json` for scripts.
- **Folder trust:** a repository's own configuration can no longer start MCP servers, load plugins,
  point providers elsewhere, change the shell or formatters, or loosen permissions until you trust
  the folder. Kete Code asks once ("Trust this folder?"); instructions, agents, commands and skills
  load either way. `kete trust` lists, adds and removes trusted folders, and `kete run` holds the
  settings back unless you pass `--trust-project-config`. After this update every folder with such
  settings asks once, including folders you used before. Details: `docs/folder-trust.md`.
- **Status line:** the row under the prompt shows the directory, git branch, permission mode and
  how much context is left. Choose and order its items (model, cost, sandbox, credit balance, task
  progress, …) with `/statusline`, or `statusline` in `cli.json`. Details: `docs/statusline.md`.
- **Ctrl+R searches your prompt history:** type to find an earlier prompt, Ctrl+R again for the next
  older match, Enter to put it in the prompt (nothing is sent), Esc to go back to what you had typed.
- **Rename moved:** renaming a session is now `<leader>shift+r` (`ctrl+x` then `R`), and is still
  in the command palette and `/rename`. To get Ctrl+R rename back, set
  `"keybinds": { "session.rename": "ctrl+r" }` in `cli.json`.
- The home screen shows short notices when they apply (agents synced from your portal, an
  `AGENTS.md` in the folder) and otherwise a tip. Dismiss a notice with ✕ or "Dismiss home notices"
  in the command palette; `"tips": false` in `cli.json` turns tips off.
- **Shell completions:** `kete completion bash|zsh|fish|powershell` prints tab completion for
  `kete`'s commands and flags; `kete completion` shows the line to add for your shell.
- **Task list:** for work with several steps the agent keeps a task list you can follow in the
  session sidebar and the status line. Details: `docs/todo.md`.
- **Language server diagnostics:** after an edit, Kete Code asks the project's language server
  (TypeScript and JavaScript, Python, Go and Rust, when installed) for new errors in the file, so the
  agent fixes them before it moves on. Details: `docs/lsp.md`.
- **Hooks:** run your own commands at fixed points of the agent loop (before or after a tool,
  when you send a prompt, when the agent finishes) with `kete.hooks` in `kete.json`. They run in
  the OS sandbox; hooks a repository defines ask before they first run. Details: `docs/hooks.md`.
- The terminal UI uses the current Kete Code violet, a "Kete Code" wordmark beside the logo, and a
  rounded outline around the prompt.
- `/release-notes` shows what's new in your version; after an upgrade it shows once on its own.

## 0.2.6

- Safer defaults: Kete Code asks before shell commands that can change things, and always before
  high-risk ones (`git push`, `reset --hard`, deletes, package installs, network tools, containers,
  cloud and deploy tools, databases, `sudo`, credentials) and web requests. Edits in your workspace
  and read-only or test/build commands still run without asking.
- Permission modes **Default / Auto / Ask / Plan**; Plan is read-only. `kete run` in scripts and CI
  stops at the first command that needs approval: use `--permission-mode auto` or `permissions`
  rules. Details: `docs/permissions.md`.
- **Sandbox:** shell commands the agent runs are confined by the OS sandbox on macOS and Linux;
  `kete sandbox` shows the status. Details: `docs/sandbox.md`.
