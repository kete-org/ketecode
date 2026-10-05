package ai.ketecode.jetbrains.core

// The runtime's event stream (`GET /api/event`, server-sent events) and what the plugin needs from it
// (mirrors packages/kete-vscode/src/events.ts): which permission prompts are waiting, and when a
// session finishes. It reads the server directly, so it works while the chat tool window is hidden.

data class Event(val type: String, val data: Any?)

/** Waiting permission requests (request id → session id) and sessions currently working. */
data class Attention(val pending: Map<String, String> = emptyMap(), val busy: Set<String> = emptySet())

sealed interface Change {
    data class Asked(val sessionID: String, val action: String) : Change
    data class Finished(val sessionID: String) : Change
}

data class Reduced(val state: Attention, val change: Change? = null)

object Events {
    val EMPTY = Attention()

    /** The next attention state for one event, and what changed that a user should hear about. */
    fun reduce(state: Attention, event: Event): Reduced {
        val data = event.data.asObject() ?: emptyMap()
        if (event.type == "permission.asked") {
            val id = data.string("id")
            val session = data.string("sessionID")
            if (id != null && session != null)
                return Reduced(state.copy(pending = state.pending + (id to session)), Change.Asked(session, data.string("action") ?: ""))
        }
        if (event.type == "permission.replied") {
            val id = data.string("requestID") ?: return Reduced(state)
            if (id !in state.pending) return Reduced(state)
            return Reduced(state.copy(pending = state.pending - id))
        }
        if (event.type == "session.status") {
            val session = data.string("sessionID")
            val type = data["status"].asObject()?.string("type")
            if (session != null && type != null) {
                if (type == "busy" || type == "retry") return Reduced(state.copy(busy = state.busy + session))
                if (type == "idle") {
                    val wasBusy = session in state.busy
                    // A finished session has no prompts left waiting.
                    val next = Attention(state.pending.filterValues { it != session }, state.busy - session)
                    return Reduced(next, if (wasBusy) Change.Finished(session) else null)
                }
            }
        }
        return Reduced(state)
    }

    data class Frames(val events: List<Event>, val rest: String)

    /** Splits server-sent-event text into complete events; returns the incomplete remainder. */
    fun parseFrames(buffer: String): Frames {
        val frames = buffer.replace("\r\n", "\n").split("\n\n")
        val rest = frames.last()
        val events = frames.dropLast(1).mapNotNull { frame ->
            val data = frame.split("\n")
                .filter { it.startsWith("data:") }
                .joinToString("\n") { it.removePrefix("data:").trimStart() }
            if (data.isEmpty()) return@mapNotNull null
            val value = Json.parseOrNull(data).asObject() ?: return@mapNotNull null
            val type = value.string("type") ?: return@mapNotNull null
            Event(type, value["data"])
        }
        return Frames(events, rest)
    }

    /** Pending requests from `GET /api/permission/request?directory=` (request id → session id). */
    fun pendingRequests(body: Any?): Map<String, String> =
        body.asObject()?.get("data").asList().orEmpty().mapNotNull { item ->
            val entry = item.asObject() ?: return@mapNotNull null
            val id = entry.string("id") ?: return@mapNotNull null
            val session = entry.string("sessionID") ?: return@mapNotNull null
            id to session
        }.toMap()
}
