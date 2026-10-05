package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.Account
import ai.ketecode.jetbrains.core.AccountState
import ai.ketecode.jetbrains.core.Accounts
import ai.ketecode.jetbrains.core.Attention
import ai.ketecode.jetbrains.core.Backoff
import ai.ketecode.jetbrains.core.Binary
import ai.ketecode.jetbrains.core.Change
import ai.ketecode.jetbrains.core.Event
import ai.ketecode.jetbrains.core.Events
import ai.ketecode.jetbrains.core.Json
import ai.ketecode.jetbrains.core.KeteConfig
import ai.ketecode.jetbrains.core.Pairing
import ai.ketecode.jetbrains.core.RuntimeStatus
import ai.ketecode.jetbrains.core.StartLine
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Disposer
import com.intellij.util.EnvironmentUtil
import java.io.File
import java.io.InputStream
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.SecureRandom
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

// The plugin's own `kete serve`: one per IDE process, started on first use, bound to 127.0.0.1 on a
// random port with a random password, restarted with backoff if it crashes, stopped when the IDE exits
// or the last project closes. Mirrors packages/kete-vscode/src/server.ts. `serve --stdio` prints
// `{"url": …}` once listening, keeps the password out of its tools' environment and exits when its
// stdin closes. Each project passes its own directory (`kete.workspace`, `?directory=`).
//
// Also owns what is per-runtime rather than per-project: the account (`kete whoami`), the event
// stream (`GET /api/event`, attention for every project) and CLI helpers.

data class Connection(val url: String, val password: String)

class RuntimeException(message: String) : Exception(message)

