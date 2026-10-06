# Spec: JetBrains plugin downloads its `kete` on first use (Marketplace build)

- Task: `docs/tasks/2026-10-06-jetbrains-first-use-download` · Size: large · Created: 2026-10-06
- Status: approved (decision pre-approved by the maintainer 2026-10-05, docs/release.md "The 400 MB
  Marketplace limit"; "yes" to building it 2026-10-06)

## Goal
Make the JetBrains plugin publishable to the JetBrains Marketplace (at most 400 MB per upload): the
Marketplace build carries no `kete` binary and, with the user's consent, downloads the platform's
`kete` from the public `kete-org/kete-releases` release matching the plugin's own version, verified
exactly as `kete upgrade` verifies a release, before it ever runs. The per-OS zips with bundled
binaries stay on the GitHub Release for offline installs.

## Scope
Module: `jetbrains-plugin` (docs/context/modules/jetbrains-plugin.md); release workflows.
1. **Pinned keys, single source:** Gradle copies `packages/cli/src/kete/update-keys.json` into the
   plugin jar (`ai/ketecode/jetbrains/update-keys.json`) at build time, and fails the build when the
   file is missing, malformed or has no keys.
2. **Resolution order** (`core/Binary.kt`, pure): `cliPath` setting → bundled
   `bin/<platform>/kete[.exe]` → a previously downloaded binary in
   `<IDE system dir>/kete-code/cli/<version>/<platform>/kete[.exe]` → "needs download". Never `PATH`.
3. **Verification** (`core/CliRelease.kt`, pure, mirrors `packages/cli/src/kete/release-verify.ts`):
   `SHA256SUMS.sig` is 64 raw bytes, Ed25519 over the exact bytes of `SHA256SUMS`, checked with
   `java.security.Signature("Ed25519")` against the pinned keys; `SHA256SUMS` parsed strictly
   (sha256sum format, ≤ 64 KB, no duplicates); the archive (`kete-<v>-<target>.zip|tar.gz`) must be
   listed and its SHA-256 must match.
4. **Installer** (`core/CliInstall.kt`): HTTPS only on every hop, size caps (SHA256SUMS ≤ 64 KB,
   .sig exactly 64 bytes, archive ≤ 300 MB, extracted binary ≤ 1 GiB), download into a staging
   directory next to the destination, verify signature then checksum, extract only `kete`/`kete.exe`
   (refusing absolute paths, `..`, links, duplicates and oversize), set executable, check it reports
   the expected version, atomically move the version directory into place under a file lock, remove
   older downloaded versions. Nothing unverified is ever executed or left where resolution would
   find it.
5. **IDE glue and consent** (`KeteCliDownload.kt`): first time, a sticky notification says what will
   be downloaded (the CLI for this OS/architecture, about 80–95 MB, from
   github.com/kete-org/kete-releases, verified with Kete Code's release signing key) with
   Download / Open Settings; consent is remembered (application setting, revocable in Settings), so
   later versions download automatically in a cancellable background task with progress. Errors
   (offline, proxy, HTTP 404 for a version without a public release, verification failures) are shown
   honestly with Retry / Open Settings. No network request before consent.
6. **Release workflow:** `kete-release.yml`'s jetbrains job builds the Marketplace zip
   `kete-code-jetbrains-<v>.zip` without binaries (checked: no `bin/` entries, < 400 MB) plus the
   three per-OS zips (unchanged checks) and the `.sha256`. `kete-jetbrains-publish.yml` drops the
   now-unreachable "doesn't fit" stop, keeps the 400 MB guard and refuses a zip with `bin/` entries.
7. **Docs:** plugin description and README disclose the download (and the smoke checklist covers it);
   docs/release.md's 400 MB section becomes "built"; the module card is updated.
8. **Tests:** signature (good, tampered, wrong key, wrong length), checksum mismatch, missing line,
   archive names per platform, extraction safety (zip-slip, absolute, symlink, oversize), resolution
   order, generated keys resource = the CLI's file, plus an opt-in live test against the real
   `kete-v0.2.4` release.

## Out of scope
- Per-OS Marketplace listings, smaller binaries, re-verifying an installed binary on every start
  (anyone who can write the IDE system directory can also write the plugin directory).
- Signing the plugin zips themselves (the Marketplace signs uploads).

## Acceptance criteria
- [ ] AC1: the keys resource is generated from the CLI's file; a missing/empty file fails the build.
- [ ] AC2: `Binary.resolve` follows setting → bundled → downloaded → needs download (unit tests).
- [ ] AC3: verification refuses a tampered SHA256SUMS, a wrong key, a sig that isn't 64 bytes, a
      checksum mismatch and a missing archive line (unit tests).
- [ ] AC4: extraction refuses absolute, `..`, symlink and oversize entries (unit tests); the
      end-to-end install with a fake fetcher lands only a verified binary (unit test).
- [ ] AC5: the opt-in live test downloads and fully verifies `kete-v0.2.4` for this platform with the
      real pinned keys (run locally once).
- [ ] AC6: a manual `kete-release.yml` run on the branch passes, including the jetbrains job's
      Marketplace-zip checks.
- [ ] AC7: docs (plugin description, README, docs/release.md, module card) describe the download.

## Risks and constraints
- Security (CLAUDE.md §9): downloading and executing code. Fail closed on every check; HTTPS only;
  signature before checksum before extraction; no PATH fallback; consent before any network request.
- Contracts: a new application setting (`cliDownloadConsent`); the Marketplace zip's name is the one
  `kete-jetbrains-publish.yml` already expected.
- Platform: tar.gz/zip reading uses the platform-bundled Apache Commons Compress (no new dependency);
  the Plugin Verifier in CI checks it resolves in every verified IDE.
