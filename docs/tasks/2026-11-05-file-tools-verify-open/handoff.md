# Handoff: File tools verify the opened file

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-11-05 planner
Done: wrote plan.md (Large: a security fix with marked edits in 6 upstream files; the user approves before the build).
Decisions:
- `FileAccess.resolve` records the checked real path in a per-tool-call `Context.Reference` registry, and the
  local driver verifies only registered paths. This avoids changing the `Target`, `Files` and `FileMutation`
  signatures, and each upstream file gets 1-2 marked lines.
- New files are created with O_EXCL at the checked real path, so a final symlink is never followed and today's
  dangling-link-inside case keeps working.
- The tool-level swap seam is the test `permissionLayer` `assert` callback, so production code gets no test hook.
Stale cards: `sandbox` and `worktrees-parallel` are stale but outside the spec, so I didn't rely on them.
`kete/stale-write.ts` (worktrees-parallel) calls `FileAccess.resolve` and `files.read`; inside a tool scope its
reads are verified too. The librarian should refresh both cards at close.
Docs enough: no. Missing:
- no card covers the file tools (`tool/plugin/read|write|edit|patch.ts`) or how their bytes reach disk
  (`FileMutation` → `Environment.files` → `environment/local.ts`)
- the environment driver split (local / memory / remote workspace `workspace.connect`, `makeFiles`) is undocumented
- `ReadToolFileSystem` reads files in ranged chunks (`read-filesystem.ts:122,233`), not in one read
- the tool test harness (`test/lib/tool.ts` `executeTool`/`registerToolPlugin`, the `permissionLayer` assert
  callback) is not in any card
Open questions for the security review: the residual risks listed at the end of plan.md.

## 2026-11-05 implementer
Done: steps 1-4 and 7 (module, 6 marked upstream edits, docs), AC1 tests and ONE AC2 test (write tool only).
NOT RUN: no shell in this session, so no test, typecheck, lint or upstream:check was run. Everything is unverified.
Files: core/src/kete/verified-open.ts (new), file-access.ts, environment/local.ts, tool/plugin/{read,write,edit,patch}.ts,
test/kete/verified-open.test.ts, test/kete/file-tools-verified-open.test.ts, docs/upstream-patches.md, docs/permissions.md.
Decisions: `Registry` and `CONFLICT` exported (declaration emit); a conflicting registry entry maps to
`KeteRealPath.UNRESOLVED` so it never matches; realpath/stat failure during verify counts as "changed".
Gaps: AC2 has no read/edit/patch cases; the discard of a just-created file on mismatch doesn't log when it
leaves the file; key lookup is by `path.resolve(absolute)` string (an unregistered path is unverified).
Likely first-run problems: Effect v4 API names (`Effect.catch`, `Effect.provideService`) and the test harness types.
