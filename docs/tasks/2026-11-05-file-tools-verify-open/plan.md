# Plan: File tools verify the opened file

**Large task: a security fix with upstream edits. The user approves this plan before the build starts.**
Upstream files edited, by marked lines only: `core/src/file-access.ts`, `core/src/environment/local.ts`,
`core/src/tool/plugin/read.ts`, `write.ts`, `edit.ts`, `patch.ts`. No shared contract, config schema, server
endpoint or SDK change.

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

## Cards read
- docs/context/modules/permissions.md (verified-at 08f5855d87, stale: no): `FileAccess.resolve` and `KeteRealPath.follow`
- docs/context/modules/add-dir.md (stale: no): extra folders count as internal roots; nothing to change
- Not relied on (stale, outside the spec): `sandbox`, `worktrees-parallel` (`kete/stale-write.ts` calls `FileAccess.resolve` and `files.read`; see Design 6)
- The cards don't cover the file tools, `FileMutation` or the environment driver, so I read the code (gaps logged in handoff.md)

## Design (why this shape)
1. **Record the checked real path where it is computed.** `FileAccess.resolve` already computes
   `real = KeteRealPath.follow(...)` (`file-access.ts:106`). One marked line records `absolute → real ?? absolute`
   into a per-tool-call registry (`KeteVerifiedOpen.record`). It does nothing when no registry is in scope and
   is skipped in job mode (where `real` is already `undefined` and the confined file system refuses symlinks).
   `UNRESOLVED` is recorded as is, so it never matches and a link loop is refused (it fails with ELOOP today
   anyway). The `Target` type and the `FileMutation`/`Files` signatures don't change.
2. **The registry is a `Context.Reference`** (`KeteVerifiedOpen.Expected`, default `undefined`; same pattern as
   `Permission.Unattended`, `permission.ts:56`). It holds a fresh `Map` per tool call plus a `changed` flag.
   `KeteVerifiedOpen.scoped(effect)` provides it. Each of the four tools appends `.pipe(KeteVerifiedOpen.scoped)`
   to its `execute` effect as the outermost pipe, after its own `mapError`. This is not global state: each call
   gets its own map.
3. **The local driver verifies only registered paths.** In `environment/local.ts`, `read` (after its existing
   `stat`/kind check) and `write` call `KeteVerifiedOpen.expected(value)`. When it returns a path, they delegate to
   `KeteVerifiedOpen.read(value, expected, range)` / `KeteVerifiedOpen.write(value, expected, bytes)`.
   Every other caller (glob, grep, list, the memory driver, remote workspace drivers, job mode) is unchanged.
   Every byte the tools read or write already passes through `files.read`/`files.write`: FileMutation's `write`,
   `writeTextPreservingBom`, `readText` and `syncTextBom`; `ReadToolFileSystem`'s chunked range reads; and
   patch's direct `environment.files.write`. So those call sites need no edits.
4. **Verify the open in both directions**: open → `handle.stat({ bigint: true })` → `R = fs.realpath(value)` →
   check that `R` equals `expected` (case-insensitive on win32 only, because `FSUtil.resolve` keeps the written
   casing there) → check that `fs.stat(R, { bigint: true })` has the descriptor's dev/ino. Use bigint because
   Windows file indexes exceed 2^53. Use no `O_NOFOLLOW` or other POSIX-only flag anywhere, so Windows runs the
   same code.
   - **Read**: `fs.open(value, "r")`, verify, then read through the handle (`handle.readFile()`, or
     `handle.read(buffer, 0, length, offset)` for a range). Build the returned `info` from the descriptor's stat
     (`type: "file"`, plus `size` and `mtimeMs` as numbers). Close the handle in `finally`.
   - **Write**: `fs.open(value, "r+")` (no truncate, no create). On ENOENT, run
     `fs.mkdir(dirname(value), { recursive: true })` as today, then create the file exclusively **at `expected`**
     with `"wx+"`. O_CREAT|O_EXCL never follows a final symlink, and creating at the checked real path also covers
     today's legitimate dangling link inside the workspace. EEXIST at that point counts as changed. Then verify.
     Only after verification passes, `handle.truncate(0)` and write all bytes at position 0 through the handle.
     An existing file keeps its mode bits (it is never re-created); a new file gets the same default mode
     `writeFile` gives.
   - **On mismatch**: nothing is read, truncated or written. If the file was just created, remove it only when
     `lstat(expected)` still shows the descriptor's dev/ino; otherwise leave the empty file and log it.
     Fail with `Environment.Failed({ path, cause: new KeteVerifiedOpen.ChangedError(...) })`, set the registry's
     `changed` flag, and `Effect.logWarning` the path and the expected real path (no file content).
