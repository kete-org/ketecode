package ai.ketecode.jetbrains.core

import java.net.URI

// Plugin settings → Kete Code's global configuration file (kete.json / kete.jsonc), mirroring
// packages/kete-vscode/src/settings.ts. The plugin writes only the keys it owns and edits the file in
// place, so comments, formatting and everything else the user configured stay as they are. An empty
// setting leaves its key alone rather than deleting what the user may have set by hand.

class JsoncException(message: String) : Exception(message)

data class KeteSettings(
    /** Kete Model Gateway root → providers.kete.settings.baseURL */
    val gatewayUrl: String? = null,
    /** Kete platform (portal) URL → kete.platform.url */
    val platformUrl: String? = null,
    /** Session budget in USD → kete.budget.session */
    val sessionBudget: Double? = null,
)

object KeteConfig {
    /** The config edits a settings object makes (key path → value); empty settings make none. */
    fun edits(settings: KeteSettings): List<Pair<List<String>, Any>> = listOfNotNull(
        settings.gatewayUrl?.takeIf { it.isNotEmpty() }?.let { listOf("providers", "kete", "settings", "baseURL") to it },
        settings.platformUrl?.takeIf { it.isNotEmpty() }?.let { listOf("kete", "platform", "url") to it },
        settings.sessionBudget?.takeIf { it > 0 && it.isFinite() }?.let { listOf("kete", "budget", "session") to it },
    )

    fun applySettings(text: String, settings: KeteSettings): String =
        edits(settings).fold(text.ifBlank { "{}" }) { current, (path, value) -> Jsonc.set(current, path, value) }

    /** An http(s) URL without a trailing slash, or null when the setting is empty or invalid. */
    fun httpUrl(value: String?): String? {
        val trimmed = value?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val uri = try {
            URI(trimmed)
        } catch (_: Exception) {
            return null
        }
        if ((uri.scheme != "http" && uri.scheme != "https") || uri.host == null || uri.rawUserInfo != null) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "${uri.scheme}://${uri.host}$port${(uri.rawPath ?: "").trimEnd('/')}"
    }

    /** The `config` directory from `kete debug paths`. */
    fun configDirectory(paths: String): String? =
        Regex("^config\\s+(.+)$", RegexOption.MULTILINE).find(paths)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }

    /** `KETE_PERMISSION_MODE` for new sessions, from the plugin's default-mode setting. */
    fun permissionMode(setting: String?): String = if (setting == "ask") "ask" else "default"
}

/** In-place edits to JSON with comments and trailing commas (the subset of jsonc-parser `modify` the plugin needs). */
object Jsonc {
    private class Obj(val open: Int, val close: Int, val depth: Int, val props: List<Prop>)
    private class Prop(val key: String, val valueStart: Int, val valueEnd: Int, val obj: Obj?)
    private class Parsed(val end: Int, val obj: Obj?)

    /** Sets `path` to `value`, creating missing objects; replaces a non-object in the way. */
    fun set(text: String, path: List<String>, value: Any): String {
        require(path.isNotEmpty())
        val source = text.ifBlank { "{}" }
        val parser = Parser(source)
        val start = parser.skip(0)
        val root = parser.value(start, 0)
        if (parser.skip(root.end) != source.length) throw JsoncException("unexpected text after the configuration object")
        var node = root.obj ?: throw JsoncException("the configuration file is not a JSON object")
        for ((index, key) in path.withIndex()) {
            val last = index == path.size - 1
            val prop = node.props.lastOrNull { it.key == key }
            if (prop == null) return insert(source, node, path.subList(index, path.size), value)
            if (last) return source.substring(0, prop.valueStart) + format(value, node.depth + 1) + source.substring(prop.valueEnd)
            if (prop.obj == null)
                return source.substring(0, prop.valueStart) + nested(path.subList(index + 1, path.size), value, node.depth + 1) + source.substring(prop.valueEnd)
            node = prop.obj
        }
        return source
    }

    /** Adds `"path[0]": …` as the object's first property (after `{`), so trailing commas and comments don't matter. */
    private fun insert(source: String, node: Obj, path: List<String>, value: Any): String {
        val indent = "  ".repeat(node.depth + 1)
        val entry = "${Json.string(path[0])}: ${nested(path.drop(1), value, node.depth + 1)}"
        val insertion = if (node.props.isEmpty()) {
            val inner = source.substring(node.open + 1, node.close)
            if (inner.isBlank()) return source.substring(0, node.open + 1) + "\n$indent$entry\n${"  ".repeat(node.depth)}" + source.substring(node.close)
            "\n$indent$entry"
        } else "\n$indent$entry,"
        return source.substring(0, node.open + 1) + insertion + source.substring(node.open + 1)
    }

    private fun nested(path: List<String>, value: Any, depth: Int): String {
        if (path.isEmpty()) return format(value, depth)
        return "{\n${"  ".repeat(depth + 1)}${Json.string(path[0])}: ${nested(path.drop(1), value, depth + 1)}\n${"  ".repeat(depth)}}"
    }

    private fun format(value: Any, @Suppress("UNUSED_PARAMETER") depth: Int): String = Json.write(value)

