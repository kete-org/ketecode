# Changelog

What changed in the `kete` CLI and terminal UI, newest first. `kete` shows the notes for its version
once after an upgrade, and any time with `/release-notes`. The VS Code extension has its own
changelog (`packages/kete-vscode/CHANGELOG.md`).

## Unreleased

- **Security:** agent, command and skill markdown files only accept YAML front matter. Front matter in
  another language (such as `---js`) is no longer evaluated, so a repository's `.kete/` files can't run
  code when a folder opens (GHSA-m7hc-g593-r9wg). Update if you open repositories you don't trust.
- **Security (VS Code extension):** `kete.cliPath`, `kete.gateway.url` and `kete.platform.url` are
  machine settings; a repository's `.vscode/settings.json` can no longer set them (GHSA-43vv-qhh9-p4cv).
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
