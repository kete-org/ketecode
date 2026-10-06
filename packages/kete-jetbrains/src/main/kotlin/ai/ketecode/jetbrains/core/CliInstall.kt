package ai.ketecode.jetbrains.core

import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.archivers.zip.ZipFile
import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

// Downloads, verifies and installs the `kete` of one public release for this platform (the Marketplace
// build of the plugin carries none; see Binary.kt). Mirrors `kete upgrade`'s install
// (packages/cli/src/kete/updater.ts), in this order, failing closed at every step:
//
//   1. under a file lock in the download root (two IDE processes never race; one in-process download
//      at a time is the caller's job), re-check: another process may have finished it already;
//   2. fetch SHA256SUMS (≤ 64 KB) and SHA256SUMS.sig (exactly 64 bytes) and verify the signature
//      against the pinned keys (CliRelease), then find the archive's line;
//   3. stream the archive (≤ 300 MB) into a staging folder inside the root, hashing as it goes, and
//      compare with the signed SHA-256;
//   4. extract only kete/kete.exe (the archive is refused if any entry has an absolute name, `..`,
//      or is a link, or if a name appears twice; kete ≤ 1 GiB), make it executable and check it
//      reports the release's version;
//   5. move the platform folder into <root>/<version>/ in one atomic rename (retried briefly when
//      Windows reports the fresh kete.exe busy, e.g. an antivirus scan), and remove every other
//      downloaded version.
//
// Nothing reaches <root>/<version>/<platform>/ unless every check passed, so Binary.resolve can trust
// what it finds there; the staging folder is deleted whatever happens. The network (HTTPS only), the
// version probe and cancellation are injected, so this file has no IntelliJ dependency and is unit-tested.

