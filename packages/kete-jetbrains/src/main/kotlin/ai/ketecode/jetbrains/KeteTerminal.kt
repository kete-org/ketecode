package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.Shell
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

// "Open in Terminal": the `kete` TUI in the IDE's terminal, for when the chat can't be shown (no JCEF)
// or the user prefers it. The terminal plugin is an optional dependency (META-INF/kete-terminal.xml);
// its classes are only touched after checking it is installed and enabled.

object KeteTerminal {
    private const val TERMINAL_PLUGIN = "org.jetbrains.plugins.terminal"

    fun available(): Boolean {
        val id = PluginId.getId(TERMINAL_PLUGIN)
        return PluginManagerCore.getPlugin(id) != null && !PluginManagerCore.isDisabled(id)
    }

    fun open(project: Project) {
        if (!available()) {
            notify(project, "The IDE's Terminal plugin is disabled. Enable it, or run kete in a system terminal.", NotificationType.WARNING)
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val binary = try {
                KeteRuntime.get().binary()
            } catch (error: Exception) {
                notify(project, error.message ?: "No kete binary", NotificationType.ERROR)
                return@executeOnPooledThread
            }
            ApplicationManager.getApplication().invokeLater({ Opener.open(project, binary) }, project.disposed)
        }
    }

    /** Separate so the terminal classes load only when the plugin is present. */
    private object Opener {
        fun open(project: Project, binary: String) {
            val widget = TerminalToolWindowManager.getInstance(project)
                .createShellWidget(project.basePath, DISPLAY_NAME, true, true)
            // The binary path is quoted for the terminal's shell; nothing else is typed.
            widget.sendCommandToExecute(Shell.quote(binary, SystemInfo.isWindows))
        }
    }
}
