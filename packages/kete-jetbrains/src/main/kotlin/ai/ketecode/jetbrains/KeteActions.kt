package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.AccountState
import ai.ketecode.jetbrains.core.Accounts
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import java.io.File
import java.util.concurrent.TimeUnit

// The plugin's actions (Tools → Kete Code, the editor and project-view context menus, the status-bar
// menu). "Add to Kete Code" has Alt+K in the default keymaps, like VS Code's `kete.addToChat`.

abstract class KeteAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }
}

/** Adds the editor's selection (or the file), or the file selected in the project view, to the chat's context. */
class AddToKeteAction : KeteAction() {
    override fun update(event: AnActionEvent) {
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        event.presentation.isEnabledAndVisible = event.project != null && file != null && !file.isDirectory && file.isInLocalFileSystem
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val editor = event.getData(CommonDataKeys.EDITOR)
        KeteProject.get(project).addContext(file, editor)
    }
}

class OpenChatAction : KeteAction() {
    override fun actionPerformed(event: AnActionEvent) {
        KeteProject.get(event.project ?: return).focusChat()
    }
}

class NewChatAction : KeteAction() {
    override fun actionPerformed(event: AnActionEvent) {
        KeteProject.get(event.project ?: return).newChat()
    }
}

class ReviewChangesAction : KeteAction() {
    override fun actionPerformed(event: AnActionEvent) {
        KeteProject.get(event.project ?: return).reviewChanges()
    }
}

class RevertFileAction : KeteAction() {
    override fun actionPerformed(event: AnActionEvent) {
        KeteProject.get(event.project ?: return).revertFile()
    }
}

class OpenSessionAction : KeteAction() {
    override fun actionPerformed(event: AnActionEvent) {
        KeteProject.get(event.project ?: return).pickSession()
    }
}

class OpenInTerminalAction : KeteAction() {
    override fun actionPerformed(event: AnActionEvent) {
        KeteTerminal.open(event.project ?: return)
    }
}

class RestartServerAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(event: AnActionEvent) {
        ApplicationManager.getApplication().executeOnPooledThread { KeteRuntime.get().restart() }
    }
}

class SignInAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = !KeteRuntime.get().signedIn
    }

    override fun actionPerformed(event: AnActionEvent) = KeteAccount.signIn(event.project)
}

class SignOutAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = KeteRuntime.get().signedIn
    }

    override fun actionPerformed(event: AnActionEvent) = KeteAccount.signOut(event.project)
}

/** Sign-in and sign-out through the CLI (`kete login`/`kete logout`), as the VS Code extension does. */
object KeteAccount {
    fun signIn(project: Project?) {
        object : Task.Backgroundable(project, "Signing in to $DISPLAY_NAME", true) {
            override fun run(indicator: ProgressIndicator) {
                val runtime = KeteRuntime.get()
                val binary = try {
                    runtime.binary()
                } catch (error: Exception) {
                    notify(project, error.message ?: "No kete binary", NotificationType.ERROR)
                    return
                }
                val child = ProcessBuilder(binary, "login", "--no-browser")
                    .directory(File(System.getProperty("user.home")))
                    .redirectErrorStream(true)
                    .apply { environment().putAll(com.intellij.util.EnvironmentUtil.getEnvironmentMap()) }
                    .start()
                child.outputStream.close()
                val output = StringBuilder()
                val reader = Thread({
                    var opened = false
                    child.inputStream.bufferedReader().forEachLine { line ->
                        synchronized(output) { output.appendLine(line) }
                        val url = if (opened) null else Accounts.authorizeURL(line)
                        if (url != null) {
                            opened = true
                            indicator.text = "Approve the sign-in in your browser…"
                            BrowserUtil.browse(url)
                        }
                    }
                }, "Kete Code login")
                reader.isDaemon = true
                reader.start()
                // Up to 10 minutes for the browser approval; cancelling stops `kete login`.
                val deadline = System.currentTimeMillis() + 10 * 60_000
                while (!child.waitFor(250, TimeUnit.MILLISECONDS)) {
                    if (indicator.isCanceled || System.currentTimeMillis() > deadline) {
                        child.destroy()
                        if (!child.waitFor(5, TimeUnit.SECONDS)) child.destroyForcibly()
                        return
                    }
                }
                reader.join(2_000)
                // `kete login` never prints the key; its output is safe to log.
                val text = synchronized(output) { output.toString() }
                com.intellij.openapi.diagnostic.logger<KeteAccount>().info("kete login exited with ${child.exitValue()}")
                if (child.exitValue() != 0) {
                    notify(project, "Sign-in failed: ${Accounts.lastLine(text) ?: "exit code ${child.exitValue()}"}", NotificationType.ERROR)
                    return
                }
                runtime.refreshAccount()
                runtime.reloadConfig()
                val account = (runtime.account as? AccountState.Known)?.account
                if (account is ai.ketecode.jetbrains.core.Account.SignedIn)
                    notify(project, "Signed in to ${account.organization}.", NotificationType.INFORMATION)
            }
        }.queue()
    }

    fun signOut(project: Project?) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val runtime = KeteRuntime.get()
            try {
                val result = runtime.cli("logout", timeoutSeconds = 60)
                val text = result.stdout + result.stderr
                // Logout always clears the local key; a warning means the platform couldn't revoke it.
                val warning = text.lines().firstOrNull { it.startsWith("Warning:") }
                when {
                    result.exit != 0 -> notify(project, "Sign-out failed: ${Accounts.lastLine(text) ?: "exit code ${result.exit}"}", NotificationType.ERROR)
                    warning != null -> notify(project, warning.removePrefix("Warning:").trim(), NotificationType.WARNING)
                    else -> notify(project, "Signed out of $DISPLAY_NAME.", NotificationType.INFORMATION)
                }
            } catch (error: Exception) {
                notify(project, "Sign-out failed: ${error.message}", NotificationType.ERROR)
            }
            runtime.refreshAccount()
            runtime.reloadConfig()
        }
    }
}

/** For the status-bar menu: the account line shown at its top. */
internal fun accountSummary(state: AccountState): String = when (state) {
    is AccountState.Known -> when (val value = state.account) {
        is ai.ketecode.jetbrains.core.Account.SignedIn -> "Signed in: ${value.organization}"
        is ai.ketecode.jetbrains.core.Account.SignedOut -> "Not signed in"
    }
    is AccountState.Unknown -> "Account unknown"
    AccountState.Checking -> "Checking account…"
}
