package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.Bridge
import ai.ketecode.jetbrains.core.Change
import ai.ketecode.jetbrains.core.ContextFilter
import ai.ketecode.jetbrains.core.EditorContext
import ai.ketecode.jetbrains.core.Panel
import ai.ketecode.jetbrains.core.Paths
import ai.ketecode.jetbrains.core.ReviewDiff
import ai.ketecode.jetbrains.core.RuntimeStatus
import ai.ketecode.jetbrains.core.Selection
import ai.ketecode.jetbrains.core.SessionItem
import ai.ketecode.jetbrains.core.Sessions
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffDialogHints
import com.intellij.diff.DiffManager
import com.intellij.diff.chains.SimpleDiffRequestChain
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.Alarm
import com.intellij.execution.runners.ExecutionUtil

// Per project: the chat tool window's browsers, what the editor shares with them, the last turn's
// review, and attention (badge and notifications). The runtime itself is shared (KeteRuntime).
// Mirrors the per-window parts of packages/kete-vscode/src/extension.ts.

@Service(Service.Level.PROJECT)
class KeteProject(private val project: Project) : Disposable {
    private val log = logger<KeteProject>()
    private val chats = LinkedHashSet<ChatPanel>()
    private val queued = ArrayList<Map<String, Any?>>()
    private val sessions = HashMap<ChatPanel, String>()
    private val editorAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var editor: EditorContext? = null

    /** The last review: file → status and the content before the turn. */
    data class ReviewEntry(val file: String, val status: String, val before: String)
    private var review: List<ReviewEntry> = emptyList()

    /** The project directory the chat opens (absolute), or null for a project without one. */
    val directory: String? get() = project.basePath

    init {
        KeteRuntime.get().addListener(this) { ApplicationManager.getApplication().invokeLater({ renderAttention() }, project.disposed) }
    }

    // ---------------------------------------------------------------------------------------------
    // Chats

    fun attach(chat: ChatPanel) {
        chats.add(chat)
        show(chat)
    }

    fun detach(chat: ChatPanel) {
        chats.remove(chat)
        sessions.remove(chat)
    }

    /** Loads (or reloads, after a restart: new port and password) the chat; a chat already on this server run is left alone. */
    fun show(chat: ChatPanel) {
        KeteRuntime.get().running()?.let { if (chat.shows(it)) return }
        chat.showMessage("Starting $DISPLAY_NAME…")
        KeteRuntime.get().connection().whenComplete { connection, error ->
            ApplicationManager.getApplication().invokeLater({
                if (connection != null) {
                    if (!chat.shows(connection)) chat.load(connection)
                } else chat.showMessage(
                    "$DISPLAY_NAME isn't available: ${error?.cause?.message ?: error?.message ?: "unknown error"}",
                    "Restart Server" to { KeteRuntime.get().restart() },
                    "Open in Terminal" to { KeteTerminal.open(project) },
                )
            }, project.disposed)
        }
    }

    fun runtimeChanged(status: RuntimeStatus) {
        if (status is RuntimeStatus.Running) {
            chats.forEach { show(it) }
            EditorToolsServer.get().register(project)
        }
        if (status is RuntimeStatus.Failed) chats.forEach { chat ->
            if (status.download) chat.showMessage(
                "$DISPLAY_NAME isn't available yet: ${status.reason}",
                "Download" to { KeteCliDownloads.get().consentAndDownload(project) },
                "Open Settings" to { ShowSettingsUtil.getInstance().showSettingsDialog(project, KeteConfigurable::class.java) },
            )
            else chat.showMessage(
                "$DISPLAY_NAME isn't available: ${status.reason}",
                "Restart Server" to { KeteRuntime.get().restart() },
                "Open in Terminal" to { KeteTerminal.open(project) },
            )
        }
        renderAttention()
    }

