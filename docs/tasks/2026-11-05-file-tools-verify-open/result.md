# Result: File tools verify the opened file

## What changed
- `packages/core/src/kete/verified-open.ts` (new):
  - a per-tool-call registry (`Expected`, set by `scoped` on the read, write, edit and patch tools' `execute`);
  - `record`: the real path `FileAccess.resolve` checked and, for an existing file, its device and inode at that moment;
  - `read` / `write`: open, then compare the descriptor's identity with the recorded one (no path lookup after the open);
    a file created since the check falls back to a path check; an inode of 0 is refused; reads open non-blocking (a FIFO can't hang them);
    writes open without truncating (or create exclusively at the checked real path), verify, then truncate and write through the descriptor;
  - any mismatch: nothing read or written, and the tool reports "The file changed while it was being opened; try again."
- Upstream, marked: `core/src/file-access.ts` (record), `core/src/environment/local.ts` (read/write delegate when recorded),
  `core/src/tool/plugin/{read,write,edit,patch}.ts` (`scoped`). Recorded in `docs/upstream-patches.md`; `docs/permissions.md` one sentence.
- Tests: `core/test/kete/verified-open.test.ts` (unchanged file, new file, hard link inside, missing, mismatch, a file replaced at the same
  path after the check, file swapped for a symlink out, folder swapped for a symlink out, dangling links, registry conflicts),
  `file-tools-verified-open.test.ts` (the real write tool with a swap between check and open). `job-fs-sites.test.ts`: the new
  file-system site classified.

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| core `bun run typecheck` | clean (after narrowing the write error type) |
| verified-open, file-tools, job-fs-sites tests | 13 pass |
| core tool/file/environment tests + `test/kete` | 2232 pass / 33 skip / 14 fail; the 14 (ripgrep/search tools, shell process substitution) fail without this change too (25 fail on the 1.2 tree): local environment |
| `bun run lint`, `upstream:check` | exit 0; pass (after re-marking the `local.ts` write block) |
| `verify --base main` | 0 new failures in util, server, core, tui, cli |
| Reviews | upstream-guard: approve. reviewer: approve (mtime precision fixed). security-reviewer: the first design re-looked the path up after the open, which toggling a parent folder three times could fool → replaced by the identity recorded at check time; FIFO and inode-0 items fixed |

## Acceptance criteria
- [x] AC1 — helper tests above (read and write refused after swaps; unchanged and new files work; hard link inside accepted).
- [x] AC2 — the write tool through the real tool; read is covered at the driver level (the read tool's harness needs a full read filesystem).
- [x] AC3 — existing file-tool tests unchanged in outcome.
- [x] AC4 — checks above; no POSIX-only flags on Windows (non-blocking read is POSIX only).

## Known residual (needs openat-based I/O; follow-up before Work mode is available)
- A **new** file: its parent folder can still be toggled to a symlink between the check and the exclusive create, so an empty or
  model-written new file can land outside; `mkdir` of missing parents follows symlinks too.
- **Deletes and moves** (`patch`) and **directory listing** are not verified.
- The **formatter** runs on the path after the write.
- The identity is recorded by path right after the check, so a toggle in that instant can still record the wrong file.
These need component-by-component opening without following symlinks (`openat` with `O_NOFOLLOW`, via Bun FFI), which plain
`node:fs` can't do. Work stays `available: false` until then; it is listed as the next security item for Phase B (2.4).

## Cards updated
See the librarian's close-out.

## Metrics
- Agents used: planner, implementer (no shell), reviewer, upstream-guard, security-reviewer, librarian
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-05)
