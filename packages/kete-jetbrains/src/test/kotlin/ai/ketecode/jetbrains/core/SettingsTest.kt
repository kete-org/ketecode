package ai.ketecode.jetbrains.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class KeteConfigTest {
    @Test
    fun `creates the configuration when the file is empty`() {
        val text = KeteConfig.applySettings("", KeteSettings(gatewayUrl = "http://localhost:8787", sessionBudget = 5.0))
        assertEquals(
            mapOf("kete" to mapOf("budget" to mapOf("session" to 5L)), "providers" to mapOf("kete" to mapOf("settings" to mapOf("baseURL" to "http://localhost:8787")))),
            Json.parse(text),
        )
    }

    @Test
    fun `keeps comments, trailing commas, other providers and unrelated keys`() {
        val before = """
            {
              // my models
              "model": "kete/auto",
              "providers": {
                "openai": { "settings": { "apiKey": "{env:OPENAI_API_KEY}" } }, /* keep */
                "kete": { "settings": { "baseURL": "http://old:1", "timeout": 5 } },
              },
            }
        """.trimIndent()
        val after = KeteConfig.applySettings(before, KeteSettings(gatewayUrl = "http://new:2", platformUrl = "https://portal.example"))
        assertTrue(after.contains("// my models"))
        assertTrue(after.contains("/* keep */"))
        assertTrue(after.contains("\"apiKey\": \"{env:OPENAI_API_KEY}\""))
        assertTrue(after.contains("\"baseURL\": \"http://new:2\""))
        assertFalse(after.contains("http://old:1"))
        assertTrue(after.contains("\"timeout\": 5"))
        // Still JSONC the parser accepts once comments are stripped, with the new key added.
        assertTrue(after.contains("\"url\": \"https://portal.example\""))
        assertEquals(after, KeteConfig.applySettings(after, KeteSettings(gatewayUrl = "http://new:2", platformUrl = "https://portal.example")))
    }

    @Test
    fun `empty settings leave the file alone and a non-object in the way is replaced`() {
        val text = "{ \"kete\": { \"budget\": 3 } }"
        assertEquals(text, KeteConfig.applySettings(text, KeteSettings()))
        assertEquals(text, KeteConfig.applySettings(text, KeteSettings(gatewayUrl = "", sessionBudget = -1.0)))
        val replaced = KeteConfig.applySettings(text, KeteSettings(sessionBudget = 2.5))
        assertEquals(mapOf("kete" to mapOf("budget" to mapOf("session" to 2.5))), Json.parse(replaced))
    }

    @Test
    fun `refuses files that aren't a JSON object`() {
        assertThrows(JsoncException::class.java) { KeteConfig.applySettings("[1, 2]", KeteSettings(gatewayUrl = "http://a")) }
        assertThrows(JsoncException::class.java) { KeteConfig.applySettings("{ \"a\": ", KeteSettings(gatewayUrl = "http://a")) }
        assertThrows(JsoncException::class.java) { KeteConfig.applySettings("{ /* open", KeteSettings(gatewayUrl = "http://a")) }
    }

    @Test
    fun `http URLs, config directory and permission mode`() {
        assertEquals("http://localhost:8787", KeteConfig.httpUrl(" http://localhost:8787/ "))
        assertEquals("https://portal.example/base", KeteConfig.httpUrl("https://portal.example/base//"))
        assertNull(KeteConfig.httpUrl(""))
        assertNull(KeteConfig.httpUrl("ftp://x"))
        assertNull(KeteConfig.httpUrl("localhost:8787"))
        assertNull(KeteConfig.httpUrl("https://user:pw@x"))
        assertEquals("/home/a/.config/kete", KeteConfig.configDirectory("data    /home/a/.local/share/kete\nconfig  /home/a/.config/kete\n"))
        assertNull(KeteConfig.configDirectory("nothing"))
        assertEquals("ask", KeteConfig.permissionMode("ask"))
        assertEquals("default", KeteConfig.permissionMode("anything"))
    }
}

class PluginSettingsTest {
    @Test
    fun `maps the plugin settings to the runtime environment and kete jsonc`() {
        val mapped = PluginSettings(defaultMode = "ask", gatewayUrl = "http://localhost:8787/", platformUrl = "", sessionBudget = "12.5").mapped()
        assertEquals(mapOf("KETE_PERMISSION_MODE" to "ask"), mapped.environment)
        assertEquals(KeteSettings("http://localhost:8787", null, 12.5), mapped.config)
        assertEquals(emptyList<String>(), mapped.invalid)
    }

    @Test
    fun `invalid values are reported and not applied`() {
        val mapped = PluginSettings(gatewayUrl = "not a url", platformUrl = "ftp://x", sessionBudget = "-3").mapped()
        assertEquals(KeteSettings(null, null, null), mapped.config)
        assertEquals(listOf("Gateway URL", "Platform URL", "Session budget"), mapped.invalid)
        assertEquals(mapOf("KETE_PERMISSION_MODE" to "default"), PluginSettings().mapped().environment)
    }
}

class PanelTest {
    @Test
    fun `dismissals keep only real notices, deduped`() {
        assertEquals(listOf("agents-md"), Panel.dismiss(emptyList(), "agents-md"))
        assertEquals(listOf("agents-md"), Panel.dismiss(listOf("agents-md"), "agents-md"))
        assertEquals(emptyList<String>(), Panel.dismiss(emptyList(), "unknown"))
    }

