package ai.ketecode.jetbrains.core

import java.security.MessageDigest

// Tools the IDE gives the agent over MCP: its problems (errors and warnings from the IDE's own
// inspections and language support). The same contract as packages/kete-vscode/src/editor-tools.ts:
// the plugin serves them on 127.0.0.1 with a random token and registers the server with its own
// `kete serve` (`PUT /api/experimental/mcp/editor?directory=`). This file is the protocol, the
// formatting and the request check.

object EditorTools {
    const val SERVER_NAME = "editor"
    private val PROTOCOL_VERSIONS = listOf("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
    private const val MAX_DIAGNOSTICS = 200
    private val SEVERITIES = listOf("error", "warning", "info", "hint")

    data class Diagnostic(
        val path: String,
        val line: Int,
        val column: Int,
        val severity: String,
        val source: String?,
        val message: String,
    )

    /** Diagnostics for one project-relative file, or every open file; null: not a file in this project. */
    fun interface Tools {
        fun diagnostics(path: String?): List<Diagnostic>?
    }

    private val TOOLS = listOf(
        mapOf(
            "name" to "diagnostics",
            "description" to "Errors and warnings the user's IDE (a JetBrains IDE) reports from its inspections, language support and " +
                "type checkers. Pass `path` (relative to the project) for one file; omit it for every file open in the editor. " +
                "The IDE analyses files as they are opened, so a file that was never opened may show no problems yet. " +
                "Use after editing to check your changes compile and lint cleanly.",
            "inputSchema" to mapOf(
                "type" to "object",
                "properties" to mapOf("path" to mapOf("type" to "string", "description" to "Project-relative file path. Omit for all open files.")),
                "additionalProperties" to false,
            ),
            "annotations" to mapOf("readOnlyHint" to true, "openWorldHint" to false),
        ),
    )

    /** The JSON-RPC response for one message; null for notifications. */
    fun handle(message: Any?, tools: Tools): Map<String, Any?>? {
        val request = message.asObject()
        if (request == null || request["jsonrpc"] != "2.0" || request["method"] !is String) return error(null, -32600, "invalid request")
        if (!request.containsKey("id")) return null
        val id = request["id"]
        val method = request.string("method")!!
        val params = request["params"].asObject() ?: emptyMap()
        return when (method) {
            "initialize" -> {
                val requested = params.string("protocolVersion") ?: ""
                result(
                    id,
                    mapOf(
                        "protocolVersion" to if (requested in PROTOCOL_VERSIONS) requested else PROTOCOL_VERSIONS[0],
                        "capabilities" to mapOf("tools" to mapOf("listChanged" to false)),
                        "serverInfo" to mapOf("name" to SERVER_NAME, "version" to "1"),
                        "instructions" to "Diagnostics from the IDE the user is working in.",
                    ),
                )
            }
            "ping" -> result(id, emptyMap<String, Any?>())
            "tools/list" -> result(id, mapOf("tools" to TOOLS))
            "tools/call" -> {
                val args = params["arguments"].asObject() ?: emptyMap()
                if (params["name"] != "diagnostics") return error(id, -32602, "unknown tool: ${params["name"]}")
                val raw = args["path"]
                if (raw != null && raw !is String) return error(id, -32602, "path must be a string")
                val path = (raw as String?)?.trim()?.takeIf { it.isNotEmpty() }
                val found = tools.diagnostics(path) ?: return result(id, text("$path is not a file in this project.", true))
                result(id, text(format(found, path)))
            }
            else -> error(id, -32601, "method not found: $method")
        }
    }

    /** Errors first, then warnings, info and hints; at most 200 lines. */
    fun format(items: List<Diagnostic>, path: String? = null): String {
        if (items.isEmpty()) return if (path != null) "No problems in $path." else "No problems in the open files."
        val sorted = items.sortedWith(
            compareBy<Diagnostic> { SEVERITIES.indexOf(it.severity) }.thenBy { it.path }.thenBy { it.line },
        )
        val summary = SEVERITIES.mapNotNull { severity ->
            val count = items.count { it.severity == severity }
            if (count == 0) null else "$count $severity${if (count == 1) "" else "s"}"
        }.joinToString(", ")
        val lines = sorted.take(MAX_DIAGNOSTICS).map {
            "${it.path}:${it.line}:${it.column} ${it.severity}${if (it.source != null) " [${it.source}]" else ""}: ${it.message.replace("\n", " ")}"
        }
        val more = if (sorted.size > MAX_DIAGNOSTICS) listOf("… and ${sorted.size - MAX_DIAGNOSTICS} more") else emptyList()
        return (listOf(summary) + lines + more).joinToString("\n")
    }

    /**
     * Only the runtime this plugin started may call: the exact bearer token, to the loopback address (not
     * a rebound name), and never from a web page (browsers always send Origin). Header names are matched
     * case-insensitively; a repeated header is refused.
     */
    fun authorized(headers: Map<String, List<String>>, token: String, port: Int): Boolean {
        fun header(name: String): List<String> = headers.entries.filter { it.key.equals(name, ignoreCase = true) }.flatMap { it.value }
        if (header("origin").isNotEmpty()) return false
        val host = header("host")
        if (host.size != 1 || host[0] != "127.0.0.1:$port") return false
        val auth = header("authorization")
        if (auth.size != 1 || !auth[0].startsWith("Bearer ")) return false
        val given = auth[0].substring(7).toByteArray(Charsets.UTF_8)
        val expected = token.toByteArray(Charsets.UTF_8)
        return MessageDigest.isEqual(given, expected)
    }

    private fun text(value: String, isError: Boolean = false) =
        mapOf("content" to listOf(mapOf("type" to "text", "text" to value)), "isError" to isError)

    private fun result(id: Any?, value: Any?) = mapOf("jsonrpc" to "2.0", "id" to id, "result" to value)

    private fun error(id: Any?, code: Int, message: String) =
        mapOf("jsonrpc" to "2.0", "id" to id, "error" to mapOf("code" to code, "message" to message))
}
