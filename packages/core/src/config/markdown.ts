export * as ConfigMarkdown from "./markdown.js"

import matter from "gray-matter"
// kete_change start: YAML front matter only. gray-matter's defaults include a JavaScript engine that evaluates
// a `---js` (or `---javascript`) block, so a repository's agent, command or skill markdown could run code when
// the folder loads (GHSA-m7hc-g593-r9wg). Any other front-matter language is refused, and the code-evaluating
// engines are replaced as a second guard.
const SAFE_LANGUAGES = new Set(["", "yaml", "yml"])
const refuse = {
  parse: () => {
    throw new Error("front matter must be YAML")
  },
}
const OPTIONS = { engines: { javascript: refuse, js: refuse, coffee: refuse, coffeescript: refuse, cson: refuse } }

/** The language named after the opening `---`, lower-cased ("" when none). */
export function frontMatterLanguage(content: string) {
  const match = content.match(/^\uFEFF?---([^\r\n]*)\r?\n/)
  return match ? match[1]!.trim().toLowerCase() : ""
}

function load(content: string) {
  const language = frontMatterLanguage(content)
  if (!SAFE_LANGUAGES.has(language)) throw new Error(`front matter must be YAML, not "${language}"`)
  return matter(content, OPTIONS)
}
// kete_change end
export function parse(content: string) {
  try {
    return load(content) // kete_change
  } catch {
    return load(sanitize(content)) // kete_change
  }
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
