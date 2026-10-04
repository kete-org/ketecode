import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { ReleaseVerify } from "../../src/kete/release-verify"

function keyPair(id: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12)
  return { pinned: { id, publicKey: raw.toString("base64") }, privateKey }
}

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex")

function sums(version: string, extra: string[] = []) {
  return (
    [
      `${sha("a")}  ${ReleaseVerify.archiveName(version, "darwin-arm64")}`,
      `${sha("b")}  ${ReleaseVerify.archiveName(version, "linux-x64")}`,
      `${sha("c")}  install.sh`,
      ...extra,
    ].join("\n") + "\n"
  )
}

describe("release verification", () => {
  test("the checked-in update-keys.json is well formed", () => {
    expect(() => ReleaseVerify.pinnedKeys()).not.toThrow()
  })

  test("a malformed pinned key is an error, not skipped", () => {
    expect(() => ReleaseVerify.pinnedKeys({ keys: [{ id: "x", publicKey: "c2hvcnQ=" }] })).toThrow("key 0")
    expect(() => ReleaseVerify.pinnedKeys({})).toThrow("no keys array")
  })

  test("a signed SHA256SUMS yields its version and archives", () => {
    const key = keyPair("k1")
    const checksums = Buffer.from(sums("0.3.0"))
    const release = ReleaseVerify.verifyRelease({
      checksums,
      signature: crypto.sign(null, checksums, key.privateKey),
      keys: [key.pinned],
    })
    expect(release.version).toBe("0.3.0")
    expect(release.keyId).toBe("k1")
    expect(release.archives.get("linux-x64")).toEqual({ name: "kete-0.3.0-linux-x64.tar.gz", sha256: sha("b") })
    expect(release.archives.has("windows-x64")).toBe(false)
  })

  test("any pinned key may sign (rotation)", () => {
    const old = keyPair("old")
    const next = keyPair("next")
    const checksums = Buffer.from(sums("0.3.0"))
    const release = ReleaseVerify.verifyRelease({
      checksums,
      signature: crypto.sign(null, checksums, next.privateKey),
      keys: [old.pinned, next.pinned],
    })
    expect(release.keyId).toBe("next")
  })

  test("fails closed: no key, wrong key, tampered file, bad signature length", () => {
    const key = keyPair("k1")
    const other = keyPair("other")
    const checksums = Buffer.from(sums("0.3.0"))
    const signature = crypto.sign(null, checksums, key.privateKey)
    expect(() => ReleaseVerify.verifyRelease({ checksums, signature, keys: [] })).toThrow("No update signing key")
    expect(() => ReleaseVerify.verifyRelease({ checksums, signature, keys: [other.pinned] })).toThrow("does not verify")
    const tampered = Buffer.from(sums("0.3.0").replace(sha("b"), sha("evil")))
    expect(() => ReleaseVerify.verifyRelease({ checksums: tampered, signature, keys: [key.pinned] })).toThrow(
      "does not verify",
    )
    expect(() =>
      ReleaseVerify.verifyRelease({ checksums, signature: signature.subarray(0, 63), keys: [key.pinned] }),
    ).toThrow("does not verify")
  })

  test("rejects malformed or ambiguous checksum files even when signed", () => {
    expect(() => ReleaseVerify.parseChecksums("nothex  kete-0.3.0-linux-x64.tar.gz\n")).toThrow("malformed")
    expect(() => ReleaseVerify.parseChecksums(`${sha("a")}  ../etc/passwd\n`)).toThrow("malformed")
    expect(() => ReleaseVerify.parseChecksums(`${sha("a")}  x\n${sha("b")}  x\n`)).toThrow("twice")
    expect(() =>
      ReleaseVerify.releaseOf(
        ReleaseVerify.parseChecksums(sums("0.3.0", [`${sha("d")}  kete-0.2.0-linux-arm64.tar.gz`])),
      ),
    ).toThrow("mixes versions")
    expect(() =>
      ReleaseVerify.releaseOf(ReleaseVerify.parseChecksums(`${sha("a")}  kete-0.3.0-linux-x64.zip\n`)),
    ).toThrow("unexpected archive")
    expect(() =>
      ReleaseVerify.releaseOf(ReleaseVerify.parseChecksums(`${sha("a")}  kete-0.3.0-plan9-x64.zip\n`)),
    ).toThrow("unexpected archive")
    expect(() => ReleaseVerify.releaseOf(ReleaseVerify.parseChecksums(`${sha("a")}  install.sh\n`))).toThrow(
      "no kete archives",
    )
  })

  test("pre-release versions parse unambiguously", () => {
    const release = ReleaseVerify.releaseOf(
      ReleaseVerify.parseChecksums(`${sha("a")}  kete-0.3.0-rc.1-linux-x64-baseline-musl.tar.gz\n`),
    )
    expect(release.version).toBe("0.3.0-rc.1")
    expect([...release.archives.keys()]).toEqual(["linux-x64-baseline-musl"])
  })

  test("semantic version order", () => {
    const ordered = [
      "0.1.0",
      "0.2.0-alpha",
      "0.2.0-alpha.1",
      "0.2.0-alpha.beta",
      "0.2.0-beta.2",
      "0.2.0-beta.11",
      "0.2.0-rc.1",
      "0.2.0",
      "0.10.0",
      "1.0.0",
    ]
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(ReleaseVerify.compareVersions(ordered[i], ordered[i + 1])).toBeLessThan(0)
      expect(ReleaseVerify.compareVersions(ordered[i + 1], ordered[i])).toBeGreaterThan(0)
    }
    expect(ReleaseVerify.compareVersions("0.2.0", "0.2.0")).toBe(0)
    expect(() => ReleaseVerify.compareVersions("local", "0.2.0")).toThrow()
    expect(ReleaseVerify.isVersion("v0.2.0")).toBe(false)
    expect(ReleaseVerify.isVersion("0.2.0-rc-1")).toBe(false)
  })
})
