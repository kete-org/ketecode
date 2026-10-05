package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BridgeTest {
    /** A `export const <name> = [ "…", … ]` string array from packages/kete-vscode/src/chat.ts. */
    private fun vscodeList(name: String): List<String> {
        val path = System.getProperty("kete.vscodeChat") ?: "../kete-vscode/src/chat.ts"
        val source = File(path).readText()
        val body = Regex("export const $name = \\[([^\\]]*)\\]").find(source)?.groupValues?.get(1)
        assertNotNull(body, "chat.ts has no `export const $name = [...]`")
        return Regex("\"([^\"]+)\"").findAll(body!!).map { it.groupValues[1] }.toList()
    }

    @Test
    fun `the allowlists match the VS Code relay's source`() {
        // Read from packages/kete-vscode/src/chat.ts, so a message added there fails here until the bridge has it.
        val fromFrame = vscodeList("fromFrame")
        val toFrame = vscodeList("toFrame")
        assertTrue(fromFrame.isNotEmpty() && toFrame.isNotEmpty())
        assertEquals(fromFrame, Bridge.FROM_PAGE)
        // Plus the theme, which the VS Code relay sends itself rather than relaying it.
        assertEquals(toFrame + "kete.theme", Bridge.TO_PAGE)
    }

    @Test
    fun `accepts every allowed message from the page`() {
        assertEquals(Bridge.Incoming.Hello, Bridge.parse("""{"type":"kete.hello"}"""))
        assertEquals(Bridge.Incoming.OpenDiff("src/a.ts"), Bridge.parse("""{"type":"kete.openDiff","path":"src/a.ts"}"""))
        assertEquals(Bridge.Incoming.ContextAdded("a.ts"), Bridge.parse("""{"type":"kete.contextAdded","path":"a.ts"}"""))
        assertEquals(Bridge.Incoming.EditorContextApplied(null), Bridge.parse("""{"type":"kete.editorContextApplied","path":null}"""))
        assertEquals(Bridge.Incoming.EditorContextApplied("a.ts"), Bridge.parse("""{"type":"kete.editorContextApplied","path":"a.ts"}"""))
        assertEquals(Bridge.Incoming.Session("ses_01ABC"), Bridge.parse("""{"type":"kete.session","sessionID":"ses_01ABC"}"""))
        assertEquals(Bridge.Incoming.Session(null), Bridge.parse("""{"type":"kete.session","sessionID":null}"""))
        assertEquals(Bridge.Incoming.ThemeApplied("dark", 22), Bridge.parse("""{"type":"kete.themeApplied","kind":"dark","tokens":22}"""))
        assertEquals(Bridge.Incoming.DismissNotice("agents-md"), Bridge.parse("""{"type":"kete.dismissNotice","id":"agents-md"}"""))
        assertEquals(Bridge.Incoming.DismissCliHint, Bridge.parse("""{"type":"kete.dismissCliHint"}"""))
    }

    @Test
    fun `drops unknown types, bad fields, oversized and malformed messages`() {
        assertNull(Bridge.parse("""{"type":"kete.addContext","path":"a.ts"}"""), "a to-page type is not accepted from the page")
        assertNull(Bridge.parse("""{"type":"kete.runCommand","command":"rm -rf /"}"""))
        assertNull(Bridge.parse("""{"type":"kete.openDiff"}"""))
        assertNull(Bridge.parse("""{"type":"kete.openDiff","path":""}"""))
        assertNull(Bridge.parse("""{"type":"kete.openDiff","path":42}"""))
        assertNull(Bridge.parse("""{"type":"kete.openDiff","path":"a\u0000b"}"""))
        assertNull(Bridge.parse("""{"type":"kete.dismissNotice","id":"<script>"}"""))
        assertNull(Bridge.parse("""{"type":"kete.openDiff","path":"${"a".repeat(Bridge.MAX_MESSAGE)}"}"""))
        assertNull(Bridge.parse("not json"))
        assertNull(Bridge.parse("""["kete.hello"]"""))
        assertNull(Bridge.parse("""{"kind":"kete.hello"}"""))
        assertEquals(Bridge.Incoming.Session(null), Bridge.parse("""{"type":"kete.session","sessionID":"../../etc"}"""))
    }

    @Test
    fun `delivers only allowed types, as a JSON string literal`() {
        assertNull(Bridge.deliverScript(mapOf("type" to "kete.hello")))
        assertNull(Bridge.deliverScript(mapOf("path" to "a")))
        val script = Bridge.deliverScript(mapOf("type" to "kete.addContext", "path" to "a\"</script><script>alert(1)</script> .ts"))
        assertNotNull(script)
        assertTrue(script!!.startsWith("window.dispatchEvent(new CustomEvent(\"kete-jetbrains-message\""))
        assertFalse(script.contains("</script>"))
        assertFalse(script.contains(" "))
        // The embedded literal decodes back to the original message.
        val literal = script.substringAfter("JSON.parse(").substringBeforeLast(") }));")
        assertEquals(mapOf("type" to "kete.addContext", "path" to "a\"</script><script>alert(1)</script> .ts"), Json.parse(Json.parse(literal) as String))
    }

    @Test
    fun `the bridge script keeps the nonce in its closure and wraps every message with it`() {
        val nonce = Bridge.newNonce()
        val script = Bridge.bridgeScript(nonce) { expression -> "window.cefQuery_1({request: '' + $expression});" }
        assertTrue(script.contains("window.cefQuery_1({request: '' + json});"))
        assertTrue(script.contains("var nonce = \"$nonce\";"))
        assertTrue(script.contains("JSON.stringify({ nonce: nonce, message: message })"))
        assertFalse(script.contains("window.nonce"))
        assertTrue(script.contains("Object.freeze"))
        assertTrue(script.contains("writable: false"))
        assertTrue(script.contains("event.isTrusted"))
        assertTrue(script.contains("\"kete-jetbrains-ready\""))
        assertTrue(script.contains("\"__keteJetBrains\""))
    }

    @Test
    fun `nonces are long and different every time`() {
        val nonces = (1..100).map { Bridge.newNonce() }.toSet()
        assertEquals(100, nonces.size)
        assertTrue(nonces.all { it.length >= 43 && Regex("^[A-Za-z0-9_-]+$").matches(it) })
    }

    @Test
    fun `accepts only envelopes with the current nonce`() {
        val nonce = Bridge.newNonce()
        assertEquals(Bridge.Incoming.Hello, Bridge.open("""{"nonce":"$nonce","message":{"type":"kete.hello"}}""", nonce))
        assertEquals(Bridge.Incoming.OpenDiff("a.ts"), Bridge.open("""{"nonce":"$nonce","message":{"type":"kete.openDiff","path":"a.ts"}}""", nonce))
        // A frame calling the query function directly doesn't know the nonce.
        assertNull(Bridge.open("""{"type":"kete.hello"}""", nonce))
        assertNull(Bridge.open("""{"message":{"type":"kete.hello"}}""", nonce))
        assertNull(Bridge.open("""{"nonce":"guess","message":{"type":"kete.hello"}}""", nonce))
        assertNull(Bridge.open("""{"nonce":"${Bridge.newNonce()}","message":{"type":"kete.hello"}}""", nonce), "an earlier load's nonce")
        assertNull(Bridge.open("""{"nonce":"","message":{"type":"kete.hello"}}""", ""))
        // The message inside is still validated.
        assertNull(Bridge.open("""{"nonce":"$nonce","message":{"type":"kete.runCommand"}}""", nonce))
        assertNull(Bridge.open("""{"nonce":"$nonce","message":"{\"type\":\"kete.hello\"}"}""", nonce))
        assertNull(Bridge.open("""{"nonce":"$nonce","message":{"type":"kete.openDiff","path":"${"a".repeat(Bridge.MAX_MESSAGE)}"}}""", nonce))
    }
}

class ExternalLinksTest {
    @Test
    fun `opens only main-frame web links the user clicked, at most once a second`() {
        val links = ExternalLinks()
        assertFalse(links.shouldOpen("https://a.example", mainFrame = true, userGesture = false, now = 0), "no gesture")
        assertFalse(links.shouldOpen("https://a.example", mainFrame = false, userGesture = true, now = 0), "a subframe")
        assertFalse(links.shouldOpen("file:///etc/passwd", mainFrame = true, userGesture = true, now = 0))
        assertFalse(links.shouldOpen("javascript:alert(1)", mainFrame = true, userGesture = true, now = 0))
        assertTrue(links.shouldOpen("https://a.example", mainFrame = true, userGesture = true, now = 10_000))
        assertFalse(links.shouldOpen("https://b.example", mainFrame = true, userGesture = true, now = 10_500), "too soon")
        assertFalse(links.shouldOpen("http://b.example", mainFrame = true, userGesture = true, now = 10_999), "too soon")
        assertTrue(links.shouldOpen("http://b.example", mainFrame = true, userGesture = true, now = 11_000))
    }
}
