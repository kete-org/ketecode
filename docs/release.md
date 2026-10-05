# Releasing Kete Code

A release is one version of everything: the `kete` CLI for every platform, the VS Code extension
for every platform, and checksums. The CLI is distributed publicly (ADR 0009) without making the
source public; the extension reaches its registries only when a maintainer publishes it explicitly. Kete Code has its own version numbers, independent of the
upstream OpenCode version the source is synced to (`.opencode-version`).

> Never run upstream's `packages/cli/script/publish*.ts` or enable `publish.yml`. They publish to
> OpenCode's npm packages, Homebrew tap and image registry.

## Where a release goes

| Channel | What | When |
| --- | --- | --- |
| GitHub Release on `kete-org/ketecode` (private) | CLI archives, every `.vsix`, the JetBrains plugin zips, `SHA256SUMS`, job image digests, guest kernels, generated notes | every tag |
| GHCR `ghcr.io/kete-org/kete-job` | the cloud job image: a signed linux/amd64 + linux/arm64 index tagged with the release tag (per-arch tags `<tag>-linux-<arch>`) | every tag |
| GHCR `ghcr.io/kete-org/kete-harness-plugin` | the Kete Code step image for Harness pipelines (`packages/kete-harness-plugin`): a signed linux/amd64 + linux/arm64 index tagged with the release tag (per-arch tags `<tag>-linux-<arch>`) | every tag |
| GitHub Release on `kete-org/kete-releases` (public) | CLI archives, `install.sh`, `install.ps1`, their `SHA256SUMS`, `SHA256SUMS.sig` (Ed25519), `SHA256SUMS.sigstore.json` (cosign), public notes | every tag, once public distribution is on |
| Homebrew `kete-org/tap/kete` (`kete-org/homebrew-tap`) | `Formula/kete.rb`: per-platform URLs into `kete-releases` and their SHA-256 | stable tags, once public distribution is on |
| npm `@ketecode/cli` + `@ketecode/cli-<platform>` | launcher + one package per platform | every tag (pre-releases under the npm tag `next`), once public distribution is on |
| VS Code Marketplace and Open VSX (`ketecode.kete-code`) | the 8 platform `.vsix` files of a released stable tag | **only** when `kete-extension-publish` is run on that tag ([Publish the extension](#publish-the-extension)) |
| JetBrains Marketplace (`ai.ketecode.kete-code`) | the all-platform plugin zip of a released stable tag, if it fits the 400 MB limit | **only** when `kete-jetbrains-publish` is run on that tag ([Publish the JetBrains plugin](#publish-the-jetbrains-plugin)) |

"Once public distribution is on" means the repository variable `KETE_PUBLIC_DISTRIBUTION` is `true`
(see [Public distribution](#public-distribution-one-time-setup)); until then a release publishes only
the private GitHub Release and the job image, and says so in its log.

Pre-release tags (`kete-v0.2.0-rc.1`) produce pre-releases: a GitHub pre-release (both
repositories), npm under `next`, and no Homebrew update. `install.sh`, `install.ps1` and
`kete upgrade` install the latest **stable** release unless given a version; only the highest
stable version is marked latest on `kete-releases`, so re-running an older tag doesn't move it. The extension can't be
published from a pre-release: the Marketplace accepts no version suffix.

## One-time setup

- **Publisher and namespace.** VS Code Marketplace publisher `ketecode`
  (<https://marketplace.visualstudio.com/manage>) and Open VSX namespace `ketecode`
  (`bunx ovsx create-namespace ketecode -p <token>`; ask the Eclipse Foundation to verify it, or
  the listing shows "unverified").
- **Credentials.** Create the GitHub environment **`registries`** (Settings → Environments), limit its
  deployment branches and tags to the tag pattern **`kete-v*`** (exactly that: a narrower pattern
  such as `kete-v*.*.*` refuses pre-release tags like `kete-v0.2.0-rc.1`, which is what stopped an
  earlier rc run).
  - **VS Code Marketplace: Microsoft Entra ID, no token.** The workflow signs in with GitHub's OIDC
    token (`azure/login`) and publishes with `vsce publish --azure-credential`, so no Marketplace
    secret is stored or rotated.
    1. In Microsoft Entra ID (portal.azure.com → App registrations), register an app such as
       `kete-extension-publish` (single tenant, no redirect URI, no client secret).
    2. Under **Certificates & secrets → Federated credentials → Add credential → GitHub Actions
       deploying Azure resources**: organization `kete-org`, repository `ketecode`, entity
       **Environment**, environment `registries` (subject
       `repo:kete-org/ketecode:environment:registries`). Only jobs in that environment, which admits
       only `kete-v*` tags, can sign in as the app.
    3. Give the app access to the publisher: add it to an Azure DevOps organization as a user
       (Organization settings → Users → Add, search the app's name; Stakeholder access is enough),
       then in <https://marketplace.visualstudio.com/manage> → publisher `ketecode` → **Members**,
       add it with the **Contributor** role.
    4. In the `registries` environment, add two **variables** (not secrets; they are identifiers):
       `AZURE_CLIENT_ID` (the app's Application (client) ID) and `AZURE_TENANT_ID` (Directory
       (tenant) ID).
  - **Open VSX:** the secret `OVSX_PAT`, an Open VSX access token (open-vsx.org → Settings → Access
    Tokens) of a member of the `ketecode` namespace. It expires: note the date and replace the
    secret before then.

  Only `kete-extension-publish.yml` uses the environment, and only when dispatched on a `kete-v*`
  tag, so no other branch, PR or workflow can sign in as the app or read the token.
- **Job image package.** The `image` job pushes with the workflow's own `GITHUB_TOKEN`
  (`packages: write`); no secret is needed. After the **first** tag's push, open the `kete-job`
  package (github.com/orgs/kete-org/packages), link it to `kete-org/ketecode`, and set its
  visibility to **public** so the platform's machines can pull it without credentials.
- **Harness step image package.** `harness-plugin-publish` pushes `ghcr.io/kete-org/kete-harness-plugin`
  the same way. After the **first** tag's push, open the `kete-harness-plugin` package, link it to
  `kete-org/ketecode`, grant this repository **Actions access** (Package settings → Manage Actions
  access → add `kete-org/ketecode` with the **Write** role; without it later pushes fail with
  `denied: permission_denied`), and set its visibility to **public** so Harness pipelines can pull it
  without registry credentials.

### Public distribution (one-time setup)

Everything below is created by a maintainer; no workflow creates repositories, secrets or settings.

1. **Repositories** (organization `kete-org`):
   - `kete-releases`, **public**, initialized with a README (copy
     `packages/kete-tools/distribution/releases-README.md`; each stable release refreshes it). It holds
     release files only, never source.
   - `homebrew-tap`, **public**, initialized with a README (`brew install kete-org/tap/kete` reads
     `Formula/kete.rb` from it).
   The `distribute` job pushes directly to both default branches: either leave them without branch
   protection, or allow the GitHub App below to bypass it.
2. **GitHub App** for the cross-repository publish: create an organization app (no webhook) with
   **Repository permissions → Contents: Read and write** and nothing else, install it on
   `kete-releases` and `homebrew-tap` **only**. In `kete-org/ketecode` → Settings → Environments,
   create **`distribution`** (deployment tags `kete-v*`) with the variable
   `KETE_DIST_APP_CLIENT_ID` (the app's client ID) and the secret `KETE_DIST_APP_PRIVATE_KEY` (a
   private key generated on the app's page). The `distribute` job mints a one-hour installation token
   scoped to those two repositories (`actions/create-github-app-token`). A fine-grained PAT with the
   same scope would also work but is tied to a person; the workflow expects the app.
3. **npm**: create the npm organization **`ketecode`** (the `@ketecode` scope), and an npm
   **granular access token** with read and write on the `@ketecode` scope (packages
   `@ketecode/cli` and `@ketecode/cli-*`), 2FA "bypass for automation" as npm requires for CI. Add it to
   `distribution` as **`NPM_TOKEN`**. Note its expiry. npm provenance is added automatically once
   `kete-org/ketecode` is public (npm refuses provenance from a private repository).
4. **Update signing key** (what `kete upgrade` verifies; ADR 0009). On a trusted machine:

   ```sh
   openssl genpkey -algorithm ed25519 -out kete-update-2026.pem
   openssl pkey -in kete-update-2026.pem -pubout -outform DER | tail -c 32 | base64
   ```

   Add the base64 public key to `packages/cli/src/kete/update-keys.json`
   (`{"id": "kete-update-2026", "publicKey": "<base64>"}`) in a PR; releases built after it can
   verify updates. Create the environment **`release-signing`** (deployment tags `kete-v*`) with the
   secret **`KETE_UPDATE_SIGNING_KEY`** (the whole PEM file). Keep an offline backup of the PEM; never
   commit it. The `sign` job refuses to sign with a key that isn't pinned.
   **Rotation:** add the next public key to `update-keys.json` and release; once that release is
   widespread, replace the secret with the next key. Builds accept any pinned key. If the key leaks,
   remove it from `update-keys.json`, release with a new key, and tell users of older builds to
   reinstall with the install script (they can't verify the new key).
5. **Switch it on:** repository variable (Settings → Secrets and variables → Actions → Variables)
   **`KETE_PUBLIC_DISTRIBUTION`** = `true`. The next tag runs `sign` and `distribute`; if anything above
   is missing, those jobs fail naming it, after the private release is already published (re-run the
   failed jobs once fixed).

## Cut a release

1. Make sure `main` is green (`kete-build`) and contains everything for the release.
2. Update `packages/kete-vscode/CHANGELOG.md` for the version (the Marketplace shows it) and
   merge that.
3. Tag `main` and push the tag:

   ```sh
   git tag kete-v0.2.0 && git push origin kete-v0.2.0
   ```

   Kete tags always start with `kete-`. This repository also holds upstream OpenCode's `vX.Y.Z`
   tags, which `upstream:sync` merges, so a bare `v0.2.0` is OpenCode's. Never push upstream's
   tags to `origin` (no `git push --tags`).
4. Watch **Actions → kete-release**. When it is green, the CLI release is live: the private
   release, the job image and, with public distribution on, `kete-releases`, Homebrew and npm.
   Then run the [manual checklist](#manual-checklist).
5. The extension is **not** published yet. When it should go out (at go-live, then for each stable
   release that changes it), [publish the extension](#publish-the-extension).

To check a build without publishing anything, run the workflow manually (Actions →
kete-release → Run workflow) with a tag name; `all_platforms` also smoke-tests macOS and Windows.
Manual runs never publish: the `image` job builds the job image and runs its end-to-end test, and
pushes nothing. From the command line:
`gh workflow run kete-release.yml --repo kete-org/ketecode --ref <branch> -f version=kete-v0.0.0-test.1`.

## Publish the extension

```sh
gh workflow run kete-extension-publish.yml --repo kete-org/ketecode --ref kete-v0.2.0 -f confirm=kete-v0.2.0
```

Run it **on the release tag** (`--ref`), not on `main`: the `registries` environment admits only
`kete-v*` tags, and the workflow refuses any other ref, a pre-release, a mismatched `confirm`, or a
tag whose GitHub Release is missing, a draft or a pre-release. It downloads that release's `.vsix`
files and `SHA256SUMS` (it builds nothing), checks the checksums, that there are exactly 8 packages
and that each carries the tag's version, then publishes to the VS Code Marketplace and Open VSX
(`--skip-duplicate`, so a re-run finishes a partial publish). Then run the extension part of the
[manual checklist](#manual-checklist).

**Open VSX is the channel for VS Code forks.** Windsurf, Cursor and VSCodium can't use the VS Code
Marketplace (its terms limit it to Microsoft's products); they install from Open VSX. The same
`.vsix` files go to both registries, so a release reaches the forks only once it is on Open VSX:
check its Open VSX page (<https://open-vsx.org/extension/ketecode/kete-code>) shows the version for
every platform. The extension's fork support (no hard-coded `vscode://` scheme or product name, no
proposed API, `engines.vscode` floor) is tested in `packages/kete-vscode/test/fork.test.ts`.

## Publish the JetBrains plugin

```sh
gh workflow run kete-jetbrains-publish.yml --repo kete-org/ketecode --ref kete-v0.3.0 -f confirm=kete-v0.3.0
```

**One-time setup:** a JetBrains Marketplace vendor (`Kete Code`) and the plugin listing
(`ai.ketecode.kete-code`), created by hand with the first upload of a released zip
(<https://plugins.jetbrains.com/plugin/add>); a Marketplace permanent token
(<https://plugins.jetbrains.com/author/me/tokens>); and the GitHub environment
**`jetbrains-marketplace`**, limited to the tag pattern `kete-v*` like `registries`, holding the
secret `JETBRAINS_MARKETPLACE_TOKEN`. Only `kete-jetbrains-publish.yml` uses it.

The workflow mirrors the extension's: run it on the release tag; it refuses any other ref, a
pre-release, a mismatched `confirm`, or a missing, draft or pre-release GitHub Release. It downloads
the release's `kete-code-jetbrains-<v>.zip` and `kete-code-jetbrains-<v>.sha256` (it builds nothing),
verifies the checksum, the 400 MB limit, the plugin id and version, and uploads the zip through the
Marketplace upload API (the token reaches curl on stdin). A version the Marketplace already has is
reported and skipped. New versions appear after JetBrains' review.

The checksum check guards only against a corrupted download. `kete-code-jetbrains-<v>.sha256` sits in
the same GitHub Release as the zip, so anyone able to replace the zip could replace it too; the
release's Ed25519-signed `SHA256SUMS` (on `kete-org/kete-releases`) lists the CLI archives and install
scripts, not the plugin zips, so the workflow can't check the zips against a signature. The zips'
integrity rests on who can write to this repository's releases; listing them in the signed
`SHA256SUMS` is a possible follow-up.

**The 400 MB Marketplace limit: decided, not built yet.** The Marketplace takes a single file of at
most 400 MB per version, and one `kete` binary is ~80–93 MB compressed, so a zip with all six
platforms (~520 MB) doesn't fit. Releases therefore attach one zip per OS (installable with
**Settings → Plugins → ⚙ → Install Plugin from Disk…**) and the all-platform zip only when it fits;
until it does, `kete-jetbrains-publish` stops with that explanation.

Go-live decision (pre-approved by the maintainer, 2026-10-05): the **Marketplace build carries no
binary and downloads the platform's `kete` on first use** from the public releases
(`kete-org/kete-releases`, the release matching the plugin's version). Before running it the plugin
verifies the release's `SHA256SUMS.sig` (Ed25519) against the pinned update key
(`packages/cli/src/kete/update-keys.json`, the key `kete upgrade` trusts) with Java's built-in
Ed25519 (`java.security.Signature`, `Ed25519`), then the archive's SHA-256 against that
`SHA256SUMS`, and refuses on any mismatch; no unverified binary ever runs. The per-OS zips with
bundled binaries stay on the GitHub Release for offline installs. **Implementation is a follow-up
that must land before the first Marketplace publish** (not part of the plugin's first PR); until
then `kete-jetbrains-publish` has nothing it can upload. Run the
[manual smoke checklist](../packages/kete-jetbrains/README.md#manual-smoke-checklist) before
publishing.

## What CI does (`.github/workflows/kete-release.yml`)

1. **build**: cross-compiles every CLI target on Linux, archives each with `LICENSE` and
   `NOTICE`, packages one extension per VS Code platform with its binary, writes `SHA256SUMS`,
   and verifies it. Then assembles the public file set (`distribute public`: every CLI archive,
   checked against that `SHA256SUMS`, plus `install.sh` and `install.ps1`, with a `SHA256SUMS` of
   exactly those files) as the `public-release` artifact; manual runs do this too.
2. **smoke** (Linux, macOS arm64, Windows x64): runs the binary with a throwaway home.
   `--version` shows the tag's version, `--help` names Kete Code and never OpenCode, and
   `debug paths` lists `kete` directories.
3. **extension**: there are exactly 8 `.vsix` files; each is packaged for its target, carries the
   tag's version and an executable `bin/kete` (`kete.exe` on Windows); the linux-x64 package's
   binary runs. **extension-e2e** (VS Code and VSCodium, in parallel): installs the linux-x64
   package into a pinned editor archive (SHA-256 checked) and runs the extension's end-to-end suite
   under xvfb (`packages/kete-vscode/script/e2e.ts --assert`: sign-in state, chat, editor context,
   sessions, review, MCP view, server restart, no server left behind). VSCodium stands in for the
   Open VSX forks; Windsurf and Cursor are covered by the manual checklist.
   **jetbrains**: builds the JetBrains plugin (`packages/kete-jetbrains`, Gradle wrapper validated)
   with the released binaries bundled: one zip per OS with both architectures, plus the all-platform
   zip if it is at most 400 MB; checks each zip's plugin id, version and executable binaries, runs
   the linux zip's `linux-x64` binary, and writes `kete-code-jetbrains-<v>.sha256`. The plugin's own
   build, unit tests and Plugin Verifier run on every pull request that touches it
   (`kete-jetbrains.yml`), not here.
4. **image**: the cloud job image (`packages/kete-job-image`) for `linux/amd64` and `linux/arm64`
   from the released `linux-x64` and `linux-arm64` archives (checksums verified first):
   `scripts/build.sh --arch amd64` builds the amd64 image and `scripts/e2e.sh` runs it end to end
   against the fake platform (no-agent, lifecycle, AC5: real npm, PyPI and crates.io installs
   through the proxy); `scripts/build.sh --arch arm64` builds the arm64 image under QEMU and a smoke
   test starts its binaries (the full e2e under emulation would cost too many minutes; the Go
   binaries are the same code cross-compiled). This job has read-only permissions; on tags it saves
   both images as an artifact with its SHA-256.
   **image-publish** (tags only; the only job with `packages: write` and `id-token: write`, no
   checkout, no build): verifies the artifact's checksum and loads it, pushes **those same tested
   images** (`:<tag>-linux-amd64`, `:<tag>-linux-arm64`), joins them into one index
   `ghcr.io/kete-org/kete-job:<tag>`, signs the index and both per-arch digests with **cosign
   keyless signing** (Sigstore; the certificate identity is
   `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/<tag>`,
   issuer `https://token.actions.githubusercontent.com`), and verifies each signature against that
   identity before anything is published (kete-code-platform ADR 0023 rule 17). Manual runs build
   and test both images and push or sign nothing.
   **harness-plugin-image** / **harness-plugin-publish**: the same pattern for the Harness step
   image (`packages/kete-harness-plugin`): read-only build of both architectures from the released
   `linux-x64` and `linux-arm64` `kete`, `scripts/smoke.sh --full` on amd64 (the image's entrypoint
   and `kete`, run mode against a fake model endpoint and cloud mode against a fake platform) and a
   smoke test on arm64 under QEMU; then, on tags only, push, index
   `ghcr.io/kete-org/kete-harness-plugin:<tag>`, cosign-sign and verify (same identity). `publish`
   adds the index digest and signing identity to the notes.
5. **kernel**: the microvm guest kernel (`packages/kete-job-host/kernel/`: Linux 6.18 LTS, the
   checked-in configurations, `check-config.sh` first) built with `build.sh` for amd64 and arm64
   (cross-compiled) on the amd64 runner, read-only permissions; saved as an artifact with its
   SHA-256. **kernel-publish** (tags only; `id-token: write`, no checkout, no build): verifies the
   artifact, signs each kernel with `cosign sign-blob` (a Sigstore bundle, same identity and issuer
   as the job images) and verifies each bundle against that identity (kete-code-platform ADR 0023
   rule 21). Manual runs build the kernels and sign nothing.
6. **publish** (tags only, after 2, 3, 4 and 5 pass):
   1. verifies `SHA256SUMS` and creates the GitHub Release as a **draft** with every file;
   2. records the job image: in the notes `Job image: ghcr.io/kete-org/kete-job@sha256:…` (the
      linux/amd64 image, as before), the index, the arm64 digest and the signing identity; the
      `kete-job-image.digest` asset (unchanged: the one linux/amd64 line **the platform's Fly
      adapter pins**, ADR 0019 rule 7, never a tag) and the `kete-job-image.digests` asset (keyed
      lines `index`, `linux/amd64`, `linux/arm64`, `cosign-identity`, `cosign-issuer`: what a
      self-hosted host agent allowlists and verifies, plus a `tested` line). The notes and the
      `.digests` asset state that linux/amd64 passed the full end-to-end test and linux/arm64 was
      smoke-tested under QEMU only. Since the multi-arch release, `kete-job-image.digest` is the
      **linux/amd64 platform-manifest digest** as resolved from the registry; it may differ in form
      from earlier releases' pin (which was the pushed image's repo digest) but names the same
      kind of single-platform image. Fly moves to the index only once a Fly staging machine is
      confirmed to start from it;
   3. attaches the guest kernels with their `.sha256` (`sha256:<hex>`, a host agent's
      `kernel_allowlist` entry) and `.sigstore.json` bundles, and names each digest in the notes;
   4. publishes the GitHub Release.

   No environment and no secrets: it writes only this repository's release, with the workflow
   token. Any failure stops the job with an error naming the step and leaves the release a draft;
   re-run the failed jobs after fixing the cause (the draft's files are replaced).
7. **sign** (tags only, public distribution on; environment `release-signing`; `contents: read`,
   `id-token: write`): checks out **only** `update-keys.json`, verifies the public files against their
   `SHA256SUMS` and that nothing unlisted is present, signs `SHA256SUMS` with
   `KETE_UPDATE_SIGNING_KEY` (refusing a key that isn't pinned, verifying the result: `SHA256SUMS.sig`),
   then with cosign keyless (`SHA256SUMS.sigstore.json`, verified against
   `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/<tag>`, issuer
   `https://token.actions.githubusercontent.com`).
8. **distribute** (tags only, public distribution on, after **publish** and **sign**; environment
   `distribution`; `contents: read`, `id-token: write` for npm provenance): runs `distribute verify`
   (exactly what `kete upgrade` checks, against the pinned keys) and `cosign verify-blob`; generates
   the notes, the formula and the npm packages with no credentials; then, with a GitHub App token
   scoped to `kete-releases` and `homebrew-tap`: creates the `kete-releases` release as a draft with
   every public file and publishes it (stable: marked latest); for stable tags, refreshes
   `kete-releases`' README and commits `Formula/kete.rb` to `homebrew-tap`; then publishes the npm
   platform packages and the launcher (`--access public`, `--tag latest|next`, `--provenance` only when
   this repository is public). Re-runnable: a published `kete-releases` release with the same
   `SHA256SUMS` is left alone (a different one is an error), unchanged repositories get no commit, and
   npm versions already published are skipped.

## What a release contains

| Asset                                                              | Contents                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `kete-<version>-<target>.tar.gz` (Linux) / `.zip` (macOS, Windows) | The `kete` binary with `LICENSE` and `NOTICE`             |
| `kete-code-<version>-<vscode target>.vsix`                         | The VS Code extension for one platform, with its binary   |
| `kete-code-jetbrains-<version>-<macos\|linux\|windows>.zip`         | The JetBrains plugin for one OS, with its arm64 and x64 binaries |
| `kete-code-jetbrains-<version>.zip` (only if ≤ 400 MB)              | The JetBrains plugin with every platform's binary          |
| `kete-code-jetbrains-<version>.sha256`                              | SHA-256 of the JetBrains plugin zips                       |
| `SHA256SUMS`                                                       | SHA-256 of every file above (`sha256sum -c SHA256SUMS`)  |
| `kete-job-image.digest`                                            | `ghcr.io/kete-org/kete-job@sha256:…`: the linux/amd64 job image Fly pins |
| `kete-job-image.digests`                                           | `index`, `linux/amd64`, `linux/arm64` image refs by digest and the cosign identity and issuer |
| `kete-guest-kernel-<release>-<amd64\|arm64>` (+ `.sha256`, `.sigstore.json`) | The self-hosted microvm guest kernel (amd64 `vmlinux`, arm64 `Image`), its allowlist digest and its cosign bundle |

The public release on `kete-org/kete-releases` has the CLI archives, `install.sh`, `install.ps1`,
and:

| Asset | Contents |
| --- | --- |
| `SHA256SUMS` | SHA-256 of every archive and both install scripts (not the private release's `SHA256SUMS`: no `.vsix`) |
| `SHA256SUMS.sig` | 64-byte Ed25519 signature of `SHA256SUMS` by a key pinned in `kete` (`packages/cli/src/kete/update-keys.json`); `kete upgrade` verifies it |
| `SHA256SUMS.sigstore.json` | cosign keyless bundle for `SHA256SUMS`, identity `…/kete-release.yml@refs/tags/kete-v<version>`; the install scripts verify it |

Homebrew and npm ship the x64 **baseline** builds (`darwin-x64-baseline`, `linux-x64-baseline`,
`linux-x64-baseline-musl`, `windows-x64-baseline`), as the extension does: a package manager can't
check for AVX2. The install scripts and `kete upgrade` pick the exact build (`kete upgrade` keeps the
running binary's own target, the `KETE_TARGET` build define).

CLI targets: `darwin-arm64`, `darwin-x64`, `darwin-x64-baseline`, `linux-arm64`,
`linux-arm64-musl`, `linux-x64`, `linux-x64-baseline`, `linux-x64-musl`,
`linux-x64-baseline-musl`, `windows-arm64`, `windows-x64`, `windows-x64-baseline`. `baseline`
builds are for CPUs without AVX2; `musl` builds are for Alpine and other musl distributions and need
the C++ runtime (`libstdc++`, `libgcc`), which Alpine doesn't install by default.

Extension targets and the binary each bundles: `darwin-arm64` (`darwin-arm64`), `darwin-x64`
(`darwin-x64-baseline`), `linux-x64` (`linux-x64-baseline`), `linux-arm64`, `alpine-x64`
(`linux-x64-baseline-musl`), `alpine-arm64` (`linux-arm64-musl`), `win32-x64`
(`windows-x64-baseline`), `win32-arm64`. VS Code and Open VSX pick the package for the user's
platform (on a remote host, the remote's). There is deliberately no universal package: the
extension never falls back to a `kete` on the `PATH`. The mapping lives in
`packages/kete-vscode/src/binary.ts`.

JetBrains plugin folders and the binary each bundles: `bin/darwin-arm64` (`darwin-arm64`),
`bin/darwin-x64` (`darwin-x64-baseline`), `bin/linux-x64` (`linux-x64-baseline`), `bin/linux-arm64`,
`bin/windows-x64` (`windows-x64-baseline`), `bin/windows-arm64`; the plugin picks the folder for the
IDE's OS and architecture (`packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/core/Binary.kt`)
and, like the extension, never runs a `kete` from the `PATH`. No musl build: JetBrains IDEs need glibc.

## Build locally

```sh
bun run --cwd packages/kete-tools release kete-v0.2.0             # every target (~20 min)
bun run --cwd packages/kete-tools release kete-v0.2.0 --single    # this machine only
```

Output goes to `packages/kete-tools/dist-release` (ignored by git). A full build needs about
3 GB of free disk space while it runs.

The public distribution steps, locally and without publishing (`--partial` accepts a `--single`
build; the formula needs every target):

```sh
bun run --cwd packages/kete-tools distribute public "$PWD/packages/kete-tools/dist-release" /tmp/kete-public --partial
bun run --cwd packages/kete-tools distribute npm /tmp/kete-public /tmp/kete-npm        # full builds only
bun run --cwd packages/kete-tools distribute homebrew /tmp/kete-public /tmp/kete.rb   # full builds only
bun run --cwd packages/kete-tools distribute notes /tmp/kete-public /tmp/notes.md
```

The job image locally (Colima on Apple silicon builds arm64; about 2 GB of disk with the test
layer): `(cd packages/cli && bun run build --target=kete-linux-arm64 --skip-web-ui)`, then
`bash packages/kete-job-image/scripts/build.sh` and
`bash packages/kete-job-image/scripts/e2e.sh kete-job:local` (`packages/kete-job-image/README.md`). To check an extension package in a real VS Code window
(isolated profile and Kete state): `bun run --cwd packages/kete-vscode e2e <path/to.vsix>`.

## Roll back

Nothing can be taken back from users who already installed a version, so the normal fix is a
**patch release**: fix on `main`, bump the patch version, tag `kete-vX.Y.Z+1`. Both registries
update installed extensions to it automatically.

When a version must stop spreading before a patch is ready:

- **GitHub:** edit the release back to a draft (or delete it) so the downloads disappear; keep the
  tag unless it was wrong, and never reuse a version number.
- **VS Code Marketplace:** a single version can't be unpublished; `vsce unpublish` removes the
  *whole extension* and its install count. Don't. Publish the patch instead.
- **Open VSX:** ask the Open VSX admins to remove the version
  (<https://github.com/EclipseFdn/open-vsx.org/issues>), and publish the patch as well.
- **Job image:** the platform pins a digest, so a bad image keeps running only until the platform
  pins the patch release's digest; a pushed tag can be deleted from the package's page, but the
  digest a platform already pinned must be replaced there.
- **A bad tag that hasn't published yet** (the job failed): delete the draft release and the tag
  (`git push --delete origin kete-vX.Y.Z`), fix, and tag again.
- **kete-releases:** edit the release back to a draft (the install scripts and `kete upgrade` then
  resolve the previous release as latest); never reuse a version number. Users who already upgraded
  keep the version; ship a patch.
- **Homebrew:** revert the commit in `homebrew-tap` (or wait for the patch release's formula).
- **npm:** `npm deprecate @ketecode/cli@X.Y.Z "<reason>"` (and the platform packages); `npm unpublish`
  works only within 72 hours and blocks the version number forever. Prefer the patch.
- **Update signing key compromised:** see step 4 of
  [Public distribution](#public-distribution-one-time-setup).

## Installing

Users install from the public releases (`packages/kete-tools/distribution/releases-README.md` is
the public README, copied to `kete-org/kete-releases` on each stable release):

- **macOS and Linux:** `curl -fsSL https://github.com/kete-org/kete-releases/releases/latest/download/install.sh | sh`
  (`--version X.Y.Z`, `--install-dir DIR`, default `~/.local/bin`). Detects macOS/Linux, x64/arm64
  (Rosetta → arm64), glibc/musl and AVX2 (else baseline). Verifies the cosign (2.4 or later) signature of
  `SHA256SUMS` for that exact tag, then the archive's checksum; without cosign it refuses unless
  given `--checksum-only` (and then warns that only the checksum was checked). Never sudo, never
  edits shell profiles; prints a `PATH` hint. On Alpine run `apk add libstdc++ libgcc` first: the
  script runs the new binary before installing it and, on musl, says so if that runtime is missing.
- **Windows:** `irm https://github.com/kete-org/kete-releases/releases/latest/download/install.ps1 | iex`
  (`-Version`, `-InstallDir`, `-ChecksumOnly`, `-NoModifyPath` via
  `& ([scriptblock]::Create((irm …/install.ps1))) -Version X.Y.Z`). Installs into
  `%LOCALAPPDATA%\Programs\kete\bin` and adds it to the user `PATH`. Same verification.
- **Environment variables** (both scripts; a flag or parameter wins): `KETE_VERSION`,
  `KETE_INSTALL_DIR`, and on Windows `KETE_NO_MODIFY_PATH=1` (accepted and ignored by `install.sh`,
  which never edits `PATH`). E.g. `curl -fsSL …/install.sh | KETE_VERSION=0.2.0 sh` or
  `$env:KETE_VERSION = "0.2.0"; irm …/install.ps1 | iex`.
- **Short URLs:** `https://ketecode.ai/cli/install` and `https://ketecode.ai/cli/install.ps1`
  redirect to the latest release's scripts above (the website repo, `kete-org/kete-code-website`,
  `docs/distribution/cli-installer.md`). They serve nothing themselves, so the scripts and their
  verification live only here; renaming the scripts or moving `kete-releases` needs the website's
  redirects changed too.
- **Homebrew:** `brew install kete-org/tap/kete`. **npm:** `npm install -g @ketecode/cli`.
- **Installer smoke test:** `kete-installer-smoke.yml` runs these public commands through
  `ketecode.ai/cli/install{,.ps1}` with cosign on Linux (glibc), Alpine (musl), macOS and Windows
  (PowerShell 7 and 5.1) after every successful release, on pull requests that change it, and by
  hand for any version (`gh workflow run kete-installer-smoke.yml --repo kete-org/ketecode -f
  version=0.2.0`). It checks the installed `kete --version` and, on Windows, the user `PATH`.
- **Manually:** download the archive for your platform, verify it (the release's notes give the
  `cosign verify-blob` command), unpack it, and put `kete` on your `PATH`. macOS builds aren't
  signed or notarized yet, so Gatekeeper blocks the first run of an archive downloaded with a browser
  (allow it in System Settings → Privacy & Security, or `xattr -d com.apple.quarantine kete`);
  the install script's `curl` download isn't quarantined.
- **VS Code:** install **Kete Code** from the Marketplace (VS Code) or Open VSX (Windsurf, Cursor,
  VSCodium), or `code --install-extension kete-code-<version>-<target>.vsix` (`windsurf`, `cursor`,
  `codium` likewise). The extension carries its own
  `kete`.
- **Updates:** `kete upgrade [version]` for script and manual installs: it reads the latest release
  from `kete-releases`, verifies `SHA256SUMS.sig` against the key pinned in the binary and the
  archive's checksum, checks the new binary runs, and swaps it in atomically; it refuses downgrades
  and reinstalls. Homebrew (`brew upgrade kete`) and npm (`npm install -g @ketecode/cli@latest`)
  installs are told to use their manager; the extension's own `kete` updates with the extension. A
  build without a pinned key reports updates as unavailable. The TUI's update notice follows the
  `autoupdate` config (`notify` by default; `true` installs automatically, script installs only;
  `false` or `KETE_DISABLE_AUTOUPDATE=1` turns the check off).

## Manual checklist

Run after each stable release, on at least one macOS and one Windows or Linux machine. Use a
fresh profile so a previous install doesn't mask problems: `code --profile kete-release-check`
(VS Code), or a separate `--user-data-dir` for Windsurf, Cursor and VSCodium.

For each editor (VS Code from the Marketplace; Windsurf, Cursor and VSCodium from Open VSX; the
extension README's "Using Kete Code in Windsurf, Cursor or VSCodium" adds the fork-specific checks):

- [ ] Search for **Kete Code** in the Extensions view; the listing shows the icon, the README and
      the new version. Install it.
- [ ] The installed package is for this platform: `Extensions → Kete Code → ⋯ → Show in Folder`
      (or the extensions directory) has `bin/kete` (`kete.exe` on Windows). Cursor has installed
      the universal package in the past; this must be the platform one.
- [ ] Open a folder that is a git repository. The status bar shows `Kete · Signed out`.
- [ ] **Sign in to Kete Code** from the status bar; the browser opens the portal; approve. The
      status bar shows your organization; `kete whoami` in a terminal agrees.
- [ ] Open the chat. It opens a session for the folder; the status bar shows the server running.
- [ ] Choose a Kete gateway model and ask for a small change to a file (for example "add a
      comment to the top of README.md"). The agent edits the file.
- [ ] Open the review, select the changed file: the editor shows its diff against HEAD.
- [ ] Select some lines, **Send Selection to Chat**: they appear as context in the prompt.
- [ ] **Restart Server** from the status bar menu: the chat reconnects.
- [ ] **Sign Out**: the status bar shows `Signed out`; no warning about revocation.
- [ ] Close the window: no `kete serve` process is left running.

Once per release, where available: Remote-SSH, WSL and Dev Containers (the extension installs on
the remote; sign-in and chat work), and the terminal commands (`Cmd+Esc` / `Ctrl+Esc`).

Record the results (editor, version, OS, pass or the failure) in the release's notes.
