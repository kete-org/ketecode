#!/usr/bin/env bun
// Builds a Kete Code release: the `kete` CLI for every target, the VS Code extension,
// and checksums. Kete-owned; replaces upstream's publish scripts, which publish to
// OpenCode's npm packages, Homebrew tap and image registry and must not be run.
//
//   bun run --cwd packages/kete-tools release kete-v0.1.0 [--out <dir>] [--single] [--skip-vsix]
//
// Kete tags carry a `kete-` prefix: this repository also holds upstream OpenCode's
// vX.Y.Z tags (which `upstream:sync` merges), and Kete's own versions must never collide
// with them.
//
// --single builds only the current platform (for a quick local check). Output, in
// --out (default: packages/kete-tools/dist-release):
//   kete-<version>-<target>.tar.gz (Linux) or .zip (macOS, Windows): the binary plus
//     LICENSE and NOTICE (OpenCode's MIT license requires both to ship with copies)
//   kete-code-<version>-<vscode target>.vsix: the VS Code extension for one platform, with that
//     platform's `kete` binary in bin/ (the extension never uses a `kete` from the PATH)
//   SHA256SUMS
// A full build needs about 3 GB of free disk space while it runs.
// Publishing is separate: the kete-release workflow uploads these to a draft GitHub Release.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "./lib"
import { executableName, targets as vscodeTargets } from "../../kete-vscode/src/binary"

const root = path.resolve(import.meta.dir, "../../..")

/** `kete-v0.1.0` or `kete-v0.1.0-rc.1` → `0.1.0` / `0.1.0-rc.1`; anything else, including upstream's bare vX.Y.Z tags, is rejected. */
export function releaseVersion(tag: string) {
  return /^kete-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(tag.trim())?.[1]
}

/**
 * The VS Code targets whose CLI build is among `built`, with the CLI target each one bundles. Releases
 * bundle the x64 baseline builds (no AVX2 needed); a `--single` build has only the regular one, which
 * then stands in.
 */
export function extensionTargets(built: readonly string[]) {
  return Object.entries(vscodeTargets).flatMap(([vscode, wanted]) => {
    const cli = built.includes(wanted) ? wanted : built.find((target) => target === wanted.replace("-baseline", ""))
    return cli ? [{ vscode, cli }] : []
  })
}

/** Linux users expect tar.gz; macOS and Windows users expect zip. */
export function archiveName(version: string, target: string) {
  return `kete-${version}-${target}.${target.startsWith("linux-") ? "tar.gz" : "zip"}`
}

export function checksums(files: readonly { name: string; bytes: Uint8Array }[]) {
  return files
    .map((file) => `${new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex")}  ${file.name}`)
    .toSorted((a, b) => a.slice(66).localeCompare(b.slice(66)))
    .join("\n")
}

if (import.meta.main) main()

function main() {
  const args = process.argv.slice(2)
  const tag = args.find((arg) => !arg.startsWith("--"))
  const version = tag ? releaseVersion(tag) : undefined
  if (!version) fail("usage: release kete-vX.Y.Z[-pre] [--out <dir>] [--single] [--skip-vsix]")
  const out = path.resolve(option(args, "--out") ?? path.join(import.meta.dir, "../dist-release"))
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })

  // The build reads OPENCODE_VERSION directly (it runs outside the CLI's env bridge). Without it,
  // the version would be derived from OpenCode's latest npm release.
  // The build runs `bun install` for every platform's native packages, which rewrites these files;
  // restore them so a release leaves the working tree as it found it.
  const saved = ["packages/cli/package.json", "bun.lock"].map((file) => {
    const full = path.join(root, file)
    return { full, bytes: fs.readFileSync(full) }
  })
  console.log("\n== Building the CLI")
  const build = run(["bun", "run", "build", ...(args.includes("--single") ? ["--single"] : [])], {
    cwd: path.join(root, "packages/cli"),
    env: { OPENCODE_VERSION: version, OPENCODE_CHANNEL: "latest" },
  })
  saved.forEach((file) => fs.writeFileSync(file.full, file.bytes))
  if (build.code !== 0) fail(`building the CLI failed:\n${build.stderr.trim() || build.stdout.trim()}`)
  const dist = path.join(root, "packages/cli/dist")
  const targets = fs
    .readdirSync(dist)
    .filter((name) => name.startsWith("cli-"))
    .map((name) => name.slice("cli-".length))
  if (targets.length === 0) fail("the build produced no targets")
  targets.forEach((target) => archive(version, target, path.join(dist, `cli-${target}`, "bin"), out))
  if (!args.includes("--skip-vsix")) packageExtensions(version, targets, dist, out)
  // The archives and extensions hold the binaries; the ~2 GB build output is no longer needed.
  fs.rmSync(dist, { recursive: true, force: true })

  const files = fs.readdirSync(out).map((name) => ({ name, bytes: fs.readFileSync(path.join(out, name)) }))
  fs.writeFileSync(path.join(out, "SHA256SUMS"), checksums(files) + "\n")
  console.log(`\nRelease ${version} in ${path.relative(root, out)}:`)
  for (const name of fs.readdirSync(out).toSorted()) console.log(`  ${name}`)
}

