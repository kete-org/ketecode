// Shared helpers for the agent scripts. No dependencies beyond Node.
import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"

export const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
export const cardsDir = path.join(root, "docs/context/modules")

/** Parses a card's front matter: module, paths (a YAML flow list) and verified-at. */
export function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return undefined
  const fields = {}
  for (const line of match[1].split("\n")) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line)
    if (pair) fields[pair[1]] = pair[2].trim()
  }
  const paths = /^\[(.*)\]$/.exec(fields.paths ?? "")
  return {
    module: fields.module,
    verifiedAt: fields["verified-at"],
    paths: paths ? splitList(paths[1]) : [],
    body: text.slice(match[0].length),
  }
}

/** Splits a flow list on commas that aren't inside braces. */
function splitList(value) {
  const items = []
  let depth = 0
  let current = ""
  for (const char of value) {
    if (char === "{") depth++
    if (char === "}") depth--
    if (char === "," && depth === 0) {
      items.push(current)
      current = ""
    } else current += char
  }
  items.push(current)
  return items.map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
}

/** Expands `{a,b}` braces, which git pathspecs don't support. */
export function expandBraces(pattern) {
  const match = /\{([^{}]*)\}/.exec(pattern)
  if (!match) return [pattern]
  return match[1]
    .split(",")
    .flatMap((part) => expandBraces(pattern.slice(0, match.index) + part + pattern.slice(match.index + match[0].length)))
}

/** The git pathspecs for a card's `paths`. */
export function pathspecs(paths) {
  return paths.flatMap(expandBraces).map((item) => `:(glob)${item.replace(/\/$/, "/**")}`)
}

export function cards() {
  if (!existsSync(cardsDir)) return []
  return readdirSync(cardsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const file = path.join(cardsDir, name)
      return { file, name, text: readFileSync(file, "utf8") }
    })
}

export function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}