@Service(Service.Level.APP)
class KeteRuntime : Disposable {
    private val log = logger<KeteRuntime>()
    private val lock = Any()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "Kete Code runtime").apply { isDaemon = true }
    }
    private val backoff = Backoff()
    private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()

    @Volatile var status: RuntimeStatus = RuntimeStatus.Stopped
        private set
    @Volatile var account: AccountState = AccountState.Checking
        private set
    @Volatile var attention: Attention = Events.EMPTY
        private set
    /** The mode the running server gives sessions without their own (the setting when it started). */
    @Volatile var serverMode: String = "default"
        private set

    private var process: Process? = null
    private var current: Connection? = null
    private var pending: CompletableFuture<Connection>? = null
    private var restartTimer: ScheduledFuture<*>? = null
    private var stopping = false
    private var events: EventStream? = null
    @Volatile private var accountChecked = 0L

    /** Calls `listener` (on any thread) whenever status, account or attention change. */
    fun addListener(parent: Disposable, listener: () -> Unit) {
        listeners.add(listener)
        Disposer.register(parent) { listeners.remove(listener) }
    }

    private fun changed() = listeners.forEach { runCatching(it).onFailure { error -> log.warn(error) } }

    private fun set(next: RuntimeStatus) {
        status = next
        log.info("server: ${describe(next)}")
        changed()
        ApplicationManager.getApplication().invokeLater {
            for (project in ProjectManager.getInstance().openProjects)
                if (!project.isDisposed) project.service<KeteProject>().runtimeChanged(next)
        }
    }

    private fun describe(status: RuntimeStatus) = when (status) {
        is RuntimeStatus.Running -> "running"
        is RuntimeStatus.Restarting -> "restarting (${status.reason})"
        is RuntimeStatus.Failed -> "failed (${status.reason})"
        else -> status.javaClass.simpleName.lowercase()
    }

    /** The running server, starting it if needed. Concurrent callers share one start. Never call on the EDT and wait. */
    fun connection(): CompletableFuture<Connection> = synchronized(lock) {
        current?.let { return CompletableFuture.completedFuture(it) }
        pending?.let { return it }
        restartTimer?.cancel(false)
        restartTimer = null
        stopping = false
        backoff.reset()
        launch()
    }

    /** The connection if the server is running, without starting it. */
    fun running(): Connection? = synchronized(lock) { current }

    fun restart(): CompletableFuture<Connection> {
        stop()
        return connection()
    }

    /** Closes stdin (the server exits on its own) and kills it if it hasn't after five seconds. */
    fun stop() {
        val child = synchronized(lock) {
            stopping = true
            restartTimer?.cancel(false)
            restartTimer = null
            val child = process
            process = null
            current = null
            pending?.completeExceptionally(RuntimeException("The server was stopped"))
            pending = null
            child
        }
        stopEvents()
        if (child != null && child.isAlive) {
            runCatching { child.outputStream.close() }
            if (!child.waitFor(5, TimeUnit.SECONDS)) child.destroyForcibly()
        }
        set(RuntimeStatus.Stopped)
    }

    private fun launch(): CompletableFuture<Connection> {
        val future = CompletableFuture<Connection>()
        pending = future
        set(RuntimeStatus.Starting)
        ApplicationManager.getApplication().executeOnPooledThread { start(future) }
        return future
    }

    private fun start(future: CompletableFuture<Connection>) {
        val binary = try {
            binary()
        } catch (error: Exception) {
            synchronized(lock) { if (pending === future) pending = null }
            set(RuntimeStatus.Failed(error.message ?: "no kete binary"))
            future.completeExceptionally(error)
            return
        }
        val password = randomToken()
        val settings = KeteSettingsService.get().current().mapped()
        serverMode = KeteConfig.permissionMode(KeteSettingsService.get().current().defaultMode)
        val builder = ProcessBuilder(binary, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0")
            .directory(File(System.getProperty("user.home")))
        builder.environment().apply {
            // The user's shell environment (PATH etc.), which an IDE started from the desktop lacks.
            putAll(EnvironmentUtil.getEnvironmentMap())
            putAll(settings.environment)
            put("KETE_PASSWORD", password)
        }
        val child = try {
            builder.start()
        } catch (error: Exception) {
            synchronized(lock) { if (pending === future) pending = null }
            crashed("Could not run kete: ${error.message}")
            future.completeExceptionally(error)
            return
        }
        synchronized(lock) {
            if (pending !== future) {
                child.destroyForcibly()
                return
            }
            process = child
        }
        drain(child.errorStream, "kete serve")
        val started = try {
            listening(child, 60_000)
        } catch (error: Exception) {
            child.destroyForcibly()
            synchronized(lock) {
                if (process === child) process = null
                if (pending === future) pending = null
            }
            val reason = error.message ?: "kete serve did not start"
            crashed(reason)
            future.completeExceptionally(RuntimeException(reason))
            return
        }
        val connection = Connection(started, password)
        synchronized(lock) {
            if (process !== child) {
                future.completeExceptionally(RuntimeException("The server was stopped while starting"))
                return
            }
            current = connection
            pending = null
        }
        // Keep draining stdout: a full pipe would block the server.
        drain(child.inputStream, "kete serve")
        child.onExit().thenAccept { exited ->
            val unexpected = synchronized(lock) {
                if (process !== exited) return@synchronized false
                process = null
                current = null
                !stopping
            }
            if (unexpected) {
                stopEvents()
                crashed("kete serve exited (code ${exited.exitValue()})")
            }
        }
        set(RuntimeStatus.Running(started))
        future.complete(connection)
        startEvents()
    }

    private fun crashed(reason: String) {
        log.warn(reason)
        when (val decision = synchronized(lock) { backoff.crashed(System.currentTimeMillis()) }) {
            is Backoff.Decision.GiveUp -> {
                set(RuntimeStatus.Failed("$reason. Stopped restarting after ${decision.failures} failures."))
                notifyFailed(reason)
            }
            is Backoff.Decision.Retry -> {
                set(RuntimeStatus.Restarting(decision.attempt, decision.delay, reason))
                synchronized(lock) {
                    val task = Runnable {
                        synchronized(lock) {
                            restartTimer = null
                            if (!stopping && current == null && pending == null) {
                                // A failed restart schedules the next one itself (crashed); nobody waits for this one.
                                launch().exceptionally { null }
                            }
                        }
                    }
                    restartTimer = scheduler.schedule(task, decision.delay, TimeUnit.MILLISECONDS)
                }
            }
        }
    }

    private fun notifyFailed(reason: String) {
        notify(null, "Kete Code server stopped: $reason", com.intellij.notification.NotificationType.ERROR, "Restart" to { restart() })
    }

    /** Reads lines from the process's stdout until the start line, or fails after `timeout` ms. */
    private fun listening(child: Process, timeout: Long): String {
        val future = CompletableFuture<String>()
        val reader = Thread({
            try {
                val stream = child.inputStream
                val buffer = StringBuilder()
                val chunk = ByteArray(4096)
                while (!future.isDone) {
                    // Byte by byte only until the start line; then the stream is handed to `drain`.
                    val read = stream.read()
                    if (read == -1) break
                    buffer.append(read.toChar())
                    if (read == '\n'.code) {
                        val line = StartLine.find(buffer.toString())
                        if (line != null) {
                            val url = StartLine.parseUrl(line)
                            if (url != null) future.complete(url)
                            else future.completeExceptionally(RuntimeException("kete serve printed an unexpected start line"))
                            return@Thread
                        }
                    }
                    if (buffer.length > chunk.size * 16) buffer.setLength(0)
                }
                future.completeExceptionally(RuntimeException("kete serve exited before it was ready"))
            } catch (error: Exception) {
                future.completeExceptionally(error)
            }
        }, "Kete Code start line")
        reader.isDaemon = true
        reader.start()
        return try {
            future.get(timeout, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            throw RuntimeException("kete serve did not start within ${timeout / 1000} seconds")
        } catch (error: java.util.concurrent.ExecutionException) {
            throw RuntimeException(error.cause?.message ?: "kete serve did not start")
        }
    }

    private fun drain(stream: InputStream, name: String) {
        val thread = Thread({
            try {
                stream.bufferedReader().forEachLine { line -> if (line.isNotBlank()) log.debug("$name: $line") }
            } catch (_: Exception) {
                // The process ended.
            }
        }, "Kete Code output")
        thread.isDaemon = true
        thread.start()
    }

    // -------------------------------------------------------------------------------------------
    // Binary and CLI

    /** The binary to run: the CLI path setting, else the one bundled for this OS/architecture. */
    fun binary(): String {
        val plugin = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))
            ?: throw RuntimeException("The Kete Code plugin's files were not found")
        val resolved = Binary.resolve(
            plugin.pluginPath.toString(),
            KeteSettingsService.get().state.cliPath,
            System.getProperty("os.name"),
            System.getProperty("os.arch"),
        )
        return when (resolved) {
            is Binary.Resolved.Ok -> resolved.path
            is Binary.Resolved.Error -> throw RuntimeException(resolved.message)
        }
    }

    data class CliResult(val exit: Int, val stdout: String, val stderr: String)

    /** Runs the CLI with `args` and a timeout. Never on the EDT. */
    fun cli(vararg args: String, timeoutSeconds: Long = 30): CliResult {
        val child = ProcessBuilder(listOf(binary()) + args)
            .directory(File(System.getProperty("user.home")))
            .apply { environment().putAll(EnvironmentUtil.getEnvironmentMap()) }
            .start()
        child.outputStream.close()
        val stdout = CompletableFuture.supplyAsync { child.inputStream.bufferedReader().readText() }
        val stderr = CompletableFuture.supplyAsync { child.errorStream.bufferedReader().readText() }
        if (!child.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
            child.destroyForcibly()
            throw RuntimeException("kete ${args.firstOrNull() ?: ""} timed out after $timeoutSeconds s")
        }
        return CliResult(child.exitValue(), stdout.get(5, TimeUnit.SECONDS), stderr.get(5, TimeUnit.SECONDS))
    }

    fun configDirectory(): String? = try {
        KeteConfig.configDirectory(cli("debug", "paths").stdout)
    } catch (error: Exception) {
        log.warn("kete debug paths: ${error.message}")
        null
    }

    /** Re-reads the account (`kete whoami`). Never on the EDT. */
    fun refreshAccount() {
        accountChecked = System.currentTimeMillis()
        account = try {
            val result = cli("whoami", "--format", "json", timeoutSeconds = 15)
            if (result.exit != 0) AccountState.Unknown(Accounts.lastLine(result.stderr) ?: "exit code ${result.exit}")
            else AccountState.Known(Accounts.parseWhoami(result.stdout))
        } catch (error: Exception) {
            AccountState.Unknown(error.message ?: error.javaClass.simpleName)
        }
        changed()
    }

    /** Re-reads the account when the IDE regains focus, at most every 30 s (it runs the binary). */
    fun refreshAccountIfStale() {
        if (System.currentTimeMillis() - accountChecked > 30_000)
            ApplicationManager.getApplication().executeOnPooledThread { refreshAccount() }
    }

    val signedIn: Boolean get() = (account as? AccountState.Known)?.account is Account.SignedIn

    // -------------------------------------------------------------------------------------------
    // Runtime HTTP API (Basic auth with this session's password)

    fun request(connection: Connection, method: String, path: String, body: Any? = null, timeoutSeconds: Long = 15): HttpResponse<String> {
        val builder = HttpRequest.newBuilder(URI.create(connection.url + path))
            .timeout(Duration.ofSeconds(timeoutSeconds))
            .header("authorization", Pairing.basic(connection.password))
        if (body != null) builder.header("content-type", "application/json")
        builder.method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(Json.write(body)))
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString())
    }

    /** GET returning parsed JSON, or null on any failure. */
    fun getJson(path: String, timeoutSeconds: Long = 10): Any? {
        val connection = running() ?: return null
        return try {
            val response = request(connection, "GET", path, timeoutSeconds = timeoutSeconds)
            if (response.statusCode() in 200..299) Json.parseOrNull(response.body()) else null
        } catch (error: Exception) {
            log.debug("GET $path: ${error.message}")
            null
        }
    }

    /** Asks the running server to reload its configuration (after sign-in, sign-out or a settings change). */
    fun reloadConfig() {
        val connection = running() ?: return
        try {
            val response = request(connection, "POST", "/api/location/reload", timeoutSeconds = 30)
            if (response.statusCode() !in 200..299) log.warn("reloading the server configuration failed: HTTP ${response.statusCode()}")
        } catch (error: Exception) {
            log.warn("reloading the server configuration failed: ${error.message}")
        }
    }

    // -------------------------------------------------------------------------------------------
    // Attention: waiting permission prompts and finished sessions, from the event stream

    private fun startEvents() {
        stopEvents()
        attention = Events.EMPTY
        val stream = EventStream()
        synchronized(lock) { events = stream }
        stream.start()
    }

    private fun stopEvents() {
        val stream = synchronized(lock) { events.also { events = null } }
        stream?.stop()
        if (attention != Events.EMPTY) {
            attention = Events.EMPTY
            changed()
        }
    }

    private fun onEvent(event: Event) {
        val before = attention
        val next = Events.reduce(before, event)
        attention = next.state
        // The stream also carries every streamed token: only attention changes reach the UI.
        if (next.state != before) changed()
        val change = next.change ?: return
        ApplicationManager.getApplication().invokeLater { routeChange(change) }
    }

    /** Tells one project about a change: the one whose chat shows the session, else the focused one. */
    private fun routeChange(change: Change) {
        val projects = ProjectManager.getInstance().openProjects.filter { !it.isDisposed }
        val session = when (change) {
            is Change.Asked -> change.sessionID
            is Change.Finished -> change.sessionID
        }
        val target = projects.firstOrNull { it.service<KeteProject>().showsSession(session) }
            ?: projects.firstOrNull { com.intellij.openapi.wm.WindowManager.getInstance().getFrame(it)?.isActive == true }
            ?: projects.firstOrNull()
        target?.service<KeteProject>()?.attentionChanged(change)
    }

    /** Requests asked while disconnected: read every open project's list again. */
    private fun onConnect(connection: Connection) {
        val pending = HashMap<String, String>()
        for (project in ProjectManager.getInstance().openProjects) {
            val directory = project.basePath ?: continue
            try {
                val response = request(connection, "GET", "/api/permission/request?directory=${encode(directory)}", timeoutSeconds = 10)
                if (response.statusCode() in 200..299) pending.putAll(Events.pendingRequests(Json.parseOrNull(response.body())))
            } catch (error: Exception) {
                log.debug("permission requests: ${error.message}")
            }
        }
        attention = attention.copy(pending = pending)
        changed()
    }

    /** Follows `GET /api/event`, reconnecting with growing delays (1 s doubling to 30 s) until stopped. */
    private inner class EventStream {
        @Volatile private var stopped = false
        @Volatile private var stream: InputStream? = null
        private var delay = 1_000L

        fun start() {
            val thread = Thread({ loop() }, "Kete Code events")
            thread.isDaemon = true
            thread.start()
        }

        fun stop() {
            stopped = true
            runCatching { stream?.close() }
        }

        private fun loop() {
            while (!stopped) {
                val connection = running()
                if (connection != null) {
                    try {
                        follow(connection)
                    } catch (error: Exception) {
                        if (!stopped) log.debug("event stream: ${error.message}")
                    }
                }
                if (stopped) return
                Thread.sleep(delay)
                delay = minOf(delay * 2, 30_000)
            }
        }

        private fun follow(connection: Connection) {
            val request = HttpRequest.newBuilder(URI.create("${connection.url}/api/event"))
                .header("accept", "text/event-stream")
                .header("authorization", Pairing.basic(connection.password))
                .GET()
                .build()
            val response = http.send(request, HttpResponse.BodyHandlers.ofInputStream())
            if (response.statusCode() !in 200..299) {
                response.body().close()
                throw RuntimeException("HTTP ${response.statusCode()}")
            }
            val body = response.body()
            stream = body
            delay = 1_000
            onConnect(connection)
            val reader = body.reader(Charsets.UTF_8)
            val chunk = CharArray(8192)
            var buffer = ""
            while (!stopped) {
                val read = reader.read(chunk)
                if (read == -1) return
                val parsed = Events.parseFrames(buffer + String(chunk, 0, read))
                buffer = parsed.rest
                if (buffer.length > 1_000_000) buffer = ""
                parsed.events.forEach { onEvent(it) }
            }
        }
    }

    override fun dispose() {
        stop()
        scheduler.shutdownNow()
    }

    companion object {
        const val PLUGIN_ID = "ai.ketecode.kete-code"

        fun get(): KeteRuntime = service()

        fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8)

        fun randomToken(): String {
            val bytes = ByteArray(32)
            SecureRandom().nextBytes(bytes)
            return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }

        /** Projects still open (for stopping the runtime when the last one closes). */
        fun openProjects(): List<Project> = ProjectManager.getInstance().openProjects.filter { !it.isDisposed }
    }
}
