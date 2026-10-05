package ai.ketecode.jetbrains.core

import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFileAttributeView

// Replacing a file so a reader (the runtime, another IDE) never sees it half written: the text goes to
// a temporary file in the same folder, which is then moved over the target atomically where the file
// system can (else a plain replace). A symbolic link (a dotfiles setup) keeps pointing at its file: the
// file it leads to is replaced, not the link. POSIX permissions of the old file are kept.

object AtomicFile {
    fun write(target: Path, text: String) {
        val file = if (Files.isSymbolicLink(target)) target.toRealPath() else target.toAbsolutePath()
        val directory = file.parent ?: throw IllegalArgumentException("no parent folder for $file")
        Files.createDirectories(directory)
        val temporary = Files.createTempFile(directory, ".${file.fileName}.", ".tmp")
        try {
            Files.writeString(temporary, text)
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) copyPermissions(file, temporary)
            try {
                Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            Files.deleteIfExists(temporary)
        }
    }

    private fun copyPermissions(from: Path, to: Path) {
        val source = Files.getFileAttributeView(from, PosixFileAttributeView::class.java) ?: return
        val target = Files.getFileAttributeView(to, PosixFileAttributeView::class.java) ?: return
        target.setPermissions(source.readAttributes().permissions())
    }
}
