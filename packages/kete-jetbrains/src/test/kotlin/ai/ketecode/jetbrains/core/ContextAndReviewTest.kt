package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ContextFilterTest {
    private val none = Selection(0, 0, 0, true)

    @Test
    fun `shares a project file, with the selected lines`() {
        assertEquals(EditorContext("src/app.ts"), ContextFilter.editorContext("src/app.ts", true, false, none))
        assertEquals(EditorContext("src/app.ts", 3, 5), ContextFilter.editorContext("src/app.ts", true, false, Selection(2, 4, 7, false)))
        // A selection ending at column 0 of a later line doesn't include that line.
        assertEquals(EditorContext("src/app.ts", 3, 4), ContextFilter.editorContext("src/app.ts", true, false, Selection(2, 4, 0, false)))
        assertEquals(EditorContext("a.kt", 1, 1), ContextFilter.editorContext("a.kt", true, false, Selection(0, 0, 0, false)))
    }

    @Test
    fun `never shares secrets, IDE-excluded files, non-local files or files outside the project`() {
        for (secret in listOf(".env", "config/.env.local", "certs/server.pem", "id_rsa", "keys/id_ed25519.pub", ".npmrc", "home/.netrc", "a.P12", "b.key"))
            assertNull(ContextFilter.editorContext(secret, true, false, none), secret)
        assertNull(ContextFilter.editorContext("build/out.js", true, true, none))
        assertNull(ContextFilter.editorContext("src/app.ts", false, false, none))
        assertNull(ContextFilter.editorContext(null, true, false, none))
        assertNull(ContextFilter.editorContext("", true, false, none))
    }

    @Test
    fun `names that only look similar are shared`() {
        assertFalse(ContextFilter.isSecret("src/environment.ts"))
        assertFalse(ContextFilter.isSecret("docs/keys.md"))
        assertTrue(ContextFilter.shareable(".envrc.example", true, false))
    }

    @Test
    fun `the message carries only the set fields`() {
        assertEquals(mapOf("path" to "a.kt"), EditorContext("a.kt").toMessage())
        assertEquals(mapOf("path" to "a.kt", "startLine" to 2, "endLine" to 3), EditorContext("a.kt", 2, 3).toMessage())
    }
}

class ReviewDiffTest {
    // The runtime's format (the `diff` package's formatPatch), with the whole file as context.
    private val header = "Index: src/app.ts\n===================================================================\n--- src/app.ts\n+++ src/app.ts\n"

    @Test
    fun `a modified file, from the patch alone`() {
        val patch = "$header@@ -1,3 +1,3 @@\n export const a = 1\n-export const b = 2\n+export const b = 20\n export const c = 3\n"
        val after = "export const a = 1\nexport const b = 20\nexport const c = 3\n"
        val expected = "export const a = 1\nexport const b = 2\nexport const c = 3\n"
        assertEquals(expected, ReviewDiff.before(patch, after))
        assertEquals(expected, ReviewDiff.before(patch, null))
    }

    @Test
    fun `an added file was empty and a deleted file comes back whole`() {
        assertEquals("", ReviewDiff.before("$header@@ -0,0 +1,2 @@\n+one\n+two\n", "one\ntwo\n"))
        assertEquals("one\ntwo\n", ReviewDiff.before("$header@@ -1,2 +0,0 @@\n-one\n-two\n", null))
    }

    @Test
    fun `an added file that is gone stays added and is never restored as an empty file`() {
        assertEquals("added", ReviewDiff.reviewStatus("added", exists = false))
        assertEquals("deleted", ReviewDiff.reviewStatus("modified", exists = false))
        assertEquals("modified", ReviewDiff.reviewStatus("modified", exists = true))
        assertEquals("added", ReviewDiff.reviewStatus("added", exists = true))

        assertTrue(ReviewDiff.revert("added", exists = false, before = "") is ReviewDiff.Revert.Skip)
        assertEquals(ReviewDiff.Revert.Delete, ReviewDiff.revert("added", exists = true, before = ""))
        assertEquals(ReviewDiff.Revert.Restore, ReviewDiff.revert("deleted", exists = false, before = "one\n"))
        assertTrue(ReviewDiff.revert("deleted", exists = false, before = "") is ReviewDiff.Revert.Skip)
        assertEquals(ReviewDiff.Revert.PutBack, ReviewDiff.revert("modified", exists = true, before = "one\n"))
        assertEquals(ReviewDiff.Revert.PutBack, ReviewDiff.revert("modified", exists = true, before = ""))
    }

    @Test
    fun `a missing final newline`() {
        val patch = "$header@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+two\n"
        assertEquals("one\ntwo", ReviewDiff.before(patch, "one\ntwo\n"))
    }

    @Test
    fun `CRLF files keep their carriage returns`() {
        assertEquals("a\r\nb\r\n", ReviewDiff.before("$header@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n", "a\r\nc\r\n"))
    }

    @Test
    fun `a patch with only some context is reversed against the current file`() {
        val current = (1..10).joinToString("") { "line $it\n" }
        val changed = current.replace("line 5\n", "line five\n")
        val patch = "$header@@ -4,3 +4,3 @@\n line 4\n-line 5\n+line five\n line 6\n"
        assertEquals(current, ReviewDiff.before(patch, changed))
    }

    @Test
    fun `refuses when the file changed since the turn`() {
        val patch = "$header@@ -4,3 +4,3 @@\n line 4\n-line 5\n+line five\n line 6\n"
        assertTrue(assertThrows(ReviewException::class.java) { ReviewDiff.before(patch, "something else entirely\n") }.message!!.contains("changed since"))
        assertTrue(assertThrows(ReviewException::class.java) { ReviewDiff.before(patch, null) }.message!!.contains("gone"))
    }

    @Test
    fun `parse reads hunks and ignores headers`() {
        val hunks = ReviewDiff.parse("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d\n")
        assertEquals(listOf(listOf(1, 1, 2), listOf(9, 9, 2)), hunks.map { listOf(it.oldStart, it.newStart, it.lines.size) })
    }

    @Test
    fun `reads the runtime's diff response, skipping malformed entries`() {
        val body = Json.parse("""{"data":[{"file":"a.ts","patch":"@@ -1 +1 @@\n-a\n+b\n","status":"modified"},{"file":3},{"file":"b.ts","patch":"x"}]}""")
        assertEquals(listOf(ReviewDiff.FileDiff("a.ts", "@@ -1 +1 @@\n-a\n+b\n", "modified")), ReviewDiff.files(body))
        assertEquals(emptyList<ReviewDiff.FileDiff>(), ReviewDiff.files(null))
    }
}
