package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BridgeTest {
    @Test
    fun `the allowlists match the VS Code relay`() {
        // packages/kete-vscode/src/chat.ts fromFrame / toFrame (+ the theme the relay sends itself).
        assertEquals(
            listOf("kete.openDiff", "kete.hello", "kete.contextAdded", "kete.editorContextApplied", "kete.session", "kete.themeApplied", "kete.dismissNotice", "kete.dismissCliHint"),
            Bridge.FROM_PAGE,
        )
        assertEquals(
            listOf("kete.addContext", "kete.workspace", "kete.editorContext", "kete.newSession", "kete.openSession", "kete.panel", "kete.theme"),
            Bridge.TO_PAGE,
        )
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
    fun `the bridge script defines a frozen, non-writable global and signals readiness`() {
        val script = Bridge.bridgeScript { expression -> "window.cefQuery_1({request: '' + $expression});" }
        assertTrue(script.contains("window.cefQuery_1({request: '' + json});"))
        assertTrue(script.contains("Object.freeze"))
        assertTrue(script.contains("writable: false"))
        assertTrue(script.contains("\"kete-jetbrains-ready\""))
        assertTrue(script.contains("\"__keteJetBrains\""))
    }
}
