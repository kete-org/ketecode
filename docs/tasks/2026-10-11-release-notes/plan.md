# Plan: What's new after an update (A14)

Upstream edits (all one-line, marked): `cli/script/build.ts` (define), `tui/src/plugin/builtins.ts`
(register the plugin), `tui/test/fixture/app.ts` (optional `app` override for tests). No config
schema, protocol or security change. New contract: `/release-notes` slash command and a release step.

## Cards read
- docs/context/modules/cli.md, ui-branding.md, kete-tools-ci.md (all current per stale-cards.mjs)
- docs/context/pitfalls.md (JSX marker rule), docs/release.md

## Files
| File | Read / change | Why |
|---|---|---|
| `CHANGELOG.md` (root, new) | create | user-facing notes; `## Unreleased` since kete-v0.2.6 |
| `packages/util/src/kete/changelog.ts` (new) | create | pure: `section`, `notesFor(text, version, preview)`, 4 KB cap, `compareVersions` |
| `packages/util/test/kete/changelog.test.ts` (new) | create | parser, cap, version order |
| `packages/cli/script/kete-release-notes.ts` (new) | create | reads root CHANGELOG for the build; missing file/section = "" |
| `packages/cli/script/build.ts` | marked edit | `KETE_RELEASE_NOTES` define |
| `packages/cli/test/kete/release-notes-build.test.ts` (new) | create | AC1 with a fixture changelog in a temp dir |
| `packages/tui/src/kete/release-notes.tsx` (new) | create | builtin plugin: `/release-notes` + palette, auto-show once after an upgrade |
| `packages/tui/src/plugin/builtins.ts` | marked edit | register `KeteReleaseNotes` |
| `packages/tui/test/fixture/app.ts` | marked edit | optional `app` (version/channel) |
| `packages/tui/test/kete/release-notes.test.tsx` (new) | create | AC2–AC4 |
| `packages/kete-tools/src/changelog-check.ts` (new) + `package.json` script `changelog:check` | create | AC5 |
| `packages/kete-tools/test/changelog-check.test.ts` (new) | create | AC5 |
| `packages/kete-tools/src/lib.ts`, `test/lib.test.ts` | edit | `CHANGELOG.md` Kete-owned |
| `.github/workflows/kete-release.yml` | edit | `changelog:check "$TAG"` step before the build (fails only; publishes nothing) |
| `docs/release.md` | edit | release step: rename `## Unreleased` → `## X.Y.Z` |
| `docs/upstream-patches.md` | append | section for this task |

## Steps
1. `util/src/kete/changelog.ts` + test. Section = lines after `## <name>` up to the next `## `,
   trimmed. `notesFor`: exact `## <version>`; else `## Unreleased` when the build is a preview or the
   version has a prerelease suffix; else "". Capped at 4096 bytes on a line boundary with a final "…".
2. `cli/script/kete-release-notes.ts` + build.ts define (computed once, `Script.version`, `Script.preview`) + cli test.
3. TUI plugin: `declare const KETE_RELEASE_NOTES`; `shouldShow({ notes, version, channel, lastSeen })`
   (channel `latest` only, lastSeen known and older, notes non-empty); storage `kete-release-notes`
   `{ version }` recorded on first run and when shown. Dialog: title "What's new in Kete Code <v>",
   scrollable plain text, esc/enter closes. Slash `/release-notes`, palette "Release notes".
4. kete-tools check + script + workflow step + lib.ts ownership.
5. CHANGELOG `## Unreleased` (user-visible changes only; no security-fix descriptions), docs/release.md, upstream-patches.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `bun test ./test/kete/release-notes-build.test.ts` in packages/cli; `bun test ./test/kete/changelog.test.ts` in packages/util |
| AC2–AC4 | `bun test ./test/kete/release-notes.test.tsx` in packages/tui |
| AC5 | `bun test ./test/changelog-check.test.ts` in packages/kete-tools |
| AC6 | typecheck + tests (cli `bun test test/kete`, tui `bun run test`, kete-tools, util kete); root `bun run lint`; `upstream:check`; `verify --base main`; built binary + pty `/release-notes` |

## Cards to update after the build
- ui-branding (release-notes plugin; "Is there a root CHANGELOG?" now yes), cli (build define), kete-tools-ci (changelog:check, isKeteOwned)
