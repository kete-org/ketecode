// Verifies, before the plugin goes to the JetBrains Marketplace, the public release its Marketplace zip
// will download from on first use: SHA256SUMS.sig (Ed25519) against the update keys inside that plugin
// zip, then every archive the plugin can pick (src/main/kotlin/ai/ketecode/jetbrains/core/Binary.kt
// targets; ArchiveTargetsTest keeps this list equal) against the signed SHA256SUMS. The checks are
// `kete upgrade`'s own (packages/cli/src/kete/release-verify.ts), so nothing here is new cryptography.
//
//   bun packages/kete-jetbrains/script/verify-public-release.ts <version> <assets dir> <update-keys.json>
//
// <assets dir> holds SHA256SUMS, SHA256SUMS.sig and the archives, downloaded from
// kete-org/kete-releases (kete-jetbrains-publish.yml). Exits 1 on any mismatch.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { ReleaseVerify } from "../../cli/src/kete/release-verify"

/** The CLI targets the plugin downloads (core/Binary.kt `targets` values). */
export const pluginTargets = [
  "darwin-arm64",
  "darwin-x64-baseline",
  "linux-x64-baseline",
  "linux-arm64",
  "windows-x64-baseline",
  "windows-arm64",
] as const

async function sha256(file: string) {
  const hash = crypto.createHash("sha256")
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function main() {
  const [version, directory, keysFile] = process.argv.slice(2)
  if (!version || !directory || !keysFile) throw new Error("usage: verify-public-release.ts <version> <assets dir> <update-keys.json>")
  if (!ReleaseVerify.isVersion(version)) throw new Error(`Not a release version: ${version}`)
  const keys = ReleaseVerify.pinnedKeys(JSON.parse(fs.readFileSync(keysFile, "utf8")))
  const release = ReleaseVerify.verifyRelease({
    checksums: fs.readFileSync(path.join(directory, "SHA256SUMS")),
    signature: fs.readFileSync(path.join(directory, "SHA256SUMS.sig")),
    keys,
  })
  if (release.version !== version) throw new Error(`The signed SHA256SUMS describes ${release.version}, not ${version}`)
  console.log(`SHA256SUMS signature verified (key ${release.keyId}), version ${release.version}`)
  for (const target of pluginTargets) {
    const archive = release.archives.get(target)
    if (!archive) throw new Error(`The signed SHA256SUMS has no archive for ${target}`)
    if (archive.name !== ReleaseVerify.archiveName(version, target)) throw new Error(`Unexpected archive name ${archive.name}`)
    const actual = await sha256(path.join(directory, archive.name))
    if (actual !== archive.sha256) throw new Error(`${archive.name}: SHA-256 ${actual} doesn't match the signed ${archive.sha256}`)
    console.log(`ok ${archive.name}`)
  }
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
