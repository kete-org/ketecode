#!/usr/bin/env bun
// Public distribution of a Kete Code release (ADR 0009, docs/release.md). Builds what the
// kete-release workflow's tag-only jobs publish; publishes nothing itself.
//
//   distribute public <release-dir> <out-dir> [--partial]   the public file set + its SHA256SUMS
//   distribute homebrew <public-dir> <out-file>             Formula/kete.rb for kete-org/homebrew-tap
//   distribute npm <public-dir> <out-dir> [--repository <url>]
//                                                           @ketecode/cli and its platform packages
//   distribute notes <public-dir> <out-file>                release notes for kete-org/kete-releases
//   distribute verify <public-dir> -                         checks a signed public release before it
//                                                           is published: SHA256SUMS.sig against the
//                                                           pinned keys (as kete upgrade will), every
//                                                           file against SHA256SUMS, nothing unlisted
//
// The public set is every CLI archive (never the .vsix files: extension publishing is a separate,
// explicit step) plus install.sh and install.ps1, with a SHA256SUMS of exactly those files. The
// release workflow signs that SHA256SUMS twice: cosign keyless (SHA256SUMS.sigstore.json, what the
// install scripts verify) and Ed25519 (SHA256SUMS.sig, what `kete upgrade` verifies).
// --partial accepts a release with only some targets (a local `release --single` dry run).

import fs from "node:fs"
import path from "node:path"
import { ReleaseVerify, type Target } from "../../cli/src/kete/release-verify"
import { Brand } from "@opencode/util/kete/brand"
import { run } from "./lib"
import { checksums } from "./release"

const distribution = path.join(import.meta.dir, "../distribution")
export const scripts = ["install.sh", "install.ps1"] as const

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/** The public files of a built release, each archive checked against the release's own SHA256SUMS. */
export function publicFiles(releaseDir: string, options: { partial?: boolean; scriptsDir?: string } = {}) {
  const sums = ReleaseVerify.parseChecksums(fs.readFileSync(path.join(releaseDir, "SHA256SUMS"), "utf8"))
  const release = ReleaseVerify.releaseOf(sums)
  const missing = ReleaseVerify.targets.filter((target) => !release.archives.has(target))
  if (missing.length > 0 && !options.partial) throw new Error(`the release has no archive for ${missing.join(", ")}`)
  const archives = [...release.archives.values()].map((archive) => {
    const bytes = fs.readFileSync(path.join(releaseDir, archive.name))
    if (sha256(bytes) !== archive.sha256) throw new Error(`${archive.name} doesn't match the release's SHA256SUMS`)
    return { name: archive.name, bytes: new Uint8Array(bytes) }
  })
  const installers = scripts.map((name) => ({
    name,
    bytes: new Uint8Array(fs.readFileSync(path.join(options.scriptsDir ?? distribution, name))),
  }))
  return { version: release.version, files: [...archives, ...installers] }
}

/** The release a public directory holds (from its SHA256SUMS, checked against the files). */
export function readPublic(publicDir: string) {
  const sums = ReleaseVerify.parseChecksums(fs.readFileSync(path.join(publicDir, "SHA256SUMS"), "utf8"))
  for (const [name, sum] of sums)
    if (sha256(fs.readFileSync(path.join(publicDir, name))) !== sum) throw new Error(`${name} doesn't match SHA256SUMS`)
  return ReleaseVerify.releaseOf(sums)
}

/** What `kete upgrade` will check, on the files about to be published. Throws on any mismatch. */
export function verifySigned(publicDir: string, keys = ReleaseVerify.pinnedKeys()) {
  const checksums = new Uint8Array(fs.readFileSync(path.join(publicDir, "SHA256SUMS")))
  const signature = new Uint8Array(fs.readFileSync(path.join(publicDir, "SHA256SUMS.sig")))
  const release = ReleaseVerify.verifyRelease({ checksums, signature, keys })
  readPublic(publicDir) // every listed file matches its checksum
  const sums = ReleaseVerify.parseChecksums(new TextDecoder().decode(checksums))
  const expected = new Set([...sums.keys(), "SHA256SUMS", "SHA256SUMS.sig", "SHA256SUMS.sigstore.json"])
  const unlisted = fs.readdirSync(publicDir).filter((name) => !expected.has(name))
  if (unlisted.length > 0) throw new Error(`files not covered by SHA256SUMS: ${unlisted.join(", ")}`)
  for (const name of scripts) if (!sums.has(name)) throw new Error(`SHA256SUMS doesn't list ${name}`)
  return release
}

