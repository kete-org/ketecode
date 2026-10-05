package ai.ketecode.jetbrains

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.util.text.StringUtil
import javax.swing.Icon

const val DISPLAY_NAME = "Kete Code"
const val TOOL_WINDOW_ID = "Kete Code"
const val NOTIFICATION_GROUP = "Kete Code"

object KeteIcons {
    @JvmField
    val ToolWindow: Icon = IconLoader.getIcon("/icons/kete.svg", KeteIcons::class.java)
}

/** A balloon in the Kete Code notification group, with optional actions that close it when chosen. The text is escaped (it may hold session titles or CLI output). */
fun notify(project: Project?, content: String, type: NotificationType, vararg actions: Pair<String, () -> Unit>) {
    val notification = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP)
        .createNotification(DISPLAY_NAME, StringUtil.escapeXmlEntities(content), type)
    for ((label, run) in actions) {
        notification.addAction(NotificationAction.createSimpleExpiring(label) { run() })
    }
    notification.notify(project)
}
