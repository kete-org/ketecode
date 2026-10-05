// Kete-owned. Literal secret masking: the step knows every secret it was given (the Kete API key,
// provider keys, the endpoint key, the clone password, any other `PLUGIN_*` key setting), so it
// replaces each known value with [REDACTED] before the pattern-based `KeteRedact.text`, which only
// catches known key shapes and `name=value` pairs. Every text the step writes or prints goes through
// one `Redactor`: log lines, output variables, summary.md, result.json, the audit copy, git output
// and the log tail in the prompt.

import { KeteRedact } from "@opencode/util/kete/redact"

export * as Secrets from "./secrets.js"

export type Env = Readonly<Record<string, string | undefined>>

/** Masks known secret values, then known secret shapes. */
export type Redactor = (text: string) => string

export const mask = "[REDACTED]"

/** Shorter values aren't masked literally: they'd hide ordinary words. Shapes still apply. */
export const minLength = 8

/** Variables outside `PLUGIN_*` whose values are secrets. */
const otherSecrets = ["DRONE_NETRC_PASSWORD"]

/** Whether a variable holds a secret: a `PLUGIN_*` key setting, a secret-looking name, or the clone password. */
export function isSecret(name: string): boolean {
  if (otherSecrets.includes(name)) return true
  return name.startsWith("PLUGIN_") && (/_KEY$/.test(name) || KeteRedact.isSecretKey(name))
}

/** Every secret value in `env` (at least `minLength` characters), and its JSON-escaped form; longest first. */
export function values(env: Env): string[] {
  const found = new Set<string>()
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || !isSecret(name)) continue
    const value = raw.trim()
    if (value.length < minLength) continue
    found.add(value)
    found.add(JSON.stringify(value).slice(1, -1))
  }
  return [...found].sort((a, b) => b.length - a.length)
}

export function redactor(env: Env): Redactor {
  const known = values(env)
  return (text) => {
    let out = text
    for (const value of known) if (out.includes(value)) out = out.split(value).join(mask)
    return KeteRedact.text(out)
  }
}

/** Pattern-based redaction only (no known values): for callers without the step's environment. */
export const shapes: Redactor = (text) => KeteRedact.text(text)

/** `KeteRedact.deep`, then the redactor over the serialized JSON (it masks escaped values too). */
export function json(value: unknown, redact: Redactor): string {
  return redact(JSON.stringify(KeteRedact.deep(value), null, 2))
}