    /** Sends to every ready chat, or opens the tool window and delivers when its web UI says hello. */
    fun deliver(message: Map<String, Any?>) {
        val ready = chats.filter { it.ready }
        if (ready.isNotEmpty()) {
            ready.forEach { it.post(message) }
            return
        }
        queued.add(message)
        if (queued.size > 50) queued.removeAt(0)
        focusChat()
    }

    fun focusChat() {
        ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.activate(null)
    }

    private fun chatVisible() = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.isVisible == true

    /** The session in the chat the user is looking at. */
    fun activeSession(): String? = sessions.values.lastOrNull()

    fun showsSession(id: String) = id in sessions.values

    fun receive(chat: ChatPanel, message: Bridge.Incoming) {
        when (message) {
            is Bridge.Incoming.Hello -> hello(chat)
            is Bridge.Incoming.DismissNotice -> {
                val state = KeteSettingsService.get().state
                state.dismissedNotices = Panel.dismiss(state.dismissedNotices, message.id).toMutableList()
                broadcastPanel()
            }
            is Bridge.Incoming.DismissCliHint -> {
                KeteSettingsService.get().state.cliHintDismissed = true
                broadcastPanel()
            }
            is Bridge.Incoming.Session -> {
                if (message.sessionID != null) sessions[chat] = message.sessionID else sessions.remove(chat)
            }
            is Bridge.Incoming.OpenDiff -> openDiff(chat, message.path)
            is Bridge.Incoming.ThemeApplied, is Bridge.Incoming.ContextAdded, is Bridge.Incoming.EditorContextApplied -> Unit
        }
    }

    private fun hello(chat: ChatPanel) {
        // The web UI loaded: its theme, the editor's file, a session to open, the project, then queued context.
        chat.post(KeteTheme.message())
        editor = editor ?: currentEditorContext()
        chat.post(mapOf("type" to "kete.editorContext", "context" to editor?.toMessage()))
        val waiting = ArrayList(queued)
        queued.clear()
        waiting.filter { it["type"] == "kete.openSession" }.takeLast(1).forEach { chat.post(it) }
        directory?.let { chat.post(mapOf("type" to "kete.workspace", "directory" to it)) }
        waiting.filter { it["type"] != "kete.openSession" }.forEach { chat.post(it) }
        chat.post(panelMessage())
    }

    private fun panelMessage(): Map<String, Any?> {
        val state = KeteSettingsService.get().state
        return Panel.message(state.dismissedNotices, state.cliHintDismissed, com.intellij.openapi.util.SystemInfo.isMac, KeteRuntime.get().serverMode)
    }

    private fun broadcastPanel() {
        val message = panelMessage()
        chats.filter { it.ready }.forEach { it.post(message) }
    }

    fun themeChanged() {
        val message = KeteTheme.message()
        chats.filter { it.ready }.forEach { it.post(message) }
    }

    fun openSession(id: String) {
        val message = mapOf("type" to "kete.openSession", "sessionID" to id)
        val ready = chats.filter { it.ready }
        if (ready.isEmpty() || ready.size < chats.size) queued.add(message)
        ready.forEach { it.post(message) }
        focusChat()
    }

    fun newChat() = deliver(mapOf("type" to "kete.newSession"))

    // ---------------------------------------------------------------------------------------------
    // Editor context

    /** The active editor's file and selection, debounced, sent to every chat when it changes. */
    fun scheduleEditorContext() {
        editorAlarm.cancelAllRequests()
        editorAlarm.addRequest({
            if (project.isDisposed) return@addRequest
            val next = currentEditorContext()
            if (next == editor) return@addRequest
            editor = next
            chats.filter { it.ready }.forEach { it.post(mapOf("type" to "kete.editorContext", "context" to next?.toMessage())) }
        }, 150)
    }

    private fun currentEditorContext(): EditorContext? {
        if (!KeteSettingsService.get().state.shareEditorContext) return null
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        val file = FileDocumentManager.getInstance().getFile(editor.document) ?: return null
        return ContextFilter.editorContext(relative(file), file.isInLocalFileSystem, excluded(file), selection(editor))
    }

