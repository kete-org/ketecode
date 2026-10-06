package ai.ketecode.jetbrains.core

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

// What the plugin trusts about a public Kete Code release before it runs a downloaded `kete`: the same
// rules `kete upgrade` applies (packages/cli/src/kete/release-verify.ts, ADR 0009). A release's
// SHA256SUMS must carry a detached Ed25519 signature (SHA256SUMS.sig, 64 raw bytes) that verifies
// against a key pinned in this build (update-keys.json, copied from packages/cli/src/kete at build
// time), and the archive's SHA-256 must match its line in that file. The archive name carries the
// version, so a signed SHA256SUMS of another release can't stand in for the requested one.
//
// Pure functions only. Signature checks are the JDK's Ed25519 (java.security); no hand-written crypto.

object CliRelease {
    /** Where public releases live (Brand.distribution in packages/util/src/kete/brand.ts). */
    const val RELEASES = "https://github.com/kete-org/kete-releases"

    /** The classpath resource Gradle generates from packages/cli/src/kete/update-keys.json. */
    const val KEYS_RESOURCE = "/ai/ketecode/jetbrains/update-keys.json"

    const val MAX_CHECKSUMS_BYTES = 64 * 1024
    const val SIGNATURE_BYTES = 64

    class PinnedKey(val id: String, val publicKey: ByteArray) {
        init {
            require(publicKey.size == 32) { "an Ed25519 public key is 32 bytes" }
        }
    }

    class VerifyException(message: String) : Exception(message)

    /** X.509 SubjectPublicKeyInfo prefix of an Ed25519 key (RFC 8410); the raw 32 bytes follow it. */
    private val SPKI_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    /** A Kete release version: X.Y.Z with an optional dot-separated pre-release (release-verify.ts isVersion). */
    private val VERSION = Regex("^(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})(?:-([0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*))?$")

    fun isVersion(value: String) = value.length <= 64 && VERSION.matches(value)

    /** The keys in update-keys.json, validated: a malformed entry is an error, never skipped. */
    fun parseKeys(json: String): List<PinnedKey> {
        val keys = Json.parseOrNull(json).asObject()?.get("keys").asList()
            ?: throw VerifyException("update-keys.json has no keys array")
        return keys.mapIndexed { index, entry ->
            val value = entry.asObject()
            val id = value?.string("id")
            val raw = value?.string("publicKey")?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }
            if (id.isNullOrEmpty() || raw == null || raw.size != 32)
                throw VerifyException("update-keys.json key $index is not { id, publicKey: <32-byte base64> }")
            PinnedKey(id, raw)
        }
    }

    /** The keys bundled with the plugin. Throws when the resource is missing or malformed: fail closed. */
    fun pinnedKeys(): List<PinnedKey> {
        val text = CliRelease::class.java.getResourceAsStream(KEYS_RESOURCE)?.use { it.readBytes().toString(Charsets.UTF_8) }
            ?: throw VerifyException("This build of the plugin has no pinned update keys ($KEYS_RESOURCE).")
        return parseKeys(text)
    }

    private fun publicKey(raw: ByteArray): PublicKey =
        KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + raw))

    /** The id of the pinned key that signed `message`, or null when none did. */
    fun verifySignature(message: ByteArray, signature: ByteArray, keys: List<PinnedKey>): String? {
        if (signature.size != SIGNATURE_BYTES) return null
        for (key in keys) {
            val verifier = Signature.getInstance("Ed25519")
            verifier.initVerify(publicKey(key.publicKey))
            verifier.update(message)
            val ok = try {
                verifier.verify(signature)
            } catch (_: java.security.SignatureException) {
                false
            }
            if (ok) return key.id
        }
        return null
    }

    private val CHECKSUM_LINE = Regex("^([0-9a-f]{64}) [ *]([A-Za-z0-9][A-Za-z0-9._-]*)$")

    /** `<sha256>  <name>` lines (sha256sum's format). Anything else, or a repeated name, is an error. */
    fun parseChecksums(text: String): Map<String, String> {
        if (text.length > MAX_CHECKSUMS_BYTES) throw VerifyException("SHA256SUMS is too large")
        val entries = LinkedHashMap<String, String>()
        for (line in text.split("\n")) {
            if (line.isBlank()) continue
            val match = CHECKSUM_LINE.matchEntire(line.removeSuffix("\r"))
                ?: throw VerifyException("SHA256SUMS has a malformed line: \"${line.take(120)}\"")
            val (sha256, name) = match.destructured
            if (entries.containsKey(name)) throw VerifyException("SHA256SUMS lists $name twice")
            entries[name] = sha256
        }
        return entries
    }

    /** `kete-<version>-<target>.tar.gz|zip` (packages/kete-tools/src/release.ts archiveName). */
    fun archiveName(version: String, target: String) =
        "kete-$version-$target.${if (target.startsWith("linux-")) "tar.gz" else "zip"}"

    fun releaseUrl(version: String, file: String) = "$RELEASES/releases/download/kete-v$version/$file"

    /**
     * Verifies a downloaded SHA256SUMS and its signature and returns the expected SHA-256 of `archive`.
     * Throws when no key is pinned, the signature doesn't verify, the file is malformed or doesn't
     * list `archive`: fail closed.
     */
    fun verifiedChecksum(checksums: ByteArray, signature: ByteArray, keys: List<PinnedKey>, archive: String): String {
        if (keys.isEmpty()) throw VerifyException("No update signing key is pinned in this build of the plugin.")
        if (signature.size != SIGNATURE_BYTES)
            throw VerifyException("The release's SHA256SUMS.sig is ${signature.size} bytes, not $SIGNATURE_BYTES.")
        verifySignature(checksums, signature, keys)
            ?: throw VerifyException("The release's SHA256SUMS signature does not verify against the pinned update keys.")
        val text = try {
            Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(checksums)).toString()
        } catch (_: java.nio.charset.CharacterCodingException) {
            throw VerifyException("SHA256SUMS is not UTF-8")
        }
        return parseChecksums(text)[archive] ?: throw VerifyException("The signed SHA256SUMS doesn't list $archive.")
    }

    fun sha256Hex(digest: MessageDigest): String = digest.digest().joinToString("") { "%02x".format(it) }
}
