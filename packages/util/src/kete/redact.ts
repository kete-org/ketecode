// A small, pattern-based redactor shared by anything that writes model/tool/command text
// somewhere a person (or another system) might read it later — first user: the audit log
// (core/src/kete/audit.ts). Best-effort: it catches known secret shapes and secret-looking field
// names, not everything. `text` redacts a string; `deep` walks a JSON-ish value, redacting every
// string and replacing the whole value under a secret-looking key; `truncate` cuts a string to at
// most `bytes` UTF-8 bytes without splitting a multi-byte character. Callers that need both should
// redact before truncating a cut must never expose half a secret the truncation point would
// otherwise slice through.

export * as KeteRedact from "./redact.js"

const MASK = "[REDACTED]"

// The bare "pass" alternative is anchored (not preceded/followed by a letter) so it catches
// delimited abbreviations (DB_PASS, APP_PASS, MYSQL_PASS, "db_pass") without matching "pass" as a
// substring of an ordinary word (passage, bypass) — `passw(?:or)?d` (password/passwd) stays
// unanchored, since that's specific enough to still match inside a compound like `dbPassword`.
const NAME =
  "(?:secret|token|passw(?:or)?d|(?<![A-Za-z])pass(?![A-Za-z])|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)"
const secretName = new RegExp(`[\\w.-]*${NAME}[\\w.-]*`, "i")

/** Whether a bare property/variable name looks like a secret (what `deep` masks a whole value
 * under). Exposed so a caller that pre-bounds a large value before calling `text` on it (the audit
 * log, for a multi-MB tool result) can still apply the same key-name rule itself. */
export function isSecretKey(name: string): boolean {
  return secretName.test(name)
}

// Known secret-value shapes: OpenAI/Anthropic-style `sk-...`, GitHub tokens, Slack tokens, AWS
// access key ids, Google API keys, and JWT-looking three-segment base64url strings.
const keyShapes = new RegExp(
  [
    "\\bsk-(?:ant-)?[A-Za-z0-9_-]{10,}\\b",
    "\\b(?:ghp|gho)_[A-Za-z0-9]{20,}\\b",
    "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b",
    "\\bxox[abp]-[A-Za-z0-9-]{10,}\\b",
    "\\bAKIA[A-Z0-9]{16}\\b",
    "\\bAIza[A-Za-z0-9_-]{20,}\\b",
    "\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b",
  ].join("|"),
  "g",
)

const pemBlock = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g
const authorizationHeader = /Authorization:\s*[^\r\n]+/gi
const bearerToken = /\bBearer\s+\S+/gi
const jsonSecretField = new RegExp(`"([\\w.-]*${NAME}[\\w.-]*)"\\s*:\\s*"([^"]*)"`, "gi")
const envSecretField = new RegExp(`\\b([\\w.-]*${NAME}[\\w.-]*)\\s*=\\s*(\\S+)`, "gi")
const colonSecretField = new RegExp(`\\b([\\w.-]*${NAME}[\\w.-]*):\\s*(\\S+)`, "gi")
const urlCredentials = /(\w+:\/\/)[^\s/:@]+:[^\s/:@]+@/g

/** Masks known secret shapes and secret-looking `name=value`/`name: value`/`"name": "value"` pairs. */
export function text(input: string): string {
  let out = input
  out = out.replace(pemBlock, "[REDACTED PRIVATE KEY]")
  out = out.replace(authorizationHeader, `Authorization: ${MASK}`)
  out = out.replace(bearerToken, `Bearer ${MASK}`)
  out = out.replace(keyShapes, MASK)
  out = out.replace(jsonSecretField, (_match, name: string) => `"${name}": "${MASK}"`)
  out = out.replace(envSecretField, (_match, name: string) => `${name}=${MASK}`)
  out = out.replace(colonSecretField, (_match, name: string) => `${name}: ${MASK}`)
  out = out.replace(urlCredentials, (_match, scheme: string) => `${scheme}${MASK}@`)
  return out
}

/**
 * Walks a JSON-ish value: every string is passed through `text`; every property whose key looks
 * like a secret name has its whole value replaced, whatever type it is.
 */
export function deep(value: unknown): unknown {
  if (typeof value === "string") return text(value)
  if (Array.isArray(value)) return value.map(deep)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? MASK : deep(item)
    }
    return out
  }
  return value
}

/** Cuts `input` to at most `bytes` UTF-8 bytes, never splitting a multi-byte character. */
export function truncate(input: string, bytes: number): string {
  const buffer = Buffer.from(input, "utf8")
  if (buffer.byteLength <= bytes) return input
  let end = bytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString("utf8")
}
