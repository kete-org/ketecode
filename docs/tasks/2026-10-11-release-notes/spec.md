# Spec: What's new after an update (A14)

- Task: `docs/tasks/2026-10-11-release-notes` · Size: medium · Created: 2026-10-11
- Status: agreed (Milestone A, approved 2026-10-10 with merge-when-green; plan item A14; notes source chosen by the
  maintainer 2026-10-11: a user-facing root CHANGELOG)

## Goal
After `kete` is upgraded, the person sees once, in the terminal, what changed for them, and can read it again any
time with `/release-notes`. It works offline.

## Today (verified 2026-10-11)
No root CHANGELOG. GitHub release notes are auto-generated PR lists (`kete-release.yml` `--generate-notes`), written
for developers. The VS Code extension keeps its own user-facing `packages/kete-vscode/CHANGELOG.md`. The binary's
version is injected at build time (`cli/script/build.ts` `define: OPENCODE_VERSION`).

## Scope
Modules: `cli`, `ui-branding` (TUI), `kete-tools-ci` (release).
1. **`CHANGELOG.md` at the repo root**, Kete-owned, user-facing: `## <version>` sections (newest first) with short
   bullets about what changed for the person (same voice as the extension's changelog). Seed it with an
   `## Unreleased` section covering what's merged since 0.2.6 (permission modes and sandbox are already in 0.2.6;
   new since then: status line, Ctrl+R history search, home notices and tips, shell completions, and anything else
   merged — read `git log kete-v0.2.6..main`). Don't mention unpublished security fixes.
2. **Embedded at build time:** the build reads the section for the version being built (or `Unreleased` for a
   preview build) and injects it as a constant, so the binary needs no network or file to show it. Sections are
   capped (e.g. 4 KB); missing section = no notes, never a build failure for previews.
3. **Release step:** `docs/release.md` gains a step: rename `## Unreleased` to `## <version>` before tagging. The
   release workflow fails a stable tag whose version has no CHANGELOG section (previews don't need one).
4. **Once after an upgrade:** the TUI remembers the last version whose notes it showed (TUI storage). When the
   running version is newer and has notes, it shows them once (a dialog or a home-screen panel, dismissible),
   then records the version. First run ever: don't show (nothing was upgraded). Preview/dev builds: never auto-show.
5. **`/release-notes`** (and the palette): shows the current version's notes any time; "No release notes for this
   version" when empty.
6. `kete --version` unchanged.

## Out of scope
Fetching notes from the network; notes for skipped versions (only the current version's section is embedded).

## Acceptance criteria
- [ ] AC1: a build of version X embeds exactly CHANGELOG's `## X` section (build-script test with a fixture
  changelog); a preview build embeds `Unreleased`; a missing section embeds nothing and doesn't fail.
- [ ] AC2: the TUI shows the notes once when the stored last-seen version is older than the running version, and
  not again after dismissal or restart (TUI test).
- [ ] AC3: first run (no stored version) and preview/dev builds don't auto-show (TUI test).
- [ ] AC4: `/release-notes` shows the embedded notes; with none, the empty message (TUI test).
- [ ] AC5: the release workflow refuses a stable `kete-vX.Y.Z` tag without a `## X.Y.Z` section (kete-tools test of
  the check; workflow calls it).
- [ ] AC6: typecheck and tests in cli, tui, kete-tools; root lint; `upstream:check`; built binary shows the
  `Unreleased` notes via `/release-notes` in a pty.

## Risks and constraints
- Contracts: new slash command `/release-notes`; new release step (documented).
- Upstream: the build-script `define` and TUI command registration are upstream files: marked, minimal.
- Security: the notes are build-time constants (no rendering of remote content); render as plain text/markdown the
  TUI already supports.
- Unpublished security fixes must not be described in CHANGELOG until their advisories are public.
