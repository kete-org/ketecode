package ai.ketecode.jetbrains.core

import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.archivers.tar.TarConstants
import org.apache.commons.compress.archivers.zip.ZipArchiveEntry
import org.apache.commons.compress.archivers.zip.ZipArchiveOutputStream
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.zip.GZIPOutputStream

class CliInstallTest {
    @TempDir
    lateinit var temp: Path

    private val binary = "#!/bin/sh\necho kete v0.2.4\n".toByteArray()

    // ---------------------------------------------------------------------------------------------
    // Archives

    private data class Entry(val name: String, val bytes: ByteArray = ByteArray(0), val symlink: String? = null, val directory: Boolean = false)

    private fun zip(vararg entries: Entry): ByteArray {
        val out = ByteArrayOutputStream()
        ZipArchiveOutputStream(out).use { zip ->
            for (entry in entries) {
                val item = ZipArchiveEntry(entry.name)
                if (entry.symlink != null) item.unixMode = 0b1010_000_111_111_111 // S_IFLNK | 0777
                zip.putArchiveEntry(item)
                zip.write(entry.symlink?.toByteArray() ?: entry.bytes)
                zip.closeArchiveEntry()
            }
        }
        return out.toByteArray()
    }

    private fun tarGz(vararg entries: Entry): ByteArray {
        val out = ByteArrayOutputStream()
        TarArchiveOutputStream(GZIPOutputStream(out)).use { tar ->
            tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX)
            for (entry in entries) {
                val item = when {
                    // preserveAbsolutePath: keep hostile names as they are, so the reader sees them.
                    entry.symlink != null -> TarArchiveEntry(entry.name, TarConstants.LF_SYMLINK, true).apply { linkName = entry.symlink }
                    entry.directory -> TarArchiveEntry(entry.name + "/", true)
                    else -> TarArchiveEntry(entry.name, true).apply { size = entry.bytes.size.toLong() }
                }
                tar.putArchiveEntry(item)
                if (entry.symlink == null && !entry.directory) tar.write(entry.bytes)
                tar.closeArchiveEntry()
            }
        }
        return out.toByteArray()
    }

    private fun extract(name: String, bytes: ByteArray, member: String = "kete", limit: Long = 1024): Path {
        val archive = temp.resolve(name)
        Files.write(archive, bytes)
        val out = temp.resolve("out-${System.nanoTime()}")
        Archives.extract(archive, member, out, limit)
        return out
    }

    @Test
    fun `extracts only the kete entry from a zip or a tar_gz`() {
        val fromZip = extract("a.zip", zip(Entry("README.md", "x".toByteArray()), Entry("kete", binary)))
        assertArrayEquals(binary, Files.readAllBytes(fromZip))
        val fromTar = extract("a.tar.gz", tarGz(Entry(".", directory = true), Entry("./kete", binary), Entry("LICENSE", "y".toByteArray())))
        assertArrayEquals(binary, Files.readAllBytes(fromTar))
        val exe = extract("w.zip", zip(Entry("kete.exe", binary)), member = "kete.exe")
        assertArrayEquals(binary, Files.readAllBytes(exe))
    }

    @Test
    fun `refuses zip-slip and absolute entry names anywhere in the archive`() {
        for (name in listOf("../kete", "bin/../../kete", "/kete", "/etc/passwd", "C:/kete", "..\\kete")) {
            assertThrows(Archives.UnsafeArchive::class.java, { extract("a.zip", zip(Entry("kete", binary), Entry(name, binary))) }, name)
            assertThrows(Archives.UnsafeArchive::class.java, { extract("a.tar.gz", tarGz(Entry(name, binary), Entry("kete", binary))) }, name)
        }
    }

    @Test
    fun `refuses a kete that is a link, a duplicate, empty, missing or too large`() {
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.zip", zip(Entry("kete", symlink = "/bin/sh"))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.tar.gz", tarGz(Entry("kete", symlink = "/bin/sh"))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.zip", zip(Entry("kete", binary), Entry("./kete", binary))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.tar.gz", tarGz(Entry("kete", binary), Entry("kete", binary))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.zip", zip(Entry("kete", ByteArray(0)))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.zip", zip(Entry("other", binary))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.tar.gz", tarGz(Entry("bin/kete", binary))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.zip", zip(Entry("kete", ByteArray(2048))), limit = 1024) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.tar.gz", tarGz(Entry("kete", ByteArray(2048))), limit = 1024) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.rar", ByteArray(10)) }
        // Links and duplicate names anywhere in the archive, not only for kete.
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.zip", zip(Entry("kete", binary), Entry("LICENSE", symlink = "/etc/passwd"))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.tar.gz", tarGz(Entry("kete", binary), Entry("NOTICE", symlink = "../x"))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.zip", zip(Entry("kete", binary), Entry("LICENSE"), Entry("./LICENSE"))) }
        assertThrows(Archives.UnsafeArchive::class.java) { extract("a.tar.gz", tarGz(Entry("LICENSE"), Entry("LICENSE"), Entry("kete", binary))) }
    }

    // ---------------------------------------------------------------------------------------------
    // Install

    private val signer = TestSigner()

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** A fake release host: URL → body (or an HTTP status). Records what was fetched. */
    private class FakeFetcher(
        val files: MutableMap<String, ByteArray>,
        val status: Map<String, Int> = emptyMap(),
        /** Like a chunked response: no Content-Length. */
        val unknownLength: Boolean = false,
    ) : CliInstall.Fetcher {
        val fetched = ArrayList<String>()
        override fun <T> get(url: String, read: (InputStream, Long) -> T): T {
            fetched.add(url)
            status[url]?.let { throw CliInstall.FetchException("$url returned HTTP $it", it) }
            val body = files[url] ?: throw CliInstall.FetchException("$url returned HTTP 404", 404)
            return read(body.inputStream(), if (unknownLength) -1 else body.size.toLong())
        }
    }

    private val version = "0.2.4"
    private val target = "darwin-arm64"
    private val archiveName = "kete-0.2.4-darwin-arm64.zip"
    private fun url(file: String) = CliRelease.releaseUrl(version, file)

    private fun release(archive: ByteArray = zip(Entry("kete", binary)), listed: ByteArray = archive): MutableMap<String, ByteArray> {
        val sums = "${sha256(listed)}  $archiveName\n${"0".repeat(64)}  install.sh\n".toByteArray()
        return mutableMapOf(url("SHA256SUMS") to sums, url("SHA256SUMS.sig") to signer.sign(sums), url(archiveName) to archive)
    }

    private val root get() = temp.resolve("cli")

    private fun need(): Binary.Resolved.Download {
        val resolved = Binary.resolve("/plugin", null, "Mac OS X", "aarch64", FakeFiles(), downloadRoot = root.toString(), version = version)
        return resolved as Binary.Resolved.Download
    }

    private class FakeFiles : Binary.Files {
        override fun isFile(path: String) = false
        override fun canExecute(path: String) = false
        override fun makeExecutable(path: String) = false
    }

    private fun installer(
        fetcher: CliInstall.Fetcher,
        probe: ((Path) -> String)? = { "kete v0.2.4\n" },
        limits: CliInstall.Limits = CliInstall.Limits(),
        move: (Path, Path) -> Unit = { from, to -> Files.move(from, to, java.nio.file.StandardCopyOption.ATOMIC_MOVE) },
        sleep: (Long) -> Unit = {},
    ) = CliInstall(root, listOf(signer.pinned), fetcher, windows = false, probe = probe, limits = limits, move = move, sleep = sleep)

    private fun leftovers(): List<String> =
        if (!Files.exists(root)) emptyList() else Files.walk(root).use { walk -> walk.map { root.relativize(it).toString() }.filter { it.isNotEmpty() && it != ".lock" }.toList() }

    @Test
    fun `installs a verified binary where Binary resolve finds it`() {
        val fetcher = FakeFetcher(release())
        val steps = ArrayList<String>()
        val path = installer(fetcher).install(need(), object : CliInstall.Progress {
            override fun step(text: String) {
                steps.add(text)
            }
        })
        assertEquals(root.resolve("0.2.4").resolve("darwin-arm64").resolve("kete"), path)
        assertArrayEquals(binary, Files.readAllBytes(path))
        assertTrue(Files.isExecutable(path))
        assertEquals(listOf(url("SHA256SUMS"), url("SHA256SUMS.sig"), url(archiveName)), fetcher.fetched)
        assertEquals(listOf("0.2.4", "0.2.4/darwin-arm64", "0.2.4/darwin-arm64/kete"), leftovers().sorted())
        assertTrue(steps.isNotEmpty())
        val resolved = Binary.resolve("/plugin", null, "Mac OS X", "aarch64", Binary.RealFiles, downloadRoot = root.toString(), version = version)
        assertEquals(Binary.Resolved.Ok(path.toString(), "downloaded"), resolved)
        // Installed already: nothing is fetched again.
        val again = FakeFetcher(mutableMapOf())
        assertEquals(path, installer(again).install(need(), object : CliInstall.Progress {}))
        assertTrue(again.fetched.isEmpty())
    }

    @Test
    fun `removes other downloaded versions and stale staging folders after installing`() {
        Files.createDirectories(root.resolve("0.2.3").resolve("darwin-arm64"))
        Files.write(root.resolve("0.2.3").resolve("darwin-arm64").resolve("kete"), binary)
        Files.createDirectories(root.resolve(".download-123"))
        Files.createDirectories(root.resolve("notes")) // not a version folder: left alone
        installer(FakeFetcher(release())).install(need(), object : CliInstall.Progress {})
        assertEquals(listOf("0.2.4", "0.2.4/darwin-arm64", "0.2.4/darwin-arm64/kete", "notes"), leftovers().sorted())
    }

    private fun assertRefused(failure: CliInstall.Failure, files: MutableMap<String, ByteArray>, status: Map<String, Int> = emptyMap(), probe: ((Path) -> String)? = { "kete v0.2.4" }): CliInstall.InstallException {
        val error = assertThrows(CliInstall.InstallException::class.java) {
            installer(FakeFetcher(files, status), probe).install(need(), object : CliInstall.Progress {})
        }
        assertEquals(failure, error.failure, error.message)
        assertEquals(emptyList<String>(), leftovers(), "nothing may be left behind")
        return error
    }

    @Test
    fun `a checksum mismatch installs nothing`() {
        val error = assertRefused(CliInstall.Failure.VERIFY, release(archive = zip(Entry("kete", "evil".toByteArray())), listed = zip(Entry("kete", binary))))
        assertTrue(error.message!!.contains("doesn't match"))
    }

    @Test
    fun `a bad signature installs nothing and never fetches the archive`() {
        val files = release()
        files[url("SHA256SUMS.sig")] = TestSigner("attacker").sign(files.getValue(url("SHA256SUMS")))
        val fetcher = FakeFetcher(files)
        assertThrows(CliInstall.InstallException::class.java) { installer(fetcher).install(need(), object : CliInstall.Progress {}) }
        assertFalse(fetcher.fetched.contains(url(archiveName)))
        assertRefused(CliInstall.Failure.VERIFY, files)
    }

    @Test
    fun `a tampered SHA256SUMS, an oversized signature or a release without this archive is refused`() {
        val tampered = release()
        tampered[url("SHA256SUMS")] = tampered.getValue(url("SHA256SUMS")) + "\n".toByteArray()
        assertRefused(CliInstall.Failure.VERIFY, tampered)
        val long = release()
        long[url("SHA256SUMS.sig")] = long.getValue(url("SHA256SUMS.sig")) + 0
        assertRefused(CliInstall.Failure.VERIFY, long)
        val other = mutableMapOf<String, ByteArray>()
        val sums = "${"1".repeat(64)}  kete-0.2.4-linux-arm64.tar.gz\n".toByteArray()
        other[url("SHA256SUMS")] = sums
        other[url("SHA256SUMS.sig")] = signer.sign(sums)
        assertTrue(assertRefused(CliInstall.Failure.VERIFY, other).message!!.contains("doesn't list"))
    }

    @Test
    fun `a version without a public release, or a network failure, says so`() {
        assertTrue(assertRefused(CliInstall.Failure.NOT_FOUND, mutableMapOf()).message!!.contains("no public release"))
        assertRefused(CliInstall.Failure.NETWORK, release(), status = mapOf(url(archiveName) to 503))
    }

    @Test
    fun `an archive over the size cap is refused`() {
        val error = assertThrows(CliInstall.InstallException::class.java) {
            installer(FakeFetcher(release()), limits = CliInstall.Limits(archive = 10)).install(need(), object : CliInstall.Progress {})
        }
        assertEquals(CliInstall.Failure.VERIFY, error.failure)
        assertEquals(emptyList<String>(), leftovers())
    }

    @Test
    fun `the size cap holds while streaming when the length is unknown`() {
        for (limits in listOf(CliInstall.Limits(archive = 10), CliInstall.Limits(checksums = 10))) {
            val error = assertThrows(CliInstall.InstallException::class.java) {
                installer(FakeFetcher(release(), unknownLength = true), limits = limits).install(need(), object : CliInstall.Progress {})
            }
            assertEquals(CliInstall.Failure.VERIFY, error.failure, error.message)
            assertTrue(error.message!!.contains("larger than"), error.message)
            assertEquals(emptyList<String>(), leftovers())
        }
        // And a normal install works without a length.
        installer(FakeFetcher(release(), unknownLength = true)).install(need(), object : CliInstall.Progress {})
    }

    @Test
    fun `the final move is retried while Windows reports the files busy, then gives up`() {
        var failures = 3
        val pauses = ArrayList<Long>()
        val flaky: (Path, Path) -> Unit = { from, to ->
            if (failures-- > 0) throw java.nio.file.AccessDeniedException(from.toString())
            Files.move(from, to, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
        }
        val path = installer(FakeFetcher(release()), move = flaky, sleep = { pauses.add(it) }).install(need(), object : CliInstall.Progress {})
        assertArrayEquals(binary, Files.readAllBytes(path))
        assertEquals(listOf(200L, 400L, 800L), pauses)

        CliInstall.deleteTree(root)
        var attempts = 0
        val stuck: (Path, Path) -> Unit = { from, _ ->
            attempts++
            throw java.nio.file.FileSystemException(from.toString(), null, "The process cannot access the file because it is being used by another process")
        }
        val error = assertThrows(CliInstall.InstallException::class.java) {
            installer(FakeFetcher(release()), move = stuck).install(need(), object : CliInstall.Progress {})
        }
        assertEquals(CliInstall.Failure.IO, error.failure)
        assertEquals(CliInstall.MOVE_ATTEMPTS, attempts)
        assertFalse(Files.exists(Path.of(need().path)), "no binary where resolve would find it")

        // Cancelling while it waits stops it.
        class Cancelled : RuntimeException()
        CliInstall.deleteTree(root)
        assertThrows(Cancelled::class.java) {
            installer(FakeFetcher(release()), move = stuck, sleep = { throw Cancelled() }).install(need(), object : CliInstall.Progress {})
        }
    }

    @Test
    fun `deleting a tree never follows a link into its target`() {
        val outside = Files.createDirectories(temp.resolve("outside"))
        Files.write(outside.resolve("keep.txt"), "keep".toByteArray())
        val tree = Files.createDirectories(temp.resolve("tree").resolve("a"))
        Files.write(tree.resolve("file"), "x".toByteArray())
        Files.createSymbolicLink(tree.resolve("link-to-dir"), outside)
        Files.createSymbolicLink(tree.resolve("link-to-file"), outside.resolve("keep.txt"))
        CliInstall.deleteTree(temp.resolve("tree"))
        assertFalse(Files.exists(temp.resolve("tree"), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertEquals("keep", Files.readString(outside.resolve("keep.txt")))
        // A link given as the tree itself is removed, not its target.
        val link = Files.createSymbolicLink(temp.resolve("top-link"), outside)
        CliInstall.deleteTree(link)
        assertFalse(Files.exists(link, java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertTrue(Files.exists(outside.resolve("keep.txt")))
    }

    @Test
    fun `a version folder that is a link is never removed as an old version`() {
        val outside = Files.createDirectories(temp.resolve("elsewhere").resolve("darwin-arm64"))
        Files.write(outside.resolve("kete"), binary)
        Files.createDirectories(root)
        Files.createSymbolicLink(root.resolve("0.2.3"), outside.parent)
        installer(FakeFetcher(release())).install(need(), object : CliInstall.Progress {})
        assertTrue(Files.exists(outside.resolve("kete")))
    }

    @Test
    fun `an unsafe archive or a binary reporting another version is refused`() {
        assertRefused(CliInstall.Failure.VERIFY, release(archive = zip(Entry("kete", binary), Entry("../evil", binary))))
        assertRefused(CliInstall.Failure.VERIFY, release(), probe = { "kete v0.2.3" })
        assertRefused(CliInstall.Failure.VERIFY, release(), probe = { throw java.io.IOException("exec format error") })
    }

    @Test
    fun `cancellation stops the install and leaves nothing`() {
        class Cancelled : RuntimeException()
        var calls = 0
        assertThrows(Cancelled::class.java) {
            installer(FakeFetcher(release())).install(need(), object : CliInstall.Progress {
                override fun checkCanceled() {
                    if (++calls > 1) throw Cancelled()
                }
            })
        }
        assertEquals(emptyList<String>(), leftovers())
    }
}
