package ai.ketecode.jetbrains.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

// The JS ↔ Kotlin bridge between the plugin and the web UI in its JCEF browser. The same message set
// as the VS Code relay (packages/kete-vscode/src/chat.ts `fromFrame`/`toFrame`); the web UI's side is
// packages/app/src/kete/ide-host.ts and vscode-messages.ts. Every message from the page is validated
// here against an allowlist before the plugin acts on it; every message to the page is checked against
// the other allowlist and embedded as a JSON string literal, never as code.
//
// The JBCefJSQuery function (`cefQuery_*`) exists in every frame of the page, so an iframe of another
// origin could call it directly. Every message therefore travels in an envelope carrying a per-load
// nonce that only the injected bridge script knows (held in its closure, never in a global); the plugin
// drops envelopes without the current nonce and makes a new one on every load.

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

    private val random = SecureRandom()

    /** A fresh random nonce for one page load (256 bits, base64url). */
    fun newNonce(): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /**
     * The validated message from an envelope `{"nonce": …, "message": {…}}` sent by the bridge script,
     * or null when the nonce isn't `nonce` (compared in constant time) or the message is invalid.
     */
    fun open(envelope: String, nonce: String): Incoming? {
        if (envelope.length > MAX_MESSAGE || nonce.isEmpty()) return null
        val data = Json.parseOrNull(envelope).asObject() ?: return null
        val given = data.string("nonce") ?: return null
        if (!MessageDigest.isEqual(given.toByteArray(Charsets.UTF_8), nonce.toByteArray(Charsets.UTF_8))) return null
        return validate(data["message"].asObject() ?: return null)
    }

    /** The validated message, or null for anything malformed, oversized or not on the allowlist. */
    fun parse(json: String): Incoming? {
        if (json.length > MAX_MESSAGE) return null
        return validate(Json.parseOrNull(json).asObject() ?: return null)
    }

    private fun validate(data: Map<String, Any?>): Incoming? {
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
     * `window.__keteJetBrains.postMessage` (sending the message in a `{nonce, message}` envelope through
     * the JBCefJSQuery whose call `inject` builds) and tells the web UI it is ready. Defined once, not
     * writable; `nonce` lives only in the closure.
     *
     * It also turns a real click (`isTrusted`) on an external http(s) link that would open a popup
     * (`target="_blank"`) into a navigation of the page itself, which the plugin cancels and opens in the
     * system browser with the click's user gesture: popups carry no gesture information in JCEF, so the
     * plugin ignores them.
     */
    fun bridgeScript(nonce: String, inject: (jsExpression: String) -> String): String = """
        (function () {
          if (window.$GLOBAL) return;
          var nonce = ${Json.string(nonce)};
          var send = function (json) { ${inject("json")} };
          var bridge = Object.freeze({ postMessage: function (message) { send(JSON.stringify({ nonce: nonce, message: message })); } });
          Object.defineProperty(window, ${Json.string(GLOBAL)}, { value: bridge, writable: false, configurable: false });
          document.addEventListener("click", function (event) {
            if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
            var link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
            if (!link || link.target !== "_blank") return;
            var url;
            try { url = new URL(link.href, location.href); } catch (_) { return; }
            if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin === location.origin) return;
            event.preventDefault();
            location.href = url.href;
          }, true);
          window.dispatchEvent(new Event(${Json.string(READY_EVENT)}));
        })();
    """.trimIndent()
}