    /** The project-relative path of a file inside the project directory, or null. */
    fun relative(file: VirtualFile): String? {
        val base = directory ?: return null
        if (!file.isInLocalFileSystem) return null
        return Paths.relative(base, file.path)
    }

    /** Whether the IDE excludes or ignores the file (excluded folders, ignored names, outside the project content). */
    fun excluded(file: VirtualFile): Boolean = ApplicationManager.getApplication().runReadAction(Computable {
        val index = ProjectFileIndex.getInstance(project)
        FileTypeManager.getInstance().isFileIgnored(file) || index.isExcluded(file) || index.isUnderIgnored(file) || !index.isInContent(file)
    })

    private fun selection(editor: Editor): Selection {
        val model = editor.selectionModel
        val document = editor.document
        if (!model.hasSelection()) return Selection(0, 0, 0, true)
        val start = document.getLineNumber(model.selectionStart)
        val end = document.getLineNumber(model.selectionEnd)
        val endColumn = model.selectionEnd - document.getLineStartOffset(end)
        return Selection(start, end, endColumn, false)
    }

    /** "Add to Kete Code": the file, with the selected lines when `editor` has a selection. Explicit, so secrets aren't filtered (as in VS Code). */
    fun addContext(file: VirtualFile, editor: Editor?) {
        val path = relative(file)
        if (path == null) {
            notify(project, "Open a file from the project to add it to $DISPLAY_NAME.", NotificationType.INFORMATION)
            return
        }
        val message = linkedMapOf<String, Any?>("type" to "kete.addContext", "path" to path)
        if (editor != null && editor.selectionModel.hasSelection()) {
            val (start, end) = ContextFilter.lines(selection(editor))
            message["startLine"] = start
            message["endLine"] = end
        }
        deliver(message)
    }

    // ---------------------------------------------------------------------------------------------
    // Review: the last turn's changes in the IDE's diff viewer

