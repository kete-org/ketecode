package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.StatusText
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.Point
import java.awt.event.MouseEvent

// The status-bar widget: the runtime's state, the signed-in account and waiting approvals (core/Status.kt),
// with a menu (open chat, sign in/out, sessions, review, terminal, restart).

class KeteStatusBarFactory : StatusBarWidgetFactory {
    override fun getId() = ID
    override fun getDisplayName() = DISPLAY_NAME
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = KeteStatusBarWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true

    companion object {
        const val ID = "ai.ketecode.status"
    }
}

class KeteStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var statusBar: StatusBar? = null
    /** Owns the runtime listener, so it goes away with the widget however the widget is disposed. */
    private val scope = Disposer.newDisposable("Kete Code status bar")

    override fun ID() = KeteStatusBarFactory.ID

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val runtime = KeteRuntime.get()
        runtime.addListener(scope) {
            ApplicationManager.getApplication().invokeLater({ this.statusBar?.updateWidget(ID()) }, project.disposed)
        }
        // The first read of the account (it runs the CLI, so off the EDT).
        ApplicationManager.getApplication().executeOnPooledThread { runtime.refreshAccountIfStale() }
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    private fun bar(): StatusText.Bar {
        val runtime = KeteRuntime.get()
        return StatusText.bar(runtime.status, runtime.account, runtime.attention.pending.size)
    }

    override fun getText(): String = bar().text

    override fun getTooltipText(): String = bar().tooltip

    override fun getAlignment(): Float = Component.CENTER_ALIGNMENT

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { event ->
        val group = ActionManager.getInstance().getAction("Kete.StatusMenu") as? ActionGroup ?: return@Consumer
        val context = SimpleDataContext.getProjectContext(project)
        val popup = JBPopupFactory.getInstance().createActionGroupPopup(
            "$DISPLAY_NAME · ${accountSummary(KeteRuntime.get().account)}",
            group,
            context,
            JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
            true,
        )
        val component = event.component
        popup.show(RelativePoint(component, Point(0, -popup.content.preferredSize.height)))
    }

    override fun dispose() {
        statusBar = null
        Disposer.dispose(scope)
    }
}
