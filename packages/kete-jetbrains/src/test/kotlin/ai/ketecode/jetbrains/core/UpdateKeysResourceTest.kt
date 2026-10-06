package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import java.io.File

class UpdateKeysResourceTest {
    @Test
    fun `the bundled update keys are packages-cli's update-keys json, byte for byte`() {
        val source = File(System.getProperty("kete.updateKeys") ?: error("kete.updateKeys is not set (run through Gradle)"))
        val resource = CliRelease::class.java.getResourceAsStream(CliRelease.KEYS_RESOURCE)?.use { it.readBytes() }
        assertNotNull(resource, "the generated resource is missing")
        assertArrayEquals(source.readBytes(), resource)
        assertEquals(CliRelease.parseKeys(source.readText()).map { it.id }, CliRelease.pinnedKeys().map { it.id })
    }
}
