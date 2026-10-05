package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.Bridge
import ai.ketecode.jetbrains.core.Pairing
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

// The chat: the runtime's own web UI (packages/app) in a JCEF browser, loaded from the plugin's
// `kete serve` with the pairing password only in the URL fragment. The page talks to the plugin through
// a JBCefJSQuery (in) and `executeJavaScript` (out), carrying the same typed messages as the VS Code
// relay (core/Bridge.kt). The bridge is injected only into pages from the runtime's origin, messages are
// accepted only while the browser shows that origin, and navigation anywhere else opens the system
// browser instead.

class ChatPanel(private val project: Project, parent: Disposable) : Disposable {
    private val log = logger<ChatPanel>()
    private val browser: JBCefBrowser = JBCefBrowser.createBuilder().build()
    private val query: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val root = JPanel(BorderLayout())

    /** The runtime origin the browser was pointed at; null while showing a message. */
    @Volatile private var origin: String? = null

    /** Whether the web UI has said hello (its bridge is running) since the last load. */
    @Volatile var ready = false
        private set

    val component: JComponent get() = root

    init {
        Disposer.register(parent, this)
        Disposer.register(this, browser)
        Disposer.register(this, query)
        query.addHandler { json ->
            // Only while the page is the runtime's web UI; never from another origin.
            val expected = origin
            if (expected == null || Pairing.origin(browser.cefBrowser.url ?: "") != expected) return@addHandler null
            val message = Bridge.parse(json) ?: return@addHandler null
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) {
                    if (message is Bridge.Incoming.Hello) ready = true
                    KeteProject.get(project).receive(this, message)
                }
            }
            null
        }
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadStart(cefBrowser: CefBrowser?, frame: CefFrame?, transitionType: CefRequest.TransitionType?) {
                if (frame?.isMain == true) ready = false
            }

            override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                if (cefBrowser == null || frame == null || !frame.isMain) return
                val expected = origin ?: return
                if (Pairing.origin(frame.url ?: "") != expected) return
                cefBrowser.executeJavaScript(Bridge.bridgeScript { expression -> query.inject(expression) }, frame.url, 0)
            }
        }, browser.cefBrowser)
        browser.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
            override fun onBeforeBrowse(
                cefBrowser: CefBrowser?,
                frame: CefFrame?,
                request: CefRequest?,
                userGesture: Boolean,
                isRedirect: Boolean,
            ): Boolean {
                val url = request?.url ?: return false
                val expected = origin ?: return false
                if (Pairing.origin(url) == expected || url.startsWith("about:") || url.startsWith("data:")) return false
                // Links to anywhere else open in the system browser, never inside the chat.
                if (frame?.isMain == true && (url.startsWith("https://") || url.startsWith("http://"))) BrowserUtil.browse(url)
                return true
            }
        }, browser.cefBrowser)
        browser.jbCefClient.addLifeSpanHandler(object : CefLifeSpanHandlerAdapter() {
            override fun onBeforePopup(cefBrowser: CefBrowser?, frame: CefFrame?, targetUrl: String?, targetFrameName: String?): Boolean {
                if (targetUrl != null && (targetUrl.startsWith("https://") || targetUrl.startsWith("http://"))) BrowserUtil.browse(targetUrl)
                return true
            }
        }, browser.cefBrowser)
        showMessage("Starting $DISPLAY_NAME…")
    }

    /** Points the browser at the runtime's web UI. */
    fun load(connection: Connection) {
        ready = false
        origin = Pairing.origin(connection.url)
        setContent(browser.component)
        browser.loadURL(Pairing.url(connection.url, connection.password))
    }

    /** Sends a message to the web UI if it is ready and the message type is allowed; returns whether it was sent. */
    fun post(message: Map<String, Any?>): Boolean {
        if (!ready) return false
        val script = Bridge.deliverScript(message) ?: run {
            log.warn("not sent to the chat (type not allowed): ${message["type"]}")
            return false
        }
        browser.cefBrowser.executeJavaScript(script, browser.cefBrowser.url, 0)
        return true
    }

    /** Shows a message instead of the chat (starting, or why the chat isn't available), with optional buttons. */
    fun showMessage(text: String, vararg buttons: Pair<String, () -> Unit>) {
        ready = false
        origin = null
        setContent(messagePanel(text, *buttons))
    }

    private fun setContent(component: JComponent) {
        root.removeAll()
        root.add(component, BorderLayout.CENTER)
        root.revalidate()
        root.repaint()
    }

    override fun dispose() {
        ready = false
        origin = null
    }

    companion object {
        /** A plain message with buttons; also what the tool window shows when JCEF isn't available. */
        fun messagePanel(text: String, vararg buttons: Pair<String, () -> Unit>): JComponent {
            val panel = JPanel(BorderLayout())
            panel.border = JBUI.Borders.empty(16)
            panel.background = UIUtil.getPanelBackground()
            val label = JBLabel("<html>${com.intellij.openapi.util.text.StringUtil.escapeXmlEntities(text)}</html>")
            label.verticalAlignment = SwingConstants.TOP
            panel.add(label, BorderLayout.NORTH)
            if (buttons.isNotEmpty()) {
                val row = JPanel(FlowLayout(FlowLayout.LEFT, 0, 8))
                row.isOpaque = false
                for ((title, run) in buttons) row.add(JButton(title).apply { addActionListener { run() } })
                panel.add(row, BorderLayout.CENTER)
            }
            return panel
        }
    }
}
