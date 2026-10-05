package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.KeteConfig
import ai.ketecode.jetbrains.core.PluginSettings
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.panel
import java.io.File

// Settings → Tools → Kete Code. The plugin's own settings are stored by the IDE (like VS Code's
// settings for the extension); gateway URL, platform URL and session budget are written into Kete
// Code's global kete.jsonc (KeteConfig), so the CLI, the TUI and every editor share them.

@Service(Service.Level.APP)
@State(name = "KeteCodeSettings", storages = [Storage("kete-code.xml")])
class KeteSettingsService : SimplePersistentStateComponent<KeteSettingsService.Settings>(Settings()) {
    class Settings : BaseState() {
        var cliPath by string()
        var defaultMode by string("default")
        var shareEditorContext by property(true)
        var notifications by property(true)
        var editorTools by property(true)
        var gatewayUrl by string()
        var platformUrl by string()
        var sessionBudget by string()
        /** The chat panel's dismissed notices (core/Panel.kt) and CLI hint. */
        var dismissedNotices by list<String>()
        var cliHintDismissed by property(false)
    }

    fun current(): PluginSettings = PluginSettings(
        cliPath = state.cliPath,
        defaultMode = state.defaultMode ?: "default",
        shareEditorContext = state.shareEditorContext,
        notifications = state.notifications,
        editorTools = state.editorTools,
        gatewayUrl = state.gatewayUrl,
        platformUrl = state.platformUrl,
        sessionBudget = state.sessionBudget,
    )

    /**
     * Writes the gateway/platform/budget settings into the global kete.jsonc (edited in place). Returns
     * whether the file changed. Runs the CLI (`kete debug paths`), so never on the EDT.
     */
    fun syncConfig(runtime: KeteRuntime): Boolean {
        val mapped = current().mapped()
        if (mapped.invalid.isNotEmpty())
            notify(null, "${mapped.invalid.joinToString(" and ")} must be valid (an http(s) URL, or a positive number). Not applied.", NotificationType.WARNING)
        if (KeteConfig.edits(mapped.config).isEmpty()) return false
        val directory = runtime.configDirectory() ?: run {
            notify(null, "Couldn't find the Kete Code configuration directory. See the IDE log.", NotificationType.ERROR)
            return false
        }
        val jsonc = File(directory, "kete.jsonc")
        val file = if (jsonc.isFile) jsonc else File(directory, "kete.json")
        val before = if (file.isFile) file.readText() else ""
        val after = try {
            KeteConfig.applySettings(before, mapped.config)
        } catch (error: Exception) {
            notify(null, "Couldn't update ${file.name}: ${error.message}. Fix the file by hand, then save the settings again.", NotificationType.ERROR)
            return false
        }
        if (after == before) return false
        File(directory).mkdirs()
        file.writeText(if (after.endsWith("\n")) after else "$after\n")
        logger<KeteSettingsService>().info("updated ${file.name} from the Kete Code settings")
        return true
    }

    companion object {
        fun get(): KeteSettingsService = service()
    }
}

class KeteConfigurable : BoundConfigurable("Kete Code") {
    private val settings get() = KeteSettingsService.get().state
    private var restartNeeded = false

    override fun createPanel(): DialogPanel = panel {
        group("Runtime") {
            row("CLI path:") {
                textField()
                    .columns(COLUMNS_LARGE)
                    .bindText({ settings.cliPath.orEmpty() }, { settings.cliPath = it.trim().ifEmpty { null } })
                    .comment("For development only: an absolute path to a kete binary. Leave empty to use the one bundled with the plugin.")
            }
            row("New sessions:") {
                comboBox(listOf("default", "ask"))
                    .bindItem({ settings.defaultMode ?: "default" }, { settings.defaultMode = it ?: "default" })
                    .comment("\"ask\" asks before every edit, command and web fetch. Applies to new sessions after the server restarts.")
            }
        }
        group("Chat") {
            row {
                checkBox("Share the current file and selection with the chat")
                    .bindSelected({ settings.shareEditorContext }, { settings.shareEditorContext = it })
                    .comment("Secret-looking files (.env, keys) and files the IDE excludes or ignores are never shared.")
            }
            row {
                checkBox("Notify me when the chat needs approval or finishes while hidden")
                    .bindSelected({ settings.notifications }, { settings.notifications = it })
            }
            row {
                checkBox("Give the agent the IDE's problems (errors and warnings)")
                    .bindSelected({ settings.editorTools }, { settings.editorTools = it })
            }
        }
        group("Kete account (written to kete.jsonc)") {
            row("Gateway URL:") {
                textField().columns(COLUMNS_LARGE)
                    .bindText({ settings.gatewayUrl.orEmpty() }, { settings.gatewayUrl = it.trim().ifEmpty { null } })
            }
            row("Platform URL:") {
                textField().columns(COLUMNS_LARGE)
                    .bindText({ settings.platformUrl.orEmpty() }, { settings.platformUrl = it.trim().ifEmpty { null } })
            }
            row("Session budget (USD):") {
                textField()
                    .bindText({ settings.sessionBudget.orEmpty() }, { settings.sessionBudget = it.trim().ifEmpty { null } })
            }
        }
    }

    override fun apply() {
        val before = KeteSettingsService.get().current()
        super.apply()
        val after = KeteSettingsService.get().current()
        restartNeeded = before.cliPath != after.cliPath || before.defaultMode != after.defaultMode
        val runtime = KeteRuntime.get()
        val restart = restartNeeded
        ApplicationManager.getApplication().executeOnPooledThread {
            if (KeteSettingsService.get().syncConfig(runtime)) runtime.reloadConfig()
            runtime.refreshAccount()
            if (restart && runtime.status !is ai.ketecode.jetbrains.core.RuntimeStatus.Stopped) runtime.restart()
        }
    }
}
