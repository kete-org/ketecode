# Handoff (append-only)

- 2026-10-10: built by one agent session; split into three PRs (todo, LSP, hooks).
- 2026-10-10: PR #29 (todo) and #30 (LSP) opened; hooks PR last. Verify results and deviations in result.md.
- 2026-10-10: security review of #30/#31. LSP fixed on its branch (merge of main, no rebase). Follow-up recorded in upstream-patches.md: upstream formatter `findExecutable` (util/which.ts) searches cwd on Windows and resolves relative PATH entries — same flaw as fixed for LSP; not changed here.
