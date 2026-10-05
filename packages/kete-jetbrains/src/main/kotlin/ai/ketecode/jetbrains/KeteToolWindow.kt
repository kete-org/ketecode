package ai.ketecode.jetbrains

import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.IdeFrame
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp

// The "Kete Code" tool window (right side): the chat when JCEF is available, otherwise a message with
// "Open in Terminal". Plus the listeners that follow the editor, the IDE's focus and project closing.

class KeteToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        if (!JBCefApp.isSupported()) {
            val panel = ChatPanel.messagePanel(
                "This IDE's runtime has no embedded browser (JCEF), so the $DISPLAY_NAME chat can't be shown here. " +
                    "You can use $DISPLAY_NAME in the IDE's terminal instead, or switch the IDE to a runtime with JCEF " +
                    "(Help → Find Action → Choose Boot Java Runtime for the IDE).",
                "Open in Terminal" to { KeteTerminal.open(project) },
            )
            toolWindow.contentManager.addContent(factory.createContent(panel, null, false))
            return
        }
        val content = factory.createContent(null, null, false)
        val chat = ChatPanel(project, content)
        content.component = chat.component
        toolWindow.contentManager.addContent(content)
        val service = KeteProject.get(project)
        service.attach(chat)
        Disposer.register(chat) { service.detach(chat) }
    }
}

/** Follows the active editor and its selection into the chat (debounced in KeteProject). */
class KeteStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        val service = KeteProject.get(project)
        project.messageBus.connect(service).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) = service.scheduleEditorContext()
            },
        )
        EditorFactory.getInstance().eventMulticaster.addSelectionListener(object : SelectionListener {
            override fun selectionChanged(e: SelectionEvent) {
                if (e.editor.project == project) service.scheduleEditorContext()
            }
        }, service)
        // A runtime already running (another project started it): register this project's editor tools.
        if (KeteRuntime.get().running() != null) EditorToolsServer.get().register(project)
    }
}

/** Picks up `kete login`/`logout` run in a terminal when the IDE regains focus (at most every 30 s). */
class KeteActivationListener : ApplicationActivationListener {
    override fun applicationActivated(ideFrame: IdeFrame) = KeteRuntime.get().refreshAccountIfStale()
}

/** One runtime per IDE: stop it when the last project closes (it starts again with the next chat). */
class KeteProjectListener : ProjectManagerListener {
    override fun projectClosed(project: Project) {
        val others = ProjectManager.getInstance().openProjects.filter { it != project && !it.isDisposed }
        if (others.isEmpty()) ApplicationManager.getApplication().executeOnPooledThread { KeteRuntime.get().stop() }
    }
}