class CliInstall(
    private val root: Path,
    private val keys: List<CliRelease.PinnedKey>,
    private val fetcher: Fetcher,
    private val windows: Boolean,
    /** Runs `<binary> --version` and returns its output; null skips the check (tests of other steps). */
    private val probe: ((Path) -> String)?,
    private val limits: Limits = Limits(),
    /** The final rename; injectable so tests can simulate Windows' "file in use". */
    private val move: (Path, Path) -> Unit = { from, to -> Files.move(from, to, StandardCopyOption.ATOMIC_MOVE) },
    private val sleep: (Long) -> Unit = Thread::sleep,
) {
    data class Limits(
        val checksums: Int = CliRelease.MAX_CHECKSUMS_BYTES,
        val archive: Long = 300L * 1024 * 1024,
        val binary: Long = 1024L * 1024 * 1024,
    )

    /** GETs an HTTPS URL. The IDE's implementation honours its proxy settings and refuses non-HTTPS redirects. */
    interface Fetcher {
        /** Hands the response body and its length (-1 when unknown) to `read`. Throws [FetchException] for HTTP errors. */
        fun <T> get(url: String, read: (InputStream, Long) -> T): T
    }

    class FetchException(message: String, val status: Int? = null, cause: Throwable? = null) : IOException(message, cause)

    enum class Failure { NETWORK, NOT_FOUND, VERIFY, IO }

    class InstallException(val failure: Failure, message: String, cause: Throwable? = null) : Exception(message, cause)

    interface Progress {
        /** Throws (the IDE's ProcessCanceledException) when the user cancelled. */
        fun checkCanceled() {}
        fun step(text: String) {}
        fun fraction(value: Double) {}
    }

    private val executable get() = Binary.executableName(windows)

    /** Installs `download` (from Binary.resolve) and returns the verified binary's path. */
    fun install(download: Binary.Resolved.Download, progress: Progress): Path {
        val version = download.version
        if (!CliRelease.isVersion(version)) throw InstallException(Failure.VERIFY, "Not a release version: $version")
        val final = Path.of(download.path)
        val versionDir = Path.of(download.directory)
        if (versionDir.parent != root || final.parent?.parent != versionDir || final.fileName.toString() != executable)
            throw InstallException(Failure.IO, "Unexpected download location ${download.path}")
        io("create $root") { Files.createDirectories(root) }
        return locked(progress) {
            if (Files.isRegularFile(final, LinkOption.NOFOLLOW_LINKS)) return@locked final
            removeStaging()
            val staging = io("create a staging folder in $root") { Files.createTempDirectory(root, STAGING_PREFIX) }
            try {
                progress.step("Checking the signature of Kete Code $version")
                val checksums = fetchBytes(CliRelease.releaseUrl(version, "SHA256SUMS"), limits.checksums, version)
                progress.checkCanceled()
                val signature = fetchBytes(CliRelease.releaseUrl(version, "SHA256SUMS.sig"), CliRelease.SIGNATURE_BYTES, version)
                val archiveName = CliRelease.archiveName(version, download.target)
                val sha256 = try {
                    CliRelease.verifiedChecksum(checksums, signature, keys, archiveName)
                } catch (error: CliRelease.VerifyException) {
                    throw InstallException(Failure.VERIFY, error.message ?: "verification failed", error)
                }
                val archive = staging.resolve(archiveName)
                progress.step("Downloading $archiveName")
                downloadArchive(CliRelease.releaseUrl(version, archiveName), archive, sha256, version, progress)
                progress.step("Unpacking $archiveName")
                progress.fraction(1.0)
                val platformDir = staging.resolve("out").resolve(download.platform)
                io("create $platformDir") { Files.createDirectories(platformDir) }
                val binary = platformDir.resolve(executable)
                try {
                    Archives.extract(archive, executable, binary, limits.binary, progress::checkCanceled)
                } catch (error: Archives.UnsafeArchive) {
                    throw InstallException(Failure.VERIFY, "$archiveName: ${error.message}", error)
                }
                io("delete $archive") { Files.delete(archive) }
                if (!windows && !binary.toFile().setExecutable(true, false))
                    throw InstallException(Failure.IO, "Couldn't make $binary executable")
                if (probe != null) {
                    progress.step("Checking the downloaded kete")
                    val reported = try {
                        probe.invoke(binary)
                    } catch (error: IOException) {
                        throw InstallException(Failure.VERIFY, "The downloaded kete doesn't run on this machine: ${error.message}", error)
                    }
                    if (reported.split(Regex("\\s+")).none { it == version || it == "v$version" })
                        throw InstallException(Failure.VERIFY, "The downloaded kete reports \"${reported.trim().take(80)}\", not $version.")
                }
                io("install into $versionDir") {
                    Files.createDirectories(versionDir)
                    val destination = versionDir.resolve(download.platform)
                    // A leftover without a binary (checked above) from an interrupted older layout.
                    if (Files.exists(destination, LinkOption.NOFOLLOW_LINKS)) deleteTree(destination)
                    moveIntoPlace(platformDir, destination, progress)
                }
                removeOtherVersions(version)
                final
            } finally {
                runCatching { deleteTree(staging) }
            }
        }
    }

    /**
     * The atomic rename, retried up to [MOVE_ATTEMPTS] times with a growing pause when the file system
     * says the files are busy (Windows: an antivirus scanner or the indexer holding the kete.exe we just
     * ran). Never falls back to a non-atomic copy.
     */
    private fun moveIntoPlace(from: Path, to: Path, progress: Progress) {
        var attempt = 1
        while (true) {
            try {
                move(from, to)
                return
            } catch (error: AtomicMoveNotSupportedException) {
                throw IOException("the file system can't move $from into place atomically", error)
            } catch (error: java.nio.file.FileSystemException) {
                if (attempt >= MOVE_ATTEMPTS) throw error
                progress.step("Waiting for the downloaded kete to be released (attempt $attempt of $MOVE_ATTEMPTS)")
                progress.checkCanceled()
                sleep(200L shl (attempt - 1))
                progress.checkCanceled()
                attempt++
            }
        }
    }

    private fun <T> locked(progress: Progress, body: () -> T): T {
        val channel = io("open the download lock") {
            FileChannel.open(root.resolve(LOCK_FILE), StandardOpenOption.CREATE, StandardOpenOption.WRITE)
        }
        channel.use {
            var lock: FileLock? = null
            var announced = false
            while (lock == null) {
                lock = try {
                    channel.tryLock()
                } catch (_: OverlappingFileLockException) {
                    null // this IDE process holds it (another download in this JVM): wait for it too
                } catch (error: IOException) {
                    throw InstallException(Failure.IO, "Couldn't lock $root: ${error.message}", error)
                }
                if (lock == null) {
                    if (!announced) progress.step("Waiting for another download of kete to finish")
                    announced = true
                    progress.checkCanceled()
                    Thread.sleep(250)
                }
            }
            try {
                return body()
            } finally {
                runCatching { lock.release() }
            }
        }
    }

    private fun removeStaging() {
        val stale = io("list $root") { Files.list(root).use { list -> list.filter { it.fileName.toString().startsWith(STAGING_PREFIX) }.toList() } }
        for (path in stale) runCatching { deleteTree(path) }
    }

    /** Every downloaded version but `keep` (best effort: on Windows a running kete.exe can't be deleted; a later install retries). */
    private fun removeOtherVersions(keep: String) {
        val others = runCatching {
            Files.list(root).use { list ->
                list.filter { isPlainDirectory(it) && CliRelease.isVersion(it.fileName.toString()) && it.fileName.toString() != keep }.toList()
            }
        }.getOrDefault(emptyList())
        for (path in others) runCatching { deleteTree(path) }
    }

    private fun failure(url: String, error: IOException, version: String): InstallException =
        if (error is FetchException && error.status == 404)
            InstallException(Failure.NOT_FOUND, "Kete Code $version has no public release at ${CliRelease.RELEASES} ($url returned HTTP 404).", error)
        else InstallException(Failure.NETWORK, "Could not download $url: ${error.message}", error)

    private fun fetchBytes(url: String, limit: Int, version: String): ByteArray = try {
        fetcher.get(url) { input, length ->
            if (length > limit) throw InstallException(Failure.VERIFY, "$url is larger than expected ($length bytes).")
            val bytes = input.readNBytes(limit + 1)
            if (bytes.size > limit) throw InstallException(Failure.VERIFY, "$url is larger than expected.")
            bytes
        }
    } catch (error: IOException) {
        throw failure(url, error, version)
    }

    private fun downloadArchive(url: String, file: Path, sha256: String, version: String, progress: Progress) {
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            fetcher.get(url) { input, length ->
                if (length > limits.archive) throw InstallException(Failure.VERIFY, "$url is larger than ${limits.archive} bytes.")
                Files.newOutputStream(file, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        progress.checkCanceled()
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > limits.archive) throw InstallException(Failure.VERIFY, "$url is larger than ${limits.archive} bytes.")
                        digest.update(buffer, 0, read)
                        out.write(buffer, 0, read)
                        if (length > 0) progress.fraction(total.toDouble() / length)
                    }
                }
            }
        } catch (error: IOException) {
            throw failure(url, error, version)
        }
        val actual = CliRelease.sha256Hex(digest)
        if (actual != sha256)
            throw InstallException(Failure.VERIFY, "The downloaded archive's SHA-256 ($actual) doesn't match the signed SHA256SUMS ($sha256).")
    }

    private fun <T> io(what: String, body: () -> T): T = try {
        body()
    } catch (error: IOException) {
        throw InstallException(Failure.IO, "Couldn't $what: ${error.message}", error)
    }

    companion object {
        const val STAGING_PREFIX = ".download-"
        const val LOCK_FILE = ".lock"
        const val MOVE_ATTEMPTS = 5

        private fun attributes(path: Path): BasicFileAttributes? =
            runCatching { Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS) }.getOrNull()

        /** A real directory: not a symlink, and not a Windows junction (which the JDK reports as a directory that is also "other"). */
        private fun isPlainDirectory(path: Path): Boolean = attributes(path)?.let { it.isDirectory && !it.isSymbolicLink && !it.isOther } == true

        /**
         * Deletes a folder tree without following links: a symlink or Windows junction is removed itself,
         * never descended into, so its target is never touched.
         */
        fun deleteTree(path: Path) {
            val top = attributes(path) ?: return
            if (top.isSymbolicLink || top.isOther || !top.isDirectory) {
                Files.delete(path)
                return
            }
            Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    if (attrs.isSymbolicLink || attrs.isOther) {
                        Files.delete(dir)
                        return FileVisitResult.SKIP_SUBTREE
                    }
                    return FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.delete(file)
                    return FileVisitResult.CONTINUE
                }

                override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
                    if (exc != null) throw exc
                    Files.delete(dir)
                    return FileVisitResult.CONTINUE
                }
            })
        }
    }
}

