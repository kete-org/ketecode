package ai.ketecode.jetbrains.core

// The runtime's state and the status-bar text (mirrors packages/kete-vscode/src/status.ts).

sealed interface RuntimeStatus {
    data object Stopped : RuntimeStatus
    data object Starting : RuntimeStatus
    data class Running(val url: String) : RuntimeStatus
    data class Restarting(val attempt: Int, val delay: Long, val reason: String) : RuntimeStatus
    /** `download`: no kete yet; the user can download it (KeteCliDownload.kt) instead of restarting. */
    data class Failed(val reason: String, val download: Boolean = false) : RuntimeStatus
}

/** The account as last read: null while checking, or the error from `kete whoami`. */
sealed interface AccountState {
    data object Checking : AccountState
    data class Known(val account: Account) : AccountState
    data class Unknown(val error: String) : AccountState
}

object StatusText {
    data class Bar(val text: String, val tooltip: String, val error: Boolean)

    fun bar(server: RuntimeStatus, account: AccountState, waiting: Int = 0): Bar {
        val who = when (account) {
            is AccountState.Known -> when (val value = account.account) {
                is Account.SignedIn -> " · ${value.organization}"
                is Account.SignedOut -> " · Signed out"
            }
            else -> ""
        }
        val state = when (server) {
            is RuntimeStatus.Failed -> " · stopped"
            is RuntimeStatus.Starting, is RuntimeStatus.Restarting -> " · starting…"
            else -> ""
        }
        val approvals = if (waiting > 0) " · $waiting waiting" else ""
        val tooltip = listOfNotNull(
            serverLine(server),
            accountLine(account),
            if (waiting > 0) "$waiting waiting for your approval in the chat" else null,
        ).joinToString("\n")
        return Bar("Kete$who$state$approvals", tooltip, server is RuntimeStatus.Failed)
    }

    fun serverLine(server: RuntimeStatus): String = when (server) {
        is RuntimeStatus.Stopped -> "Server: not started (starts when you open the chat)"
        is RuntimeStatus.Starting -> "Server: starting…"
        is RuntimeStatus.Running -> "Server: running on ${server.url}"
        is RuntimeStatus.Restarting -> "Server: restarting in ${Math.round(server.delay / 1000.0)} s (attempt ${server.attempt}): ${server.reason}"
        is RuntimeStatus.Failed -> "Server: stopped: ${server.reason}"
    }

    fun accountLine(account: AccountState): String = when (account) {
        is AccountState.Checking -> "Account: checking…"
        is AccountState.Unknown -> "Account: unknown (${account.error})"
        is AccountState.Known -> when (val value = account.account) {
            is Account.SignedOut ->
                if (value.handConfigured.isNotEmpty()) "Account: not signed in; gateway configured by hand (${value.handConfigured.joinToString(", ")})"
                else "Account: not signed in"
            is Account.SignedIn -> "Account: ${value.organization} on ${value.platformURL}\nKey stored in ${value.storage}"
        }
    }
}
