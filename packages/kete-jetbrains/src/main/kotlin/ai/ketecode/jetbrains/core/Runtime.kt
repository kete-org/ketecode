package ai.ketecode.jetbrains.core

import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.Base64

// The pure parts of running `kete serve --stdio` (mirrors packages/kete-vscode/src/server.ts and
// chat.ts): the start line, the pairing URL, Basic auth, restart backoff and workspace paths.

object StartLine {
    private val LOOPBACK = setOf("127.0.0.1", "localhost", "[::1]")

    /** The server origin from the `{"url": …}` line `serve --stdio` prints, only if it is a loopback http URL. */
    fun parseUrl(line: String): String? {
        val value = Json.parseOrNull(line.trim()).asObject() ?: return null
        val raw = value.string("url") ?: return null
        val uri = try {
            URI(raw)
        } catch (_: Exception) {
            return null
        }
        if (uri.scheme != "http") return null
        val host = uri.host ?: return null
        if (host !in LOOPBACK) return null
        if (uri.rawUserInfo != null) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "http://$host$port"
    }

    /** The first line that looks like the start line (a JSON object), from the text read so far. */
    fun find(buffer: String): String? = buffer.split(Regex("\r?\n")).firstOrNull { it.trim().startsWith("{") }
}

object Pairing {
    /** The server's fixed internal account name (packages/app/src/servers/connect/pairing.ts). */
    const val USERNAME = "opencode"

    /** The query flag that tells the web UI it runs in the JetBrains plugin (packages/app/src/kete/ide-host.ts). */
    const val HOST_QUERY = "kete-host=jetbrains"

    /**
     * The web UI's pairing link: `/connect?kete-host=jetbrains#<base64url JSON>`. The part after `#`
     * (the password) never reaches the server.
     */
    fun url(server: String, password: String): String {
        val code = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(Json.write(mapOf("username" to USERNAME, "password" to password)).toByteArray(Charsets.UTF_8))
        return "${server.trimEnd('/')}/connect?$HOST_QUERY#$code"
    }

    fun basic(password: String): String =
        "Basic " + Base64.getEncoder().encodeToString("$USERNAME:$password".toByteArray(Charsets.UTF_8))

    /** The origin (scheme://host:port) of a URL, or null. */
    fun origin(url: String): String? = try {
        val uri = URI(url)
        if (uri.scheme == null || uri.host == null) null
        else "${uri.scheme}://${uri.host}${if (uri.port == -1) "" else ":${uri.port}"}"
    } catch (_: Exception) {
        null
    }
}

/** Restart delays like server.ts: 1 s doubling to 30 s; give up after 5 crashes within 2 minutes. */
class Backoff(
    private val initial: Long = 1_000,
    private val max: Long = 30_000,
    private val maxFailures: Int = 5,
    private val window: Long = 120_000,
) {
    private val failures = ArrayDeque<Long>()

    sealed interface Decision {
        data class Retry(val attempt: Int, val delay: Long) : Decision
        data class GiveUp(val failures: Int) : Decision
    }

    fun reset() = failures.clear()

    fun crashed(now: Long): Decision {
        while (failures.isNotEmpty() && now - failures.first() >= window) failures.removeFirst()
        failures.addLast(now)
        if (failures.size >= maxFailures) return Decision.GiveUp(failures.size)
        val attempt = failures.size
        val delay = minOf(initial shl (attempt - 1), max)
        return Decision.Retry(attempt, delay)
    }
}

object Paths {
    /**
     * The absolute path of a workspace-relative path from the web UI, or null when it would leave the
     * workspace folder: lexically (absolute paths, `..`, or a different drive; mirrors status.ts
     * `insideWorkspace`) or through a symbolic link ([realInside]). The path returned is the lexical one
     * (inside the folder as the IDE names it); [realInside] gives where it really leads.
     */
    fun insideWorkspace(folder: String, relative: String): Path? {
        val lexical = lexicallyInside(folder, relative) ?: return null
        realInside(folder, lexical) ?: return null
        return lexical
    }

    /**
     * Where `target` (an absolute path lexically inside `folder`) really leads once symbolic links are
     * followed, or null when that is outside the real `folder`, is the folder itself, or can't be told
     * (the folder doesn't exist, or a link on the way dangles). A target that doesn't exist yet is
     * resolved through its nearest existing parent. A check, not a lock: the file system can still change
     * between the check and the write.
     */
    fun realInside(folder: String, target: Path): Path? {
        val base = try {
            Path.of(folder).toRealPath()
        } catch (_: Exception) {
            return null
        }
        var existing: Path = target.toAbsolutePath().normalize()
        val missing = ArrayList<String>()
        while (!Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) {
            missing.add(0, existing.fileName?.toString() ?: return null)
            existing = existing.parent ?: return null
        }
        val real = try {
            // Fails for a dangling link, which a write would follow out of the folder.
            missing.fold(existing.toRealPath()) { path, name -> path.resolve(name) }
        } catch (_: Exception) {
            return null
        }
        if (real == base || !real.startsWith(base)) return null
        return real
    }

    private fun lexicallyInside(folder: String, relative: String): Path? {
        if (relative.isEmpty() || relative.contains('\u0000')) return null
        if (relative.startsWith("/") || relative.startsWith("\\") || Regex("^[A-Za-z]:").containsMatchIn(relative)) return null
        val base = try {
            Path.of(folder).toAbsolutePath().normalize()
        } catch (_: Exception) {
            return null
        }
        val resolved = try {
            base.resolve(relative).normalize()
        } catch (_: Exception) {
            return null
        }
        if (resolved == base || !resolved.startsWith(base)) return null
        return resolved
    }

    /** `path` relative to `folder` with forward slashes, or null when it isn't inside it. */
    fun relative(folder: String, path: String): String? {
        val base = Path.of(folder).toAbsolutePath().normalize()
        val target = Path.of(path).toAbsolutePath().normalize()
        if (target == base || !target.startsWith(base)) return null
        return base.relativize(target).joinToString("/")
    }
}

object Shell {
    /** One argument quoted for the IDE terminal's shell: POSIX single quotes, or PowerShell/cmd double quotes on Windows. */
    fun quote(argument: String, windows: Boolean): String {
        if (windows) {
            // PowerShell (the default Windows terminal shell) needs `&` to run a quoted path; cmd accepts it quoted too.
            return "& \"" + argument.replace("\"", "`\"") + "\""
        }
        if (argument.isNotEmpty() && Regex("^[A-Za-z0-9_./:=@%+-]+$").matches(argument)) return argument
        return "'" + argument.replace("'", "'\\''") + "'"
    }
}
