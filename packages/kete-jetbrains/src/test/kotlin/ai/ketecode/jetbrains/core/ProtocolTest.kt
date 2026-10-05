package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EventsTest {
    @Test
    fun `tracks waiting approvals and finished sessions`() {
        var state = Events.EMPTY
        val asked = Events.reduce(state, Event("permission.asked", mapOf("id" to "p1", "sessionID" to "s1", "action" to "bash")))
        assertEquals(Change.Asked("s1", "bash"), asked.change)
        state = asked.state
        assertEquals(mapOf("p1" to "s1"), state.pending)
        state = Events.reduce(state, Event("session.status", mapOf("sessionID" to "s1", "status" to mapOf("type" to "busy")))).state
        assertEquals(setOf("s1"), state.busy)
        val idle = Events.reduce(state, Event("session.status", mapOf("sessionID" to "s1", "status" to mapOf("type" to "idle"))))
        assertEquals(Change.Finished("s1"), idle.change)
        assertEquals(Attention(), idle.state, "a finished session has no prompts left waiting")
    }

    @Test
    fun `replies clear prompts; idle without busy is not a finish; other events change nothing`() {
        val state = Attention(pending = mapOf("p1" to "s1"))
        assertEquals(Attention(), Events.reduce(state, Event("permission.replied", mapOf("requestID" to "p1"))).state)
        assertEquals(state, Events.reduce(state, Event("permission.replied", mapOf("requestID" to "other"))).state)
        assertNull(Events.reduce(Attention(), Event("session.status", mapOf("sessionID" to "s2", "status" to mapOf("type" to "idle")))).change)
        assertEquals(state, Events.reduce(state, Event("message.part.delta", mapOf("text" to "hi"))).state)
        assertEquals(state, Events.reduce(state, Event("permission.asked", "not an object")).state)
    }

    @Test
    fun `splits server-sent events and keeps the incomplete rest`() {
        val parsed = Events.parseFrames("data: {\"type\":\"a\",\"data\":1}\r\n\r\n: comment\n\ndata: not json\n\ndata: {\"type\":\"b\"}\n\ndata: {\"ty")
        assertEquals(listOf(Event("a", 1L), Event("b", null)), parsed.events)
        assertEquals("data: {\"ty", parsed.rest)
    }

    @Test
    fun `reads pending requests`() {
        val body = Json.parse("""{"data":[{"id":"p1","sessionID":"s1"},{"id":2},{"sessionID":"x"}]}""")
        assertEquals(mapOf("p1" to "s1"), Events.pendingRequests(body))
    }
}

class EditorToolsTest {
    private val tools = EditorTools.Tools { path ->
        when (path) {
            null -> listOf(EditorTools.Diagnostic("b.kt", 2, 1, "warning", null, "unused"), EditorTools.Diagnostic("a.kt", 9, 3, "error", "Kotlin", "type\nmismatch"))
            "a.kt" -> emptyList()
            else -> null
        }
    }

    private fun call(path: String?) = EditorTools.handle(
        mapOf("jsonrpc" to "2.0", "id" to 7L, "method" to "tools/call", "params" to mapOf("name" to "diagnostics", "arguments" to (if (path == null) emptyMap() else mapOf("path" to path)))),
        tools,
    )

    @Suppress("UNCHECKED_CAST")
    private fun text(reply: Map<String, Any?>?): String = ((reply!!["result"] as Map<String, Any?>)["content"] as List<Map<String, Any?>>)[0]["text"] as String

    @Test
    fun `initialize, list and call`() {
        val init = EditorTools.handle(mapOf("jsonrpc" to "2.0", "id" to 1L, "method" to "initialize", "params" to mapOf("protocolVersion" to "2025-06-18")), tools)
        assertEquals("2025-06-18", (init!!["result"] as Map<*, *>)["protocolVersion"])
        val old = EditorTools.handle(mapOf("jsonrpc" to "2.0", "id" to 1L, "method" to "initialize", "params" to mapOf("protocolVersion" to "1999")), tools)
        assertEquals("2025-11-25", (old!!["result"] as Map<*, *>)["protocolVersion"])
        val list = EditorTools.handle(mapOf("jsonrpc" to "2.0", "id" to 2L, "method" to "tools/list"), tools)
        assertTrue(Json.write(list).contains("\"diagnostics\""))
        assertEquals("1 error, 1 warning\na.kt:9:3 error [Kotlin]: type mismatch\nb.kt:2:1 warning: unused", text(call(null)))
        assertEquals("No problems in a.kt.", text(call("a.kt")))
        assertEquals("../x is not a file in this project.", text(call("../x")))
    }

