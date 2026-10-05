package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.Base64

class StartLineTest {
    @Test
    fun `accepts only loopback http URLs`() {
        assertEquals("http://127.0.0.1:4096", StartLine.parseUrl("""{"url":"http://127.0.0.1:4096"}"""))
        assertEquals("http://localhost:1", StartLine.parseUrl("""{"url":"http://localhost:1/"}"""))
        assertEquals("http://[::1]:8080", StartLine.parseUrl("""{"url":"http://[::1]:8080"}"""))
        assertNull(StartLine.parseUrl("""{"url":"https://127.0.0.1:4096"}"""))
        assertNull(StartLine.parseUrl("""{"url":"http://example.com:4096"}"""))
        assertNull(StartLine.parseUrl("""{"url":"http://user:pw@127.0.0.1:1"}"""))
        assertNull(StartLine.parseUrl("""{"url":"http://127.0.0.1.evil.com:1"}"""))
        assertNull(StartLine.parseUrl("""{"other":"x"}"""))
        assertNull(StartLine.parseUrl("not json"))
        assertNull(StartLine.parseUrl("""{"url": 5}"""))
    }

    @Test
    fun `finds the start line among other output`() {
        assertEquals("""{"url":"http://127.0.0.1:1"}""", StartLine.find("migrating…\r\n{\"url\":\"http://127.0.0.1:1\"}\n"))
        assertNull(StartLine.find("starting\n"))
    }
}

class PairingTest {
    @Test
    fun `the password is only in the fragment, with the JetBrains host flag in the query`() {
        val url = Pairing.url("http://127.0.0.1:4096", "s3cret/+=")
        val (before, fragment) = url.split("#", limit = 2)
        assertEquals("http://127.0.0.1:4096/connect?kete-host=jetbrains", before)
        assertFalse(before.contains("s3cret"))
        val decoded = String(Base64.getUrlDecoder().decode(fragment))
        assertEquals(mapOf("username" to "opencode", "password" to "s3cret/+="), Json.parse(decoded))
        assertFalse(fragment.contains("="), "base64url without padding")
    }

    @Test
    fun `basic auth and origins`() {
        assertEquals("Basic " + Base64.getEncoder().encodeToString("opencode:pw".toByteArray()), Pairing.basic("pw"))
        assertEquals("http://127.0.0.1:5", Pairing.origin("http://127.0.0.1:5/session/abc#x"))
        assertNull(Pairing.origin("about:blank"))
    }
}

class BackoffTest {
    @Test
    fun `doubles from one second to thirty and gives up after five crashes in two minutes`() {
        val backoff = Backoff()
        assertEquals(Backoff.Decision.Retry(1, 1_000), backoff.crashed(0))
        assertEquals(Backoff.Decision.Retry(2, 2_000), backoff.crashed(10))
        assertEquals(Backoff.Decision.Retry(3, 4_000), backoff.crashed(20))
        assertEquals(Backoff.Decision.Retry(4, 8_000), backoff.crashed(30))
        assertEquals(Backoff.Decision.GiveUp(5), backoff.crashed(40))
    }

    @Test
    fun `old crashes fall out of the window and the delay is capped`() {
        val backoff = Backoff(initial = 10_000, max = 30_000, maxFailures = 10)
        backoff.crashed(0)
        backoff.crashed(1)
        assertEquals(Backoff.Decision.Retry(3, 30_000), backoff.crashed(2))
        assertEquals(Backoff.Decision.Retry(1, 10_000), backoff.crashed(500_000))
    }
}

class PathsTest {
    private val folder = System.getProperty("java.io.tmpdir") + "/kete-project"

    @Test
    fun `keeps paths inside the project`() {
        assertNotNull(Paths.insideWorkspace(folder, "src/app.ts"))
        assertTrue(Paths.insideWorkspace(folder, "src/../src/app.ts")!!.endsWith("src/app.ts"))
    }

    @Test
    fun `refuses traversal, absolute paths, drives and the folder itself`() {
        assertNull(Paths.insideWorkspace(folder, "../other/x"))
        assertNull(Paths.insideWorkspace(folder, "src/../../x"))
        assertNull(Paths.insideWorkspace(folder, "/etc/passwd"))
        assertNull(Paths.insideWorkspace(folder, "\\\\server\\share"))
        assertNull(Paths.insideWorkspace(folder, "C:\\Windows"))
        assertNull(Paths.insideWorkspace(folder, "c:x"))
        assertNull(Paths.insideWorkspace(folder, ""))
        assertNull(Paths.insideWorkspace(folder, "."))
        assertNull(Paths.insideWorkspace(folder, "a\u0000b"))
    }

    @Test
    fun `relative paths use forward slashes`() {
        assertEquals("src/main/App.kt", Paths.relative(folder, "$folder/src/main/App.kt"))
        assertNull(Paths.relative(folder, "$folder-other/x"))
        assertNull(Paths.relative(folder, folder))
    }
}

class ShellTest {
    @Test
    fun `quotes the binary for the terminal's shell`() {
        assertEquals("/opt/kete/bin/kete", Shell.quote("/opt/kete/bin/kete", false))
        assertEquals("'/Users/a b/kete'", Shell.quote("/Users/a b/kete", false))
        assertEquals("'/x/it'\\''s/kete'", Shell.quote("/x/it's/kete", false))
        assertEquals("'/x/\$(rm)/kete'", Shell.quote("/x/\$(rm)/kete", false))
        assertEquals("& \"C:\\Program Files\\kete.exe\"", Shell.quote("C:\\Program Files\\kete.exe", true))
    }
}
