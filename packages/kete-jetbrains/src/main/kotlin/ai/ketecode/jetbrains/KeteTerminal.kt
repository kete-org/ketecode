package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.Shell
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

// "Open in Terminal": the `kete` TUI in the IDE's terminal, for when the chat can't be shown (no JCEF)
// or the user prefers it. The terminal plugin is an optional dependency (META-INF/kete-terminal.xml);
// its classes are only touched after checking it is installed and enabled.

object KeteTerminal {
    /** Whether the Terminal plugin is loaded: its classes are visible to this plugin only through the optional dependency. */
    fun available(): Boolean = try {
        Class.forName("org.jetbrains.plugins.terminal.TerminalToolWindowManager", false, KeteTerminal::class.java.classLoader)
        true
    } catch (_: ClassNotFoundException) {
        false
    } catch (_: LinkageError) {
        false
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
