# Spec: File tools open paths without following swapped links

- Task: `docs/tasks/2026-11-05-file-tools-openat` · Size: large · Created: 2026-11-05
- Status: closed (approved 2026-11-05, user: "start the openat file I/O fix"; Phase A pre-approval of recommended options) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Close the rest of the file-tool race that #100 narrowed. After the permission check, the read, write, edit and
patch tools touch the checked real path without following any symbolic link, so a concurrent process can't swap a
folder or file for a link and redirect a create, delete, move or listing outside the allowed folders. With this in
place, Work mode can be made available (a separate, small follow-up). Code sessions get the same protection.

## Scope
Modules: `permissions` (file tools, `KeteVerifiedOpen`), `job-mode` (`util/src/kete/linux-ffi.ts`, `kete/job-files.ts`,
the existing confined file system), the local environment driver.

- **No-follow resolution of the checked real path** (`core/src/kete/verified-open.ts` and a small platform layer):
  - **macOS**: `open`/`openat` with `O_NOFOLLOW_ANY` (refuses a symlink in any component). Parents are created with
    `mkdirat`, and entries are removed and renamed with `unlinkat`/`renameat` relative to a parent directory opened
    the same way. Reached through `bun:ffi` (libc), like `linux-ffi.ts`.
  - **Linux**: `openat2` with `RESOLVE_NO_SYMLINKS` (and `RESOLVE_NO_MAGICLINKS`) plus the `*at` helpers, **reusing**
    `KeteLinuxFfi` (job mode already uses them). Not a second copy.
  - **Windows**: no change from #100 (identity check). Work refuses all shell commands there, so nothing runs
    concurrently in Work. Documented.
- **Operations covered** (the residuals listed in #100's result):
  - **create**: missing parent folders and a new file are created through directory descriptors, with no link
    followed (exclusive create of the file);
  - **read/write of an existing file**: opened no-follow, plus #100's identity check;
  - **delete** (`patch` delete, the driver's `remove`) and **move** (`patch` move): through the parent directory's
    descriptor (`unlinkat`, `renameat`); a recursive delete of a folder is refused unless the tool asked for a file;
  - **list** (`read` on a folder): the folder opened no-follow; its entries are read through that descriptor where the
    platform allows (Linux `getdents64` via `KeteLinuxFfi`), else the descriptor's identity is compared with a
    no-follow `lstat` before and after `readdir`;
  - **formatter**: it runs on the path after the write. Either it's refused in a Work session, or the formatter's
    target is checked with a no-follow open first. The planner picks the smaller safe option.
- **Fail closed**: if the FFI can't be loaded (unknown platform or architecture, or the symbol is missing), the
  verified paths refuse the operation with a clear error. They never fall back to following links. Code sessions
  outside the verified scope are unchanged.
- **Paths with legitimate symlinks**: `FileAccess.resolve` already turned the path into its real path, which has no
  symlinks at check time (on macOS `/var` → `/private/var` is resolved by then). So a no-follow open of the real
  path only fails if something changed after the check.
- Docs: `docs/upstream-patches.md` (if an upstream line changes), `permissions` and `job-mode` cards, and #100's
  residual list in `result.md` marked as closed.

## Out of scope
- Making Work available (a separate small PR after this one, with its own security sign-off).
- A Windows sandbox; network or sandbox changes; the Work interpreter's own reach (that's WS2).

## Acceptance criteria
- [ ] AC1: Swap tests (macOS and Linux, in CI's Kete-owned tests): a parent folder swapped for a symlink to an
  outside folder after the check. Each case is refused, and nothing appears or changes outside:
  - create of a new file;
  - mkdir of missing parents;
  - write;
  - delete;
  - move (from and to);
  - list.
- [ ] AC2: Normal operations still work: create with new parents, overwrite (mode kept), read whole and ranged,
  delete a file, move a file, list a folder, and a path whose real path differs from the lexical one (e.g. a macOS
  tmp path).
- [ ] AC3: FFI unavailable → the verified operations refuse with a clear message (a test with an injected missing
  platform).
- [ ] AC4: core typecheck and tests, lint, `upstream:check`, `verify --base main`, CI on Linux (Kete-owned tests),
  and a security review with no open high or medium finding.

## Risks and constraints
- Security-critical: deny on any doubt; keep descriptors closed on every path; no secrets in errors.
- `O_NOFOLLOW_ANY` needs macOS 11+, which the desktop already requires; check the constant's value against the SDK.
- FFI on the hot path: one extra syscall per component at most; measure that the file-tool tests don't slow down
  noticeably.
- Upstream edits only where the driver or tools must call the new paths; minimal and marked.