    private class Parser(val text: String) {
        /** The next index that isn't whitespace or a comment. */
        fun skip(from: Int): Int {
            var index = from
            while (index < text.length) {
                val char = text[index]
                when {
                    char.isWhitespace() || char == '﻿' -> index++
                    text.startsWith("//", index) -> {
                        while (index < text.length && text[index] != '\n') index++
                    }
                    text.startsWith("/*", index) -> {
                        val end = text.indexOf("*/", index + 2)
                        if (end == -1) throw JsoncException("unterminated comment")
                        index = end + 2
                    }
                    else -> return index
                }
            }
            return index
        }

        fun value(start: Int, depth: Int): Parsed {
            if (depth > 64) throw JsoncException("nested too deeply")
            if (start >= text.length) throw JsoncException("unexpected end of the file")
            return when (text[start]) {
                '{' -> obj(start, depth)
                '[' -> array(start, depth)
                '"' -> Parsed(string(start).second, null)
                else -> Parsed(scalar(start), null)
            }
        }

        private fun obj(open: Int, depth: Int): Parsed {
            val props = ArrayList<Prop>()
            var index = skip(open + 1)
            while (true) {
                if (index >= text.length) throw JsoncException("unterminated object")
                if (text[index] == '}') return Parsed(index + 1, Obj(open, index, depth, props))
                if (text[index] != '"') throw JsoncException("expected a property name at $index")
                val (key, keyEnd) = string(index)
                index = skip(keyEnd)
                if (index >= text.length || text[index] != ':') throw JsoncException("expected ':' at $index")
                val valueStart = skip(index + 1)
                val parsed = value(valueStart, depth + 1)
                props.add(Prop(key, valueStart, parsed.end, parsed.obj))
                index = skip(parsed.end)
                if (index < text.length && text[index] == ',') index = skip(index + 1)
                else if (index < text.length && text[index] != '}') throw JsoncException("expected ',' or '}' at $index")
            }
        }

        private fun array(open: Int, depth: Int): Parsed {
            var index = skip(open + 1)
            while (true) {
                if (index >= text.length) throw JsoncException("unterminated array")
                if (text[index] == ']') return Parsed(index + 1, null)
                val parsed = value(index, depth + 1)
                index = skip(parsed.end)
                if (index < text.length && text[index] == ',') index = skip(index + 1)
                else if (index < text.length && text[index] != ']') throw JsoncException("expected ',' or ']' at $index")
            }
        }

        /** The decoded string starting at `start` (a quote), and the index after its closing quote. */
        private fun string(start: Int): Pair<String, Int> {
            var index = start + 1
            val out = StringBuilder()
            while (index < text.length) {
                val char = text[index]
                if (char == '"') return Pair(out.toString(), index + 1)
                if (char == '\\' && index + 1 < text.length) {
                    // JSON escapes, so a key spelled with escapes (e.g. "provid\u0065rs") is still found.
                    when (val escape = text[index + 1]) {
                        'b' -> out.append('\b')
                        'f' -> out.append('\u000C')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            val code = text.substring(index + 2, minOf(index + 6, text.length))
                                .takeIf { hex -> hex.length == 4 && hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' } }?.toInt(16)
                                ?: throw JsoncException("bad unicode escape at $index")
                            out.append(code.toChar())
                            index += 6
                            continue
                        }
                        else -> out.append(escape)
                    }
                    index += 2
                    continue
                }
                out.append(char)
                index++
            }
            throw JsoncException("unterminated string")
        }

        private fun scalar(start: Int): Int {
            var index = start
            while (index < text.length && (text[index].isLetterOrDigit() || text[index] in "+-.")) index++
            if (index == start) throw JsoncException("unexpected '${text[start]}' at $start")
            return index
        }
    }
}

/**
 * The plugin's own settings (Settings → Tools → Kete Code), as stored by the IDE. [mapped] turns them
 * into what the runtime gets: its environment for new sessions and the `kete.jsonc` edits.
 */
data class PluginSettings(
    val cliPath: String? = null,
    val defaultMode: String = "default",
    val shareEditorContext: Boolean = true,
    val notifications: Boolean = true,
    val editorTools: Boolean = true,
    val gatewayUrl: String? = null,
    val platformUrl: String? = null,
    val sessionBudget: String? = null,
) {
    data class Mapped(
        /** Environment for `kete serve` (new sessions' permission mode). */
        val environment: Map<String, String>,
        /** What goes into kete.jsonc. */
        val config: KeteSettings,
        /** Settings that were set but invalid, so they weren't applied (shown to the user). */
        val invalid: List<String>,
    )

    fun mapped(): Mapped {
        val invalid = ArrayList<String>()
        val gateway = KeteConfig.httpUrl(gatewayUrl)
        if (!gatewayUrl.isNullOrBlank() && gateway == null) invalid.add("Gateway URL")
        val platform = KeteConfig.httpUrl(platformUrl)
        if (!platformUrl.isNullOrBlank() && platform == null) invalid.add("Platform URL")
        val budget = sessionBudget?.trim()?.takeIf { it.isNotEmpty() }?.let { text ->
            text.toDoubleOrNull()?.takeIf { it > 0 && it.isFinite() } ?: run {
                invalid.add("Session budget")
                null
            }
        }
        return Mapped(
            environment = mapOf("KETE_PERMISSION_MODE" to KeteConfig.permissionMode(defaultMode)),
            config = KeteSettings(gateway, platform, budget),
            invalid = invalid,
        )
    }
}