    @Test
    fun `notifications get no reply; bad requests get errors`() {
        assertNull(EditorTools.handle(mapOf("jsonrpc" to "2.0", "method" to "notifications/initialized"), tools))
        assertEquals(-32600, ((EditorTools.handle("x", tools)!!["error"]) as Map<*, *>)["code"])
        assertEquals(-32601, ((EditorTools.handle(mapOf("jsonrpc" to "2.0", "id" to 1L, "method" to "nope"), tools)!!["error"]) as Map<*, *>)["code"])
        val badPath = EditorTools.handle(mapOf("jsonrpc" to "2.0", "id" to 1L, "method" to "tools/call", "params" to mapOf("name" to "diagnostics", "arguments" to mapOf("path" to 3L))), tools)
        assertEquals(-32602, (badPath!!["error"] as Map<*, *>)["code"])
        val unknown = EditorTools.handle(mapOf("jsonrpc" to "2.0", "id" to 1L, "method" to "tools/call", "params" to mapOf("name" to "terminal")), tools)
        assertEquals(-32602, (unknown!!["error"] as Map<*, *>)["code"])
    }

    @Test
    fun `caps the list at 200 lines`() {
        val many = (1..250).map { EditorTools.Diagnostic("a.kt", it, 1, "hint", null, "m") }
        val text = EditorTools.format(many)
        assertEquals(202, text.lines().size)
        assertTrue(text.endsWith("… and 50 more"))
    }

    @Test
    fun `only the runtime with the exact token, loopback host and no Origin may call`() {
        val good = mapOf("Host" to listOf("127.0.0.1:5000"), "Authorization" to listOf("Bearer tok"))
        assertTrue(EditorTools.authorized(good, "tok", 5000))
        assertTrue(EditorTools.authorized(mapOf("host" to listOf("127.0.0.1:5000"), "authorization" to listOf("Bearer tok")), "tok", 5000))
        assertFalse(EditorTools.authorized(good + ("Origin" to listOf("http://evil.example")), "tok", 5000))
        assertFalse(EditorTools.authorized(good + ("Host" to listOf("localhost:5000")), "tok", 5000))
        assertFalse(EditorTools.authorized(good + ("Host" to listOf("127.0.0.1:5000", "127.0.0.1:5000")), "tok", 5000))
        assertFalse(EditorTools.authorized(good, "tok", 5001))
        assertFalse(EditorTools.authorized(good + ("Authorization" to listOf("Bearer tok2")), "tok", 5000))
        assertFalse(EditorTools.authorized(good + ("Authorization" to listOf("Basic tok")), "tok", 5000))
        assertFalse(EditorTools.authorized(mapOf("Host" to listOf("127.0.0.1:5000")), "tok", 5000))
    }
}

class AccountsTest {
    @Test
    fun `parses whoami`() {
        assertEquals(Account.SignedOut(listOf("kete")), Accounts.parseWhoami("""{"signed_in":false,"hand_configured":["kete",3]}"""))
        val signedIn = Accounts.parseWhoami(
            """{"signed_in":true,"organization":{"name":"Acme"},"platform_url":"https://p","gateway_url":"https://g","storage_description":"the macOS Keychain"}""",
        )
        assertEquals(Account.SignedIn("Acme", "https://p", "https://g", "the macOS Keychain", emptyList()), signedIn)
        assertThrows(AccountException::class.java) { Accounts.parseWhoami("""{"signed_in":true}""") }
        assertThrows(AccountException::class.java) { Accounts.parseWhoami("Error: boom") }
    }

    @Test
    fun `finds the authorize URL and the last line`() {
        assertEquals("https://portal.example/cli/authorize?code=1", Accounts.authorizeURL("Open this link:\n   https://portal.example/cli/authorize?code=1\nwaiting"))
        assertNull(Accounts.authorizeURL("javascript:alert(1)//cli/authorize\nhttps://portal.example/other"))
        assertEquals("network unreachable", Accounts.lastLine("│ starting\n■ network unreachable\n└ Failed\n"))
    }
}

class SessionsTest {
    @Test
    fun `lists top-level, unarchived sessions, newest first`() {
        val body = Json.parse(
            """{"data":[
              {"id":"old","title":"Old","time":{"created":1,"updated":10}},
              {"id":"new","title":"  New  ","time":{"updated":20}},
              {"id":"child","parentID":"new","time":{"updated":30}},
              {"id":"gone","time":{"updated":40,"archived":41}},
              {"id":"bad id!","time":{"updated":50}},
              {"id":"untitled","title":"","time":{"created":5}}
            ]}""",
        )
        assertEquals(
            listOf(SessionItem("new", "New", 20), SessionItem("old", "Old", 10), SessionItem("untitled", "Untitled session", 5)),
            Sessions.parse(body),
        )
        assertEquals(emptyList<SessionItem>(), Sessions.parse("nope"))
    }

    @Test
    fun `relative times and titles`() {
        assertEquals("just now", Sessions.ago(0, 30_000))
        assertEquals("5 min ago", Sessions.ago(0, 300_000))
        assertEquals("3 h ago", Sessions.ago(0, 3 * 3_600_000L))
        assertEquals("2 d ago", Sessions.ago(0, 2 * 86_400_000L))
        assertEquals("1970-01-01", Sessions.ago(0, 30 * 86_400_000L))
        assertEquals("Fix", Sessions.title(Json.parse("""{"data":{"title":"Fix"}}""")))
        assertTrue(Sessions.isId("ses_1-A"))
        assertFalse(Sessions.isId("a/b"))
    }
}
