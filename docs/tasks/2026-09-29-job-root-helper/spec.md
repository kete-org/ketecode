# Spec: Job mode part 2: the Go root helper and its tool-runner client

- Task: `docs/tasks/2026-09-29-job-root-helper` · Size: large · Created: 2026-09-29
- Status: approved (user, 2026-09-29)

## Goal
In job mode, tools run as a separate tool user instead of being refused: `kete` asks a small Go
root helper over a unix socket to start each process as that user, inside its cgroup, with the
hardening platform ADR 0019 rule 5 requires (kete-code-platform `docs/jobs.md` §8 item 3). With
this, a job can run the shell tool, git and the other spawner-seam processes end to end — inside the
cloud container. The helper is Linux-only and ships in the container image (a later task), not in
the CLI or VS Code downloads.

## Scope
- **`packages/kete-root-helper/`** (new Go module; Kete-owned by path): a root process that listens
  on a unix socket the `kete` user alone can connect to (peer credentials checked: uid = `kete`), and
  per request:
  - starts the process as the **fixed** tool uid/gid (from the helper's own start-up configuration,
    never a request field): `clone3` with `CLONE_INTO_CGROUP` into the tool cgroup, then
    `setgroups`/`setgid`/`setuid`, then `no_new_privs`, then `chdir` to a directory that must resolve
    beneath the worktree root, then `execve` of an absolute path (no shell, no `PATH` lookup as root);
  - argv and env as data; env limited to a fixed allowlist of names;
  - passes only stdio (pipes it creates); every other descriptor closed;
  - streams stdin/stdout/stderr and reports exit code/signal;
  - `kill` only through a pidfd of a process it started, in the tool cgroup;
  - limits: request rate, message size, concurrent processes; `pids.max`/`memory.max` are set on the
    cgroups by the entrypoint (later task), which the helper checks exist.
- **Protocol:** versioned, length-prefixed messages over the socket; stdio multiplexed as frames on
  the connection (no descriptor passing, so the TypeScript client needs no native code). Written
  down in the module's README as a contract.
- **TypeScript client** (`packages/util/src/kete/`): a `KeteToolRunner.Interface` implementation
  that speaks the protocol and returns a full `ChildProcessHandle` (pid, exitCode, isRunning, kill,
  stdin sink, stdout/stderr/all streams). Job mode uses it when `KETE_JOB_TOOL_SOCKET` (a path) is set;
  without it, the fail-closed stub stays. `additionalFds` and `unref` are refused in job mode.
- **Still refused in job mode:** PTY and the persistent-PTY daemon, `secret-store` and `job-git`
  direct spawns (the entrypoint makes the worktree), MCP servers, plugins, formatters from repo
  config.
- **Tests:** Go unit tests; Linux integration tests that run as root with a real second user and
  cgroup v2 (a privileged container locally; a new CI job on `ubuntu-latest`, path-filtered to the
  helper and tool-runner files to protect the CI minutes budget); TypeScript client tests against a
  fake helper; one end-to-end test (in the Linux job) of `kete` in job mode running a shell command
  as the tool user through the real helper.
- Docs: the module README (protocol), `docs/jobs.md`, the job-mode card, a new card.

## Out of scope
- The container image, entrypoint, egress proxy, cgroup creation and limits (the entrypoint's job).
- `openat2` worktree confinement for `kete`'s own file tools, the unix-socket server for `kete`
  itself, the gateway key by descriptor, the entrypoint-owned audit sink (later tasks).
- PTY through the helper.
- Shipping the helper in the CLI or VS Code release.

## Acceptance criteria
- [x] AC1: As root with a real tool user, the helper starts a process that runs as the tool uid/gid
  with no supplementary groups, `NoNewPrivs: 1`, in the tool cgroup, with only fds 0–2 open, cwd
  beneath the worktree (Linux integration test).
- [x] AC2: The helper refuses: a peer that isn't the `kete` uid; a cwd outside the worktree
  (including via `..` and symlinks); a relative executable; env names outside the allowlist;
  oversized messages; too many requests or processes (tests).
- [x] AC3: stdin/stdout/stderr stream correctly (including large output and binary data), exit code
  and signal are reported, and `kill` works and only reaches the helper's own children (tests).
- [x] AC4: The TypeScript client implements the full `ChildProcessHandle` contract against a fake
  helper, and job mode picks the client when `KETE_JOB_TOOL_SOCKET` is set and the stub otherwise
  (tests).
- [x] AC5: End to end on Linux: `kete` in job mode runs a shell-tool command through the real helper;
  the command's process runs as the tool user (the CI Linux job).
- [x] AC6: `go vet`, `go test` (unit) pass; typecheck, Kete tests, lint, `upstream:check`,
  `verify --base main` pass; the CI job passes.

## Risks and constraints
- **Security-critical:** the helper is the only boundary between `kete` and root. It must stay small,
  auditable and free of shells; every input is untrusted.
- **New toolchain:** Go joins Bun in the repo (CI job, `go.mod` pinned Go version); no Go on the
  developer's Mac today — local runs use a container.
- **CI budget:** the new Linux job must be path-filtered and short.
- **Contract:** the socket protocol is a contract between `kete` and the helper (both in this repo);
  version it.