/** Extracts one member of a release archive, refusing anything unsafe (Apache Commons Compress, bundled with the IntelliJ Platform). */
object Archives {
    class UnsafeArchive(message: String) : IOException(message)

    /** The entry name with `./` and empty segments removed; absolute names and `..` are refused. */
    fun safeName(raw: String): String {
        val name = raw.replace('\\', '/')
        if (name.startsWith("/") || Regex("^[A-Za-z]:").containsMatchIn(name)) throw UnsafeArchive("absolute entry name \"${raw.take(120)}\"")
        val segments = name.split('/').filter { it.isNotEmpty() && it != "." }
        if (".." in segments) throw UnsafeArchive("entry name with \"..\": \"${raw.take(120)}\"")
        return segments.joinToString("/")
    }

    /** Writes `member` (a regular file at the archive's top level, ≤ `limit` bytes) to `out`, which must not exist. */
    fun extract(archive: Path, member: String, out: Path, limit: Long, checkCanceled: () -> Unit = {}) {
        val name = archive.fileName.toString()
        when {
            name.endsWith(".zip") -> extractZip(archive, member, out, limit, checkCanceled)
            name.endsWith(".tar.gz") -> extractTarGz(archive, member, out, limit, checkCanceled)
            else -> throw UnsafeArchive("unknown archive type")
        }
    }

