package ai.ketecode.jetbrains.core

// Which navigations of the chat page open in the system browser. Only a main-frame http(s) navigation
// the user started (a click: CEF's user gesture) opens anything, and at most one per `interval` ms, so a
// page can't flood the desktop with browser tabs. Popups never open anything: JCEF doesn't say whether
// a user started them (ChatPanel ignores them; Bridge.bridgeScript turns real clicks on target="_blank"
// links into page navigations instead).

class ExternalLinks(private val interval: Long = 1_000) {
    private var last: Long? = null

    /** Whether `url` should open in the system browser now; records the open when it should. */
    @Synchronized
    fun shouldOpen(url: String, mainFrame: Boolean, userGesture: Boolean, now: Long): Boolean {
        if (!mainFrame || !userGesture || !isWeb(url)) return false
        val previous = last
        if (previous != null && now - previous in 0L until interval) return false
        last = now
        return true
    }

    companion object {
        fun isWeb(url: String): Boolean = url.startsWith("https://") || url.startsWith("http://")
    }
}