5. **Produce the clear tool error in one place.** When the registry's `changed` flag is set, `scoped` turns the
   failure into a `ToolFailure` whose message starts "The file changed while it was being opened; try again."
   followed by the tool's original message, which keeps patch's "Completed before failure" list. The four
   tools' own error mapping is untouched.
6. Other `FileAccess.resolve` callers (`kete/stale-write.ts`, `kete/lsp.ts`, `kete/memory-files.ts`,
   `schedule/check.ts`) record only when they run inside a tool's scope. Recording the same path twice keeps
   the first value; a different second value marks the entry conflicting, and a conflicting entry is always
   refused.

Upstream-first: no config, plugin hook or service seam sits between `FileAccess.resolve` and the bytes on disk.
The `Files` interface takes a bare path, so a hook would have to re-open the file by path, which is the bug.
The Kete module holds all the logic; each upstream file gets one or two marked lines.

## Files
| File | Read / change | Why |
|---|---|---|
| packages/core/src/kete/verified-open.ts | create | `Expected` reference, `scoped`, `record`, `expected`, `read`, `write`, `ChangedError`. A header comment explains the threat and why the module uses node:fs (it is called only from the environment seam) |
| packages/core/src/kete/real-path.ts | read | `follow`/`UNRESOLVED` semantics, which produce the expected value |
| packages/core/src/file-access.ts | change (1 marked line, 1 import) | record `absolute → real ?? absolute` after line 106 when not in job mode |
| packages/core/src/environment/local.ts | change (marked lines in `read` and `write`, 1 import) | delegate registered paths to the helper |
| packages/core/src/environment/files.ts | read | the `Failed`/`NotFound`/`WrongKind` and `FileInfo` shapes the helper must return |
| packages/core/src/tool/plugin/read.ts | change (1 marked line) | `.pipe(KeteVerifiedOpen.scoped)` on `execute` (lines ~118-135) |
| packages/core/src/tool/plugin/write.ts | change (1 marked line) | same, on `execute` (lines 64-96) |
| packages/core/src/tool/plugin/edit.ts | change (1 marked line) | same, on `execute` (lines 279-389), after `withLock` and `mapError` |
| packages/core/src/tool/plugin/patch.ts | change (1 marked line) | same, on `execute` (lines 85-313) |
| packages/core/src/file-mutation.ts | read | confirms that writes go through `files.write`/`files.read` inside the tool's fiber |
| packages/core/src/tool/read-filesystem.ts | read | the chunked `files.read(range)` calls (lines 122, 233); each one is verified |
| packages/core/src/permission.ts | read (lines 50-60) | the `Context.Reference` pattern to copy |
| packages/core/test/kete/verified-open.test.ts | create | AC1 helper tests |
| packages/core/test/kete/file-tools-verified-open.test.ts | create | AC2 tool tests |
| packages/core/test/kete/file-access-symlink.test.ts | read | fixture pattern for real outside folders and links (`outside`, `provide`) |
| packages/core/test/tool-write.test.ts | read | how to build a tool on a real temp dir with a `permissionLayer` whose `assert` callback runs code (the swap seam) |
| packages/core/test/tool-read.test.ts, tool-edit.test.ts, tool-patch.test.ts | read | the same harness for the other tools |
| docs/upstream-patches.md | change | new section "Verified open for file tools (fix/file-tools-verify-open)": a file / change / why-no-seam table and a sync checklist |
| docs/permissions.md | change (near lines 215-218) | one sentence: reads and writes verify that the file they open is the one the check approved |

## Steps
1. Create `kete/verified-open.ts` with the namespace export `KeteVerifiedOpen`, like `real-path.ts`:
   - `Expected = Context.Reference<Registry | undefined>("@kete/VerifiedOpen/Expected", { defaultValue: () => undefined })`,
     where `Registry = { paths: Map<string, string | typeof CONFLICT>, changed: boolean }` and keys are
     `path.resolve(absolute)`.
   - `scoped(effect)` provides a fresh registry. On failure with `changed` set, it wraps the error in a
     `ToolFailure` as described in Design 5.
   - `record(absolute, real)` and `expected(absolute)`, both Effects that read the reference.
   - `read(value, expected, range?)` and `write(value, expected, bytes)` as described in Design 4. They return
     `Effect<…, NotFound | Failed>`, mapping ENOENT/ENOTDIR to `NotFound` the same way `local.ts` `attempt` does.
