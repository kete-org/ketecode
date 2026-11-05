# Spec: File tools verify the opened file

- Task: `docs/tasks/2026-11-05-file-tools-verify-open` · Size: large · Created: 2026-11-05
- Status: closed (approved 2026-11-05, Phase A pre-approval: "continue building until Phase A is complete", recommended options) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
The agent's file tools read and write the file their permission check approved, not whatever the path points
to a moment later. Today `FileAccess.resolve` checks a path's real path (symlinks followed) and the tool then
opens the path again, so a concurrent process (a sandboxed command the agent started) can swap a directory
holding a symlink into the path between the two and redirect a read or write outside the allowed folders.
PR 1.3b of Phase A (`docs/desktop-enhancement-plan.md`): the security review of 1.3 found this; Work mode
stays unavailable until it lands. It protects Code sessions too.

## Scope
Modules: the file tools (`read`, `write`, `edit`, `patch`; `core/src/tool/plugin/*`), `FileAccess`
(`core/src/file-access.ts`), `KeteRealPath` (`core/src/kete/real-path.ts`), the file mutation / environment write
path (`core/src/environment/local.ts` or wherever the bytes are written).

- **Reads**: open the file, `fstat` the descriptor, re-resolve the path's real path and `stat` it; the read
  proceeds only if the real path is still the one the check approved and its device/inode equal the
  descriptor's. Read through the descriptor.
- **Writes and edits**: open without truncating (create if missing), verify the same way, then truncate and write
  through the descriptor. A new file is created exclusively in its checked directory (the directory is
  re-verified after creation). Never follow a symlink in the final component when creating.
- On mismatch: the tool fails with a clear error ("the file changed while it was being opened; try again") and
  nothing is read or written. Logged; no partial write.
- One Kete-owned helper (`core/src/kete/verified-open.ts`) holds the logic; the upstream call sites change by a
  marked line or two each. Line endings, BOM preservation and permissions behave as today.

## Out of scope
- Directory listing, glob and grep (ripgrep doesn't follow symlinks; patterns are checked separately).
- Narrowing the OS sandbox's writable folders for Work (WS2).

## Acceptance criteria
- [ ] AC1: Unit tests on the helper: a file swapped for a symlink to an outside file after the check is refused
  for read and for write; a directory swapped for one holding such a symlink is refused; an unchanged file is
  read/written; a new file is created; a hard link to an outside file made before the check is refused when its
  real path is outside (and accepted inside, as today).
- [ ] AC2: Tool-level tests (read, write, edit) through the real tools with a fake "swap between check and open"
  seam: refused, and the outside file is unchanged.
- [ ] AC3: Existing file-tool tests pass unchanged (BOM, line endings, new files, permissions).
- [ ] AC4: core typecheck and tests, lint, `upstream:check`, `verify --base main`, Windows-safe paths (no
  POSIX-only calls on the Windows path: fall back to the same check with `stat`).

## Risks and constraints
- Security: this is the fix for a high finding; a security review runs on the diff.
- Upstream edits in the file tools and the write path: minimal, marked, recorded.
- Performance: one extra `fstat` and `realpath` per file operation.
