# Spec: Job mode piece A3: openat2 confinement and entrypoint-owned audit/result sink

- Task: `docs/tasks/2026-10-01-job-file-confinement` · Size: large · Created: 2026-10-01
- Status: approved (user, 2026-10-01) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Close the last two runtime requirements of kete-code-platform `docs/jobs.md` §8: in a job, `kete`
opens working-tree files only with `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_MAGICLINKS)` from the working-tree root (item 3, "`kete` is not a deputy"), and its audit
log and result go to an entrypoint-owned sink (item 4), so a tool that plants symlinks in the
worktree can't make `kete` read or write outside it, and nothing `kete` writes for the platform can be
rewritten afterwards.

## Scope
### 1. File confinement (modules: job-mode, core environment/file tools)
- A job-mode `Files` driver injected at the existing seam (`Environment.layer`,
  `core/src/environment/environment.ts:24-33`, via `KeteJobServer.replacements`), in a Kete-owned
  module. It holds an `O_PATH` descriptor of the working-tree root opened at startup and performs every
  open, stat, readdir, mkdir, rename and unlink relative to it with `openat2` and the three
  `RESOLVE_*` flags (and `*at` calls on descriptors it got that way). Paths are worktree-relative;
  absolute paths outside the root and `..` escapes are refused before the syscall.
- `openat2` from Bun through `bun:ffi` and libc `syscall(SYS_openat2, …)` (precedent:
  `cli/src/kete/dumpable.ts`), per architecture (x86_64 and arm64 both 437).
- **D1 — coverage:** every in-process file access `kete` makes to the worktree in job mode: the
  file tools on `Environment.files` (read, write, edit, patch) **and** the in-process listing/reading
  behind glob, list and file search (`FileSystem`/`FSUtil`/`FileSystemSearch`). Subprocesses (ripgrep,
  git, formatters) already run through the root helper as the tool user (part 1) and are unchanged.
- **Fail closed:** if `openat2` is unavailable (`ENOSYS`, old kernel, non-Linux) job mode refuses to
  start (`error`), never falls back to plain `open`.
- Outside job mode, nothing changes.

### 2. Audit and result sink (modules: audit, job-mode, job-entrypoint)
- **D2 — sink shape: a pipe.** The entrypoint creates a pipe, passes the write end to `kete` as an
  inherited descriptor (close-on-exec in `kete` after it's read, `KETE_JOB_AUDIT_FD`), and reads the
  other end itself into a root-owned file it uploads. `kete` can only append; it can't seek,
  truncate or rewrite lines already sent (an `O_APPEND` file descriptor would still allow
  `ftruncate`). The 20 MB cap is enforced on both sides; a full or broken pipe interrupts the run
  like a failed audit write today.
- In job mode the audit writer (`core/src/kete/audit.ts`) writes to that descriptor and no file in
  `kete`'s data dir; outside job mode it's unchanged.
- **D3 — result:** the `kete job run --json` result keeps going to `kete`'s stdout, which is already
  a root-created file the tool user can't reach (`entry_linux.go:304-314`); no change. (Alternative:
  send the result through the same pipe as a final record.)
- Entrypoint: uploads what it read from the pipe instead of reading `kete`'s audit file.

### 3. Tests and docs
- TS unit tests for the driver (fake syscall layer) and the audit sink; Linux tests (root helper CI
  container) with real `openat2`: symlink to `/etc/passwd`, symlinked directory, `..`, absolute path,
  magic link (`/proc/self/root`), a symlink swapped in mid-operation; all refused, normal edits work.
- The end-to-end lifecycle asserts the audit came through the pipe and a planted symlink is refused.
- contracts.md §6d (`KETE_JOB_AUDIT_FD`), job-mode / audit / job-entrypoint cards.

## Out of scope
- Fly-kernel checks (wait for the platform's Fly adapter).
- `RESOLVE_NO_XDEV` (not required; the worktree is one filesystem).
- The root helper's own `openat2` use (unchanged).

## Acceptance criteria
- [ ] AC1: In job mode, read/write/edit/patch and glob/list/search refuse a symlink (file or
  directory), `..`, an absolute path outside the worktree and a magic link, on Linux with real
  `openat2`; ordinary worktree edits work (Linux tests).
- [ ] AC2: Job mode refuses to start when `openat2` is unavailable (test with the syscall stubbed to `ENOSYS`).
- [ ] AC3: In job mode the audit goes only to the inherited pipe; no audit file is written in the data
  dir; a closed pipe interrupts the run (tests).
- [ ] AC4: The entrypoint uploads the audit it read from the pipe; the e2e lifecycle passes with it and
  with a planted symlink refused.
- [ ] AC5: Outside job mode, file tools and the audit behave as before (existing tests).
- [ ] AC6: typecheck, Kete tests, lint, `upstream:check`, `verify --base main`, Go tests, integration
  and e2e.

## Risks and constraints
- **Security-critical**, and the driver is a second file-access implementation: it must match the
  local driver's behaviour for every operation the tools use, or a tool breaks only in jobs. The plan
  lists each operation.
- `bun:ffi` and raw syscalls: architecture-specific numbers and struct layout (`open_how`, 24 bytes);
  test on both arm64 and x86_64 (CI is x86_64, Colima arm64).
- If glob/search can't be routed through the driver without upstream edits, those edits need
  `kete_change` markers; the plan says which.
- Contract: a new descriptor variable (additive) between the entrypoint and `kete`.
