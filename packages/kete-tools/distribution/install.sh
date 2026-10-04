#!/bin/sh
# Kete Code installer for macOS and Linux (ADR 0009, docs/release.md "Installing").
#
#   curl -fsSL https://github.com/kete-org/kete-releases/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.2.0 --install-dir ~/bin
#   curl -fsSL .../install.sh | KETE_VERSION=0.2.0 sh
#
# Downloads the kete archive for this machine from the public releases repository, verifies the
# cosign (Sigstore keyless) signature on SHA256SUMS against the Kete release workflow's identity for
# that exact tag, verifies the archive against SHA256SUMS, and installs the binary into a directory
# you own (default ~/.local/bin). It never uses sudo and never edits your shell profile.
#
# Options:
#   --version X.Y.Z[-pre]  install this version (default: the latest stable release)
#   --install-dir DIR      install into DIR (default: $KETE_INSTALL_DIR or ~/.local/bin)
#   --checksum-only        skip the signature check when cosign isn't installed. Weaker: it proves
#                          the archive matches the release's SHA256SUMS, not who published it.
#   -h, --help
#
# Environment (a flag wins over its variable): KETE_VERSION, KETE_INSTALL_DIR. KETE_NO_MODIFY_PATH
# is accepted for parity with install.ps1 and changes nothing: this script never edits your PATH.
# KETE_RELEASES_URL overrides the releases repository (a mirror, or tests); the signature identity
# never changes.
set -eu

releases="${KETE_RELEASES_URL:-https://github.com/kete-org/kete-releases}"
identity_prefix="https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v"
issuer="https://token.actions.githubusercontent.com"
version="${KETE_VERSION:-}"
install_dir="${KETE_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}"
checksum_only=0

say() { printf '%s\n' "$*" >&2; }
fail() {
  say "kete install: $*"
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Install Kete Code (kete) from https://github.com/kete-org/kete-releases.

Usage: install.sh [--version X.Y.Z] [--install-dir DIR] [--checksum-only]

  --version X.Y.Z[-pre]  install this version (default: $KETE_VERSION or the latest stable release)
  --install-dir DIR      install into DIR (default: $KETE_INSTALL_DIR or ~/.local/bin)
  --checksum-only        skip the signature check when cosign isn't installed (weaker: proves the
                         archive matches SHA256SUMS, not who published it)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || fail "--version needs a value"
      version="$2"
      shift 2
      ;;
    --install-dir)
      [ $# -ge 2 ] || fail "--install-dir needs a value"
      install_dir="$2"
      shift 2
      ;;
    --checksum-only)
      checksum_only=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done
version="${version#v}"

is_version() {
  printf '%s' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$'
}

# HTTPS only, except a loopback mirror (tests).
case "$releases" in
  https://*) proto_flags="--proto =https --tlsv1.2" ;;
  http://127.0.0.1:* | http://localhost:*) proto_flags="" ;;
  *) fail "KETE_RELEASES_URL must be an https:// URL" ;;
esac

if command -v curl >/dev/null 2>&1; then
  # shellcheck disable=SC2086 # proto_flags is a deliberate word list
  download() { curl -fsSL $proto_flags --retry 3 --connect-timeout 20 --max-time 900 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -q --tries=3 --timeout=60 -O "$2" "$1"; }
else
  fail "curl or wget is required"
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  else
    fail "sha256sum, shasum or openssl is required to verify the download"
  fi
}

# The release target for this machine (packages/cli/script/build.ts): <os>-<arch>[-baseline][-musl].
detect_target() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) fail "on Windows, use install.ps1 (see the releases page)" ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported CPU architecture: $(uname -m)" ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple silicon: install the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  baseline=""
  if [ "$arch" = x64 ]; then
    if [ "$os" = darwin ]; then
      [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)" = 1 ] || baseline="-baseline"
    else
      grep -qw avx2 /proc/cpuinfo 2>/dev/null || baseline="-baseline"
    fi
  fi
  musl=""
  if [ "$os" = linux ]; then
    if ldd --version 2>&1 | grep -qi musl; then
      musl="-musl"
    else
      for loader in /lib/ld-musl-*.so.1; do
        [ -e "$loader" ] && musl="-musl"
      done
    fi
  fi
  target="$os-$arch$baseline$musl"
  if [ "$os" = linux ]; then extension=tar.gz; else extension=zip; fi
}

