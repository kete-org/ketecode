package ai.ketecode.jetbrains.core

import java.io.File

// Which `kete` binary the plugin runs (mirrors packages/kete-vscode/src/binary.ts), in this order:
//   1. the `cliPath` setting (development);
//   2. the binary bundled under bin/<os>-<arch>/ (the per-OS zips on the GitHub Release, kete-release.yml);
//   3. the binary downloaded earlier for this plugin version into the IDE's system directory
//      (<system>/kete-code/cli/<version>/<os>-<arch>/kete[.exe]; the Marketplace build carries none);
//   4. otherwise it must be downloaded first (CliInstall.kt verifies it before it lands there).
// The PATH is never searched: the plugin runs the binary of its own version.

object Binary {
    /** The bundled folder for each OS/architecture → the CLI build target it holds (packages/cli/script/build.ts). */
    val targets: Map<String, String> = linkedMapOf(
        "darwin-arm64" to "darwin-arm64",
        "darwin-x64" to "darwin-x64-baseline",
        "linux-x64" to "linux-x64-baseline",
        "linux-arm64" to "linux-arm64",
        "windows-x64" to "windows-x64-baseline",
        "windows-arm64" to "windows-arm64",
    )

    /** Which platform zip of the release carries each folder (`kete-code-jetbrains-<v>-<bundle>.zip`). */
    val bundles: Map<String, List<String>> = linkedMapOf(
        "macos" to listOf("darwin-arm64", "darwin-x64"),
        "linux" to listOf("linux-x64", "linux-arm64"),
        "windows" to listOf("windows-x64", "windows-arm64"),
    )

    sealed interface Resolved {
        /** `source`: "setting", "bundled" or "downloaded". */
        data class Ok(val path: String, val source: String) : Resolved
        data class Error(val message: String) : Resolved
        /** No binary yet: `target` of release `version` must be downloaded and verified into `directory` (the version folder). */
        data class Download(val version: String, val platform: String, val target: String, val directory: String, val path: String) : Resolved
    }

    /** `os.name`/`os.arch` → the bundled folder name, or null for a platform without a bundled binary. */
    fun platform(osName: String, osArch: String): String? {
        val name = osName.lowercase()
        val os = when {
            name.startsWith("mac") || name.contains("darwin") -> "darwin"
            name.startsWith("windows") -> "windows"
            name.startsWith("linux") -> "linux"
            else -> return null
        }
        val arch = when (osArch.lowercase()) {
            "aarch64", "arm64" -> "arm64"
            "amd64", "x86_64", "x64" -> "x64"
            else -> return null
        }
        return "$os-$arch".takeIf { it in targets }
    }

    fun executableName(windows: Boolean) = if (windows) "kete.exe" else "kete"

    /** The file checks resolution needs; the IDE passes real ones, tests pass fakes. */
    interface Files {
        fun isFile(path: String): Boolean
        fun canExecute(path: String): Boolean
        /** Restores a missing executable bit (zip tools can drop it); returns whether it worked. */
        fun makeExecutable(path: String): Boolean
    }

    object RealFiles : Files {
        override fun isFile(path: String) = File(path).isFile
        override fun canExecute(path: String) = File(path).canExecute()
        override fun makeExecutable(path: String) = File(path).setExecutable(true, false)
    }

    /** Where downloaded binaries live: `<root>/<version>/<platform>/kete[.exe]`. */
    fun downloadedPath(root: String, version: String, platform: String, windows: Boolean) =
        listOf(root, version, platform, executableName(windows)).joinToString(File.separator)

    /**
     * The binary to run (see the order at the top). `downloadRoot` is `<IDE system dir>/kete-code/cli`
     * and `version` the plugin's own version; either may be null when unknown, and then no download is offered.
     */
    fun resolve(
        pluginPath: String,
        setting: String?,
        osName: String,
        osArch: String,
        files: Files = RealFiles,
        downloadRoot: String? = null,
        version: String? = null,
    ): Resolved {
        val windows = osName.lowercase().startsWith("windows")
        val configured = setting?.trim().orEmpty()
        if (configured.isNotEmpty()) {
            if (!File(configured).isAbsolute && !(windows && Regex("^[A-Za-z]:[\\\\/]").containsMatchIn(configured)))
                return Resolved.Error("The Kete Code CLI path must be an absolute path to the kete binary (got \"$configured\").")
            val problem = usable(configured, windows, files)
            return if (problem == null) Resolved.Ok(configured, "setting") else Resolved.Error("CLI path: $problem")
        }
        val platform = platform(osName, osArch)
            ?: return Resolved.Error("Kete Code has no kete binary for $osName ($osArch). Set a CLI path in Settings → Tools → Kete Code.")
        val bundled = listOf(pluginPath, "bin", platform, executableName(windows)).joinToString(File.separator)
        // A bundled file that exists but can't be made executable is an error, not a reason to download.
        if (files.isFile(bundled)) {
            val problem = usable(bundled, windows, files)
            return if (problem == null) Resolved.Ok(bundled, "bundled") else Resolved.Error("Bundled kete: $problem")
        }
        if (downloadRoot == null || version == null || !CliRelease.isVersion(version))
            return Resolved.Error(
                "This build of the Kete Code plugin has no kete binary for this platform ($platform) and can't download one " +
                    "(plugin version ${version ?: "unknown"}). Install the plugin zip for your operating system from the Kete Code " +
                    "release, or set a CLI path in Settings → Tools → Kete Code.",
            )
        val downloaded = downloadedPath(downloadRoot, version, platform, windows)
        if (files.isFile(downloaded)) {
            val problem = usable(downloaded, windows, files)
            return if (problem == null) Resolved.Ok(downloaded, "downloaded") else Resolved.Error("Downloaded kete: $problem")
        }
        return Resolved.Download(
            version = version,
            platform = platform,
            target = targets.getValue(platform),
            directory = listOf(downloadRoot, version).joinToString(File.separator),
            path = downloaded,
        )
    }

    private fun usable(path: String, windows: Boolean, files: Files): String? {
        if (!files.isFile(path)) return "$path does not exist or is not a file"
        if (windows || files.canExecute(path)) return null
        return if (files.makeExecutable(path)) null else "$path is not executable"
    }
}
