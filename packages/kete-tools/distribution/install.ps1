# Kete Code installer for Windows (ADR 0009, docs/release.md "Installing").
#
#   irm https://github.com/kete-org/kete-releases/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://github.com/kete-org/kete-releases/releases/latest/download/install.ps1))) -Version 0.2.0
#
# Downloads the kete archive for this machine from the public releases repository, verifies the
# cosign (Sigstore keyless) signature on SHA256SUMS against the Kete release workflow's identity for
# that exact tag, verifies the archive against SHA256SUMS, and installs kete.exe into a directory you
# own (default %LOCALAPPDATA%\Programs\kete\bin), adding it to your user PATH unless -NoModifyPath.
# It never asks for administrator rights.
#
#   -Version X.Y.Z[-pre]  install this version (default: the latest stable release)
#   -InstallDir DIR       install into DIR
#   -ChecksumOnly         skip the signature check when cosign isn't installed. Weaker: it proves the
#                         archive matches the release's SHA256SUMS, not who published it.
#   -NoModifyPath         don't add the install directory to your user PATH
#
# Environment (a parameter wins over its variable): KETE_VERSION, KETE_INSTALL_DIR, and
# KETE_NO_MODIFY_PATH=1 (or true) for -NoModifyPath. So `$env:KETE_VERSION = "0.2.0"; irm … | iex` works.
# KETE_RELEASES_URL overrides the releases repository (a mirror, or tests); the signature identity
# never changes.
param(
  [string]$Version = "",
  [string]$InstallDir = "",
  [switch]$ChecksumOnly,
  [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
$ProgressPreference = "SilentlyContinue"

if (-not $Version -and $env:KETE_VERSION) { $Version = $env:KETE_VERSION }
if (-not $NoModifyPath -and $env:KETE_NO_MODIFY_PATH -match '^(1|true|yes)$') { $NoModifyPath = [switch]$true }

$Releases = if ($env:KETE_RELEASES_URL) { $env:KETE_RELEASES_URL } else { "https://github.com/kete-org/kete-releases" }
$IdentityPrefix = "https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v"
$Issuer = "https://token.actions.githubusercontent.com"
$VersionPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$'

function Fail([string]$Message) {
  throw "kete install: $Message"
}

if (-not ($Releases -match '^https://' -or $Releases -match '^http://(127\.0\.0\.1|localhost):')) {
  Fail "KETE_RELEASES_URL must be an https:// URL"
}
if (-not $InstallDir) {
  $InstallDir = if ($env:KETE_INSTALL_DIR) { $env:KETE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\kete\bin" }
}

# Windows PowerShell 5.1 may default to TLS 1.0.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-File([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -TimeoutSec 900
}

# The release target: windows-<arch>[-baseline] (packages/cli/script/build.ts).
$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($osArch) {
  "X64" { $arch = "x64" }
  "Arm64" { $arch = "arm64" }
  default { Fail "unsupported CPU architecture: $osArch" }
}
$baseline = ""
if ($arch -eq "x64") {
  # PF_AVX2_INSTRUCTIONS_AVAILABLE (40). If it can't be determined, the baseline build is the safe choice.
  $avx2 = $false
  try {
    Add-Type -Namespace KeteInstall -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);'
    $avx2 = [KeteInstall.Cpu]::IsProcessorFeaturePresent(40)
  } catch {
    $avx2 = $false
  }
  if (-not $avx2) { $baseline = "-baseline" }
}
$target = "windows-$arch$baseline"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kete-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $Version = $Version.TrimStart("v")
  if (-not $Version) {
    $latest = Join-Path $tmp "latest"
    Get-File "$Releases/releases/latest/download/SHA256SUMS" $latest
    $escaped = [regex]::Escape($target)
    foreach ($line in Get-Content $latest) {
      if ($line -match "^[0-9a-f]{64}  kete-(.+)-$escaped\.zip$") { $Version = $Matches[1]; break }
    }
    if (-not $Version) { Fail "the latest release has no build for $target" }
  }
  if ($Version -notmatch $VersionPattern) { Fail "not a release version: $Version" }

  $base = "$Releases/releases/download/kete-v$Version"
  $archive = "kete-$Version-$target.zip"
  Write-Host "Installing Kete Code $Version ($target) into $InstallDir"
  $sums = Join-Path $tmp "SHA256SUMS"
  Get-File "$base/SHA256SUMS" $sums

  if ($ChecksumOnly) {
    Write-Warning "-ChecksumOnly: the signature on SHA256SUMS is NOT verified. This only proves the archive matches the release's checksum file, not that the Kete release workflow published it."
  } else {
    $cosign = Get-Command cosign -ErrorAction SilentlyContinue
    if (-not $cosign) {
      Fail "cosign (2.4 or later) is required to verify the release signature. Install it (https://docs.sigstore.dev/cosign/system_config/installation/, e.g. winget install sigstore.cosign), or rerun with -ChecksumOnly to verify only the SHA-256 checksum (weaker)."
    }
    $bundle = Join-Path $tmp "SHA256SUMS.sigstore.json"
    Get-File "$base/SHA256SUMS.sigstore.json" $bundle
    # Windows PowerShell 5.1 turns a native command's stderr into an error under "Stop"; cosign
    # reports success on stderr. The exit code decides.
    $ErrorActionPreference = "Continue"
    & $cosign.Source verify-blob --bundle $bundle --certificate-identity "$IdentityPrefix$Version" --certificate-oidc-issuer $Issuer $sums *> $null
    $verified = $LASTEXITCODE -eq 0
    $ErrorActionPreference = "Stop"
    if (-not $verified) { Fail "the SHA256SUMS signature does not verify against $IdentityPrefix${Version}: refusing to install (cosign older than 2.4 can't read the bundle format)" }
    Write-Host "Verified the SHA256SUMS signature ($IdentityPrefix$Version)"
  }

  $entries = @(Get-Content $sums | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($archive))$" })
  if ($entries.Count -ne 1) { Fail "SHA256SUMS has no single entry for $archive" }
  $expected = $entries[0].Substring(0, 64)

  $zip = Join-Path $tmp $archive
  Get-File "$base/$archive" $zip
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Fail "checksum mismatch for $archive (expected $expected, got $actual): refusing to install" }

  $unpacked = Join-Path $tmp "unpacked"
  Expand-Archive -Path $zip -DestinationPath $unpacked
  $exe = Join-Path $unpacked "kete.exe"
  if (-not (Test-Path -PathType Leaf $exe)) { Fail "$archive has no kete.exe" }

  # Check the new binary runs here before it replaces anything.
  $ErrorActionPreference = "Continue"
  $installed = (& $exe --version 2>$null | Out-String).Trim()
  $ErrorActionPreference = "Stop"
  if ($installed -notmatch [regex]::Escape($Version)) { Fail "the downloaded kete.exe doesn't run on this machine (got: $installed); nothing was installed" }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $destination = Join-Path $InstallDir "kete.exe"
  $staged = Join-Path $InstallDir (".kete-install-" + [System.Guid]::NewGuid().ToString("N") + ".exe")
  Copy-Item $exe $staged
  # A running kete.exe can't be overwritten, but it can be renamed aside.
  $aside = $null
  if (Test-Path $destination) {
    $aside = "$destination." + [System.Guid]::NewGuid().ToString("N").Substring(0, 8) + ".old"
    Move-Item $destination $aside
  }
  try {
    Move-Item $staged $destination
  } catch {
    if ($aside) { Move-Item $aside $destination }
    Remove-Item -Force -ErrorAction SilentlyContinue $staged
    throw
  }
  if ($aside) { Remove-Item -Force -ErrorAction SilentlyContinue $aside }

  Write-Host "Installed $installed at $destination"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $onPath = @(($userPath -split ";") | Where-Object { $_ -and ($_.TrimEnd("\") -ieq $InstallDir.TrimEnd("\")) }).Count -gt 0
  if (-not $onPath) {
    if ($NoModifyPath) {
      Write-Host "$InstallDir is not on your PATH; add it to run kete from any terminal."
    } else {
      $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
      [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
      Write-Host "Added $InstallDir to your user PATH. Open a new terminal to use kete."
    }
  }
  Write-Host "Update later with: kete upgrade"
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
