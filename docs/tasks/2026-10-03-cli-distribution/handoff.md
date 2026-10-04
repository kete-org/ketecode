# Handoff: Public CLI distribution: releases repo, install scripts, Homebrew, npm, verified kete upgrade

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-04 build agent

**Done:** spec (approved), ADR 0009, plan, build, docs and cards; nothing committed, pushed,
tagged or published, no repository settings changed. Results and checks: `result.md`.

**Decisions taken within the brief** (ADR 0009 has the reasoning):
- Extension publishing: a separate manual workflow, `kete-extension-publish.yml`, dispatched **on**
  a released stable tag with `-f confirm=<tag>` (not an input on `kete-release.yml`, not a second
  tag pattern): it reuses the already-built, checked `.vsix` files of that release and needs no
  rebuild. `kete-release.yml`'s `publish` job no longer uses the `registries` environment at all.
- `kete upgrade` verifies a detached **Ed25519** signature (`SHA256SUMS.sig`) with a key pinned in
  the binary (`packages/cli/src/kete/update-keys.json`), not Sigstore: `sigstore` is only a
  transitive dependency (via `pacote`), is large, and needs the Sigstore TUF repository online at
  verification time. The install scripts verify the cosign keyless bundle. Both signatures come
  from one tag-only `sign` job.
- Cross-repo credential: a **GitHub App** installation token (`actions/create-github-app-token`
  v3.2.0, pinned), variable `KETE_DIST_APP_CLIENT_ID` + secret `KETE_DIST_APP_PRIVATE_KEY`, scoped
  to `kete-releases` and `homebrew-tap` with contents: write. Secrets live in environments
  `distribution` (app key, `NPM_TOKEN`) and `release-signing` (`KETE_UPDATE_SIGNING_KEY`).
- Public distribution is gated by the repository variable `KETE_PUBLIC_DISTRIBUTION=true`, so
  releases keep working (private release + job image) until the setup below exists.
- Homebrew and npm ship the x64 **baseline** builds (as the VS Code extension does); install
  scripts and `kete upgrade` choose the exact build (`kete upgrade` keeps its own `KETE_TARGET`).
- `autoupdate: true` keeps upstream's meaning (the background check installs) but only for
  direct (script/manual) installs; Homebrew/npm installs only get the notice. Default `notify`.
- `install.ps1` adds its directory to the **user** PATH by default (`-NoModifyPath` opts out);
  `install.sh` never edits shell profiles (prints a hint).

**For the user to confirm (contract/security beyond the brief):**
1. **npm provenance can't be produced while `kete-org/ketecode` is private** (npm rejects
   provenance from private repositories). Implemented: `--provenance` is added automatically when
   the repository is public; until then packages publish without it (with a log notice).
   Alternative not built: run the npm publish from a workflow inside the public `kete-releases`
   repository, which would attest that repository's workflow instead.
2. **Root `README.md` not edited.** It is upstream OpenCode's README, untouched by Kete so far;
   adding a Kete section would be a persistent upstream patch inside an OpenCode-branded page. The
   public install README is `packages/kete-tools/distribution/releases-README.md` (copied into
   `kete-releases` on each stable release) plus `docs/release.md` "Installing". Say if you want a
   Kete README in this repository too.
3. **Existing installs can't self-update into this.** Binaries released before this change have
   the disabled updater, and binaries built before a key is pinned in `update-keys.json` report
   "unavailable". The first release built **after** the key is pinned is the first that
   `kete upgrade` works from; earlier users reinstall once with the script.

**What you must create** (nothing here was created):
1. Repository `kete-org/kete-releases` — **public**, initialized with a README (use
   `packages/kete-tools/distribution/releases-README.md`).
2. Repository `kete-org/homebrew-tap` — **public**, initialized with a README.
3. GitHub App (organization-owned, no webhook): Repository permissions → **Contents: Read and
   write** only; install it on `kete-releases` and `homebrew-tap` only.
4. Environment **`distribution`** on `kete-org/ketecode` (deployment tags `kete-v*`): variable
   `KETE_DIST_APP_CLIENT_ID` (the app's client ID), secret `KETE_DIST_APP_PRIVATE_KEY` (an app
   private key), secret `NPM_TOKEN`.
5. npm organization **`ketecode`** and a granular access token with read/write on `@ketecode/*`
   (automation / 2FA bypass for CI) → `NPM_TOKEN` above.
6. Update signing key: `openssl genpkey -algorithm ed25519 -out kete-update-2026.pem`; public key
   `openssl pkey -in kete-update-2026.pem -pubout -outform DER | tail -c 32 | base64` → a PR adding
   `{"id": "kete-update-2026", "publicKey": "<base64>"}` to `packages/cli/src/kete/update-keys.json`;
   the PEM → secret **`KETE_UPDATE_SIGNING_KEY`** in a new environment **`release-signing`**
   (deployment tags `kete-v*`). Keep an offline backup; never commit the PEM.
7. Environment **`registries`**: change its deployment rule to the tag pattern **`kete-v*`** (it
   refused rc tags). It is now used only by `kete-extension-publish.yml` (secrets `VSCE_PAT`,
   `OVSX_PAT` unchanged).
8. When 1–6 exist: repository variable **`KETE_PUBLIC_DISTRIBUTION`** = `true`.

## 2026-10-04 build agent (after review)
Reviewer findings fixed (see `result.md`). `install.ps1` has never been executed: run it once on
Windows PowerShell 5.1 and 7 (with and without cosign, `-ChecksumOnly`) before announcing it.
