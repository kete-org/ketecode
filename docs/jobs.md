# Unattended jobs (`kete job run`)

`kete job run <spec.json>` runs Kete Code unattended, from a JSON spec file, with no one to
answer permission prompts (ADR 0005, ADR 0008). It creates its own git worktree and branch,
starts a fresh session there with a spending budget and a time limit, waits for it to finish,
and reports how it ended. It never overwrites your working checkout.

```sh
kete job run ./job.json
kete job run ./job.json --json   # exactly one JSON result object on stdout, nothing else
```

## Spec v1

A job spec is a JSON file (no comments, no YAML). Unknown fields at any level are refused, with
the field's path in the error (`policy.budget: missing`, `policy.allow[1].action: ...`).

```json
{
  "version": 1,
  "prompt": "Upgrade the lodash dependency and fix anything that breaks",
  "agent": "build",
  "model": "anthropic/claude-sonnet-4-5",
  "policy": {
    "version": 1,
    "allow": [{ "action": "shell", "resource": "bun test*" }],
    "budget": 5,
    "timeout": 30
  },
  "branch": "job/upgrade-lodash"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Must be `1`. |
| `prompt` | exactly one of `prompt`/`prompt_file` | The instruction, inline. Must not be empty after trimming. |
| `prompt_file` | exactly one of `prompt`/`prompt_file` | A path to a text file, resolved relative to the spec file's own directory. Must resolve (after following any symlinks) to a path **inside that directory** — `..` segments, absolute paths, and a symlink pointing outside are all refused — must be a regular file, UTF-8, at most 256 KiB, not empty after trimming. |
| `agent` | no | Agent name, as in `kete run --agent`. |
| `model` | no | `provider/model` or `provider/model#variant`, as in `kete run --model`. |
| `policy.version` | no | `1` if present. |
| `policy.allow` | no | Rules the run may proceed on without asking: `{ "action": "...", "resource": "..." }` (wildcards allowed, same as agent permission rules). `question` and `budget` can never be allowed — the parser refuses a spec that tries. |
| `policy.budget` | yes | USD spending limit for the whole run (the session and every subagent it starts). Must be greater than 0. |
| `policy.timeout` | yes | Minutes the whole run may take, from the root session's creation. Must be greater than 0. |
| `branch` | no | The branch name to create. Must be a valid git ref name (no spaces or control characters, no `..`, `@{`, `\`, `~^:?*[`, no leading `-`/`/`, no trailing `/`, `.lock` or `.`). Defaults to `kete/job/<8 hex chars>`. |

`policy` uses the same schema the runtime decodes a session's `kete.unattended` metadata with
(`@opencode/schema/kete/unattended`), so a spec that parses here is guaranteed to be accepted by
the runtime too.

## What a job does

1. Validates the spec. Any problem refuses the run before anything is created or any network
   request is made (exit `2`).
2. If `--server <url>` was passed, refuses unless its host is loopback (`localhost`,
   `127.0.0.0/8`, `::1`) — the worktree the CLI is about to create needs to be visible to that
   server, which only holds when the server is on this machine. The default background service and
   `--standalone` are always local, so this check doesn't apply to them. A second check compares
   what the server resolves the working directory to against the directory itself (after
   `realpath`); a mismatch (e.g. a loopback tunnel to another host) also refuses.
3. If the current directory is a git repository with at least one commit: creates a worktree at
   `<data dir>/worktree/<project id, first 6 chars>/job-<8 hex chars>` (upstream's own worktree
   convention) and a new branch there — `git -C <repo root> worktree add -b <branch> <path>
   <HEAD sha>`, so the job starts from exactly the committed `HEAD`; uncommitted changes in your
   checkout are not included, and the summary says so when they exist. If the directory isn't a
   git repository, the job runs in place instead (`isolated: false` in the result) — there's no
   branch and no isolation. A repository with no commits, or a `branch` requested outside a git
   repository, refuses (exit `2`). The project's own `commands.start` setup script does **not**
   run for a job (it only runs for `POST /api/worktree`, which jobs bypass) — if your project needs
   setup, do it in the prompt, under the job's own policy.
4. Starts a new session at that location with the spec's `agent`/`model` and `kete.unattended`
   metadata set to the policy, submits the prompt, and waits for the run to finish. Every
   permission that would otherwise ask is denied instead unless the policy's `allow` covers it, and
   the runtime **always** denies editing Kete configuration — `.kete/`, `kete.json`/`kete.jsonc`
   anywhere in the project, or anything in the global config directory — even when the policy or
   the agent would otherwise allow it. A denial doesn't stop the run by itself; the run just
   continues without whatever it was denied. If the runtime ever *asks* during a job, that's a
   runtime bug (a job's family should never ask) — the CLI declines it and stops the run.
5. Cleans up before the prompt is submitted only: if worktree creation succeeded but something
   later failed before the prompt went out (e.g. the session couldn't be created), the worktree
   and branch are removed — the branch still equals its base, nothing is lost. Once the prompt is
   submitted, the worktree and branch are always kept, whatever the outcome.
6. Reports the outcome (below) on exit, and to stdout/stderr, or as one `--json` object.

## Output

Without `--json`: the run's final answer (the root session's last assistant message) goes to
stdout; a start line (branch, worktree, session id) and a summary (outcome, exit code, branch,
worktree, cost, duration, the audit log path, and every denial) go to stderr.

With `--json`: exactly one object on stdout, nothing else:

```json
{
  "version": 1,
  "outcome": "completed",
  "exit_code": 0,
  "session_id": "ses_...",
  "text": "...",
  "isolated": true,
  "branch": "kete/job/1a2b3c4d",
  "worktree": "/path/to/worktree",
  "directory": "/path/to/original/cwd",
  "cost_usd": 0.42,
  "cost_scope": "family",
  "duration_ms": 12345,
  "audit_log": "/path/to/audit/ses_....jsonl",
  "audit_local": true,
  "denied": [{ "action": "edit", "resources": [".kete/kete.jsonc"], "message": "..." }]
}
```

`cost_scope` is `"family"` when the cost is summed from the unattended audit log (the whole
session family — the root plus every subagent), or `"root"` when only the root session's own
recorded cost was available (no local audit log, e.g. a remote server). `audit_local` is `false`
in the same case; `audit_log` is still the path the *server* would have written to, for reference.
A spec error's `--json` output is just `{ "version": 1, "outcome": "refused", "exit_code": 2,
"denied": [], "message": "..." }` — nothing else is known yet.

This is a v1 contract: additive changes only from here on (new fields, new `outcome` values might
be added later; existing ones won't change meaning).

## Exit codes

| Exit | Outcome | Meaning |
| --- | --- | --- |
| `0` | `completed` | The run finished on its own. |
| `1` | `error` | An ordinary failure — a model error, a tool error the agent couldn't recover from, an unexpected disconnect, or the runtime bug case (an unattended run got asked a permission). |
| `2` | `refused` / `audit_failed` | The run was refused before or without really starting: a bad spec, a non-local `--server`, no git commit to start from, or (rare) the run's own audit log couldn't be written. |
| `3` | `time_limit` | The run reached `policy.timeout`. |
| `4` | `budget` | The run reached `policy.budget`. |
| `130` | `interrupted` | `kete job run` was interrupted (Ctrl-C); a second interrupt exits at once without waiting for cleanup. |

## Known gaps

- A project that reconfigures its worktree parent directory through a plugin is not honored for
  jobs — the CLI always uses upstream's own default convention (`<data dir>/worktree/<project id,
  first 6 chars>/`), since it can't see plugin-applied settings without running core.
- The Kete-configuration deny (step 4) matches on paths and, best-effort, on shell command text; a
  symlink that points into `.kete/` isn't caught (permission resources are lexical paths, not
  resolved through symlinks), and a sufficiently obfuscated shell command can evade the text check.
- A `permission.asked` from a subagent (not the root session) during a job isn't currently
  recognized as the runtime-bug case described above — only the root session's own asks are.
- With a remote server (same machine, different port — e.g. `--server http://127.0.0.1:PORT`), the
  audit log is read from the path the *client's* data directory would use; if the client and server
  use different data directories, the client falls back to classifying the session's own execution
  event instead of reading the log, and the cost and denial list are less complete (`cost_scope:
  "root"`, `audit_local: false`, `denied: []`).

## Job mode

Job mode (kete-code-platform docs/jobs.md §8, ADRs 0018–0021) is the cloud-job runtime image's
build: an unpublished VM image where the runtime's tools run only through a second-user Go root
helper (`packages/kete-root-helper`; see its README for the protocol and the `root-helper` context
card for how the client fits in). Without a socket configured, job mode stays **fail-closed**: it
refuses every process spawn instead of running one unrestricted.

### The image ↔ runtime env contract

| Variable | Meaning |
| --- | --- |
| `KETE_JOB_MODE=1` | Turns job mode on. Set by the image entrypoint, bridged internally to `OPENCODE_JOB_MODE` (`@opencode/util/kete/env.ts`). Unset or empty is off; any other value is treated as **on** (fails closed — a typo never silently disables job mode). An invalid value makes `kete serve` refuse to start. |
| `KETE_JOB_MAX_OUTPUT_TOKENS` | Required in job mode. A positive integer, the output-token ceiling every model request is clamped or set to. Missing or invalid: every model request is refused locally, naming this variable. |
| `KETE_JOB_TOOL_SOCKET` | The root helper's unix socket path, set by the image entrypoint once the helper is listening. Bridged to `OPENCODE_JOB_TOOL_SOCKET`. Unset or empty: the fail-closed stub stays (every spawn refused). A value that isn't an absolute path makes `kete serve` refuse to start. Set to an absolute path: every spawn goes through `KeteToolHelper.runner` (`@opencode/util/kete/tool-helper.ts`), the real client for the helper's protocol. |
| `KETE_JOB_GATEWAY_KEY_FD` | Required in job mode. The number (3–1023) of an inherited descriptor — a pipe, socket or regular file — holding the job's gateway key (1–4096 printable ASCII bytes). `kete job run` reads it once (10 s timeout), closes it and removes the variable. Missing or invalid: exit `2` `refused`, naming the variable, never the content. The entrypoint passes fd 3. |
| `KETE_JOB_AUDIT_FD` | Required in job mode (piece A3). The number (3–1023, not the key's) of an inherited **pipe** the audit log goes to — never a file. `kete job run` marks it close-on-exec, removes the variable and relays its server child's audit into it unchanged; `kete` can append, never seek, truncate or rewrite. Missing, not a pipe or the key's descriptor: exit `2` `refused`. The entrypoint passes fd 4 and copies the pipe into a root-owned file it uploads. |
| `KETE_GATEWAY_KEY` | **Ignored** in job mode (and removed from the environment before anything is spawned). The descriptor key is the only gateway key: a signed-in account, a `kete auth login` key and `providers.kete.settings.apiKey` are ignored too, so every model call is metered on the job's key. |
| `KETE_PLATFORM_URL` | Required in job mode (`KETE_GATEWAY_URL` too, as before). The platform's `http(s)` root the first sync uses. Unset or not an `http(s)` URL: exit `1` `error`, naming the variable. Configured URLs (`kete.platform.url`) are ignored. |

### What job mode does

- **The first sync is made with the job's gateway key, and the job fails closed on it.** After the
  connection check and before any server starts, `kete job run` calls `GET /api/v1/sync` with the
  descriptor key as the Bearer (`packages/cli/src/kete/job-sync.ts`); no account file or key store is
  read. The job's agent, skills and organization policies come from that response, cached under
  `<config>/managed/<organization id>/`, and the server child loads that cache (it gets the
  organization id on its secrets descriptor). `spec.agent` is **required** (a job's key is pinned to
  one agent, ADR 0020 rule 9) and must be one of the synced agents. Outcomes: sync failed (network,
  the platform refusing the key, a platform error, an invalid response) or a managed skill failed to
  download → exit `1` `error`; `spec.agent` missing or not synced → exit `2` `refused`. No server or
  session exists in any of those cases. Later refreshes (every 5 minutes) keep the last copy when they
  fail; if the policies are somehow not loaded, `edit`, `shell` and `webfetch` ask, which unattended
  mode turns into a denial.

- **Every process spawn goes through the root helper, or is refused.** `CrossSpawnSpawner.node`
  (the service ~20 spawn sites in the runtime already funnel through — the shell tool, MCP stdio
  servers, ripgrep, git, formatters, worktree hooks, the Azure CLI token helper, and more) is
  replaced with `KeteToolHelper.runner({socket})` when `KETE_JOB_TOOL_SOCKET` is a valid absolute
  path, else the fail-closed stub (`@opencode/util/kete/tool-runner.ts`) that refuses every command
  with: "Job mode: tools run only through the job's tool runner; refused to start `<command>`."
  Interactive PTYs and the persistent-PTY daemon are always refused, socket or not — the helper
  doesn't do PTYs (out of scope; see the root helper's task spec). The two spawn sites outside the
  shared `ChildProcessSpawner` service (the OS keychain CLI, `kete job run`'s own
  `git worktree add`) carry their own guard with the identical wording, and are also unaffected by
  the socket — they stay refused. `packages/core/test/kete/job-spawn-sites.test.ts` is the
  enforcement: a static check that classifies every spawn-adjacent file in the runtime, so a new
  one can't go unclassified.
- **What actually runs a tool process, and its lifetime.** Every spawned process runs as the
  helper's fixed tool uid/gid, in its own cgroup leaf, with its cwd confined beneath the worktree
  root and its env filtered to the helper's allowlist (`packages/kete-root-helper` README, "Spawn
  sequence"). Nothing a tool call starts outlives it: on scope release (or once the process has
  exited and its output streams are drained) the client's connection closes, and the helper kills
  whatever remains in that leaf and removes it — unlike local (non-job) mode, where a detached
  background process can survive its parent.
- **Repository configuration is ignored, not narrowed.** The repo's `kete.json`/`kete.jsonc`,
  `.kete/` (config, agents, skills, commands, modes, plugin directories, MCP servers) and the
  repo's `.claude/`/`.agents/` directories never load — `config.entries()` doesn't include them.
  The global config directory still loads (that's where `kete.runtime.type` lives), and so do the
  `KETE_CONFIG`/`KETE_CONFIG_CONTENT` entries the entrypoint sets. Project instructions
  (`AGENTS.md`/`CLAUDE.md`) still load as model context — they're repository text like any file the
  agent reads, not configuration.
- **No plugin code loads from disk**, global included; only built-in (precompiled) plugins run.
- **Every MCP server is disabled** — global config, well-known and platform-synced, stdio and
  remote alike.
- **Only the `kete` provider's models are usable.** Every other model is removed from the list.
  Every model HTTP request through the Kete gateway is checked and, where possible, conformed
  before any bytes are sent (`@opencode/core/kete/job-request.ts`): only function tools, one
  candidate, inline content as `data:`/base64 only (never a URL or a file reference), no
  provider-side conversation state, and the output-token limit from
  `KETE_JOB_MAX_OUTPUT_TOKENS`. A request that can't be made to conform is refused with the reason,
  and never reaches the network. This implements ADR 0020 rules 8, 16 and 17, not a full mirror of
  rule 18's strict per-route schemas.
- **Runtime registration is off.** The runtime never registers with the platform in job mode; one
  info line is logged instead.
- **Job mode implies unattended.** Every session must carry `kete.unattended` (ADR 0008); a
  job-mode session that doesn't gets its step refused before any tool or model request runs,
  classified `refused` the same way an unattended run with no budget/time limit is. `kete job run`
  already sets this metadata, so a job started the normal way is unaffected.
- **`kete job run` never uses `--server` or the background service.** It can't verify that a
  server it didn't start itself is running with `KETE_JOB_MODE` set, so `--server` is refused
  outright; it always starts its own `kete serve` child instead, which inherits the bridged
  `OPENCODE_JOB_MODE` (`extendEnv: true`).
- **`kete`'s own server is a unix socket, and its secrets travel by descriptor.** The child is
  `kete serve --stdio --socket <dir>/s`, where `<dir>` is a fresh `0700` directory under
  `XDG_RUNTIME_DIR`, else `TMPDIR` (the socket itself is `0600`); there is no TCP listener and no
  TCP fallback, and the directory is removed after the run. The child's per-run password and the
  gateway key reach it as one message on an inherited pipe (fd 3), never in either process's
  environment; the key is then held in memory only. In job mode `kete serve` refuses any other shape
  (`--port`, `--hostname`, no `--socket`, not `--stdio`), so the background service, a TUI's
  standalone child and ACP can't open a TCP port; outside job mode `--socket` is refused.
- **Both `kete` processes are non-dumpable.** `kete job run` and its server call
  `prctl(PR_SET_DUMPABLE, 0)` before reading any secret, and refuse to start if that fails: no
  other process of the `kete` user can ptrace them or read their memory, `/proc/<pid>/environ` or
  `/proc/<pid>/fd`.
- **The server's `?auth_token=` query credential is refused**; only the Basic header is accepted,
  and passwords are compared in constant time (everywhere, not only in job mode).
- **`kete` never follows a symlink in the worktree (piece A3).** Its own file access to the
  worktree — the read, write, edit and patch tools, the read tool's directory listings, glob/grep's
  type checks, AGENTS.md discovery and the server's `/fs` routes — goes through `openat2` beneath a
  descriptor of the worktree root (its cwd) with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
  RESOLVE_NO_MAGICLINKS`: a symlink anywhere in a path, `..`, an absolute path outside the worktree
  and a magic link (`/proc/<pid>/root`) are refused ("Job mode: refused to follow a symbolic link or
  leave the working tree: <path>"), so a tool that plants a link can't make `kete` read or write its
  own files. In-process writes outside the file tools (FSUtil) are refused in the worktree, and file
  search uses ripgrep through the tool runner instead of the in-process indexer. Directory walks
  (FSUtil `scan`/`globUp`) rooted in the worktree list it through `openat2` and never enter or
  report a symlink; a walk rooted elsewhere never follows links (`symlink: true` is ignored in job
  mode, also for kete's own global config dirs) and drops every result in the worktree that is only
  reachable through one. Residual limitations: metadata calls (`stat`, `exists`, `up`/`findUp`)
  still follow links, so they can reveal whether a link target exists and its type and size, never
  its content or the names inside it; and a walk rooted outside the worktree, or effect's
  `FileSystem.glob`, may still spend CPU traversing a planted link before its results are dropped. Subprocesses
  (ripgrep, git, the shell) are unchanged: they already run as the tool user. **There is no
  fallback:** without `openat2` (kernel < 5.6, seccomp, or a non-Linux host — job mode now refuses
  to start on macOS) `kete serve` refuses to start and `kete job run` reports `error` (1).
  `packages/core/test/kete/job-fs-sites.test.ts` classifies every other in-process file-access site.
- **The audit log goes to the entrypoint's pipe (piece A3).** In job mode the audit writer writes
  only to the server's fd 4 (a pipe to `kete job run`, which relays it to `KETE_JOB_AUDIT_FD`); no
  file is created under `<data>/audit`. Detail lines stop at 19,000,000 bytes (one `truncated` line
  per root), and any write past 20,000,000 bytes — or a full or broken pipe — interrupts the run as
  `audit_failed`, so the entrypoint's 20 MB cap is never reached by a working `kete`. The result's
  `audit_log` field is absent in job mode (`audit_local: true`); the result itself still goes to
  stdout.
- **`kete job run` uses its cwd as the prepared worktree.** In a cloud job the root entrypoint
  clones the repository, creates the agent's working copy and checks out the job's branch (ADR 0019
  rule 5), then starts `kete job run` in it. So in job mode `kete job run` makes no `git` call at
  all: it needs `spec.branch` (the branch the entrypoint checked out) and a `.git` in cwd (else
  exit `2` `refused`, before any session), runs the session in cwd, never creates or removes a
  worktree, and reports `isolated: true`, `worktree` and `directory` = cwd, `branch` =
  `spec.branch`.

### What's still refused, and what's left to the image/entrypoint

Even with a working helper socket, job mode still refuses: interactive PTYs and the persistent-PTY
daemon (never routed through the helper); `additionalFds` and `unref` on any spawned process
(`KeteToolHelper.runner` refuses both — the helper's protocol has no descriptor-passing, and
job-mode processes must never outlive their tool call); MCP servers, disk plugins, and formatters
from repository config (never loaded, not narrowed — see above); and the OS keychain CLI /
`kete job run`'s own worktree `git` (guarded directly, independent of the socket).

The entrypoint that starts the helper and the egress proxy, sets `KETE_JOB_MODE` /
`KETE_JOB_TOOL_SOCKET` / `KETE_JOB_MAX_OUTPUT_TOKENS`, and delegates the cgroups the helper's
`--tool-cgroup` start-up check requires is `packages/kete-job-entrypoint` (its README is the
contract); the container image is a later task. Without a socket configured, job mode stays
fail-closed: every tool spawn is refused.
