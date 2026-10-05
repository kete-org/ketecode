package ai.ketecode.jetbrains.core

// The IDE's look-and-feel → the `kete.theme` message the web UI already understands from VS Code
// (packages/app/src/kete/vscode-theme.ts maps `--vscode-*` variables onto its design tokens). Mapping
// the IDE's colours onto the VS Code variable names keeps one token mapping for both editors.

object Theme {
    /** The `@editor.background` pseudo-key is the editor colour scheme's background, not a UIManager key. */
    const val EDITOR_BACKGROUND = "@editor.background"

    /** Each VS Code variable and the LAF keys that supply it, in order of preference. */
    val MAPPING: List<Pair<String, List<String>>> = listOf(
        "--vscode-editor-background" to listOf(EDITOR_BACKGROUND, "EditorPane.background"),
        "--vscode-sideBar-background" to listOf("ToolWindow.background", "Panel.background"),
        "--vscode-panel-background" to listOf("Panel.background"),
        "--vscode-editorWidget-background" to listOf("Popup.background", "Panel.background"),
        "--vscode-input-background" to listOf("TextField.background"),
        "--vscode-list-hoverBackground" to listOf("List.hoverBackground", "Tree.hoverBackground"),
        "--vscode-list-activeSelectionBackground" to listOf("List.selectionBackground"),
        "--vscode-foreground" to listOf("Label.foreground"),
        "--vscode-descriptionForeground" to listOf("Label.infoForeground", "ContextHelp.foreground"),
        "--vscode-disabledForeground" to listOf("Label.disabledForeground"),
        "--vscode-textLink-foreground" to listOf("Link.activeForeground"),
        "--vscode-textLink-activeForeground" to listOf("Link.hoverForeground", "Link.activeForeground"),
        "--vscode-panel-border" to listOf("Borders.color", "Component.borderColor"),
        "--vscode-widget-border" to listOf("Borders.color"),
        "--vscode-input-border" to listOf("Component.borderColor", "TextField.borderColor"),
        "--vscode-focusBorder" to listOf("Component.focusColor", "Component.focusedBorderColor"),
        "--vscode-icon-foreground" to listOf("Label.foreground"),
        // The accent: the IDE's default-button colour.
        "--vscode-button-background" to listOf("Button.default.startBackground", "Button.default.background"),
        "--vscode-button-foreground" to listOf("Button.default.foreground"),
    )

    private val HEX = Regex("^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
    private val FONT = Regex("^[A-Za-z0-9 ._-]{1,100}$")

    /** `#rrggbb` for an sRGB colour with full alpha, `#rrggbbaa` otherwise. */
    fun hex(red: Int, green: Int, blue: Int, alpha: Int = 255): String =
        if (alpha >= 255) String.format("#%02x%02x%02x", red, green, blue) else String.format("#%02x%02x%02x%02x", red, green, blue, alpha)

    /**
     * The `kete.theme` message.
     * @param color the IDE's colour for a LAF key (or [EDITOR_BACKGROUND]) as `#rrggbb[aa]`, or null
     */
    fun message(
        dark: Boolean,
        highContrast: Boolean,
        color: (String) -> String?,
        uiFont: String?,
        editorFont: String?,
        fontSize: Int?,
    ): Map<String, Any?> {
        val variables = LinkedHashMap<String, String>()
        for ((variable, keys) in MAPPING) {
            val value = keys.asSequence().mapNotNull { color(it) }.firstOrNull { HEX.matches(it) } ?: continue
            variables[variable] = value
        }
        uiFont?.takeIf { FONT.matches(it) }?.let { variables["--vscode-font-family"] = "\"$it\", system-ui, sans-serif" }
        editorFont?.takeIf { FONT.matches(it) }?.let { variables["--vscode-editor-font-family"] = "\"$it\", ui-monospace, monospace" }
        fontSize?.takeIf { it in 6..48 }?.let { variables["--vscode-font-size"] = "${it}px" }
        val kind = when {
            highContrast && dark -> "high-contrast"
            highContrast -> "high-contrast-light"
            dark -> "dark"
            else -> "light"
        }
        return mapOf("type" to "kete.theme", "kind" to kind, "variables" to variables)
    }
}
