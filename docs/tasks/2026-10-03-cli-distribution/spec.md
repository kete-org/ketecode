# Spec: Public CLI distribution: releases repo, install scripts, Homebrew, npm, verified kete upgrade

- Task: `docs/tasks/2026-10-03-cli-distribution` · Size: large · Created: 2026-10-03
- Status: built (approved by user, 2026-10-04: all of the above)

## Goal
Anyone can install and update `kete` on macOS, Linux and Windows without access to the private
source: from a public releases repository, by install script, Homebrew or npm, with every install
and `kete upgrade` verified; and the VS Code extension reaches its registries only when explicitly
published. Design: ADR 0009.

## Scope
- **Release workflow** (`kete-tools-ci` card): `build` assembles the public file set; `publish`
  drops the Marketplace/Open VSX steps and its environment; new tag-only `sign` (Ed25519 + cosign
  keyless over the public `SHA256SUMS`) and `distribute` (kete-releases, Homebrew tap, npm) jobs
  behind `vars.KETE_PUBLIC_DISTRIBUTION`; new `kete-extension-publish.yml` (manual, on a stable tag).
- **kete-tools**: `src/distribute.ts` (public set, formula, npm packages, notes, verify),
  `distribution/` (`install.sh`, `install.ps1`, npm launcher + README, kete-releases README).
- **CLI** (`cli`, `brand-env` cards): Kete-owned verified updater (`kete/updater.ts`,
  `kete/release-verify.ts`, `kete/update-keys.json`, `kete/upgrade.ts`) replacing `UpdaterDisabled`;
  `KETE_TARGET` build define; `Brand.updatesAvailable = true`, `urls.releases`, `distribution`;
  branded TUI update dialog; uninstall message names Homebrew/npm.
- **Docs**: ADR 0009, `docs/release.md`, cards, contracts §9, upstream-patches.

## Out of scope
- Creating the repositories, GitHub App, npm organization, tokens, signing key, environments or the
  repository variable (the user does; `handoff.md` lists them). No repository settings change.
- macOS code signing/notarization; Windows Authenticode; a `kete uninstall` implementation; Scoop,
  winget, apt/rpm channels; publishing anything (no tag, no run).
- Editing upstream's root `README.md` (OpenCode's README, untouched by Kete so far): the public
  install README lives in `kete-releases` (`distribution/releases-README.md`) and `docs/release.md`.

## Acceptance criteria
- [ ] AC1: A stable tag no longer publishes the extension; `kete-extension-publish.yml` publishes a
  released stable tag's verified `.vsix` files only when dispatched on that tag with confirmation.
- [ ] AC2: The release builds a public file set (CLI archives + install scripts + their
  `SHA256SUMS`, no `.vsix`); on tags with distribution on, `sign` produces `SHA256SUMS.sig`
  (pinned-key Ed25519, refusing an unpinned key) and `SHA256SUMS.sigstore.json` (cosign keyless,
  verified), and `distribute` verifies both, then publishes to `kete-org/kete-releases`, the Homebrew
  tap (stable) and npm, with credentials only in tag-restricted environments and only in the
  publishing steps.
- [ ] AC3: `install.sh` (POSIX sh) detects the release target (OS, arch, Rosetta, musl, AVX2),
  verifies the cosign signature for the exact tag and the archive checksum, fails closed without
  cosign unless `--checksum-only` (with a warning), installs to a user directory without sudo;
  `install.ps1` does the same on Windows.
- [ ] AC4: Homebrew formula with per-platform URLs and SHA-256 generated from the release; npm
  `@ketecode/cli` launcher + per-platform optional packages (`os`/`cpu`/`libc`), provenance when the
  source is public, `NPM_TOKEN` named.
- [ ] AC5: `kete upgrade` installs only releases whose `SHA256SUMS` signature verifies against a
  pinned key and whose archive matches; refuses downgrades and reinstalls; replaces the binary
  atomically (interrupted replace keeps the old one; Windows rolls back); tells Homebrew/npm installs
  to use their manager; reports "unavailable" with no pinned key. Tests cover tampered checksum,
  signature and archive, downgrade refusal and interrupted replace.
- [ ] AC6: Checks pass: cli/util/tui typechecks and Kete tests, kete-tools typecheck and tests,
  actionlint on the workflows, a local dry run of the build and distribution steps (no publishing),
  `bun run lint`, `upstream:check`, card-check.

## Risks and constraints
- **Security:** a new long-lived signing secret (mitigated per ADR 0009); install scripts are a
  trust root; the updater replaces executables (atomicity, no unverified install, no package-manager
  execution). CLAUDE.md §9 "Updates".
- **Contracts:** release file names, signature formats and identity, install-script flags and
  directories, npm and formula names become public contracts (contracts §9).
- **Upstream:** minimal marked edits (`index.ts`, `commands.ts`, `build.ts`, `dialog-update.tsx`);
  upstream publish scripts/workflows untouched.
- **Known limits:** npm provenance is impossible while the source repository is private; the
  updater is dormant until a maintainer pins a key.
