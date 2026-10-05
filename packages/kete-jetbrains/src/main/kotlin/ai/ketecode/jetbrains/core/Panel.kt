package ai.ketecode.jetbrains.core

// The chat panel's "what's new" notices and CLI hint (mirrors packages/kete-vscode/src/panel.ts): what
// the plugin knows that the web UI (packages/app/src/kete/panel.tsx) doesn't — the host platform, the
// server's default permission mode, and the user's dismissals. Sent as the `kete.panel` message, which
// packages/app/src/kete/vscode-messages.ts `panelMessage` validates on the other side.

data class Notice(val id: String, val title: String, val body: String, val isNew: Boolean = false)

object Panel {
    val NOTICE_ID = Regex("^[a-z0-9-]{1,64}$")
    private const val MAX_DISMISSED = 50

    /** The same notices as the VS Code extension; `body` may use backtick spans, rendered as `<code>`, never HTML. */
    val NOTICES = listOf(
        Notice(
            "portal-agents",
            "Agents from your portal",
            "Agents you set up in the Kete Code Portal sync here automatically. Pick one with `/agent`.",
            isNew = true,
        ),
        Notice("agents-md", "Kete reads your AGENTS.md", "Project conventions in `AGENTS.md` load at the start of every session."),
    )

    /** Adds `id` only if it names a real notice, deduped and capped, so a stale page can't grow the list forever. */
    fun dismiss(dismissed: List<String>, id: String): List<String> {
        if (NOTICES.none { it.id == id } || id in dismissed) return dismissed.toList()
        return (dismissed + id).takeLast(MAX_DISMISSED)
    }

    /** The `kete.panel` message. */
    fun message(dismissed: List<String>, cliHintDismissed: Boolean, mac: Boolean, defaultMode: String): Map<String, Any?> = mapOf(
        "type" to "kete.panel",
        "platform" to if (mac) "mac" else "other",
        "defaultMode" to if (defaultMode == "ask") "ask" else "default",
        "cliHint" to !cliHintDismissed,
        "notices" to NOTICES.filter { it.id !in dismissed }.map { notice ->
            buildMap<String, Any?> {
                put("id", notice.id)
                put("title", notice.title)
                put("body", notice.body)
                if (notice.isNew) put("isNew", true)
            }
        },
    )
}
