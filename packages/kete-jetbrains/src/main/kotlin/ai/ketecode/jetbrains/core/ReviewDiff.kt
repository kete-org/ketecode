package ai.ketecode.jetbrains.core

// A turn's changes as IDE diffs (mirrors packages/kete-vscode/src/review.ts): the file before the turn,
// rebuilt from the runtime's unified patch (`GET /api/session/:id/diff`), against the file on disk.
// Session diffs carry the whole file as context, so the "before" side comes from the patch alone; a
// patch with only some context is reversed against the current file instead, and refused if that file
// changed since the turn.

class ReviewException(message: String) : Exception(message)

object ReviewDiff {
    data class Line(val kind: Char, val text: String, val newline: Boolean)
    data class Hunk(val oldStart: Int, val newStart: Int, val lines: List<Line>)

    /** One file's change in the runtime's diff response. */
    data class FileDiff(val file: String, val patch: String, val status: String)

    private val HEADER = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@")

    fun parse(patch: String): List<Hunk> {
        val hunks = ArrayList<Hunk>()
        val rows = patch.split("\n")
        var index = 0
        while (index < rows.size) {
            val header = HEADER.find(rows[index])
            if (header == null) {
                index++
                continue
            }
            val lines = ArrayList<Line>()
            index++
            while (index < rows.size) {
                val row = rows[index]
                if (row.startsWith("@@")) break
                if (row.startsWith("\\")) {
                    // "\ No newline at end of file" applies to the line before it.
                    if (lines.isNotEmpty()) lines[lines.size - 1] = lines.last().copy(newline = false)
                    index++
                    continue
                }
                val kind = row.firstOrNull()
                if (kind != ' ' && kind != '-' && kind != '+') {
                    if (row.isEmpty()) {
                        index++
                        continue
                    }
                    break
                }
                lines.add(Line(kind, row.substring(1), true))
                index++
            }
            hunks.add(Hunk(header.groupValues[1].toInt(), header.groupValues[2].toInt(), lines))
        }
        return hunks
    }

    /**
     * The file as it was before the patch. `current` (the file on disk) is only needed when the patch
     * doesn't carry the whole file; null means the file doesn't exist now.
     */
    fun before(patch: String, current: String?): String {
        val hunks = parse(patch)
        if (hunks.isEmpty()) return current ?: ""
        val first = hunks[0]
        if (hunks.size == 1 && first.oldStart <= 1 && first.newStart <= 1 && coversWhole(first, current))
            return join(first.lines.filter { it.kind != '+' })
        if (current == null) throw ReviewException("the file is gone, and the patch doesn't carry all of it")
        return reverse(hunks, current)
    }

    /** The diffs in a `GET /api/session/:id/diff` response body; malformed entries are skipped. */
    fun files(body: Any?): List<FileDiff> =
        body.asObject()?.get("data").asList().orEmpty().mapNotNull { item ->
            val entry = item.asObject() ?: return@mapNotNull null
            val file = entry.string("file") ?: return@mapNotNull null
            val patch = entry.string("patch") ?: return@mapNotNull null
            val status = entry.string("status") ?: return@mapNotNull null
            FileDiff(file, patch, status)
        }

    private fun coversWhole(hunk: Hunk, current: String?) =
        current == null || join(hunk.lines.filter { it.kind != '-' }) == current

    /** Undoes the hunks on `current`, checking every context and added line still matches. */
    private fun reverse(hunks: List<Hunk>, current: String): String {
        val lines = split(current)
        val out = ArrayList<Line>()
        var cursor = 0
        for (hunk in hunks) {
            val start = maxOf(hunk.newStart - 1, 0)
            if (start < cursor) throw ReviewException("overlapping hunks")
            out.addAll(lines.subList(minOf(cursor, lines.size), minOf(start, lines.size)))
            cursor = start
            for (line in hunk.lines) {
                if (line.kind == '-') {
                    out.add(line)
                    continue
                }
                if (lines.getOrNull(cursor)?.text != line.text) throw ReviewException("the file changed since this turn")
                if (line.kind == ' ') out.add(lines[cursor])
                cursor++
            }
        }
        if (cursor < lines.size) out.addAll(lines.subList(cursor, lines.size))
        return join(out)
    }

    private fun split(text: String): List<Line> {
        if (text.isEmpty()) return emptyList()
        val parts = text.split("\n").toMutableList()
        val newline = text.endsWith("\n")
        if (newline) parts.removeAt(parts.size - 1)
        return parts.mapIndexed { index, part -> Line(' ', part, index < parts.size - 1 || newline) }
    }

    private fun join(lines: List<Line>) = lines.joinToString("") { it.text + if (it.newline) "\n" else "" }
}