/** One .vsix per VS Code target, each with its platform's binary (vsce package --target). */
function packageExtensions(version: string, built: readonly string[], dist: string, out: string) {
  const extension = path.join(root, "packages/kete-vscode")
  const matched = extensionTargets(built)
  if (matched.length === 0) fail(`no VS Code target matches the built CLI targets (${built.join(", ")})`)
  step("Building the VS Code extension", ["bun", "run", "build"], { cwd: extension })
  // The bundled binary is OpenCode-derived: ship OpenCode's NOTICE next to the extension's LICENSE.
  fs.copyFileSync(path.join(root, "NOTICE"), path.join(extension, "NOTICE"))
  const bin = path.join(extension, "bin")
  for (const target of matched) {
    fs.rmSync(bin, { recursive: true, force: true })
    fs.mkdirSync(bin)
    const windows = target.vscode.startsWith("win32-")
    const source = path.join(dist, `cli-${target.cli}`, "bin", windows ? "kete.exe" : "kete")
    const destination = path.join(bin, executableName(windows ? "win32" : "linux"))
    fs.copyFileSync(source, destination)
    // vsce stores each file's mode; VS Code keeps it on install, so the binary stays executable.
    fs.chmodSync(destination, 0o755)
    step(
      `Packaging the VS Code extension for ${target.vscode} (${target.cli})`,
      [
        "bunx",
        "--bun",
        "@vscode/vsce@4.0.0",
        "package",
        version,
        "--target",
        target.vscode,
        "--no-git-tag-version",
        "--no-update-package-json",
        "--no-dependencies",
        // The repository is private for now, so the manifest deliberately has no repository link.
        "--allow-missing-repository",
        "--out",
        path.join(out, `kete-code-${version}-${target.vscode}.vsix`),
      ],
      { cwd: extension },
    )
  }
  fs.rmSync(bin, { recursive: true, force: true })
  fs.rmSync(path.join(extension, "NOTICE"), { force: true })
}

function archive(version: string, target: string, bin: string, out: string) {
  const executable = fs.existsSync(path.join(bin, "kete.exe")) ? "kete.exe" : "kete"
  if (!fs.existsSync(path.join(bin, executable))) fail(`missing binary for ${target}`)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "kete-release-"))
  fs.copyFileSync(path.join(bin, executable), path.join(staging, executable))
  fs.chmodSync(path.join(staging, executable), 0o755)
  for (const file of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(root, file), path.join(staging, file))
  const output = path.join(out, archiveName(version, target))
  const entries = [executable, "LICENSE", "NOTICE"]
  console.log(`\n== Archiving ${target}`)
  const result = run(
    output.endsWith(".tar.gz")
      ? ["tar", "--owner=0", "--group=0", "--numeric-owner", "-czf", output, ...entries]
      : ["zip", "-X", "-q", output, ...entries],
    { cwd: staging },
  )
  fs.rmSync(staging, { recursive: true, force: true })
  if (result.code !== 0) fail(`archiving ${target} failed:\n${result.stderr.trim() || result.stdout.trim()}`)
}

function step(label: string, cmd: readonly string[], options: { cwd: string; env?: Record<string, string> }) {
  console.log(`\n== ${label}`)
  const result = options.env ? run(cmd, options) : run(cmd, { cwd: options.cwd })
  if (result.code !== 0) fail(`${label} failed:\n${result.stderr.trim() || result.stdout.trim()}`)
}

function option(args: readonly string[], name: string) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function fail(message: string): never {
  console.error(`release: ${message}`)
  process.exit(1)
}
