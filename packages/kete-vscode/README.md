# Kete Code

Kete Code is an AI coding agent for your workspace. Ask it to build, fix or explain something in
the chat: it reads the code, plans, edits files, runs commands, and shows the changes for review.

The agent runs next to your code. The extension includes the `kete` runtime for your platform and
starts it for you, so there is nothing else to install.

## Getting started

1. Open a folder in VS Code.
2. Click the **Kete Code** icon in the activity bar (or run **Kete Code: Open Chat**).
3. Connect a model: **sign in to your Kete account** (click `Kete` in the status bar, then **Sign in
   to Kete Code**), or connect your own provider key or a local model from the chat's settings.
4. Describe what you want to do.

## Features

- **Chat** beside your editor: `Cmd+Esc` / `Ctrl+Esc` focuses it, `Cmd+Shift+Esc` /
  `Ctrl+Shift+Esc` starts a new chat. Prefer it on the right? Run **Kete Code: Move Chat to Right
  Side Bar**.
- **Your editor in context:** the file you're in, and your selection, follow you into the chat as a
  context item (turn off with `kete.chat.shareEditorContext`). `Alt+K` adds the selection or file
  explicitly. Secret files (`.env`, keys) and `files.exclude` matches are never shared
  automatically.
- **Never miss a prompt:** a badge on the chat and in the status bar shows approvals waiting for
  you, and a notification tells you when Kete Code needs you or finishes while the chat is hidden.
- **Review changes:** **Kete Code: Review Changes** (or the chat's title bar) opens every file the
  last turn changed in VS Code's multi-file diff editor, before on the left and your file on the
  right, so the editor's own arrows undo single changes. **Revert File** in the diff's title bar
  puts a whole file back as it was before the turn, after asking. Selecting a file in the chat's
  review opens that turn's diff.
- **MCP servers:** the MCP Servers view shows each server's state. One your organization adds that
  runs a command on your computer waits for you: **Review and Approve** shows the exact command, and
  it runs only after you approve it (again, if it ever changes). **Sign In** handles servers that
  use OAuth.
- **Ask before edits:** click the shield in the chat's title bar, or the **Auto / Ask / Plan**
  toggle next to send in the composer, and Kete Code asks before every file edit, shell command and
  web fetch in that chat (the status bar shows "Ask"). New chats follow `kete.chat.askBeforeEdits`.
  **Plan** switches to the read-only **Plan** agent. Neither Ask nor Plan ever allows what the
  agent's permissions or your organization's policy deny. In Ask mode an "Always allow" answered
  earlier doesn't skip the question.
- **Your editor's diagnostics:** Kete Code can ask VS Code for the errors and warnings your language
  servers and linters report (the `editor_diagnostics` tool), so it checks its edits the way you
  would. Secret files and `files.exclude` matches are left out; turn it off with
  `kete.editorTools.enabled`.
- **Sessions:** the Sessions view lists this workspace's sessions, marks those working or waiting
  for your approval, and opens one in the chat. **Copy Session Link** (on each session) makes a
  `vscode://ketecode.kete-code/session?id=…` link back to it.
- **Looks like VS Code:** the chat takes your theme's colours and fonts, and follows theme changes.
- **Send Selection / Send File to Chat** (editor context menu) to add code to the prompt.
- **Terminal:** the Kete Code terminal UI beside the editor (**Kete Code: Open Kete Code** in the
  command palette; `Cmd+Alt+K` / `Ctrl+Alt+K` inserts the current file into it).
- **Your models:** your Kete account, your own keys for the major providers, or local models
  (Ollama, LM Studio, any OpenAI-compatible server).

## Signing in

**Sign in to Kete Code** opens the Kete portal in your browser to approve the sign-in. The key it
issues is stored in your operating system's credential store (macOS Keychain, Windows Credential
Manager or the Linux Secret Service), never in VS Code settings. The status bar shows the account
you are signed in to; **Sign Out** revokes the key.

## Platforms

Windows (x64, arm64), macOS (Apple silicon, Intel) and Linux (x64, arm64, including Alpine). VS
Code installs the build for your platform. With Remote-SSH, WSL or Dev Containers the extension
and the agent run on the remote side, next to the code.

## Privacy and security

- Your code leaves your machine only as context for the model provider you choose (the Kete
  gateway when you are signed in, or your own provider or local model), and in the requests the
  agent makes when it uses its web search and web fetch tools.
- The extension sends no telemetry.
- The agent runs on a local server that listens only on `127.0.0.1`, uses a new password for each
  session, and refuses requests from other programs and web pages.
- By default the agent edits files and runs commands in the workspace without asking; it asks
  before reading `.env` files or working outside the workspace folder. Change this with Kete
  Code's `permissions` settings (`allow`, `ask` or `deny` per action, for example shell commands
  or edits). Agents managed by your organization come with their own permissions.

## Settings

| Setting               | Description                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `kete.budget.session` | Pause a session and ask before it spends more than this many USD                          |
| `kete.gateway.url`    | Gateway URL for manual setup; not needed, and ignored, when you are signed in              |
| `kete.platform.url`   | Kete platform URL, for sign-in when no other is configured                                 |
| `kete.cliPath`        | For development: a `kete` binary to use instead of the included one                       |
| `kete.chat.shareEditorContext` | Share the active file and selection with the chat (default on)                   |
| `kete.chat.notifications`      | Notify when the chat is hidden and needs you or finishes (default on)            |

## License

MIT. Kete Code is built on [OpenCode](https://github.com/anomalyco/opencode) (MIT); see `NOTICE`.
