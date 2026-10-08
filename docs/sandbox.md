# The OS sandbox for agent commands

Kete Code runs every shell command the agent runs inside an operating-system sandbox. The
[permission system](permissions.md) decides *whether* a command runs; the sandbox limits *what it can
do* once it runs. Together they let the project's tests and builds run without a prompt while the
code they run — which an edit may have changed — can't take over your machine.

Decision record: [ADR 0013](adr/0013-local-os-sandbox.md).

## What a sandboxed command can do

| | Allowed | Not allowed |
| --- | --- | --- |
| **Write** | The workspace (the project's folder), a private temp directory for the session (`TMPDIR`, `TMP`, `TEMP` point there; on macOS also the shared temp directories), package-manager and build caches (npm, bun, pnpm, yarn, pip, uv, cargo, Go, Gradle, Maven), paths you add | Anywhere else. Inside the workspace too: Kete Code's configuration (`.kete/`, `kete.json`, `kete.jsonc`, `.claude/`, `.agents/`), git's `.git/config`, `.git/hooks/` (and the `core.hooksPath` folder, e.g. `.husky/_`), `.git/info/attributes`, the `.git` folder itself, Kete Code's own folders |
| **Read** | Everything else, including the workspace's `.env` (tests load it; reading it is still governed by permissions) | Credentials: `~/.ssh` (except `known_hosts` and `config`), `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.gnupg`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.pgpass`, `~/.git-credentials`, `~/.config/gh`, cargo and gem credentials, Terraform and Vault tokens, `~/.password-store`, keychains, Kete Code's config, data and log folders |
| **Network** | Commands a person approved just now (you allowed the prompt), or that an unattended run's policy allows. A saved "Always allow" lets a command run without asking but **doesn't** give it network: ask for it with `sandbox: "network"`, or set `network: "all"` | Everything else. Without network a command reaches only this machine (macOS: loopback and this machine's own addresses, unless `loopback: false`; Linux: the sandbox's own loopback) and Unix sockets in the workspace and its private temp directory — not the SSH or GPG agent, the session bus, VS Code's or tmux's sockets (on Linux `SSH_AUTH_SOCK`, `GPG_AGENT_INFO` and `DBUS_SESSION_BUS_ADDRESS` are removed and `$XDG_RUNTIME_DIR` is hidden) |
| **Other processes** | Its own children | macOS: opening apps (`open`), AppleScript, the clipboard, the keychain, launchd jobs. Linux: seeing or signalling other processes |

Git keeps working: `git status`, `diff`, `add`, `commit`, `branch`, `checkout`, `stash` and `log`
write only what the sandbox allows. What it can't do is change the files through which git runs
commands (`core.fsmonitor`, hooks, filters, aliases), so code that ran in a test can't make your next
`git` command run it again outside the sandbox. `git config` and `git push` need more (below).

Approved commands get network for their whole run, including anything they start: an approved
`npm install` runs packages' install scripts with network.

## Platforms

| Platform | Sandbox | Notes |
| --- | --- | --- |
| macOS | `sandbox-exec` (Seatbelt) | Built in. Deprecated by Apple but present; checked on macOS 26. |
| Linux | bubblewrap (`bwrap`) | Install it: `apt install bubblewrap`, `dnf install bubblewrap`, `pacman -S bubblewrap`. It needs unprivileged user namespaces: on Ubuntu 24.04 and later AppArmor restricts them (`sysctl kernel.apparmor_restrict_unprivileged_userns`); in containers they are often off. |
| Windows | none yet | Commands run unsandboxed; the permission prompts are the only protection. |
| Cloud and self-hosted jobs | the job's own sandbox | `kete job run` in a job image; see `docs/jobs.md`. |

Check yours with `kete sandbox` (exit 0 when sandboxed, 1 when not). When there is no sandbox, Kete
Code says so when it starts, the terminal UI shows **⚠ Unsandboxed** in its footer, and commands
still run (unless the sandbox is required, below).

## When a command needs more

If a command fails because of the sandbox, the agent is told so and can run it again with
`sandbox: "network"` (network access) or `sandbox: "off"` (no sandbox) for that one command. **Both
always ask you**, in every mode — a configured rule or "Always allow" can't pre-approve them — Plan
mode blocks them, and unattended runs refuse them.

Common cases:

- `git push` over SSH: works with keys in your SSH agent (approved commands have network, and
  `known_hosts` is readable); keys only on disk need `sandbox: "off"`. HTTPS pushes with a credential
  helper also need `"off"`.
- `git config …`, `git init`/`git clone` inside the workspace, `git submodule update --init`: need
  `"off"` (they write git config).
- `npm install` / `pip install` from a private registry: add the credentials file to `allowRead`.
- Docker, `ps`, `sudo` and other setuid tools on macOS, `open`, `osascript`: `"off"`.
- A tool cache not in the list (e.g. `~/.gradle/wrapper`, `~/.rustup`): add it to `allowWrite`.
- Linux: `/tmp` and `/var/tmp` are private to each command (empty at the start); use `$TMPDIR`, which is private to the session and keeps its files between commands.
- Linux: a process started with `&` ends when the command ends — use the shell tool's background
  mode. A dev server started without network can't be reached from your browser; approve its
  command (approved commands share the host's network) or set `network: "all"`.
- Linux: a cache directory that doesn't exist yet can't be created from inside the sandbox; the
  first install creates it if you approve running it with `"off"`, or create it yourself.

## Settings

```jsonc
// ~/.config/kete/kete.jsonc (the global config)
{
  "kete": {
    "sandbox": {
      "mode": "auto",          // "auto" (default) | "required" | "off"
      "network": "approved",   // "approved" (default) | "none" | "all"
      "caches": true,          // let commands write package-manager caches
      "loopback": true,        // macOS without network: reach services on this machine
      "allowWrite": ["~/.gradle"],
      "allowRead": ["~/.npmrc"],
      "denyRead": ["~/secrets"],
      "denyWrite": ["deploy/"]
    }
  }
}
```

- **`mode: "off"` turns the sandbox off.** Agent commands then run with your full access. So does
  `KETE_SANDBOX=off`. Kete Code warns when it starts and the TUI shows it.
- **`mode: "required"`** refuses commands where no sandbox is available instead of running them
  unsandboxed. `KETE_SANDBOX=required` does the same; any other value of `KETE_SANDBOX` is treated
  as `required`.
- Paths are absolute, start with `~/`, or (for `denyRead`/`denyWrite`) are relative to the workspace.

**Only you can loosen the sandbox.** Settings that loosen it — `mode: "off"`, a looser `network`,
`caches: true`, `allowWrite`, `allowRead` — count only from the global config and `KETE_SANDBOX`. A
repository's own `.kete/kete.jsonc` can only make it stricter (`mode: "required"`, `network:
"none"`, `caches: false`, `denyRead`, `denyWrite`); anything else there is ignored, with a warning
and a line in `kete sandbox`.

### Organizations

Every command that runs outside the sandbox — because it is off, unavailable, or a person approved
`sandbox: "off"` — passes the `sandbox_off` permission check. An organization policy that denies it
requires the sandbox:

```json
{ "action": "sandbox_off", "resource": "*", "effect": "deny" }
```

A policy denying `sandbox_network` stops commands from asking for network access.

## What the sandbox doesn't cover

- **Services on this machine.** On macOS, a command without network can still connect to anything
  listening on 127.0.0.1 or this machine's own addresses — a local database, a dev server, Docker if
  it exposes TCP — because test suites start and call local servers. Set `"loopback": false` to block
  that (Unix sockets in the workspace and private temp directory still work). On Linux the sandbox
  has its own loopback, so the host's local services are out of reach without network.
- macOS's per-user cache directory (`/private/var/folders/…/C`) is writable (Apple's tools need it),
  so it is a place a command could leave something for later, like the package caches.

- Only the agent's shell commands. Your own terminal and `!` commands, MCP servers, formatters,
  language servers and Kete Code's own git calls run as before.
- On Linux, Kete configuration is protected where Kete Code looks for it (the folder you started in
  and its parents inside writable folders), not in every subfolder; git internals only in the
  workspace's own git folder, not in nested repositories. When a protected file doesn't exist yet,
  Kete Code puts an unreadable placeholder there for the duration of the command and removes it
  afterwards (inside the sandbox git is told to ignore it; your own `git status` may list it while
  the command runs).
- Caches are shared with builds you run yourself: code could leave a poisoned entry (e.g. in the Go
  build cache) for a later build outside the sandbox. Set `caches: false` if that matters to you.
- Files other tools act on later — editor settings (`.vscode/`, `.idea/`), a planted bare git
  repository in a subfolder — aren't protected.
- There is no per-host network allowlist locally; approved commands reach any host.

## Reference

- Runtime: `packages/core/src/kete/sandbox.ts` (decision, permission hook, status RPC),
  `packages/core/src/kete/sandbox/` (settings, policy resolution, Seatbelt profile, bwrap arguments,
  probe).
- Knowledge-base card: `docs/context/modules/sandbox.md`.
