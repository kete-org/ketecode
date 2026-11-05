# Result: File tools open paths without following swapped links

## What changed
PR1 (#103, merged):
- `util/src/kete/darwin-ffi.ts`: macOS `openat` with `O_NOFOLLOW_ANY`, the `*at` helpers and `readdir`.
- `util/src/kete/linux-ffi.ts`: `readdir`, an `openat` binding, and an opt-in per-component no-follow `openat2` fallback for `ENOSYS`/`EPERM`.
- `util/src/kete/confined-fs.ts`: `Ops.open`/`create`.

PR2 (this branch):
- `core/src/kete/verified-open.ts`:
  - after the check, read, write, create (with missing parents), list and delete go through descriptors opened without following links, on macOS and Linux;
  - a checked link is deleted as an entry of its link-free lexical folder;
  - writes refuse files with other hard links;
  - the formatter runs only when the path still resolves to the checked file and that file has one link;
  - unsupported platforms fail closed; Windows keeps #100's identity check.
- Upstream, marked: `core/src/environment/local.ts` (list, remove), `core/src/formatter.ts` (one line). Recorded in `docs/upstream-patches.md`.
- Tests: `core/test/kete/verified-open-nofollow.test.ts` (swap cases for create, mkdir, write, delete, move, list and formatter; link and hard-link cases; normal operations; FFI unavailable). `job-fs-sites.test.ts`: reason text only.
- `docs/tasks/2026-11-05-file-tools-verify-open/result.md`: #100's residuals marked closed.

## Remaining limits (security review of PR2)
- The formatter rewrites by path: a swap during its own spawn (milliseconds) is not covered. It runs only when the path still resolves to the checked file just before it starts (a linked workspace folder is fine) and that file still opens without following links.
- Writes to a file with other hard links are refused. Reads are not (pnpm node_modules uses hard links): reading through a hard link planted inside the workspace remains a sandbox-level follow-up (macOS Work already denies file-link).
- A link inside a linked folder is not deleted (refused).
- Not tested: macOS x64 (reasoned from the SDK), a live seccomp EPERM on Linux.

## Checks
The implementers had no shell; the main session ran every check.

| Check | Result |
|---|---|
| Spikes | macOS `O_NOFOLLOW_ANY` through `bun:ffi`: a linked parent → ELOOP |
| util typecheck and `test/kete` (PR1) | clean; 471 pass (the real-libSystem cases ran on macOS arm64) |
| core typecheck | clean (after a type fix) |
| verified-open-nofollow, verified-open, file-tools-verified-open, job-fs-sites, tool-patch | 82+ pass; nofollow 28 pass after the last fixes |
| core `test/kete` plus tool/file/environment tests | 2298 pass (local ripgrep/shell failures excluded; they fail on main too) |
| `bun run lint`, `upstream:check` | exit 0; pass |
| `verify --base main` | 0 new failures in util, server, core, tui, cli (run before the last fixes, which touch only `verified-open.ts` and its tests, re-run above) |
| CI Linux (Kete-owned tests) | PR1 green; PR2 see PR |
| Reviews | PR1: security high (the fallback opened the cwd for `/`), FFI buffer lifetimes, device opens → fixed and re-checked. PR2: the patch test moving a symlink → link delete through its parent; security mediums (link-delete parent, formatter path) plus hard links → fixed; the re-check found a hard-link swap before formatting → nlink check added. Upstream-guard and reviewer: approve |

## Acceptance criteria
- [x] AC1: swap tests for create, mkdir, write, delete, move (both sides), list and formatter: refused, outside untouched (macOS locally; Linux in CI).
- [x] AC2: normal operations (create with parents, overwrite keeps mode, read whole and ranged, delete, move, list, linked workspace folder, macOS tmp path).
- [x] AC3: FFI unavailable → every operation fails closed.
- [x] AC4: checks above; the security review has no open high or medium finding.

## Cards updated
<!-- And the "Docs enough: no" gaps the librarian added. -->

## Metrics
- Agents used: librarian ×2, planner, implementer ×4 (no shell), reviewer ×2, upstream-guard, security-reviewer ×4
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-05)