detect_target

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t kete-install)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "$version" ]; then
  download "$releases/releases/latest/download/SHA256SUMS" "$tmp/latest" || fail "could not reach $releases"
  version="$(sed -n 's/^[0-9a-f]\{64\}  kete-\(.*\)-'"$target"'\.'"$extension"'$/\1/p' "$tmp/latest" | head -n 1)"
  [ -n "$version" ] || fail "the latest release has no build for $target"
fi
is_version "$version" || fail "not a release version: $version"

base="$releases/releases/download/kete-v$version"
archive="kete-$version-$target.$extension"
say "Installing Kete Code $version ($target) into $install_dir"

download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "release kete-v$version not found at $releases"

if [ "$checksum_only" = 1 ]; then
  say "WARNING: --checksum-only: the signature on SHA256SUMS is NOT verified. This only proves the"
  say "archive matches the release's checksum file, not that the Kete release workflow published it."
else
  command -v cosign >/dev/null 2>&1 || fail "cosign (2.4 or later) is required to verify the release signature.
Install it (https://docs.sigstore.dev/cosign/system_config/installation/, e.g. brew install cosign),
or rerun with --checksum-only to verify only the SHA-256 checksum (weaker)."
  download "$base/SHA256SUMS.sigstore.json" "$tmp/SHA256SUMS.sigstore.json" || fail "the release has no SHA256SUMS signature"
  cosign verify-blob \
    --bundle "$tmp/SHA256SUMS.sigstore.json" \
    --certificate-identity "$identity_prefix$version" \
    --certificate-oidc-issuer "$issuer" \
    "$tmp/SHA256SUMS" >/dev/null 2>&1 ||
    fail "the SHA256SUMS signature does not verify against $identity_prefix$version: refusing to install (cosign older than 2.4 can't read the bundle format)"
  say "Verified the SHA256SUMS signature ($identity_prefix$version)"
fi

expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
if [ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" != 1 ] || ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
  fail "SHA256SUMS has no single entry for $archive"
fi

download "$base/$archive" "$tmp/$archive" || fail "could not download $archive"
actual="$(sha256 "$tmp/$archive")"
[ "$actual" = "$expected" ] || fail "checksum mismatch for $archive (expected $expected, got $actual): refusing to install"

mkdir -p "$tmp/unpacked"
if [ "$extension" = tar.gz ]; then
  tar -xzf "$tmp/$archive" -C "$tmp/unpacked" kete
elif command -v unzip >/dev/null 2>&1; then
  unzip -q "$tmp/$archive" kete -d "$tmp/unpacked"
else
  tar -xf "$tmp/$archive" -C "$tmp/unpacked" kete
fi
[ -f "$tmp/unpacked/kete" ] || fail "$archive has no kete binary"
chmod 755 "$tmp/unpacked/kete"
# Check the new binary runs here before it replaces anything.
installed="$("$tmp/unpacked/kete" --version 2>"$tmp/run.err" || true)"
case "$installed" in
  *"$version"*) ;;
  *)
    # musl builds link the C++ runtime dynamically; Alpine doesn't install it by default.
    if [ -n "$musl" ] && grep -Eq 'lib(stdc\+\+|gcc_s)' "$tmp/run.err"; then
      fail "kete needs the C++ runtime libraries on this system (Alpine: apk add libstdc++ libgcc); nothing was installed"
    fi
    fail "the downloaded kete doesn't run on this machine (got: ${installed:-$(head -n 1 "$tmp/run.err")}); nothing was installed"
    ;;
esac

mkdir -p "$install_dir" 2>/dev/null || fail "can't create $install_dir; choose another with --install-dir"
[ -w "$install_dir" ] || fail "can't write to $install_dir; choose a directory you own with --install-dir (this installer never uses sudo)"
# Copy beside the destination, then rename: an interrupted install never leaves a partial kete.
cp "$tmp/unpacked/kete" "$install_dir/.kete-install.$$"
chmod 755 "$install_dir/.kete-install.$$"
mv -f "$install_dir/.kete-install.$$" "$install_dir/kete"

say "Installed $installed at $install_dir/kete"

existing="$(command -v kete 2>/dev/null || true)"
case ":$PATH:" in
  *":$install_dir:"*)
    if [ -n "$existing" ] && [ "$existing" != "$install_dir/kete" ]; then
      say "Note: another kete comes first on your PATH: $existing"
    fi
    ;;
  *)
    say ""
    say "$install_dir is not on your PATH. Add it, for example:"
    say "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.profile   # or ~/.zshrc, ~/.bashrc"
    ;;
esac
say "Update later with: kete upgrade"
