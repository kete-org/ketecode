package ai.ketecode.jetbrains

import ai.ketecode.jetbrains.core.Theme
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.ProjectManager
import com.intellij.ui.JBColor
import com.intellij.ui.scale.JBUIScale
import com.intellij.util.ui.UIUtil
import java.awt.Color
import javax.swing.UIManager
import kotlin.math.roundToInt

// The IDE's current look-and-feel as the web UI's `kete.theme` message (core/Theme.kt), and the
// listeners that resend it when the theme or the editor colour scheme changes.

object KeteTheme {
    fun message(): Map<String, Any?> {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val color = { key: String ->
            val value: Color? = if (key == Theme.EDITOR_BACKGROUND) scheme.defaultBackground else UIManager.getColor(key)
            value?.let { Theme.hex(it.red, it.green, it.blue, it.alpha) }
        }
        val font = UIUtil.getLabelFont()
        val size = (font.size / JBUIScale.scale(1f)).roundToInt()
        return Theme.message(
            dark = !JBColor.isBright(),
            highContrast = false,
            color = color,
            uiFont = font.family,
            editorFont = scheme.editorFontName,
            fontSize = size,
        )
    }

    private fun broadcast() {
        ApplicationManager.getApplication().invokeLater {
            for (project in ProjectManager.getInstance().openProjects)
                if (!project.isDisposed) KeteProject.get(project).themeChanged()
        }
    }

    class LafListener : LafManagerListener {
        override fun lookAndFeelChanged(source: com.intellij.ide.ui.LafManager) = broadcast()
    }

    class ColorsListener : EditorColorsListener {
        override fun globalSchemeChange(scheme: com.intellij.openapi.editor.colors.EditorColorsScheme?) = broadcast()
    }
}
