# Handoff: What's new after an update (A14)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-11 planner + implementer (one agent)

Done: plan.md written and built.
- Root `CHANGELOG.md` (Kete-owned; `isKeteOwned` + test line) with `## Unreleased` (user-visible changes merged
  since kete-v0.2.6: status line, Ctrl+R history search, rename on `<leader>shift+r`, home notices and tips, shell
  completions, task list, LSP diagnostics, hooks, TUI violet/wordmark/outlined prompt, `/release-notes`) and a
  short `## 0.2.6`. Left out: runner/cloud-jobs/orchestration/review-jobs work (not user-facing in the CLI), the
  local-build channel fix (source builds only), and any security-fix wording.
- `@opencode/util/kete/changelog` (section, cap 4 KB on a line boundary, notesFor, compareVersions).
- `cli/script/kete-release-notes.ts` + `build.ts` define `KETE_RELEASE_NOTES` (marked).
- `tui/src/kete/release-notes.tsx` builtin plugin (`builtins.ts`, marked): `/release-notes` + palette "Release
  notes"; auto-show once when channel is `latest`, stored version (`kete-release-notes`) is older and notes exist.
- `kete-tools changelog:check` + `kete-release.yml` step before the build (fails only); `docs/release.md` step 2.
- `tui/test/fixture/app.ts` gains an optional `app` (marked); `docs/upstream-patches.md` section.

Decisions:
- Pre-release versions (`0.3.0-rc.1`) fall back to `## Unreleased` like previews; a stable version never does.
- The version is recorded when the notes are shown (not on dismissal), and on first run; preview/dev channels
  never record. If another dialog is open at startup, nothing is recorded so the notes show next launch.
- Notes render as plain text (bullets → •, `**`/backticks dropped), in a scrollable dialog (↑/↓/PgUp/PgDn).
- In tests `KETE_RELEASE_NOTES` is set as a global (the build replaces the identifier).

Docs enough: no — missing: ui-branding card doesn't say the TUI's version/channel come from `useTuiApp()` and the
fixture hard-codes them; cli card doesn't say `Script.preview`/channel derivation for local builds.

Open: librarian to update cards ui-branding (release-notes plugin; "Is there a root CHANGELOG?" now yes), cli
(build define), kete-tools-ci (changelog:check, CHANGELOG.md ownership).

### Checks (2026-10-11)
- util `typecheck` ok, `bun test ./test/kete` pass; cli `typecheck` ok, `bun test test/kete` 321 pass / 0 fail;
  tui `typecheck` ok, full `bun run test` 1479 pass / 0 fail (release-notes tests 7/7 after the final edit);
  kete-tools `typecheck` ok, `bun test` 64 pass; root `bun run lint` 0/0; `upstream:check` passed;
  `verify --base main`: no new failures (core's 30 failures are the same on main).
- Binary built (`--single --skip-install --skip-web-ui`); pty (scratch XDG dirs) `/release-notes` shows "What's new in
  0.0.0-feature-release-notes-…" with the Unreleased bullets, PgDn scrolls, Esc closes. After the first pty run the
  dialog joined hard-wrapped bullet lines (`plainLines`) and got 2 more rows of margin; rebuilt and re-checked.
- Not exercised for real: the auto-show after an actual `kete upgrade` between two release builds (covered by the
  TUI tests with channel `latest`), and the workflow step on a real tag.
