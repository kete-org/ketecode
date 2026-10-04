# Kete Code releases

Downloads of `kete`, the Kete Code AI coding agent, for macOS, Linux and Windows. This repository
holds release files only; each [release](https://github.com/kete-org/kete-releases/releases) is
published by the Kete Code release workflow.

## Install

**macOS and Linux**

```sh
curl -fsSL https://github.com/kete-org/kete-releases/releases/latest/download/install.sh | sh
```

Installs into `~/.local/bin` (change it with `--install-dir DIR`; a specific version with
`--version X.Y.Z`: `curl -fsSL …/install.sh | sh -s -- --version 0.2.0`). The script needs
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 2.4 or later (`brew install cosign`) to
verify the release signature, and refuses to install without it unless you pass `--checksum-only`
(weaker: it then checks only the SHA-256 checksum). It never uses `sudo` and never edits your shell
profile; it tells you if the directory isn't on your `PATH`.

**Windows** (PowerShell)

```powershell
irm https://github.com/kete-org/kete-releases/releases/latest/download/install.ps1 | iex
```

Installs into `%LOCALAPPDATA%\Programs\kete\bin` and adds it to your user `PATH`. Options
(`-Version`, `-InstallDir`, `-ChecksumOnly`, `-NoModifyPath`) need the script-block form:
`& ([scriptblock]::Create((irm …/install.ps1))) -Version 0.2.0`. cosign: `winget install sigstore.cosign`.

**Homebrew** (macOS, Linux)

```sh
brew install kete-org/tap/kete
```

**npm**

```sh
npm install -g @ketecode/cli
```

**Manually:** download the archive for your platform from a release, check it against `SHA256SUMS`,
unpack it and put `kete` on your `PATH`. `baseline` builds are for x64 CPUs without AVX2; `musl`
builds are for Alpine and other musl distributions, and need the C++ runtime installed first
(Alpine: `apk add libstdc++ libgcc`).

## Update

- Installed with the script or manually: `kete upgrade` (or `kete upgrade 0.3.0`).
- Homebrew: `brew upgrade kete`. npm: `npm install -g @ketecode/cli@latest`.

`kete upgrade` installs a release only after verifying the Ed25519 signature on its `SHA256SUMS`
(`SHA256SUMS.sig`) against a key built into `kete`, and the archive's checksum. It never downgrades,
and it leaves Homebrew and npm installs to their package manager.

## Verify a release yourself

Every release has `SHA256SUMS`, its cosign keyless signature bundle `SHA256SUMS.sigstore.json`, and
`SHA256SUMS.sig` (the signature `kete upgrade` checks).

```sh
version=0.2.0
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v$version" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS   # macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
```

## License

Kete Code is built on [OpenCode](https://github.com/anomalyco/opencode) (MIT). Each archive contains
`LICENSE` and `NOTICE`.