2. `file-access.ts`: after line 106, add
   `if (!KeteJobMode.enabled()) yield* KeteVerifiedOpen.record(absolute, real ?? absolute) // kete_change: …`.
3. `environment/local.ts`: in `read`, after the kind check, add
   `const expected = yield* KeteVerifiedOpen.expected(value)` and
   `if (expected !== undefined) return yield* KeteVerifiedOpen.read(value, expected, range)` as one marked block.
   Turn `write` into an `Effect.gen` that delegates the same way and otherwise runs the current `attempt` body
   unchanged.
4. Add `.pipe(KeteVerifiedOpen.scoped) // kete_change: …` as the outermost pipe of each tool's `execute` in
   read, write, edit and patch, plus the marked import.
5. AC1 tests in `test/kete/verified-open.test.ts`. Skip the symlink cases on win32 (symlinks need privileges
   there), as `file-access-symlink.test.ts` does; run the unchanged-file, new-file and hard-link-inside cases on
   every platform. Call `read`/`write` directly with `expected` set to the real path from before the swap, and
   swap before the call. Cases:
   - a file swapped for a symlink to an outside file: read refused; write refused and the outside file unchanged
   - a parent folder swapped for a folder holding such a symlink: refused
   - an unchanged file: read and written (bytes round-trip, mode kept)
   - a new file: created
   - a dangling link inside the workspace: its target is still created
   - a hard link inside the workspace: accepted
   - a hard link whose path is outside: `FileAccess.resolve` makes it external (assert the recorded value)
6. AC2 tests in `test/kete/file-tools-verified-open.test.ts`: run the real read, write and edit tools (the
   harness from `tool-write.test.ts` and the other tool tests, the local driver, a real temp dir). Use
   `permissionLayer({ assert })` to swap `notes.txt` for a symlink to an outside file when the `read`/`edit`
   assertion arrives, which is after the check and before the open. Expect a `ToolFailure` whose message
   contains "changed while it was being opened", and check that the outside file's bytes are neither returned
   nor changed. Add a patch case if the harness makes it cheap.
7. Docs: add the `docs/upstream-patches.md` section covering the 6 files, why no seam works, and a sync
   checklist item: "if upstream changes `Files.read/write` in `local.ts` or adds another byte path for the file
   tools, route it through `KeteVerifiedOpen`". Add the `docs/permissions.md` sentence.
8. Run the verification table and report any check that can't run.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | in `packages/core`: `bun run test ./test/kete/verified-open.test.ts` |
| AC2 | in `packages/core`: `bun run test ./test/kete/file-tools-verified-open.test.ts` |
| AC3 | in `packages/core`: `bun run test ./test/tool-read.test.ts ./test/tool-write.test.ts ./test/tool-edit.test.ts ./test/tool-patch.test.ts ./test/tool-read-filesystem.test.ts ./test/file-mutation.test.ts ./test/environment.test.ts ./test/file-access.test.ts ./test/kete/file-access-symlink.test.ts ./test/kete/permission-realpath.test.ts`, then `bun run test ./test/kete` |
| AC4 | in `packages/core`: `bun run typecheck`, `bun run test`; root: `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main`. Windows can't be run locally: confirm by review that `verified-open.ts` uses no `O_NOFOLLOW` or other POSIX-only `fs.constants` flags, and that the tests' non-symlink cases aren't skipped on win32 |

## Cards to update after the build
- permissions: add a Quick answer "Do file tools re-check the path when they open it?" (the registry is recorded
  in `FileAccess.resolve` and verified in `environment/local.ts` by `kete/verified-open.ts`); add the module to `paths`.
- pitfalls.md: "A new byte path for read/write/edit/patch must go through `files.read`/`files.write` inside
  `KeteVerifiedOpen.scoped`; otherwise it reopens by path without verification."
- worktrees-parallel (already stale): note that `stale-write.ts` reads inside a tool scope are verified too.

## Residual risks (for the security review)
- A triple swap is not closed: the path points outside at open, back inside at `realpath`, and outside again at
  `stat`. Node has no `openat` or `F_GETPATH`. The window is narrow and needs precise timing.
- `mkdir -p` of missing parents runs before verification, so a swap can create empty folders outside. A failed
  exclusive create in a swapped folder can leave an empty file outside when the inode check can't confirm it is
  safe to remove.
- The formatter (`formatter.file`) runs an external process on the path after the write; out of scope.
- Remote workspace drivers and the memory driver are not verified (no local symlinks).
- A FIFO swapped in after the kind check still blocks a read open, as it does today.
