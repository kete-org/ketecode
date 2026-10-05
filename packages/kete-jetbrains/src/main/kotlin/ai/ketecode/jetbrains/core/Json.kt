package ai.ketecode.jetbrains.core

// A small, strict JSON reader and writer for the bridge, the runtime API and the MCP tool. Values are
// plain Kotlin: Map<String, Any?>, List<Any?>, String, Long (integers), Double, Boolean and null.
// Kept dependency-free (no IDE classes) so everything that uses it is unit-testable.

class JsonException(message: String) : Exception(message)

object Json {
    /** Nesting deeper than this is refused rather than risking a stack overflow on hostile input. */
    private const val MAX_DEPTH = 64

    fun parse(text: String): Any? {
        val reader = Reader(text)
        reader.space()
        val value = reader.value(0)
        reader.space()
        if (!reader.done()) throw JsonException("unexpected trailing text at ${reader.index}")
        return value
    }

    /** The parsed value, or null when the text isn't valid JSON. */
    fun parseOrNull(text: String): Any? = try {
        parse(text)
    } catch (_: JsonException) {
        null
    }

    fun write(value: Any?): String = StringBuilder().also { write(value, it) }.toString()

    private fun write(value: Any?, out: StringBuilder) {
        when (value) {
            null -> out.append("null")
            is String -> string(value, out)
            is Boolean -> out.append(value.toString())
            is Int, is Long, is Short, is Byte -> out.append(value.toString())
            is Double -> if (value.isFinite()) out.append(number(value)) else out.append("null")
            is Float -> write(value.toDouble(), out)
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, item) in value) {
                    if (!first) out.append(',')
                    first = false
                    string(key.toString(), out)
                    out.append(':')
                    write(item, out)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                var first = true
                for (item in value) {
                    if (!first) out.append(',')
                    first = false
                    write(item, out)
                }
                out.append(']')
            }
            is Array<*> -> write(value.toList(), out)
            else -> string(value.toString(), out)
        }
    }

    private fun number(value: Double): String =
        if (value == Math.floor(value) && Math.abs(value) < 1e15) value.toLong().toString() else value.toString()

    /** A JSON string literal. Also escapes U+2028/2029 and `<`, so the result is safe inside JavaScript source. */
    fun string(value: String, out: StringBuilder = StringBuilder()): StringBuilder {
        out.append('"')
        for (char in value) {
            when (char) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                ' ', ' ', '<', '>' -> out.append(String.format("\\u%04x", char.code))
                else -> if (char < ' ') out.append(String.format("\\u%04x", char.code)) else out.append(char)
            }
        }
        out.append('"')
        return out
    }

    private class Reader(val text: String) {
        var index = 0

        fun done() = index >= text.length

        fun space() {
            while (index < text.length && text[index] in " \t\r\n") index++
        }

        fun value(depth: Int): Any? {
            if (depth > MAX_DEPTH) throw JsonException("nested too deeply")
            if (done()) throw JsonException("unexpected end")
            return when (val char = text[index]) {
                '{' -> obj(depth)
                '[' -> array(depth)
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (char == '-' || char in '0'..'9') number() else throw JsonException("unexpected '$char' at $index")
            }
        }

        private fun literal(word: String, result: Any?): Any? {
            if (!text.startsWith(word, index)) throw JsonException("unexpected token at $index")
            index += word.length
            return result
        }

        private fun obj(depth: Int): Map<String, Any?> {
            val result = LinkedHashMap<String, Any?>()
            index++
            space()
            if (peek() == '}') {
                index++
                return result
            }
            while (true) {
                space()
                if (peek() != '"') throw JsonException("expected a key at $index")
                val key = string()
                space()
                expect(':')
                space()
                result[key] = value(depth + 1)
                space()
                when (peek()) {
                    ',' -> index++
                    '}' -> {
                        index++
                        return result
                    }
                    else -> throw JsonException("expected ',' or '}' at $index")
                }
            }
        }

        private fun array(depth: Int): List<Any?> {
            val result = ArrayList<Any?>()
            index++
            space()
            if (peek() == ']') {
                index++
                return result
            }
            while (true) {
                space()
                result.add(value(depth + 1))
                space()
                when (peek()) {
                    ',' -> index++
                    ']' -> {
                        index++
                        return result
                    }
                    else -> throw JsonException("expected ',' or ']' at $index")
                }
            }
        }

        private fun string(): String {
            expect('"')
            val out = StringBuilder()
            while (true) {
                if (done()) throw JsonException("unterminated string")
                val char = text[index++]
                when {
                    char == '"' -> return out.toString()
                    char == '\\' -> {
                        if (done()) throw JsonException("unterminated escape")
                        when (val escape = text[index++]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (index + 4 > text.length) throw JsonException("bad unicode escape")
                                val hex = text.substring(index, index + 4)
                                val code = hex.toIntOrNull(16) ?: throw JsonException("bad unicode escape")
                                out.append(code.toChar())
                                index += 4
                            }
                            else -> throw JsonException("bad escape '\\$escape'")
                        }
                    }
                    char < ' ' -> throw JsonException("control character in string")
                    else -> out.append(char)
                }
            }
        }

        private fun number(): Any {
            val start = index
            if (peek() == '-') index++
            digits()
            var integral = true
            if (peek() == '.') {
                integral = false
                index++
                digits()
            }
            if (peek() == 'e' || peek() == 'E') {
                integral = false
                index++
                if (peek() == '+' || peek() == '-') index++
                digits()
            }
            val literal = text.substring(start, index)
            if (integral) literal.toLongOrNull()?.let { return it }
            return literal.toDoubleOrNull() ?: throw JsonException("bad number '$literal'")
        }

        private fun digits() {
            val start = index
            while (index < text.length && text[index] in '0'..'9') index++
            if (index == start) throw JsonException("expected a digit at $index")
        }

        private fun peek(): Char? = if (index < text.length) text[index] else null

        private fun expect(char: Char) {
            if (peek() != char) throw JsonException("expected '$char' at $index")
            index++
        }
    }
}

/** Typed reads from a parsed JSON object, without unchecked casts at every call site. */
fun Any?.asObject(): Map<String, Any?>? {
    if (this !is Map<*, *>) return null
    if (keys.any { it !is String }) return null
    @Suppress("UNCHECKED_CAST") // every key was just checked to be a String
    return this as Map<String, Any?>
}

fun Any?.asList(): List<Any?>? = (this as? List<*>)?.toList()

fun Map<String, Any?>.string(key: String): String? = this[key] as? String

fun Map<String, Any?>.long(key: String): Long? = when (val value = this[key]) {
    is Long -> value
    is Double -> if (value == Math.floor(value) && value.isFinite()) value.toLong() else null
    else -> null
}

fun Map<String, Any?>.number(key: String): Double? = when (val value = this[key]) {
    is Long -> value.toDouble()
    is Double -> value
    else -> null
}

fun Map<String, Any?>.bool(key: String): Boolean? = this[key] as? Boolean
