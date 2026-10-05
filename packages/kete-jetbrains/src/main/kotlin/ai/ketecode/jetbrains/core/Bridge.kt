package ai.ketecode.jetbrains.core

// The JS ↔ Kotlin bridge between the plugin and the web UI in its JCEF browser. The same message set
// as the VS Code relay (packages/kete-vscode/src/chat.ts `fromFrame`/`toFrame`); the web UI's side is
// packages/app/src/kete/ide-host.ts and vscode-messages.ts. Every message from the page is validated
// here against an allowlist before the plugin acts on it; every message to the page is checked against
// the other allowlist and embedded as a JSON string literal, never as code.

object Bridge {
    /** Message types the page may send to the plugin (chat.ts `fromFrame`). */
    val FROM_PAGE = listOf(
        "kete.openDiff",
        "kete.hello",
        "kete.contextAdded",
        "kete.editorContextApplied",
        "kete.session",
        "kete.themeApplied",
        "kete.dismissNotice",
        "kete.dismissCliHint",
    )

    /** Message types the plugin may send to the page (chat.ts `toFrame`, plus the theme the VS Code relay sends itself). */
    val TO_PAGE = listOf(
        "kete.addContext",
        "kete.workspace",
        "kete.editorContext",
        "kete.newSession",
        "kete.openSession",
        "kete.panel",
        "kete.theme",
    )

    const val READY_EVENT = "kete-jetbrains-ready"
    const val MESSAGE_EVENT = "kete-jetbrains-message"
    const val GLOBAL = "__keteJetBrains"

    /** Larger messages are dropped unread: nothing the page legitimately sends comes close. */
    const val MAX_MESSAGE = 64 * 1024
    private const val MAX_PATH = 4096

    sealed interface Incoming {
        data object Hello : Incoming
        data class OpenDiff(val path: String) : Incoming
        data class ContextAdded(val path: String) : Incoming
        data class EditorContextApplied(val path: String?) : Incoming
        data class Session(val sessionID: String?) : Incoming
        data class ThemeApplied(val kind: String, val tokens: Int) : Incoming
        data class DismissNotice(val id: String) : Incoming
        data object DismissCliHint : Incoming
    }

    /** The validated message, or null for anything malformed, oversized or not on the allowlist. */
    fun parse(json: String): Incoming? {
        if (json.length > MAX_MESSAGE) return null
        val data = Json.parseOrNull(json).asObject() ?: return null
        val type = data.string("type") ?: return null
        if (type !in FROM_PAGE) return null
        return when (type) {
            "kete.hello" -> Incoming.Hello
            "kete.openDiff" -> path(data["path"])?.let { Incoming.OpenDiff(it) }
            "kete.contextAdded" -> path(data["path"])?.let { Incoming.ContextAdded(it) }
            "kete.editorContextApplied" -> when (val value = data["path"]) {
                null -> Incoming.EditorContextApplied(null)
                else -> path(value)?.let { Incoming.EditorContextApplied(it) }
            }
            "kete.session" -> when (val value = data["sessionID"]) {
                null -> Incoming.Session(null)
                else -> (value as? String)?.takeIf { Sessions.isId(it) }?.let { Incoming.Session(it) } ?: Incoming.Session(null)
            }
            "kete.themeApplied" -> Incoming.ThemeApplied(
                (data.string("kind") ?: "unknown").take(32),
                (data.long("tokens") ?: 0L).coerceIn(0L, 1000L).toInt(),
            )
            "kete.dismissNotice" -> data.string("id")?.takeIf { Panel.NOTICE_ID.matches(it) }?.let { Incoming.DismissNotice(it) }
            "kete.dismissCliHint" -> Incoming.DismissCliHint
            else -> null
        }
    }

    private fun path(value: Any?): String? =
        (value as? String)?.takeIf { it.isNotEmpty() && it.length <= MAX_PATH && !it.contains('\u0000') }

    /** JavaScript that delivers `message` to the page, or null when its type isn't allowed to go there. */
    fun deliverScript(message: Map<String, Any?>): String? {
        val type = message["type"] as? String ?: return null
        if (type !in TO_PAGE) return null
        val literal = Json.string(Json.write(message)).toString()
        return "window.dispatchEvent(new CustomEvent(${Json.string(MESSAGE_EVENT)}, { detail: JSON.parse($literal) }));"
    }

    /**
     * The script the plugin runs in the page once it has loaded from the runtime's origin: defines
     * `window.__keteJetBrains.postMessage` (sending JSON through the JBCefJSQuery whose call `inject`
     * builds) and tells the web UI it is ready. Defined once, not writable.
     */
    fun bridgeScript(inject: (jsExpression: String) -> String): String = """
        (function () {
          if (window.$GLOBAL) return;
          var send = function (json) { ${inject("json")} };
          var bridge = Object.freeze({ postMessage: function (message) { send(JSON.stringify(message)); } });
          Object.defineProperty(window, ${Json.string(GLOBAL)}, { value: bridge, writable: false, configurable: false });
          window.dispatchEvent(new Event(${Json.string(READY_EVENT)}));
        })();
    """.trimIndent()
}