const downloadUrl = (version: string, name: string) =>
  `${Brand.urls.releases}/releases/download/kete-v${version}/${name}`

// Package managers can't check for AVX2, so x64 gets the baseline build (as the VS Code extension
// does, packages/kete-vscode/src/binary.ts); the install scripts detect it and pick.
export const homebrewTargets = {
  macosArm: "darwin-arm64",
  macosIntel: "darwin-x64-baseline",
  linuxArm: "linux-arm64",
  linuxIntel: "linux-x64-baseline",
} as const satisfies Record<string, Target>

export function homebrewFormula(release: ReleaseVerify.Release) {
  const entry = (target: Target) => {
    const archive = release.archives.get(target)
    if (!archive) throw new Error(`the release has no ${target} archive for the Homebrew formula`)
    return [`      url "${downloadUrl(release.version, archive.name)}"`, `      sha256 "${archive.sha256}"`].join("\n")
  }
  return `# Generated by the Kete Code release workflow (packages/kete-tools/src/distribute.ts in the
# Kete Code repository) for kete-v${release.version}. Don't edit: the next release replaces it.
class Kete < Formula
  desc "AI coding agent for the terminal"
  homepage "${Brand.urls.releases}"
  version "${release.version}"
  license "MIT"

  on_macos do
    on_arm do
${entry(homebrewTargets.macosArm)}
    end
    on_intel do
${entry(homebrewTargets.macosIntel)}
    end
  end

  on_linux do
    on_arm do
${entry(homebrewTargets.linuxArm)}
    end
    on_intel do
${entry(homebrewTargets.linuxIntel)}
    end
  end

  def install
    bin.install "kete"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kete --version")
  end
end
`
}

/** One npm package per platform (esbuild-style), selected by npm through os, cpu and libc. */
export const npmPlatforms = [
  { suffix: "darwin-arm64", target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { suffix: "darwin-x64", target: "darwin-x64-baseline", os: "darwin", cpu: "x64" },
  { suffix: "linux-arm64", target: "linux-arm64", os: "linux", cpu: "arm64", libc: "glibc" },
  { suffix: "linux-arm64-musl", target: "linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl" },
  { suffix: "linux-x64", target: "linux-x64-baseline", os: "linux", cpu: "x64", libc: "glibc" },
  { suffix: "linux-x64-musl", target: "linux-x64-baseline-musl", os: "linux", cpu: "x64", libc: "musl" },
  { suffix: "windows-arm64", target: "windows-arm64", os: "win32", cpu: "arm64" },
  { suffix: "windows-x64", target: "windows-x64-baseline", os: "win32", cpu: "x64" },
] as const satisfies readonly { suffix: string; target: Target; os: string; cpu: string; libc?: string }[]

const npmScope = Brand.distribution.npmPackage

export type NpmPackage = { readonly directory: string; readonly manifest: Record<string, unknown> }

/** The package.json of every npm package for `version`: platform packages first, the launcher last. */
export function npmManifests(version: string, options: { repository?: string } = {}): NpmPackage[] {
  const common = {
    version,
    license: "MIT",
    homepage: Brand.urls.releases,
    ...(options.repository ? { repository: { type: "git", url: options.repository } } : {}),
  }
  const platforms = npmPlatforms.map((platform) => ({
    directory: `cli-${platform.suffix}`,
    manifest: {
      name: `${npmScope}-${platform.suffix}`,
      description: `The ${Brand.displayName} binary for ${platform.suffix} (installed by ${npmScope}).`,
      ...common,
      os: [platform.os],
      cpu: [platform.cpu],
      ...("libc" in platform ? { libc: [platform.libc] } : {}),
      files: ["bin", "LICENSE", "NOTICE"],
      preferUnplugged: true,
    },
  }))
  return [
    ...platforms,
    {
      directory: "cli",
      manifest: {
        name: npmScope,
        description: `${Brand.displayName}: AI coding agent for the terminal.`,
        ...common,
        bin: { [Brand.cliName]: "bin/kete.js" },
        files: ["bin", "README.md", "LICENSE", "NOTICE"],
        engines: { node: ">=18" },
        optionalDependencies: Object.fromEntries(platforms.map((entry) => [entry.manifest.name, version])),
      },
    },
  ]
}

function writeNpm(publicDir: string, out: string, repository: string | undefined) {
  const release = readPublic(publicDir)
  const root = path.resolve(import.meta.dir, "../../..")
  fs.rmSync(out, { recursive: true, force: true })
  for (const pkg of npmManifests(release.version, { repository })) {
    const directory = path.join(out, pkg.directory)
    fs.mkdirSync(path.join(directory, "bin"), { recursive: true })
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(pkg.manifest, null, 2) + "\n")
    for (const file of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(root, file), path.join(directory, file))
    const platform = npmPlatforms.find((entry) => `cli-${entry.suffix}` === pkg.directory)
    if (!platform) {
      fs.copyFileSync(path.join(distribution, "npm/kete.js"), path.join(directory, "bin/kete.js"))
      fs.chmodSync(path.join(directory, "bin/kete.js"), 0o755)
      fs.copyFileSync(path.join(distribution, "npm/README.md"), path.join(directory, "README.md"))
      continue
    }
    const archive = release.archives.get(platform.target)
    if (!archive) throw new Error(`the release has no ${platform.target} archive for ${pkg.manifest.name}`)
    const member = platform.os === "win32" ? "kete.exe" : "kete"
    const source = path.join(publicDir, archive.name)
    const result = archive.name.endsWith(".tar.gz")
      ? run(["tar", "-xzf", source, "-C", path.join(directory, "bin"), member], { cwd: out })
      : run(["unzip", "-q", source, member, "-d", path.join(directory, "bin")], { cwd: out })
    if (result.code !== 0) throw new Error(`unpacking ${archive.name} failed: ${result.stderr.trim()}`)
    fs.chmodSync(path.join(directory, "bin", member), 0o755)
  }
}

