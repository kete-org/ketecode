# 0009. Public CLI distribution and verified self-update

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Until now a Kete Code release was a GitHub Release on the private `kete-org/ketecode` repository:
nobody outside the organization could download `kete`, `kete upgrade` was disabled
(`UpdaterDisabled`, "no verified release channel yet"), and every stable tag also published the VS
Code extension to the Marketplace and Open VSX.

The user decided (2026-10-04) to distribute the CLI publicly **without making the source public**,
through an install script, Homebrew and npm, with a verified `kete upgrade`; and to make extension
publishing an explicit step, separate from releases, because it is the final go-live step.

Constraints: CLAUDE.md §9 (updates verify artifact integrity, never run unverified binaries, never
weaken TLS or signature checks, no invented cryptography), §10 (no hidden failures), §12 (small
dependencies, contracts), and upstream's publish machinery (`publish.yml`,
`packages/cli/script/publish*.ts`) must never run: it targets OpenCode's npm packages, tap and
registry.

## Decision

1. **A public releases repository.** `kete-org/kete-releases` (public, release files only) receives
   every release's CLI archives, `install.sh`, `install.ps1`, a `SHA256SUMS` of exactly those files,
   its two signatures and public release notes. The private repository keeps its own full release
   (archives, `.vsix`, job image digests, kernels). `.vsix` files are never published publicly by a
   release.

2. **Two signatures over the public `SHA256SUMS`, made in one tag-only `sign` job.**
   - `SHA256SUMS.sigstore.json`: **cosign keyless** (Sigstore), identity
     `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v<version>`,
     issuer `https://token.actions.githubusercontent.com`, the same identity as the job images and
     kernels. The install scripts verify it, for the exact tag being installed.
   - `SHA256SUMS.sig`: a detached **Ed25519** signature (64 raw bytes) by a long-lived key whose
     public half is **pinned in the binary** (`packages/cli/src/kete/update-keys.json`). `kete upgrade`
     verifies it with `node:crypto`.

   Why not Sigstore in `kete upgrade`: `sigstore` is in the tree only transitively (via `pacote`), is
   large (TUF client, Fulcio chain and Rekor verification, protobuf specs), and needs the Sigstore
   TUF repository online at verification time, a third-party dependency on every upgrade for users
   on slow or filtered networks. Ed25519 needs no new dependency, no network beyond the release
   files, and no hand-written cryptography (`crypto.verify(null, …)`). The cost is a long-lived
   secret, mitigated by: an environment (`release-signing`) that only `kete-v*` tags can use; a job
   that checks out only the pinned key list and runs only openssl, jq and cosign; a check that the
   key is pinned before signing; and **rotation by list** (the binary accepts any pinned key: ship
   the next key in a release signed by the current one, then switch). A build with no pinned key
   reports updates as unavailable and installs nothing.

3. **`kete upgrade` (Kete-owned `KeteUpdater`, replacing `UpdaterDisabled`).** The latest version
   is read from the *signed* `SHA256SUMS` of the latest release (file names carry the version), not
   from an API, so it is authenticated and not rate-limited. An install requires: a valid signature
   by a pinned key; for an explicit version, the signed file must describe exactly that version;
   the archive for the binary's build target (`KETE_TARGET`, a build define) must match its signed
   checksum; the unpacked binary must run and report that version. Never a downgrade or the same
   version. The new binary is staged in the old one's directory and swapped in with one rename
   (Windows: rename the running exe aside, rename the new one in, roll back on failure).
   Homebrew and npm installs (detected from the binary's real path) are **told** to use their
   manager; the editor extension's copy and source builds don't update. The background check honours
   upstream's `autoupdate` policy (`notify` by default), installs automatically only for direct
   installs with `autoupdate: true`, and stays silent without a pinned key. `Brand.updatesAvailable`
   is `true`.

4. **Install channels.**
   - `install.sh` (POSIX sh; macOS and Linux; x64/arm64; glibc/musl; AVX2 or baseline; Rosetta
     → arm64) and `install.ps1` (Windows x64/arm64; AVX2 or baseline) install into a user directory
     (`~/.local/bin`, `%LOCALAPPDATA%\Programs\kete\bin`), never with sudo or administrator rights.
     They **fail closed**: without cosign they refuse, unless the user passes `--checksum-only` /
     `-ChecksumOnly`, which prints a warning that only the checksum was checked.
   - Homebrew: `kete-org/homebrew-tap` `Formula/kete.rb`, generated per release (per-platform URL
     and SHA-256) and pushed by the tag-only `distribute` job, stable releases only.
   - npm: `@ketecode/cli` (a dependency-free launcher) plus one optional dependency per platform
     (`@ketecode/cli-<os>-<arch>[-musl]`, selected by `os`/`cpu`/`libc`), published by the same job;
     pre-releases under the `next` tag. `--provenance` is passed **only when the source repository is
     public**: npm refuses provenance from a private repository.
   - Package managers can't detect AVX2, so Homebrew and npm ship the x64 **baseline** builds, as the
     VS Code extension does; the install scripts detect and choose.

5. **Credentials.** The cross-repository publish uses a **GitHub App installation token**
   (`actions/create-github-app-token`, scoped to `kete-releases` and `homebrew-tap`, contents: write;
   app client ID in variable `KETE_DIST_APP_CLIENT_ID`, private key in secret
   `KETE_DIST_APP_PRIVATE_KEY`), short-lived and not tied to a person; `NPM_TOKEN` for npm. Both live
   in the environment `distribution`; the update key `KETE_UPDATE_SIGNING_KEY` in `release-signing`.
   Both environments, like `registries`, admit only `kete-v*` tags. The `sign` and `distribute` jobs
   run only on tag pushes and only when the repository variable `KETE_PUBLIC_DISTRIBUTION` is
   `true`, so releases keep working until the one-time setup is done.

6. **Extension publishing is explicit.** `kete-release.yml` no longer publishes to the Marketplace
   or Open VSX and its `publish` job no longer uses an environment. `kete-extension-publish.yml`
   (manual dispatch **on** a released stable tag, the tag typed again to confirm, environment
   `registries`) publishes the `.vsix` files already attached to that tag's published release after
   checking them against its `SHA256SUMS`.

## Consequences

- Anyone can install and update `kete` without access to the source; the install script's trust
  root is the Sigstore identity of this repository's release workflow, and `kete upgrade`'s is the
  pinned Ed25519 key. Two roots, both checked in CI before anything is published (`distribute
  verify` runs what `kete upgrade` will run).
- Public contracts: the release file names, `SHA256SUMS`/`.sig`/`.sigstore.json` formats and the
  signing identity, the install scripts' flags and default directories, the npm package names and
  the formula name. Changing any of them needs a migration path (CLAUDE.md §12).
- The Ed25519 private key must be generated, stored and rotated by a maintainer; losing it means a
  release with a new pinned key that existing installs can't verify (they reinstall with the
  script). Revisit Sigstore in the binary if a small, offline-capable verifier becomes available.
- npm provenance is unavailable until the source repository is public; the job turns it on
  automatically then.
- Users who install with `--checksum-only` get integrity against a tampered mirror only, not
  publisher authentication; the scripts say so.
- `kete uninstall` stays disabled; it now names the Homebrew and npm commands.
