// What `kete upgrade` trusts about a public release (ADR 0009): a SHA256SUMS file whose detached
// Ed25519 signature (SHA256SUMS.sig, 64 raw bytes) verifies against a key pinned in this binary
// (update-keys.json), and nothing else. The release's version is read from the signed file names, so
// neither the URL nor GitHub's metadata can make a different release look like the requested one.
//
// Pure functions only (no network or filesystem): the updater (./updater.ts) fetches, these decide.
// Signature verification is node:crypto's Ed25519; there is no hand-written cryptography here.
import crypto from "node:crypto"
import pinned from "./update-keys.json"

export type PinnedKey = { readonly id: string; readonly publicKey: string }

/** The CLI targets a release publishes (packages/cli/script/build.ts, docs/release.md). */
export const targets = [
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "linux-arm64",
  "linux-arm64-musl",
  "linux-x64",
  "linux-x64-baseline",
  "linux-x64-musl",
  "linux-x64-baseline-musl",
  "windows-arm64",
  "windows-x64",
  "windows-x64-baseline",
] as const

export type Target = (typeof targets)[number]

export function isTarget(value: string | undefined): value is Target {
  return targets.some((target) => target === value)
}

/** A Kete release version: X.Y.Z with an optional dot-separated pre-release (release.ts releaseVersion). */
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/

export function isVersion(value: string) {
  return value.length <= 64 && versionPattern.test(value)
}

/** Semantic-version order of two valid versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const left = versionPattern.exec(a)
  const right = versionPattern.exec(b)
  if (!left || !right) throw new Error(`Not a release version: ${!left ? a : b}`)
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return difference
  }
  const leftPre = left[4]?.split(".")
  const rightPre = right[4]?.split(".")
  // A version without a pre-release ranks above the same version with one (0.2.0 > 0.2.0-rc.1).
  if (!leftPre || !rightPre) return (leftPre ? -1 : 0) + (rightPre ? 1 : 0)
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index++) {
    const x = leftPre[index]
    const y = rightPre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return difference
      continue
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The keys in update-keys.json, validated: a malformed entry is an error, never skipped. */
export function pinnedKeys(input: unknown = pinned): readonly PinnedKey[] {
  if (typeof input !== "object" || input === null || !("keys" in input) || !Array.isArray(input.keys))
    throw new Error("update-keys.json has no keys array")
  return input.keys.map((entry: unknown, index: number) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      !("publicKey" in entry) ||
      typeof entry.id !== "string" ||
      typeof entry.publicKey !== "string" ||
      Buffer.from(entry.publicKey, "base64").length !== 32
    )
      throw new Error(`update-keys.json key ${index} is not { id, publicKey: <32-byte base64> }`)
    return { id: entry.id, publicKey: entry.publicKey }
  })
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw 32-byte key follows it.
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex")

/** The id of the pinned key that signed `message`, or undefined when none did. */
export function verifySignature(message: Uint8Array, signature: Uint8Array, keys: readonly PinnedKey[]) {
  if (signature.length !== 64) return undefined
  for (const key of keys) {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(key.publicKey, "base64")]),
      format: "der",
      type: "spki",
    })
    if (crypto.verify(null, message, publicKey, signature)) return key.id
  }
  return undefined
}

/** `<sha256>  <name>` lines (sha256sum's format). Anything else, or a repeated name, is an error. */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  if (text.length > 64 * 1024) throw new Error("SHA256SUMS is too large")
  const entries = new Map<string, string>()
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue
    const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line.replace(/\r$/, ""))
    const [, sha256, name] = match ?? []
    if (!sha256 || !name) throw new Error(`SHA256SUMS has a malformed line: ${JSON.stringify(line.slice(0, 120))}`)
    if (entries.has(name)) throw new Error(`SHA256SUMS lists ${name} twice`)
    entries.set(name, sha256)
  }
  return entries
}

export type Release = {
  readonly version: string
  /** Archive name and SHA-256 per target. */
  readonly archives: ReadonlyMap<Target, { readonly name: string; readonly sha256: string }>
}

/** `kete-<version>-<target>.tar.gz|zip` (packages/kete-tools/src/release.ts archiveName). */
export function archiveName(version: string, target: Target) {
  return `kete-${version}-${target}.${target.startsWith("linux-") ? "tar.gz" : "zip"}`
}

/**
 * The release a verified SHA256SUMS describes. Every archive in it must name the same version and a
 * known target with that target's archive format; other files (the install scripts) are ignored.
 */
export function releaseOf(checksums: ReadonlyMap<string, string>): Release {
  const archives = new Map<Target, { name: string; sha256: string }>()
  const versions = new Set<string>()
  for (const [name, sha256] of checksums) {
    if (!name.startsWith("kete-") || !(name.endsWith(".tar.gz") || name.endsWith(".zip"))) continue
    // Match by the known target suffixes (a version's pre-release and a target both contain "-").
    const parsed = targets
      .map((target) => {
        const suffix = `-${target}.${target.startsWith("linux-") ? "tar.gz" : "zip"}`
        return name.endsWith(suffix) ? { target, version: name.slice("kete-".length, -suffix.length) } : undefined
      })
      .find((entry) => entry !== undefined && isVersion(entry.version))
    if (!parsed) throw new Error(`SHA256SUMS lists an unexpected archive: ${name}`)
    const { target, version } = parsed
    versions.add(version)
    archives.set(target, { name, sha256 })
  }
  const [version, ...others] = [...versions]
  if (!version) throw new Error("SHA256SUMS lists no kete archives")
  if (others.length > 0) throw new Error(`SHA256SUMS mixes versions: ${[...versions].join(", ")}`)
  return { version, archives }
}

/**
 * Verifies a downloaded SHA256SUMS and its signature and returns the release it describes. Throws
 * when no key is pinned, the signature doesn't verify, or the file is malformed: fail closed.
 */
export function verifyRelease(input: {
  readonly checksums: Uint8Array
  readonly signature: Uint8Array
  readonly keys: readonly PinnedKey[]
}): Release & { readonly keyId: string } {
  if (input.keys.length === 0) throw new Error("No update signing key is pinned in this build.")
  const keyId = verifySignature(input.checksums, input.signature, input.keys)
  if (!keyId) throw new Error("The release's SHA256SUMS signature does not verify against the pinned update keys.")
  return { ...releaseOf(parseChecksums(new TextDecoder("utf-8", { fatal: true }).decode(input.checksums))), keyId }
}

export * as ReleaseVerify from "./release-verify"
