package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.ContextFilter
import ai.ketecode.jetbrains.core.EditorTools
import ai.ketecode.jetbrains.core.Json
import ai.ketecode.jetbrains.core.Paths
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.components.serviceIfCreated
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

// The IDE's problems for the agent, as an MCP server the runtime connects to (the contract of
// packages/kete-vscode/src/editor-tools.ts; protocol in core/EditorTools.kt). One loopback server per
// IDE; each project gets its own path (/mcp/<random key>) and its own random bearer token, a new one on
// every registration (every runtime start or restart), and is registered with the running `kete serve`
// under its own directory. The runtime, not the plugin, executes the tool
// call and applies permissions. Secret-looking and IDE-excluded files are never reported.

@Service(Service.Level.APP)
class EditorToolsServer : Disposable {
    private val log = logger<EditorToolsServer>()
    /** A registered project and its current bearer token (replaced on every registration). */
    private class Entry(val project: Project, @Volatile var token: String)

    private val projects = ConcurrentHashMap<String, Entry>()
    private var server: HttpServer? = null
    private var port = 0

    private fun ensureStarted(): Int = synchronized(this) {
        server?.let { return port }
        val created = HttpServer.create(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 0)
        created.executor = Executors.newFixedThreadPool(2) { runnable -> Thread(runnable, "Kete Code editor tools").apply { isDaemon = true } }
        created.createContext("/mcp/") { exchange -> handle(exchange) }
        created.start()
        server = created
        port = created.address.port
        port
    }

    /** Registers the project's tools with the running runtime (after every start: new port and password). Never blocks the EDT. */
    fun register(project: Project) {
        if (!KeteSettingsService.get().state.editorTools) return
        val directory = project.basePath ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val port = ensureStarted()
                val runtime = KeteRuntime.get()
                val connection = runtime.running() ?: return@executeOnPooledThread
                // A new token for every (re)connect: one from an earlier runtime run stops working.
                val token = KeteRuntime.randomToken()
                val key = synchronized(projects) {
                    val known = projects.entries.firstOrNull { it.value.project == project }
                    if (known != null) {
                        known.value.token = token
                        known.key
                    } else KeteRuntime.randomToken().also { projects[it] = Entry(project, token) }
                }
                val response = runtime.request(
                    connection,
                    "PUT",
                    "/api/experimental/mcp/${EditorTools.SERVER_NAME}?directory=${KeteRuntime.encode(directory)}",
                    mapOf(
                        "config" to mapOf(
                            "type" to "remote",
                            "url" to "http://127.0.0.1:$port/mcp/$key",
                            "headers" to mapOf("Authorization" to "Bearer $token"),
                            "oauth" to false,
                            "codemode" to false,
                        ),
                    ),
                )
                if (response.statusCode() !in 200..299) log.warn("editor tools: HTTP ${response.statusCode()}: ${response.body().take(300)}")
                else log.info("editor tools (diagnostics) registered with the runtime")
            } catch (error: Exception) {
                log.warn("editor tools unavailable: ${error.message}")
            }
        }
    }

    fun forget(project: Project) {
        projects.entries.removeIf { it.value.project == project }
    }

    private fun handle(exchange: HttpExchange) {
        try {
            val headers = exchange.requestHeaders.mapValues { it.value.toList() }
            val key = exchange.requestURI.path.removePrefix("/mcp/")
            // An unknown path gets the same answer as a wrong token.
            val entry = projects[key] ?: return send(exchange, 401, null)
            if (!EditorTools.authorized(headers, entry.token, port)) return send(exchange, 401, null)
            val project = entry.project.takeIf { !it.isDisposed } ?: return send(exchange, 404, null)
            // Streamable HTTP without a server-to-client stream: GET is refused, DELETE ends nothing.
            if (exchange.requestMethod == "DELETE") return send(exchange, 200, null)
            if (exchange.requestMethod != "POST") return send(exchange, 405, null)
            val bytes = exchange.requestBody.readNBytes(MAX_BODY + 1)
            if (bytes.size > MAX_BODY) return send(exchange, 413, null)
            val parsed = try {
                Json.parse(String(bytes, Charsets.UTF_8))
            } catch (_: Exception) {
                return send(exchange, 400, mapOf("jsonrpc" to "2.0", "id" to null, "error" to mapOf("code" to -32700, "message" to "parse error")))
            }
            val tools = EditorTools.Tools { path -> diagnostics(project, path) }
            val messages = if (parsed is List<*>) parsed else listOf(parsed)
            val replies = messages.mapNotNull { EditorTools.handle(it, tools) }
            if (replies.isEmpty()) return send(exchange, 202, null)
            send(exchange, 200, if (parsed is List<*>) replies else replies[0])
        } catch (error: Exception) {
            log.warn("editor tools: ${error.message}")
            runCatching { send(exchange, 500, null) }
        }
    }

    private fun send(exchange: HttpExchange, status: Int, body: Any?) {
        if (body == null) {
            exchange.sendResponseHeaders(status, -1)
            exchange.close()
            return
        }
        val bytes = Json.write(body).toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.add("content-type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    /** Diagnostics for one project file, or every open file; null when `path` isn't a shareable file in the project. */
    private fun diagnostics(project: Project, path: String?): List<EditorTools.Diagnostic>? {
        val base = project.basePath ?: return null
        val keteProject = KeteProject.get(project)
        val files: List<VirtualFile> = if (path != null) {
            val target = Paths.insideWorkspace(base, path) ?: return null
            listOf(LocalFileSystem.getInstance().findFileByNioFile(target) ?: return null)
        } else {
            FileEditorManager.getInstance(project).openFiles.toList()
        }
        val results = ArrayList<EditorTools.Diagnostic>()
        for (file in files) {
            val relative = keteProject.relative(file)
            if (!ContextFilter.shareable(relative, file.isInLocalFileSystem, keteProject.excluded(file))) {
                if (path != null) return null
                continue
            }
            results.addAll(ApplicationManager.getApplication().runReadAction(Computable { highlights(project, file, relative!!) }))
        }
        return results
    }

    private fun highlights(project: Project, file: VirtualFile, relative: String): List<EditorTools.Diagnostic> {
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return emptyList()
        val found = ArrayList<EditorTools.Diagnostic>()
        DaemonCodeAnalyzerEx.processHighlights(document, project, HighlightSeverity.WEAK_WARNING, 0, document.textLength) { info: HighlightInfo ->
            val message = info.description
            if (message != null && found.size < 1000) {
                val offset = info.startOffset.coerceIn(0, document.textLength)
                val line = document.getLineNumber(offset)
                found.add(
                    EditorTools.Diagnostic(
                        path = relative,
                        line = line + 1,
                        column = offset - document.getLineStartOffset(line) + 1,
                        severity = when {
                            info.severity >= HighlightSeverity.ERROR -> "error"
                            info.severity >= HighlightSeverity.WARNING -> "warning"
                            else -> "info"
                        },
                        source = info.inspectionToolId,
                        message = message,
                    ),
                )
            }
            true
        }
        return found
    }

    override fun dispose() {
        synchronized(this) {
            server?.stop(0)
            server = null
        }
    }

    companion object {
        private const val MAX_BODY = 1_000_000

        fun get(): EditorToolsServer = service()

        fun getIfCreated(): EditorToolsServer? = serviceIfCreated()
    }
}
