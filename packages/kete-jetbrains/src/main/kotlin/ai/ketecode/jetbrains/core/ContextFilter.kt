package ai.ketecode.jetbrains.core

// What the chat is told about the editor (mirrors packages/kete-vscode/src/editor-context.ts): the
// active file and selection, shared automatically as one context item. Only project files are shared;
// secrets and anything the IDE excludes or ignores are never shared.

data class EditorContext(val path: String, val startLine: Int? = null, val endLine: Int? = null) {
    fun toMessage(): Map<String, Any?> = buildMap {
        put("path", path)
        if (startLine != null) put("startLine", startLine)
        if (endLine != null) put("endLine", endLine)
    }
}

/** Zero-based lines; `endColumn` is the column the selection ends at. */
data class Selection(val startLine: Int, val endLine: Int, val endColumn: Int, val empty: Boolean)

object ContextFilter {
    /** Names that usually hold secrets: never shared automatically (the same list as editor-context.ts). */
    val SECRET = Regex("(^|/)(\\.env(\\..*)?|.*\\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\\.pub)?|\\.npmrc|\\.netrc)$", RegexOption.IGNORE_CASE)

    fun isSecret(relative: String) = SECRET.containsMatchIn(relative)

    /** Whether a project file may be shared with the chat at all. */
    fun shareable(relative: String?, localFile: Boolean, excluded: Boolean): Boolean =
        localFile && !relative.isNullOrEmpty() && !excluded && !isSecret(relative)

    /**
     * The context item for the active editor, or null when nothing may be shared.
     * @param relative project-relative path with forward slashes, or null outside the project
     * @param localFile whether the editor shows a real file on disk (not a diff, scratch or remote file)
     * @param excluded whether the IDE excludes or ignores the file (excluded folders, ignored files)
     */
    fun editorContext(relative: String?, localFile: Boolean, excluded: Boolean, selection: Selection?): EditorContext? {
        if (!shareable(relative, localFile, excluded)) return null
        val path = relative!!
        if (selection == null || selection.empty) return EditorContext(path)
        val (start, end) = lines(selection)
        return EditorContext(path, start, end)
    }

    /** One-based start and end lines; a selection ending at column 0 of a later line doesn't include that line. */
    fun lines(selection: Selection): Pair<Int, Int> {
        val end = if (selection.endColumn == 0 && selection.endLine > selection.startLine) selection.endLine else selection.endLine + 1
        return Pair(selection.startLine + 1, end)
    }
}