    @Suppress("DEPRECATION") // ZipFile(Path): the builder API is newer than the oldest supported IDE's Commons Compress
    private fun extractZip(archive: Path, member: String, out: Path, limit: Long, checkCanceled: () -> Unit) {
        ZipFile(archive).use { zip ->
            var found: org.apache.commons.compress.archivers.zip.ZipArchiveEntry? = null
            val names = HashSet<String>()
            for (entry in zip.entries) {
                val name = safeName(entry.name)
                if (entry.isUnixSymlink) throw UnsafeArchive("the archive contains a link (\"${entry.name.take(120)}\")")
                if (name.isNotEmpty() && !names.add(name.removeSuffix("/"))) throw UnsafeArchive("\"${name.take(120)}\" appears twice")
                if (name != member) continue
                if (entry.isDirectory) throw UnsafeArchive("$member is not a regular file")
                if (entry.size > limit) throw UnsafeArchive("$member is larger than $limit bytes")
                found = entry
            }
            val entry = found ?: throw UnsafeArchive("no $member in the archive")
            zip.getInputStream(entry).use { copy(it, out, limit, member, checkCanceled) }
        }
    }

    private fun extractTarGz(archive: Path, member: String, out: Path, limit: Long, checkCanceled: () -> Unit) {
        TarArchiveInputStream(GZIPInputStream(BufferedInputStream(Files.newInputStream(archive)))).use { tar ->
            var found = false
            val names = HashSet<String>()
            while (true) {
                checkCanceled()
                val entry = tar.nextEntry ?: break
                val name = safeName(entry.name)
                if (entry.isSymbolicLink || entry.isLink) throw UnsafeArchive("the archive contains a link (\"${entry.name.take(120)}\")")
                if (name.isNotEmpty() && !names.add(name)) throw UnsafeArchive("\"${name.take(120)}\" appears twice")
                if (name != member) continue
                if (!entry.isFile) throw UnsafeArchive("$member is not a regular file")
                if (entry.size > limit) throw UnsafeArchive("$member is larger than $limit bytes")
                copy(tar, out, limit, member, checkCanceled)
                found = true
            }
            if (!found) throw UnsafeArchive("no $member in the archive")
        }
    }

    private fun copy(input: InputStream, out: Path, limit: Long, member: String, checkCanceled: () -> Unit) {
        Files.newOutputStream(out, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { output ->
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                checkCanceled()
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > limit) throw UnsafeArchive("$member is larger than $limit bytes")
                output.write(buffer, 0, read)
            }
            if (total == 0L) throw UnsafeArchive("$member is empty")
        }
    }
}
