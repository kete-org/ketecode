package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.Binary
import ai.ketecode.jetbrains.core.CliInstall
import ai.ketecode.jetbrains.core.CliRelease
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.io.HttpRequests
import java.io.IOException
import java.io.InputStream
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

// The Marketplace build of the plugin carries no `kete`: the first time it needs one it asks once, then
// downloads the binary of its own version from the public releases and verifies it (core/CliInstall.kt)
// in a cancellable background task. Consent is remembered (Settings → Tools → Kete Code), so later
// plugin versions download theirs with visible progress and no question. No network request is made
// before consent, and the PATH is never used instead.

/** Thrown by `KeteRuntime.binary()` while the CLI still has to be downloaded (or the download failed). */
class KeteCliMissingException(message: String) : Exception(message)

@Service(Service.Level.APP)
class KeteCliDownloads {
    private val log = logger<KeteCliDownloads>()
    private val lock = Any()
    private var inFlight: CompletableFuture<String>? = null
    private var consentNotification: Notification? = null
    /** The last download's failure: not retried by itself (the runtime asks for the binary often), only by Retry/Download. */
    @Volatile private var lastFailure: String? = null

    /** `<IDE system dir>/kete-code/cli`: per IDE, outside the plugin folder (which a plugin update replaces). */
    val root: Path get() = Path.of(PathManager.getSystemPath(), "kete-code", "cli")

    /** The plugin's own version: the CLI release it downloads (release builds set both from the kete-vX.Y.Z tag). */
    val version: String? get() = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.version

    /**
     * The binary for `need`: waits for the download when the user already agreed (never call on the EDT),
     * otherwise asks (once while the question is open) and throws [KeteCliMissingException].
     */
    fun binary(need: Binary.Resolved.Download): String {
        if (!KeteSettingsService.get().state.cliDownloadConsent) {
            askConsent(need, null)
            throw KeteCliMissingException(
                "$DISPLAY_NAME needs to download its kete CLI ${need.version} for ${describe(need.platform)} first. " +
                    "Choose Download, or set a CLI path in Settings → Tools → $DISPLAY_NAME.",
            )
        }
        lastFailure?.let { throw KeteCliMissingException(it) }
        val future = start(need, null)
        // The EDT never waits for a download (the task reports progress through it).
        if (ApplicationManager.getApplication().isDispatchThread && !future.isDone)
            throw KeteCliMissingException("$DISPLAY_NAME is downloading its kete CLI ${need.version}; try again when it finishes.")
        return try {
            future.get()
        } catch (error: java.util.concurrent.ExecutionException) {
            throw KeteCliMissingException(error.cause?.message ?: "The kete download failed.")
        }
    }

    /** Consent given in Settings: a failed download may be tried again the next time the CLI is needed. */
    fun resetFailure() {
        lastFailure = null
    }

    /** "Download" chosen in the chat or a notification: remembers consent and starts (or joins) the download. */
    fun consentAndDownload(project: Project?) {
        KeteSettingsService.get().state.cliDownloadConsent = true
        lastFailure = null
        ApplicationManager.getApplication().executeOnPooledThread {
            val runtime = KeteRuntime.get()
            val need = try {
                runtime.resolveBinary()
            } catch (error: Exception) {
                notify(project, error.message ?: "No kete binary", NotificationType.ERROR)
                return@executeOnPooledThread
            }
            if (need is Binary.Resolved.Download) start(need, project)
            else afterInstall()
        }
    }

    private fun describe(platform: String) = platform.replace("darwin", "macOS").replace("linux", "Linux").replace("windows", "Windows").replace("-", " ")

    private fun askConsent(need: Binary.Resolved.Download, project: Project?) {
        synchronized(lock) {
            if (consentNotification?.isExpired == false) return
            val notification = NotificationGroupManager.getInstance().getNotificationGroup(DOWNLOAD_NOTIFICATION_GROUP)
                .createNotification(
                    "$DISPLAY_NAME needs its kete CLI",
                    // No network request before consent, so the size is the releases' range, not this file's.
                    "This plugin downloads the kete CLI ${need.version} for ${describe(need.platform)} (about 80–95 MB) once from " +
                        "github.com/kete-org/kete-releases, and verifies it with Kete Code's release signing key before running it. " +
                        "Later versions download automatically. You can instead set a CLI path in Settings → Tools → $DISPLAY_NAME.",
                    NotificationType.INFORMATION,
                )
            notification.addAction(NotificationAction.createSimpleExpiring("Download") { consentAndDownload(project) })
            notification.addAction(NotificationAction.createSimpleExpiring("Open Settings") { openSettings(project) })
            consentNotification = notification
            notification.notify(project)
        }
    }

