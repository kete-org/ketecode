package ai.ketecode.jetbrains.core

import java.net.URI

// The Kete account the CLI is signed in to, read with `kete whoami --format json` (local state only,
// never the key), and the `kete login` output the plugin needs to drive sign-in (mirrors
// packages/kete-vscode/src/account.ts), plus the session list (sessions.ts).

sealed interface Account {
    val handConfigured: List<String>

    data class SignedOut(override val handConfigured: List<String>) : Account
    data class SignedIn(
        val organization: String,
        val platformURL: String,
        val gatewayURL: String,
        val storage: String,
        override val handConfigured: List<String>,
    ) : Account
}

class AccountException(message: String) : Exception(message)

object Accounts {
    /** Parses `kete whoami --format json`. Throws on anything unexpected rather than guessing. */
    fun parseWhoami(stdout: String): Account {
        val value = Json.parseOrNull(stdout.trim()).asObject() ?: throw AccountException("Unexpected output from kete whoami")
        val signedIn = value.bool("signed_in") ?: throw AccountException("Unexpected output from kete whoami")
        val handConfigured = value["hand_configured"].asList().orEmpty().filterIsInstance<String>()
        if (!signedIn) return Account.SignedOut(handConfigured)
        val organization = value["organization"].asObject()?.string("name")
        val platform = value.string("platform_url")
        val gateway = value.string("gateway_url")
        val storage = value.string("storage_description")
        if (organization == null || platform == null || gateway == null || storage == null)
            throw AccountException("Unexpected output from kete whoami")
        return Account.SignedIn(organization, platform, gateway, storage, handConfigured)
    }

    /** The authorize URL `kete login` prints on its own line. Only http(s) URLs to /cli/authorize. */
    fun authorizeURL(output: String): String? =
        output.split(Regex("\r?\n")).map { it.trim() }.firstOrNull { line ->
            val uri = try {
                URI(line)
            } catch (_: Exception) {
                return@firstOrNull false
            }
            (uri.scheme == "https" || uri.scheme == "http") && uri.host != null && (uri.path ?: "").endsWith("/cli/authorize")
        }

    /** The last meaningful line of CLI output, for an error message. */
    fun lastLine(text: String): String? =
        text.split(Regex("\r?\n"))
            .map { it.replace(Regex("^[│■└\\s]+"), "").trim() }
            .lastOrNull { it.isNotEmpty() && it != "Failed" }
}

data class SessionItem(val id: String, val title: String, val updated: Long)

object Sessions {
    /** Session ids the runtime makes; anything else in a message or a response is ignored. */
    private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")

    fun isId(value: String) = ID.matches(value)

    /** Top-level, unarchived sessions from a list response, most recently updated first. */
    fun parse(body: Any?, limit: Int = 50): List<SessionItem> =
        body.asObject()?.get("data").asList().orEmpty().mapNotNull { item ->
            val entry = item.asObject() ?: return@mapNotNull null
            val id = entry.string("id")?.takeIf { isId(it) } ?: return@mapNotNull null
            if (entry["parentID"] is String) return@mapNotNull null
            val time = entry["time"].asObject() ?: emptyMap()
            if (time["archived"] is Long || time["archived"] is Double) return@mapNotNull null
            val updated = time.long("updated") ?: time.long("created") ?: 0L
            val title = entry.string("title")?.trim()?.takeIf { it.isNotEmpty() }?.take(200) ?: "Untitled session"
            SessionItem(id, title, updated)
        }.sortedByDescending { it.updated }.take(limit)

    /** "just now", "5 min ago", "3 h ago", "2 d ago", or the date. */
    fun ago(time: Long, now: Long): String {
        val seconds = maxOf(0L, Math.round((now - time) / 1000.0))
        return when {
            seconds < 60 -> "just now"
            seconds < 3600 -> "${seconds / 60} min ago"
            seconds < 86_400 -> "${seconds / 3600} h ago"
            seconds < 7 * 86_400 -> "${seconds / 86_400} d ago"
            else -> java.time.Instant.ofEpochMilli(time).toString().take(10)
        }
    }

    /** The title from a `GET /api/session/:id` response. */
    fun title(body: Any?): String? = body.asObject()?.get("data").asObject()?.string("title")
}
