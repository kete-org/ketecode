package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.io.File

class ArchiveTargetsTest {
    @Test
    fun `the publish-time release check verifies exactly the archives the plugin downloads`() {
        val script = File(System.getProperty("kete.verifyScript") ?: error("kete.verifyScript is not set (run through Gradle)")).readText()
        val list = Regex("export const pluginTargets = \\[(.*?)] as const", RegexOption.DOT_MATCHES_ALL).find(script)?.groupValues?.get(1)
            ?: error("pluginTargets not found in ${System.getProperty("kete.verifyScript")}")
        val targets = Regex("\"([a-z0-9-]+)\"").findAll(list).map { it.groupValues[1] }.toSet()
        assertEquals(Binary.targets.values.toSet(), targets)
    }
}
