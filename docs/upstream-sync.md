# Upstream sync runbook

How Kete Code takes a new OpenCode release. The tooling is in `packages/kete-tools`;
the rules it enforces are in CLAUDE.md §4 and `docs/architecture.md` §15.

## Model

- `upstream` is OpenCode (`github.com/anomalyco/opencode`), with pushing disabled
  (`git remote set-url --push upstream no_push`). `origin` is Kete Code.
- Kete's `main` contains upstream's history. A sync **merges** an upstream release
  tag (`vX.Y.Z`); it never copies files or rebases.
- `.opencode-version` pins the release `main` is built on.
- Each sync happens on its own `upstream/vX.Y.Z` branch and lands through a PR
  containing only the sync (no feature work).

## Commands

Run from anywhere in the repository:

```sh
bun run --cwd packages/kete-tools upstream:sync v2.0.17            # merge, pin, check
bun run --cwd packages/kete-tools upstream:sync v2.0.17 --verify   # + typecheck/tests vs main
bun run --cwd packages/kete-tools upstream:sync --continue         # after resolving conflicts
bun run --cwd packages/kete-tools upstream:sync --abort            # give up; deletes the branch
bun run --cwd packages/kete-tools upstream:check                   # hygiene checks (markers include uncommitted edits)
bun run --cwd packages/kete-tools verify --base main               # typecheck + tests, new failures only
```

`--pr` pushes the branch and opens the pull request with the generated report,
and refuses to do so while any check fails. Without `--pr` nothing is pushed.
The report is written to `.git/kete-upstream-sync-report.md`.

## What the sync does

1. **Preflight**: clean working tree; `upstream` exists and cannot be pushed to;
   the tag exists upstream and is newer than `main:.opencode-version`; `main`
   matches `origin/main`.
2. **Merge** the tag into `upstream/vX.Y.Z` (created from `main`).
3. **Auto-resolve the release noise.** Upstream tags every release on a
   version-bump commit that is _not_ an ancestor of the next release, so every
   sync conflicts on each `package.json` `"version"` and on `bun.lock`. Hunks that
   only touch `"version"` take upstream's value; `bun.lock` takes upstream's copy
   and is regenerated with `bun install`. Anything else, including a hunk that
   mixes a version bump with a Kete edit, is left for a human. Every automatic
   resolution is listed in the report.
4. **Stop on real conflicts**, split into files Kete has changed since the last
   release (see below) and files it has not.
5. **Pin** `.opencode-version` in its own commit.
6. **Check** (`upstream:check`):
   - _pin_: HEAD contains the pinned release;
   - _markers_: every edit to an upstream file carries a `kete_change` marker;
     edits to files that cannot carry comments (`.json`, `.txt`, `.md`, …) are
     listed in `docs/upstream-patches.md`; upstream files are not deleted or
     added outside Kete paths without a record;
   - _leaks_: no new `".opencode"`, `opencode.json[c]` or `"OpenCode"` literals in
     engine sources (`packages/{cli,core,server,tui,util}/src`) compared with the
     pre-sync `main`;
   - _license_: `LICENSE` is unchanged from upstream and `NOTICE` exists.
7. **Verify** (`--verify`): typecheck and tests for the engine packages on the
   sync branch and on `main` (in a temporary worktree); only failures that `main`
   does not have count. This runs locally; Kete does not use paid CI for it.
8. **Report** with the upstream compare link, auto-resolutions, check results,
   test comparison, new upstream GitHub workflows, and a reviewer checklist.

## Resolving conflicts

- **Files Kete has changed**: take upstream's version first, then re-apply the Kete
  edit with its `kete_change` marker. `docs/upstream-patches.md` says what each
  patch is for; if the patch has to change shape, update that entry in the same PR.
- **Files Kete has not changed**: take upstream's side (`git checkout --theirs`).
- Never drop a `kete_change` line to make a conflict go away; the marker check
  will not notice a patch that disappeared entirely.
- Then `git add` the files and run `upstream:sync --continue`.

## After the checks

- **Leaks**: route the new literal through `Brand`
  (`packages/util/src/kete/brand.ts`) with a marked edit. If it must stay (for
  example, OpenCode's own hosted-provider name), add `file:pattern-id` to
  `packages/kete-tools/leak-allowlist.txt` with a comment saying why.
- **New upstream tests that assert OpenCode names**: `verify` reports them as new
  failures; retarget them to `Brand` values with markers, as in the rebrand.
- **New GitHub workflows**: every inherited workflow is disabled in the repository
  settings, but a workflow _file added_ by upstream starts enabled. Disable each
  one listed in the report (`gh workflow disable <file>`) before merging. The repository is
  public (ADR 0010): an enabled upstream workflow on `pull_request_target` or with secrets could
  run for fork pull requests, so check `gh workflow list --all` after every sync.
- **Hosted-service defaults**: review new upstream features for opencode.ai
  endpoints, telemetry, or providers enabled by default (see
  `packages/core/src/kete/hosted.ts`).

## Rehearsal record

Rehearsal from `v2.0.15` to `v2.0.16`, run before the first real sync, on a
throwaway branch (`v2.0.15` + the rebrand and Zen commits):

- 38 files auto-resolved (37 `package.json` version bumps, `bun.lock`); no manual conflicts.
- All checks passed, and the regenerated `bun.lock` was byte-identical to the
  lockfile of the real branches.
- The merged tree matched the real branches except for two upstream tests that were new in
  `v2.0.16` and still asserted OpenCode names, which is what `--verify` is for.
