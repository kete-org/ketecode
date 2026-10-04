import { describe, expect, test } from "bun:test"
import { archiveName, checksums, extensionTargets, releaseVersion } from "../src/release"

describe("release", () => {
  test("accepts kete-vX.Y.Z tags, with an optional pre-release", () => {
    expect(releaseVersion("kete-v0.1.0")).toBe("0.1.0")
    expect(releaseVersion("kete-v1.2.3-rc.1")).toBe("1.2.3-rc.1")
    // Upstream OpenCode's bare vX.Y.Z tags live in this repository too and must never trigger a Kete release.
    for (const tag of ["v0.1.0", "v2.0.16", "0.1.0", "kete-v0.1", "kete-v0.1.0 extra", "vscode-v0.0.13", ""])
      expect(releaseVersion(tag)).toBeUndefined()
  })

  test("names archives by platform convention", () => {
    expect(archiveName("0.1.0", "linux-x64-musl")).toBe("kete-0.1.0-linux-x64-musl.tar.gz")
    expect(archiveName("0.1.0", "darwin-arm64")).toBe("kete-0.1.0-darwin-arm64.zip")
    expect(archiveName("0.1.0", "windows-x64-baseline")).toBe("kete-0.1.0-windows-x64-baseline.zip")
  })

  test("writes sha256sum-compatible checksums sorted by file name", () => {
    const text = checksums([
      { name: "b.zip", bytes: new TextEncoder().encode("b") },
      { name: "a.tar.gz", bytes: new TextEncoder().encode("a") },
    ])
    expect(text.split("\n")).toEqual([
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.tar.gz",
      "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.zip",
    ])
  })
})

describe("extensionTargets", () => {
  test("maps every VS Code platform to the CLI build it bundles", () => {
    const full = [
      "darwin-arm64",
      "darwin-x64",
      "darwin-x64-baseline",
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-baseline",
      "linux-x64-baseline-musl",
      "linux-x64-musl",
      "windows-arm64",
      "windows-x64",
      "windows-x64-baseline",
    ]
    expect(extensionTargets(full)).toEqual([
      { vscode: "darwin-arm64", cli: "darwin-arm64" },
      { vscode: "darwin-x64", cli: "darwin-x64-baseline" },
      { vscode: "linux-x64", cli: "linux-x64-baseline" },
      { vscode: "linux-arm64", cli: "linux-arm64" },
      { vscode: "alpine-x64", cli: "linux-x64-baseline-musl" },
      { vscode: "alpine-arm64", cli: "linux-arm64-musl" },
      { vscode: "win32-x64", cli: "windows-x64-baseline" },
      { vscode: "win32-arm64", cli: "windows-arm64" },
    ])
  })

  test("a single-platform build packages the regular binary for x64", () => {
    expect(extensionTargets(["linux-x64"])).toEqual([{ vscode: "linux-x64", cli: "linux-x64" }])
    expect(extensionTargets(["darwin-arm64"])).toEqual([{ vscode: "darwin-arm64", cli: "darwin-arm64" }])
  })
})