    private fun openDiff(chat: ChatPanel, path: String) {
        val base = directory ?: return
        val target = Paths.insideWorkspace(base, path)
        if (target == null) {
            log.warn("ignored a request to open a path outside the project")
            return
        }
        val session = sessions[chat]
        val relative = Paths.relative(base, target.toString()) ?: return
        reviewChanges(session, relative) { shown ->
            if (shown) return@reviewChanges
            // Not part of the last turn: just open the file.
            val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target)
            if (file != null) FileEditorManager.getInstance(project).openFile(file, true)
        }
    }

    /** Opens the latest turn's changes in the chat's session (all files, or just `only`). Calls `done` with whether it showed anything. */
    fun reviewChanges(session: String? = activeSession(), only: String? = null, done: (Boolean) -> Unit = {}) {
        val base = directory
        val runtime = KeteRuntime.get()
        if (session == null || base == null || runtime.running() == null) {
            if (only == null) notify(project, "Open a session in the $DISPLAY_NAME chat to review its changes.", NotificationType.INFORMATION)
            done(false)
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val body = runtime.getJson("/api/session/${KeteRuntime.encode(session)}/diff", timeoutSeconds = 15)
            val diffs = ReviewDiff.files(body).filter { only == null || it.file == only }
            ApplicationManager.getApplication().invokeLater({ showReview(base, diffs, only, done) }, project.disposed)
        }
    }

    private fun showReview(base: String, diffs: List<ReviewDiff.FileDiff>, only: String?, done: (Boolean) -> Unit) {
        if (diffs.isEmpty()) {
            if (only == null) notify(project, "$DISPLAY_NAME changed no files in the last turn.", NotificationType.INFORMATION)
            done(false)
            return
        }
        val factory = DiffContentFactory.getInstance()
        val entries = ArrayList<ReviewEntry>()
        val requests = diffs.mapNotNull { diff ->
            val target = Paths.insideWorkspace(base, diff.file) ?: return@mapNotNull null
            val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target)
            val current = file?.let { found -> ApplicationManager.getApplication().runReadAction(Computable { FileDocumentManager.getInstance().getDocument(found)?.text }) }
            val before = try {
                ReviewDiff.before(diff.patch, current)
            } catch (error: Exception) {
                log.warn("can't show ${diff.file} before the turn: ${error.message}")
                return@mapNotNull null
            }
            val status = ReviewDiff.reviewStatus(diff.status, exists = current != null)
            entries.add(ReviewEntry(diff.file, status, before))
            val type = FileTypeManager.getInstance().getFileTypeByFileName(target.fileName.toString())
            val left = factory.create(project, before, type)
            // The right side is the file itself, so it can be edited in the diff viewer.
            val right = if (file != null) factory.create(project, file) else factory.createEmpty()
            SimpleDiffRequest("${diff.file} (before ↔ after $DISPLAY_NAME)", left, right, "Before the turn", if (file != null) "Now" else "Deleted")
        }
        review = entries
        if (requests.isEmpty()) {
            done(false)
            return
        }
        DiffManager.getInstance().showDiff(project, SimpleDiffRequestChain(requests), DiffDialogHints.DEFAULT)
        done(true)
    }

    /** Puts a file back as it was before the turn, after asking: the active editor's file, else one picked from the review. */
    fun revertFile() {
        val base = directory ?: return
        if (review.isEmpty()) {
            notify(project, "Review the last turn's changes first (\"Review Changes\").", NotificationType.INFORMATION)
            return
        }
        val active = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.let { relative(it) }
        val entry = review.firstOrNull { it.file == active }
        if (entry != null) return confirmRevert(base, entry)
        JBPopupFactory.getInstance().createPopupChooserBuilder(review.map { it.file })
            .setTitle("Revert a File to Before the Turn")
            .setItemChosenCallback { chosen -> review.firstOrNull { it.file == chosen }?.let { confirmRevert(base, it) } }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    private fun confirmRevert(base: String, entry: ReviewEntry) {
        // Inside the project lexically and once symbolic links are followed (a link to ~/.ssh is refused).
        val target = Paths.insideWorkspace(base, entry.file)
        val real = target?.let { Paths.realInside(base, it) }
        if (target == null || real == null) {
            notify(project, "Not reverting ${entry.file}: it leads outside the project.", NotificationType.WARNING)
            return
        }
        val exists = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target) != null
        val plan = ReviewDiff.revert(entry.status, exists, entry.before)
        val (question, action) = when (plan) {
            is ReviewDiff.Revert.Skip -> {
                notify(project, "Nothing to revert for ${entry.file}: ${plan.reason}.", NotificationType.INFORMATION)
                return
            }
            ReviewDiff.Revert.Delete -> "Delete ${entry.file}? $DISPLAY_NAME created it in this turn." to "Delete"
            ReviewDiff.Revert.Restore -> "Restore ${entry.file}? $DISPLAY_NAME deleted it in this turn." to "Restore"
            ReviewDiff.Revert.PutBack -> "Revert ${entry.file} to how it was before this turn? Your edits since then are lost too." to "Revert"
        }
        // The full resolved path, so a surprising location is visible before anything is written.
        val choice = Messages.showOkCancelDialog(project, "$question\n\n$real", "Revert File", action, "Cancel", Messages.getWarningIcon())
        if (choice != Messages.OK) return
        try {
            WriteCommandAction.runWriteCommandAction(project, "Revert ${entry.file}", null, {
                // Checked again right before writing: the file system may have changed while the dialog was open.
                if (Paths.insideWorkspace(base, entry.file) == null) throw IllegalStateException("it now leads outside the project")
                val existing = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(target)
                when (plan) {
                    ReviewDiff.Revert.Delete -> existing?.delete(this)
                    else -> {
                        val file = existing ?: run {
                            val parent = VfsUtil.createDirectoryIfMissing(target.parent.toString())
                                ?: throw IllegalStateException("can't create ${target.parent}")
                            parent.createChildData(this, target.fileName.toString())
                        }
                        val document = FileDocumentManager.getInstance().getDocument(file)
                        if (document != null) document.setText(entry.before) else VfsUtil.saveText(file, entry.before)
                    }
                }
            })
            val done = when (plan) {
                ReviewDiff.Revert.Delete -> "deleted"
                ReviewDiff.Revert.Restore -> "restored"
                else -> "reverted"
            }
            notify(project, "${entry.file} $done.", NotificationType.INFORMATION)
        } catch (error: Exception) {
            notify(project, "Couldn't revert ${entry.file}: ${error.message}", NotificationType.ERROR)
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Sessions

    fun pickSession() {
        val base = directory ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val runtime = KeteRuntime.get()
            if (runtime.running() == null && runCatching { runtime.connection().get(60, java.util.concurrent.TimeUnit.SECONDS) }.isFailure) {
                notify(project, "The $DISPLAY_NAME server isn't running.", NotificationType.WARNING)
                return@executeOnPooledThread
            }
            val items = Sessions.parse(runtime.getJson("/api/session?directory=${KeteRuntime.encode(base)}"))
            ApplicationManager.getApplication().invokeLater({ chooseSession(items) }, project.disposed)
        }
    }

    private class Choice(val item: SessionItem, private val label: String) {
        override fun toString() = label
    }

    private fun chooseSession(items: List<SessionItem>) {
        if (items.isEmpty()) {
            notify(project, "No $DISPLAY_NAME sessions in this project yet.", NotificationType.INFORMATION)
            return
        }
        val now = System.currentTimeMillis()
        val waiting = KeteRuntime.get().attention
        val choices = items.map { item ->
            val state = when {
                item.id in waiting.pending.values -> "needs approval"
                item.id in waiting.busy -> "working…"
                else -> Sessions.ago(item.updated, now)
            }
            Choice(item, "${item.title}  ·  $state")
        }
        JBPopupFactory.getInstance().createPopupChooserBuilder(choices)
            .setTitle("Open a $DISPLAY_NAME Session")
            .setItemChosenCallback { openSession(it.item.id) }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    // ---------------------------------------------------------------------------------------------
    // Attention

    private fun renderAttention() {
        if (project.isDisposed) return
        val waiting = KeteRuntime.get().attention.pending.size
        val window = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID) ?: return
        window.setIcon(if (waiting > 0) ExecutionUtil.getLiveIndicator(KeteIcons.ToolWindow) else KeteIcons.ToolWindow)
        window.stripeTitle = if (waiting > 0) "$DISPLAY_NAME ($waiting)" else DISPLAY_NAME
    }

    fun attentionChanged(change: Change) {
        if (chatVisible() || !KeteSettingsService.get().state.notifications) return
        when (change) {
            is Change.Asked -> notify(
                project,
                "$DISPLAY_NAME needs your approval${if (change.action.isNotEmpty()) " (${change.action})" else ""}.",
                NotificationType.WARNING,
                "Open Chat" to { focusChat() },
            )
            is Change.Finished -> ApplicationManager.getApplication().executeOnPooledThread {
                val title = Sessions.title(KeteRuntime.get().getJson("/api/session/${KeteRuntime.encode(change.sessionID)}", 5)) ?: "your session"
                ApplicationManager.getApplication().invokeLater({
                    notify(
                        project,
                        "$DISPLAY_NAME finished: $title.",
                        NotificationType.INFORMATION,
                        "Open Chat" to { focusChat() },
                        "Review Changes" to { reviewChanges(change.sessionID) },
                    )
                }, project.disposed)
            }
        }
    }

    override fun dispose() {
        chats.clear()
        EditorToolsServer.getIfCreated()?.forget(project)
    }

    companion object {
        fun get(project: Project): KeteProject = project.service()
    }
}
