package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * Opt-in: downloads a real public release and verifies it end to end with the real pinned keys, which
 * proves the JDK's Ed25519 path accepts the release workflow's signatures. Skipped unless
 *
 *   KETE_LIVE_RELEASE=0.2.4 ./gradlew test --tests '*CliLiveReleaseTest*'
 *
 * For this machine's platform it also runs the binary (`--version`). KETE_LIVE_TARGET=linux-arm64 (a
 * Binary.targets folder) checks another platform's archive instead (a tar.gz from a Mac, say), without
 * running it.
 *
 * The fetcher here is HttpURLConnection with the same rules as the IDE's (HTTPS on every hop, timeouts);
 * the plugin itself uses IntelliJ's HttpRequests, which needs a running IDE for its proxy settings.
 */
class CliLiveReleaseTest {
    @TempDir
    lateinit var temp: Path

    private object HttpsFetcher : CliInstall.Fetcher {
        override fun <T> get(url: String, read: (InputStream, Long) -> T): T {
            var current = url
            repeat(5) {
                if (!current.startsWith("https://")) throw IOException("refusing a non-HTTPS URL: $current")
                val connection = URI(current).toURL().openConnection() as HttpURLConnection
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 15_000
                connection.readTimeout = 60_000
                val status = connection.responseCode
                if (status in 300..399) {
                    current = URI(current).resolve(connection.getHeaderField("Location") ?: throw IOException("redirect without Location")).toString()
                    connection.disconnect()
                    return@repeat
                }
                if (status != 200) throw CliInstall.FetchException("$current returned HTTP $status", status)
                return connection.inputStream.use { read(it, connection.contentLengthLong) }
            }
            throw IOException("too many redirects from $url")
        }
    }

    @Test
    fun `downloads and verifies a real public release`() {
        val version = System.getProperty("kete.liveRelease")
        assumeTrue(!version.isNullOrBlank(), "set KETE_LIVE_RELEASE=<version> to run")
        val osName = System.getProperty("os.name")
        val host = Binary.platform(osName, System.getProperty("os.arch")) ?: error("no release platform for this machine")
        val platform = System.getProperty("kete.liveTarget")?.takeIf { it.isNotBlank() } ?: host
        val windows = platform.startsWith("windows")
        val root = temp.resolve("cli")
        val resolved = Binary.resolve(
            "/nonexistent-plugin",
            null,
            if (windows) "Windows 11" else if (platform.startsWith("darwin")) "Mac OS X" else "Linux",
            if (platform.endsWith("arm64")) "aarch64" else "amd64",
            Binary.RealFiles,
            downloadRoot = root.toString(),
            version = version,
        )
        val need = resolved as? Binary.Resolved.Download ?: error("expected a download, got $resolved")
        val runnable = platform == host
        val steps = ArrayList<String>()
        val path = CliInstall(
            root = root,
            keys = CliRelease.pinnedKeys(),
            fetcher = HttpsFetcher,
            windows = windows,
            probe = if (runnable) ::probe else null,
        ).install(need, object : CliInstall.Progress {
            override fun step(text: String) {
                steps.add(text)
                println("live: $text")
            }
        })
        assertEquals(Path.of(need.path), path)
        assertTrue(Files.isRegularFile(path) && Files.size(path) > 1_000_000, "a real kete binary")
        println("live: installed ${need.target} ($version) at $path, ${Files.size(path)} bytes; ran --version: $runnable")
    }

    private fun probe(binary: Path): String {
        val home = Files.createDirectories(temp.resolve("home"))
        val child = ProcessBuilder(binary.toString(), "--version")
            .redirectErrorStream(true)
            .apply { environment()["HOME"] = home.toString() }
            .start()
        child.outputStream.close()
        val output = child.inputStream.readNBytes(64 * 1024).toString(Charsets.UTF_8)
        if (!child.waitFor(60, TimeUnit.SECONDS)) {
            child.destroyForcibly()
            throw IOException("--version timed out")
        }
        println("live: --version → ${output.trim()}")
        return output
    }
}