    @Test
    fun `the panel message matches what the web UI validates`() {
        val message = Panel.message(listOf("portal-agents"), cliHintDismissed = false, mac = true, defaultMode = "ask")
        assertEquals("kete.panel", message["type"])
        assertEquals("mac", message["platform"])
        assertEquals("ask", message["defaultMode"])
        assertEquals(true, message["cliHint"])
        val notices = message["notices"] as List<*>
        assertEquals(1, notices.size)
        assertEquals("agents-md", (notices[0] as Map<*, *>)["id"])
        assertFalse((notices[0] as Map<*, *>).containsKey("isNew"))
        for (notice in Panel.NOTICES) {
            assertTrue(Panel.NOTICE_ID.matches(notice.id))
            assertTrue(notice.title.length in 1..120 && notice.body.length in 1..600)
        }
        assertEquals("other", Panel.message(emptyList(), true, false, "weird")["platform"])
        assertEquals("default", Panel.message(emptyList(), true, false, "weird")["defaultMode"])
    }
}

class ThemeTest {
    @Test
    fun `maps the IDE's colours onto the VS Code variables the web UI knows`() {
        val colors = mapOf(
            Theme.EDITOR_BACKGROUND to "#1e1f22",
            "Panel.background" to "#2b2d30",
            "Label.foreground" to "#dfe1e5",
            "Button.default.startBackground" to "#3574f0",
            "Component.focusColor" to "nonsense",
        )
        val message = Theme.message(true, false, { colors[it] }, "Inter", "JetBrains Mono", 13)
        assertEquals("kete.theme", message["type"])
        assertEquals("dark", message["kind"])
        @Suppress("UNCHECKED_CAST") val variables = message["variables"] as Map<String, String>
        assertEquals("#1e1f22", variables["--vscode-editor-background"])
        assertEquals("#2b2d30", variables["--vscode-sideBar-background"], "falls back to Panel.background")
        assertEquals("#3574f0", variables["--vscode-button-background"])
        assertNull(variables["--vscode-focusBorder"], "values that aren't hex colours are dropped")
        assertEquals("\"Inter\", system-ui, sans-serif", variables["--vscode-font-family"])
        assertEquals("13px", variables["--vscode-font-size"])
        // Every variable is one the web UI accepts (packages/app/src/kete/vscode-theme.ts VSCODE_VARIABLES).
        val known = setOf(
            "--vscode-editor-background", "--vscode-sideBar-background", "--vscode-panel-background", "--vscode-editorWidget-background",
            "--vscode-input-background", "--vscode-list-hoverBackground", "--vscode-list-activeSelectionBackground", "--vscode-foreground",
            "--vscode-descriptionForeground", "--vscode-disabledForeground", "--vscode-textLink-foreground", "--vscode-textLink-activeForeground",
            "--vscode-panel-border", "--vscode-widget-border", "--vscode-input-border", "--vscode-contrastBorder", "--vscode-focusBorder",
            "--vscode-icon-foreground", "--vscode-button-background", "--vscode-button-foreground", "--vscode-font-family",
            "--vscode-editor-font-family", "--vscode-font-size",
        )
        assertTrue(known.containsAll(Theme.MAPPING.map { it.first }))
    }

    @Test
    fun `kinds, unsafe fonts and hex`() {
        assertEquals("light", Theme.message(false, false, { null }, null, null, null)["kind"])
        assertEquals("high-contrast", Theme.message(true, true, { null }, null, null, null)["kind"])
        assertEquals("high-contrast-light", Theme.message(false, true, { null }, null, null, null)["kind"])
        @Suppress("UNCHECKED_CAST")
        val variables = Theme.message(false, false, { null }, "x\"; } body { color: red", "Mono", 200)["variables"] as Map<String, String>
        assertEquals(mapOf("--vscode-editor-font-family" to "\"Mono\", ui-monospace, monospace"), variables)
        assertEquals("#0a0b0c", Theme.hex(10, 11, 12))
        assertEquals("#0a0b0c80", Theme.hex(10, 11, 12, 128))
    }
}

class StatusTextTest {
    @Test
    fun `status bar text and tooltip`() {
        val signedIn = AccountState.Known(Account.SignedIn("Acme", "https://p", "https://g", "Keychain", emptyList()))
        val bar = StatusText.bar(RuntimeStatus.Running("http://127.0.0.1:1"), signedIn, 2)
        assertEquals("Kete · Acme · 2 waiting", bar.text)
        assertTrue(bar.tooltip.contains("Server: running on http://127.0.0.1:1"))
        assertTrue(bar.tooltip.contains("2 waiting for your approval"))
        assertFalse(bar.error)
        val failed = StatusText.bar(RuntimeStatus.Failed("boom"), AccountState.Known(Account.SignedOut(emptyList())))
        assertEquals("Kete · Signed out · stopped", failed.text)
        assertTrue(failed.error)
        assertEquals("Kete · starting…", StatusText.bar(RuntimeStatus.Restarting(1, 1000, "x"), AccountState.Checking).text)
    }
}

class JsonTest {
    @Test
    fun `round trips values`() {
        val value = mapOf("a" to listOf(1L, 2.5, true, null, "x\"y\\z\n"), "b" to mapOf("c" to "é😀"))
        assertEquals(value, Json.parse(Json.write(value)))
        assertEquals("\"\\u003c/script\\u003e\"", Json.write("</script>"))
        assertEquals("5", Json.write(5.0))
    }

    @Test
    fun `rejects invalid JSON and deep nesting`() {
        for (bad in listOf("", "{", "{\"a\" 1}", "[1,]", "tru", "\"\\x\"", "01a", "{} extra", "\"a\nb\""))
            assertThrows(JsonException::class.java, { Json.parse(bad) }, bad)
        assertThrows(JsonException::class.java) { Json.parse("[".repeat(100) + "]".repeat(100)) }
        assertEquals(mapOf("u" to "\u00e9"), Json.parse("{\"u\":\"\\u00e9\"}"))
        assertNull(Json.parseOrNull("{"))
    }
}
