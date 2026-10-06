package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64

/** A throwaway Ed25519 signing key, standing in for the release workflow's. */
class TestSigner(val id: String = "test-key") {
    private val pair: KeyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()

    /** The raw 32-byte public key (the X.509 encoding's last 32 bytes), as update-keys.json holds it. */
    val raw: ByteArray = pair.public.encoded.takeLast(32).toByteArray()
    val pinned = CliRelease.PinnedKey(id, raw)

    fun sign(message: ByteArray): ByteArray = Signature.getInstance("Ed25519").run {
        initSign(pair.private)
        update(message)
        sign()
    }
}

class CliReleaseTest {
    private val signer = TestSigner()
    private val sha = "a".repeat(64)
    private val sums = "$sha  kete-0.2.4-darwin-arm64.zip\n${"b".repeat(64)}  kete-0.2.4-linux-x64-baseline.tar.gz\n".toByteArray()

    @Test
    fun `a signature by a pinned key verifies and names the key`() {
        assertEquals("test-key", CliRelease.verifySignature(sums, signer.sign(sums), listOf(signer.pinned)))
        val other = TestSigner("other")
        assertEquals("test-key", CliRelease.verifySignature(sums, signer.sign(sums), listOf(other.pinned, signer.pinned)))
    }

    @Test
    fun `a tampered SHA256SUMS, a wrong key or a signature of the wrong length doesn't verify`() {
        val signature = signer.sign(sums)
        val tampered = sums.copyOf().also { it[0] = 'c'.code.toByte() }
        assertNull(CliRelease.verifySignature(tampered, signature, listOf(signer.pinned)))
        assertNull(CliRelease.verifySignature(sums, signature, listOf(TestSigner("wrong").pinned)))
        assertNull(CliRelease.verifySignature(sums, signature.copyOf(63), listOf(signer.pinned)))
        assertNull(CliRelease.verifySignature(sums, signature + 0, listOf(signer.pinned)))
        assertNull(CliRelease.verifySignature(sums, ByteArray(64), listOf(signer.pinned)))
        assertThrows(CliRelease.VerifyException::class.java) {
            CliRelease.verifiedChecksum(tampered, signature, listOf(signer.pinned), "kete-0.2.4-darwin-arm64.zip")
        }
        val wrongLength = assertThrows(CliRelease.VerifyException::class.java) {
            CliRelease.verifiedChecksum(sums, signature.copyOf(65), listOf(signer.pinned), "kete-0.2.4-darwin-arm64.zip")
        }
        assertTrue(wrongLength.message!!.contains("65 bytes"))
    }

    @Test
    fun `no pinned key means nothing verifies`() {
        assertThrows(CliRelease.VerifyException::class.java) {
            CliRelease.verifiedChecksum(sums, signer.sign(sums), emptyList(), "kete-0.2.4-darwin-arm64.zip")
        }
    }

    @Test
    fun `the verified checksum is the archive's line, and a missing line is refused`() {
        val signature = signer.sign(sums)
        assertEquals(sha, CliRelease.verifiedChecksum(sums, signature, listOf(signer.pinned), "kete-0.2.4-darwin-arm64.zip"))
        val missing = assertThrows(CliRelease.VerifyException::class.java) {
            CliRelease.verifiedChecksum(sums, signature, listOf(signer.pinned), "kete-0.2.5-darwin-arm64.zip")
        }
        assertTrue(missing.message!!.contains("doesn't list"))
    }

    @Test
    fun `SHA256SUMS is parsed strictly`() {
        assertEquals(mapOf("a.zip" to sha, "b.zip" to sha), CliRelease.parseChecksums("$sha  a.zip\r\n$sha *b.zip\n\n"))
        for (bad in listOf("$sha a.zip extra", "${sha.uppercase()}  a.zip", "$sha  ../a.zip", "abc  a.zip", "$sha  a.zip\n$sha  a.zip"))
            assertThrows(CliRelease.VerifyException::class.java, { CliRelease.parseChecksums(bad) }, bad)
        assertThrows(CliRelease.VerifyException::class.java) { CliRelease.parseChecksums("x".repeat(64 * 1024 + 1)) }
    }

    @Test
    fun `archive names follow the release's, per platform`() {
        val names = Binary.targets.mapValues { (_, target) -> CliRelease.archiveName("0.2.4", target) }
        assertEquals(
            mapOf(
                "darwin-arm64" to "kete-0.2.4-darwin-arm64.zip",
                "darwin-x64" to "kete-0.2.4-darwin-x64-baseline.zip",
                "linux-x64" to "kete-0.2.4-linux-x64-baseline.tar.gz",
                "linux-arm64" to "kete-0.2.4-linux-arm64.tar.gz",
                "windows-x64" to "kete-0.2.4-windows-x64-baseline.zip",
                "windows-arm64" to "kete-0.2.4-windows-arm64.zip",
            ),
            names,
        )
        assertEquals(
            "https://github.com/kete-org/kete-releases/releases/download/kete-v0.3.0-rc.1/SHA256SUMS",
            CliRelease.releaseUrl("0.3.0-rc.1", "SHA256SUMS"),
        )
    }

    @Test
    fun `versions are release versions only`() {
        for (good in listOf("0.2.4", "1.0.0-rc.1", "0.0.0-test.30")) assertTrue(CliRelease.isVersion(good), good)
        for (bad in listOf("0.2", "v0.2.4", "0.2.4/../x", "01.2.3", "0.2.4-", "")) assertFalse(CliRelease.isVersion(bad), bad)
    }

    @Test
    fun `keys are parsed strictly`() {
        val encoded = Base64.getEncoder().encodeToString(signer.raw)
        assertEquals("k", CliRelease.parseKeys("""{"keys":[{"id":"k","publicKey":"$encoded"}]}""").single().id)
        for (bad in listOf("{}", """{"keys":[{"id":"k"}]}""", """{"keys":[{"id":"","publicKey":"$encoded"}]}""", """{"keys":[{"id":"k","publicKey":"AAAA"}]}"""))
            assertThrows(CliRelease.VerifyException::class.java, { CliRelease.parseKeys(bad) }, bad)
        assertTrue(CliRelease.pinnedKeys().isNotEmpty())
    }
}