export function releaseNotes(version: string) {
  const identity = `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v${version}`
  return `# ${Brand.displayName} ${version}

## Install

- macOS and Linux: \`curl -fsSL ${Brand.urls.releases}/releases/latest/download/install.sh | sh\`
  (this version: \`… | sh -s -- --version ${version}\`)
- Windows: \`irm ${Brand.urls.releases}/releases/latest/download/install.ps1 | iex\`
- Homebrew: \`brew install ${Brand.distribution.homebrewFormula}\` · npm: \`npm install -g ${Brand.distribution.npmPackage}\`
- Already installed: \`kete upgrade\`

## Verify

\`SHA256SUMS\` lists every file here. \`SHA256SUMS.sigstore.json\` is its cosign keyless signature,
identity \`${identity}\`, issuer \`https://token.actions.githubusercontent.com\`; \`SHA256SUMS.sig\` is the
Ed25519 signature \`kete upgrade\` verifies with the key built into \`kete\`.

\`\`\`sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity '${identity}' \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
\`\`\`
`
}

if (import.meta.main) main()

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const positional = rest.filter((arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--repository")
  const [input, output] = positional
  if (!command || !input || !output) fail("usage: distribute public|homebrew|npm|notes <in> <out> (see the header)")
  try {
    if (command === "public") {
      const { version, files } = publicFiles(input, { partial: rest.includes("--partial") })
      fs.rmSync(output, { recursive: true, force: true })
      fs.mkdirSync(output, { recursive: true })
      for (const file of files) fs.writeFileSync(path.join(output, file.name), file.bytes)
      fs.writeFileSync(path.join(output, "SHA256SUMS"), checksums(files) + "\n")
      console.log(`public release ${version}: ${files.length} files + SHA256SUMS in ${output}`)
    } else if (command === "homebrew") {
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, homebrewFormula(readPublic(input)))
    } else if (command === "npm") {
      const index = rest.indexOf("--repository")
      writeNpm(input, output, index === -1 ? undefined : rest[index + 1])
    } else if (command === "verify") {
      const release = verifySigned(input)
      console.log(
        `verified ${release.version}: SHA256SUMS signed by pinned key ${release.keyId}, ${release.archives.size} archives`,
      )
    } else if (command === "notes") {
      fs.writeFileSync(output, releaseNotes(readPublic(input).version))
    } else fail(`unknown command: ${command}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

function fail(message: string): never {
  console.error(`distribute: ${message}`)
  process.exit(1)
}