    private fun start(need: Binary.Resolved.Download, project: Project?): CompletableFuture<String> {
        synchronized(lock) {
            inFlight?.let { if (!it.isDone) return it }
            val future = CompletableFuture<String>()
            inFlight = future
            val task = object : Task.Backgroundable(project, "Downloading the $DISPLAY_NAME CLI ${need.version}", true) {
                override fun run(indicator: ProgressIndicator) {
                    indicator.isIndeterminate = false
                    val installer = CliInstall(
                        root = root,
                        keys = CliRelease.pinnedKeys(),
                        fetcher = IdeFetcher,
                        windows = SystemInfo.isWindows,
                        probe = ::probe,
                    )
                    val path = installer.install(need, object : CliInstall.Progress {
                        override fun checkCanceled() = indicator.checkCanceled()
                        override fun step(text: String) {
                            indicator.text = text
                        }
                        override fun fraction(value: Double) {
                            indicator.fraction = value.coerceIn(0.0, 1.0)
                        }
                    })
                    future.complete(path.toString())
                }

                override fun onSuccess() {
                    if (!future.isDone) future.completeExceptionally(KeteCliMissingException("The kete download ended without a result."))
                }

                override fun onCancel() {
                    future.completeExceptionally(KeteCliMissingException("The kete download was cancelled. Choose Download to try again."))
                }

                override fun onThrowable(error: Throwable) {
                    future.completeExceptionally(KeteCliMissingException(message(error)))
                }
            }
            future.whenComplete { _, error ->
                if (error == null) {
                    lastFailure = null
                    log.info("installed kete ${need.version} for ${need.platform}")
                    afterInstall()
                } else {
                    log.warn("kete download failed: ${error.message}")
                    lastFailure = error.message ?: "The kete download failed."
                    failed(error.message ?: "The kete download failed.", project)
                }
            }
            // Queued from the EDT in any modality: a modal dialog (Settings → Apply) must not hold it back
            // while callers wait. The task itself runs on a pooled thread with a progress indicator.
            ApplicationManager.getApplication().invokeLater({ task.queue() }, ModalityState.any())
            return future
        }
    }

    private fun message(error: Throwable): String = when (error) {
        is CliInstall.InstallException -> when (error.failure) {
            CliInstall.Failure.NOT_FOUND -> "${error.message} Install the plugin zip for your operating system from the Kete Code GitHub Release, or set a CLI path in Settings → Tools → $DISPLAY_NAME."
            CliInstall.Failure.NETWORK -> "${error.message}. Check your connection and the IDE's proxy settings (Settings → Appearance & Behavior → System Settings → HTTP Proxy), then retry."
            CliInstall.Failure.VERIFY -> "The downloaded kete failed verification and was deleted: ${error.message}"
            CliInstall.Failure.IO -> error.message ?: "The kete download failed."
        }
        is CliRelease.VerifyException -> "The kete download can't be verified: ${error.message}"
        else -> "The kete download failed: ${error.message ?: error.javaClass.simpleName}"
    }

    private fun failed(reason: String, project: Project?) {
        notify(project, reason, NotificationType.ERROR, "Retry" to { consentAndDownload(project) }, "Open Settings" to { openSettings(project) })
    }

    private fun afterInstall() {
        val runtime = KeteRuntime.get()
        if (runtime.status is ai.ketecode.jetbrains.core.RuntimeStatus.Failed) runtime.restart()
        runtime.refreshAccount()
    }

    private fun openSettings(project: Project?) {
        ApplicationManager.getApplication().invokeLater {
            ShowSettingsUtil.getInstance().showSettingsDialog(project, KeteConfigurable::class.java)
        }
    }

    /** `kete --version` of a binary that already passed the signature and checksum checks (as `kete upgrade` does). */
    private fun probe(binary: Path): String {
        val child = ProcessBuilder(binary.toString(), "--version")
            .directory(java.io.File(System.getProperty("user.home")))
            .redirectErrorStream(true)
            .start()
        child.outputStream.close()
        val output = CompletableFuture.supplyAsync { child.inputStream.readNBytes(64 * 1024).toString(Charsets.UTF_8) }
        if (!child.waitFor(60, TimeUnit.SECONDS)) {
            child.destroyForcibly()
            throw IOException("kete --version did not finish within 60 seconds")
        }
        val text = output.get(5, TimeUnit.SECONDS)
        if (child.exitValue() != 0) throw IOException("kete --version exited with code ${child.exitValue()}: ${text.trim().take(200)}")
        return text
    }

    /** HTTPS GETs through the IDE's HTTP stack (proxy settings, trusted certificates). */
    object IdeFetcher : CliInstall.Fetcher {
        override fun <T> get(url: String, read: (InputStream, Long) -> T): T {
            if (!url.startsWith("https://")) throw IOException("refusing a non-HTTPS URL: $url")
            return try {
                HttpRequests.request(url)
                    .productNameAsUserAgent()
                    .connectTimeout(15_000)
                    .readTimeout(60_000)
                    .redirectLimit(5)
                    .throwStatusCodeException(true)
                    // Runs for every hop, redirects included, before it connects: GitHub's redirect to its
                    // download host must be HTTPS too.
                    .tuner { connection ->
                        if (connection.url.protocol != "https") throw IOException("refusing a non-HTTPS redirect to ${connection.url.host}")
                    }
                    .connect { request -> read(request.inputStream, request.connection.contentLengthLong) }
            } catch (error: HttpRequests.HttpStatusException) {
                throw CliInstall.FetchException("$url returned HTTP ${error.statusCode}", error.statusCode, error)
            }
        }
    }

    companion object {
        const val PLUGIN_ID = "ai.ketecode.kete-code"
        const val DOWNLOAD_NOTIFICATION_GROUP = "Kete Code CLI download"

        fun get(): KeteCliDownloads = service()
    }
}
