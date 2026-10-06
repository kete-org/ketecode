package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BinaryTest {
    private class FakeFiles(val files: Set<String>, val executable: Set<String> = files, val chmod: Boolean = true) : Binary.Files {
        val made = ArrayList<String>()
        override fun isFile(path: String) = path in files
        override fun canExecute(path: String) = path in executable
        override fun makeExecutable(path: String): Boolean {
            made.add(path)
            return chmod
        }
    }

    private fun bundled(platform: String, windows: Boolean = false) =
        listOf("/plugin", "bin", platform, if (windows) "kete.exe" else "kete").joinToString(File.separator)

    @Test
    fun `maps os name and architecture to the bundled folder`() {
        assertEquals("darwin-arm64", Binary.platform("Mac OS X", "aarch64"))
        assertEquals("darwin-x64", Binary.platform("Mac OS X", "x86_64"))
        assertEquals("linux-x64", Binary.platform("Linux", "amd64"))
        assertEquals("linux-arm64", Binary.platform("Linux", "aarch64"))
        assertEquals("windows-x64", Binary.platform("Windows 11", "amd64"))
        assertEquals("windows-arm64", Binary.platform("Windows 11", "aarch64"))
        assertNull(Binary.platform("FreeBSD", "amd64"))
        assertNull(Binary.platform("Linux", "riscv64"))
    }

    @Test
    fun `every bundled folder maps to a CLI target and belongs to exactly one platform zip`() {
        assertEquals(Binary.targets.keys, Binary.bundles.values.flatten().toSet())
        assertEquals(Binary.bundles.values.flatten().size, Binary.bundles.values.flatten().toSet().size)
    }

    @Test
    fun `uses the bundled binary for this platform`() {
        val path = bundled("linux-x64")
        val result = Binary.resolve("/plugin", null, "Linux", "amd64", FakeFiles(setOf(path)))
        assertEquals(Binary.Resolved.Ok(path, "bundled"), result)
        val windows = bundled("windows-arm64", windows = true)
        assertEquals(Binary.Resolved.Ok(windows, "bundled"), Binary.resolve("/plugin", "  ", "Windows 11", "aarch64", FakeFiles(setOf(windows), emptySet())))
    }

    @Test
    fun `restores a missing executable bit, and says so when it can't`() {
        val path = bundled("darwin-arm64")
        val files = FakeFiles(setOf(path), executable = emptySet())
        assertEquals(Binary.Resolved.Ok(path, "bundled"), Binary.resolve("/plugin", null, "Mac OS X", "aarch64", files))
        assertEquals(listOf(path), files.made)
        val stuck = Binary.resolve("/plugin", null, "Mac OS X", "aarch64", FakeFiles(setOf(path), emptySet(), chmod = false))
        assertTrue(stuck is Binary.Resolved.Error)
    }

    @Test
    fun `a build without this platform's binary explains what to install`() {
        val result = Binary.resolve("/plugin", null, "Linux", "aarch64", FakeFiles(setOf(bundled("linux-x64"))))
        assertTrue(result is Binary.Resolved.Error && result.message.contains("linux-arm64"))
        val unknown = Binary.resolve("/plugin", null, "SunOS", "sparc", FakeFiles(emptySet()))
        assertTrue(unknown is Binary.Resolved.Error && unknown.message.contains("CLI path"))
    }

    @Test
    fun `the CLI path setting wins, but only as an absolute path to a file`() {
        val custom = "/home/dev/kete/packages/cli/dist/kete"
        assertEquals(Binary.Resolved.Ok(custom, "setting"), Binary.resolve("/plugin", custom, "Linux", "amd64", FakeFiles(setOf(custom))))
        assertTrue(Binary.resolve("/plugin", "kete", "Linux", "amd64", FakeFiles(setOf("kete"))) is Binary.Resolved.Error)
        assertTrue(Binary.resolve("/plugin", custom, "Linux", "amd64", FakeFiles(emptySet())) is Binary.Resolved.Error)
        val windows = "C:\\tools\\kete.exe"
        assertEquals(Binary.Resolved.Ok(windows, "setting"), Binary.resolve("/plugin", windows, "Windows 10", "amd64", FakeFiles(setOf(windows))))
    }

    private fun downloaded(platform: String, windows: Boolean = false) =
        listOf("/system/cli", "0.2.4", platform, if (windows) "kete.exe" else "kete").joinToString(File.separator)

    private fun resolve(files: FakeFiles, setting: String? = null, os: String = "Linux", arch: String = "amd64", version: String? = "0.2.4") =
        Binary.resolve("/plugin", setting, os, arch, files, downloadRoot = "/system/cli", version = version)

    @Test
    fun `resolution order is setting, bundled, downloaded, then download`() {
        val custom = "/opt/kete"
        val all = FakeFiles(setOf(custom, bundled("linux-x64"), downloaded("linux-x64")))
        assertEquals(Binary.Resolved.Ok(custom, "setting"), resolve(all, setting = custom))
        assertEquals(Binary.Resolved.Ok(bundled("linux-x64"), "bundled"), resolve(all))
        assertEquals(Binary.Resolved.Ok(downloaded("linux-x64"), "downloaded"), resolve(FakeFiles(setOf(downloaded("linux-x64")))))
        assertEquals(
            Binary.Resolved.Download(
                version = "0.2.4",
                platform = "linux-x64",
                target = "linux-x64-baseline",
                directory = listOf("/system/cli", "0.2.4").joinToString(File.separator),
                path = downloaded("linux-x64"),
            ),
            resolve(FakeFiles(emptySet())),
        )
        val windows = resolve(FakeFiles(emptySet()), os = "Windows 11", arch = "aarch64")
        assertTrue(windows is Binary.Resolved.Download && windows.path == downloaded("windows-arm64", windows = true) && windows.target == "windows-arm64")
    }

    @Test
    fun `never downloads instead of a broken setting or bundled binary, nor for an unknown version or platform`() {
        assertTrue(resolve(FakeFiles(emptySet()), setting = "/opt/missing") is Binary.Resolved.Error)
        val stuck = FakeFiles(setOf(bundled("linux-x64")), executable = emptySet(), chmod = false)
        assertTrue(resolve(stuck) is Binary.Resolved.Error)
        assertTrue(resolve(FakeFiles(emptySet()), version = null) is Binary.Resolved.Error)
        assertTrue(resolve(FakeFiles(emptySet()), version = "../../etc") is Binary.Resolved.Error)
        assertTrue(resolve(FakeFiles(emptySet()), os = "FreeBSD") is Binary.Resolved.Error)
        val brokenDownload = FakeFiles(setOf(downloaded("linux-x64")), executable = emptySet(), chmod = false)
        assertTrue(resolve(brokenDownload) is Binary.Resolved.Error)
    }
}
