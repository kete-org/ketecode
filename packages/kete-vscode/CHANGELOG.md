# Changelog

## Unreleased

- Bundles the new `kete` runtime: responses that hit the output limit carry on, compaction keeps
  recent messages word for word, long-running commands are no longer cut off after five minutes, and
  policy statements move to a top-level `policies` key (the old form still works). Details in the CLI
  changelog.

## 0.2.12

- Bundles the 0.2.12 `kete` runtime. No changes to the extension itself.

## 0.2.11

- Bundles the 0.2.11 `kete` runtime. No changes to the extension itself.

## 0.2.10

- New sessions start on your organization's default model (its Default coding tier in the Kete
  portal) when you're signed in, unless you pick another.

## 0.2.9

- Gateway address follows your organization: when the Kete Gateway moves to a new address, the
  extension's signed-in runtime picks it up from the platform, so you don't need to sign in again.
- Clearer error when a request uses a model an agent isn't allowed: the message names both models
  instead of saying the agent was paused.

## 0.2.8

- **Share a session:** "Kete Code: Share Session" and "Kete Code: Unshare Session" (Command Palette
  and the sessions list). A modal message shows what will be sent before anything is uploaded; the
  link is copied afterwards. Needs a signed-in account. Details: `docs/sharing.md`.

## 0.2.7

- Security: `kete.cliPath`, `kete.gateway.url` and `kete.platform.url` are machine settings. A
  workspace's `.vscode/settings.json` can no longer choose the program the extension runs or where
  your sign-in and gateway traffic go; set them in your user settings (GHSA-43vv-qhh9-p4cv).
- Security: shell commands in a slash command's markdown ask permission and run in the OS sandbox
  (GHSA-3hxr-ggpq-r784), and symlinks in a repository can no longer reach files outside the
  workspace without asking (GHSA-96qv-q98x-hrm4). Both fixes are in the bundled `kete`.
- **Folder trust:** a repository's own configuration can no longer start MCP servers, load plugins,
  point providers elsewhere, change the shell or formatters, or loosen permissions until you trust
  the folder. The chat panel shows the question above the message box ("Trust this folder?" / "Not
  now"); instructions, agents, commands and skills load either way. After this update every folder
  with such settings asks once, including folders you used before. Details: `docs/folder-trust.md`.

## 0.2.6

- Safer defaults: Kete Code now asks before shell commands that can change things, and always
  before high-risk ones (`git push`, `reset --hard`, deletes, package installs, network tools,
  containers, cloud and deploy tools, databases, `sudo`, credentials) and web requests. Edits in
  your workspace and read-only or test/build commands still run without asking.
- Edits to Kete Code's own configuration, agents and skills (`.kete/`, `kete.json`) and to `.git`
  always ask; edits to build and test entry points (`package.json`, `Makefile`, `*.config.*`,
  `conftest.py`, …) ask, and the next test or build command after one asks once. "Always allow"
  is no longer offered for high-risk commands, and for web fetches it covers one site, not every URL.
- The composer's toggle is now **Default / Auto / Ask / Plan**. **Auto** (new) runs edits and
  commands without asking but still asks before high-risk commands (scripts it runs can still do
  anything you can). **Plan** is now enforced as read-only by the runtime, not only by the Plan
  agent; MCP tools are off in Plan. The status bar shows the chat's mode.
- **Upgrading:** `kete run` in scripts and CI now stops at the first command that needs approval.
  Use `--permission-mode auto` (still stops at high-risk commands), `permissions` rules for the
  commands it needs, or `--dangerously-skip-permissions` in a throwaway environment. `--auto` no
  longer approves high-risk commands. Details: `docs/permissions.md`.
- **Sandbox:** shell commands the agent runs now run in an OS sandbox on macOS (`sandbox-exec`) and
  Linux (bubblewrap): they can write only inside the workspace, temp and package caches, can't
  write git hooks or config, `.kete/` or Kete's own settings, can't read SSH keys or cloud
  credentials, and get network only when you approved the command. `kete sandbox` shows the status;
  where no sandbox is available (Windows, some Linux setups) commands run unsandboxed and Kete Code
  says so. Details: `docs/sandbox.md`.
- Permissions are the first layer and the sandbox the second: a command you allow outside the
  sandbox (`sandbox: off`, always asked) runs with your access.

## 0.2.4

- Local models: the model picker shows a **Local** group for Ollama, LM Studio and vLLM (also on
  another machine, via `OLLAMA_HOST`), marks models that can't use tools, and says when a local
  server isn't reachable. Offline mode (`kete --offline`) keeps everything on your machine.
- Works in Windsurf, Cursor and VSCodium (install from Open VSX): the diagnostics tool names the
  editor you're in, and the chat's editor chip now reports itself when the file was opened before
  the chat finished loading. See "Using Kete Code in Windsurf, Cursor or VSCodium" in the README.
- The chat's empty state and composer are redesigned: a header, a hero mark, dismissible "what's
  new" notices and a CLI hint, and an **Auto / Ask / Plan** toggle next to send (Auto and Ask are
  the same permission mode as the title-bar shield; Plan switches to the **Plan** agent).
- The chat follows your editor: the active file and selection are shared as context.
- `Cmd/Ctrl+Esc` focuses the chat and `Cmd/Ctrl+Shift+Esc` starts a new one (they used to open the
  terminal UI, which is now in the command palette); `Alt+K` adds the selection or file to the chat.
- A badge and notifications when Kete Code is waiting for your approval or finishes while hidden.
- **Kete Code: Move Chat to Right Side Bar**.
- **Kete Code: Review Changes** opens the last turn's changes in VS Code's multi-file diff editor
  (also from the chat's title bar and the "finished" notification). **Revert File** in the diff's
  title bar puts a file back as it was before the turn, after asking. Selecting a file in the chat's
  review now shows that turn's change, not the diff against the last commit.
- The chat uses your VS Code theme's colours and fonts, including high-contrast themes.
- An **MCP Servers** view lists every MCP server Kete Code knows: connected, failed, off, waiting
  for sign-in, or waiting for your approval. An MCP server your organization adds that runs a
  command on your computer stays off until you **Review and Approve** it: the exact command is
  shown first, and a changed command asks again. **Sign In** runs the OAuth sign-in; servers can be
  connected and disconnected in place.
- **Ask before edits:** the shield in the chat's title bar makes Kete Code ask before every file
  edit, shell command and web fetch in that chat, even ones the agent's permissions allow; the status
  bar shows "Ask" while it's on. `kete.chat.askBeforeEdits` sets it for new chats. It never allows
  anything the agent or your organization's policy denies. (Plan first? Pick the **Plan** agent in the
  chat.)
- Kete Code can read VS Code's **diagnostics** (errors and warnings from your language servers,
  linters and type checkers) with the `editor_diagnostics` tool, to check its edits. Turn off with
  `kete.editorTools.enabled`.
- A **Sessions** view under the chat lists this workspace's sessions (which are working or waiting
  for you, too); select one to open it in the chat. **Copy Session Link** gives a
  `vscode://ketecode.kete-code/session?id=…` link that opens it again; **Kete Code: Open Session…**
  picks one from the command palette.

Release notes for each version are published with the Kete Code release of the same version.

## 0.2.0

- The extension includes the `kete` runtime for your platform and runs its own local server.
- Sign in to your Kete account from VS Code; the status bar shows the account and server.
- Open diffs from the chat's review in the editor; send the selection or file to the chat.
