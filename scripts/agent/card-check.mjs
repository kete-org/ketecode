#!/usr/bin/env node
// Checks the knowledge base: every module card has the template's front matter and sections in
// order; every `path:line` reference in docs/context points at an existing file with that many
// lines; no Markdown file in docs/context looks like it holds a secret.
// Usage: node scripts/agent/card-check.mjs
// Exit code: 0 when clean, 1 when anything is wrong.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import { cards, frontMatter, root } from "./lib.mjs"

const SECTIONS = [
  "Quick answers",
  "Purpose",
  "Entry points",
  "Key files",
  "Data flow",
  "Data and APIs used",
  "Rules that must not break",
  "Testing",
  "Changes",
  "Gotchas",
]

const SECRETS = [
  [/kete_(live|test)_[A-Za-z0-9]{16,}/, "Kete API key"],
  [/sk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, "provider API key"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/(sk|pk)_(live|test)_[A-Za-z0-9]{16,}/, "payment key"],
  [/postgres(ql)?:\/\/[^\s:]+:[^\s@]+@/, "database URL with a password"],
]

// `path/to/file.ext:12` or `:12-20`, backticked or not.
const REFERENCE = /(?<![\w/.-])((?:packages|docs|scripts|services|\.github)\/[\w./@()[\]-]+?\.(?:ts|tsx|mts|mjs|js|sql|md|json|toml|ya?ml)):(\d+)(?:-(\d+))?/g

const problems = []
const lineCounts = new Map()
const lines = (file) => {
  if (!lineCounts.has(file)) lineCounts.set(file, readFileSync(file, "utf8").split("\n").length)
  return lineCounts.get(file)
}

function checkReferences(name, text) {
  for (const match of text.matchAll(REFERENCE)) {
    const [, relative, start, end] = match
    const file = path.join(root, relative)
    if (!existsSync(file) || !statSync(file).isFile()) {
      problems.push(`${name}: ${relative} doesn't exist`)
      continue
    }
    const last = Number(end ?? start)
    if (last > lines(file)) problems.push(`${name}: ${relative}:${end ? `${start}-${end}` : start} is past the end (${lines(file)} lines)`)
  }
}

function checkSecrets(name, text) {
  for (const [pattern, kind] of SECRETS) if (pattern.test(text)) problems.push(`${name}: looks like it contains a ${kind}`)
}

for (const card of cards()) {
  const name = `modules/${card.name}`
  const meta = frontMatter(card.text)
  if (!meta) {
    problems.push(`${name}: no front matter`)
    continue
  }
  if (!meta.module) problems.push(`${name}: front matter has no module`)
  if (meta.paths.length === 0) problems.push(`${name}: front matter has no paths`)
  if (!/^[0-9a-f]{7,40}$/.test(meta.verifiedAt ?? "")) problems.push(`${name}: verified-at isn't a commit sha`)
  const headings = [...meta.body.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim())
  let at = -1
  for (const section of SECTIONS) {
    const index = headings.indexOf(section)
    if (index === -1) problems.push(`${name}: missing section "${section}"`)
    else if (index < at) problems.push(`${name}: section "${section}" is out of order`)
    else at = index
  }
  if (/^```/m.test(meta.body)) problems.push(`${name}: contains a code block (cite path:line instead)`)
  checkReferences(name, card.text)
  checkSecrets(name, card.text)
}

const contextDir = path.join(root, "docs/context")
for (const file of existsSync(contextDir) ? readdirSync(contextDir) : []) {
  if (!file.endsWith(".md")) continue
  const text = readFileSync(path.join(contextDir, file), "utf8")
  checkReferences(file, text)
  checkSecrets(file, text)
}

for (const problem of problems) console.log(`✗ ${problem}`)
console.log(problems.length === 0 ? `✓ ${cards().length} cards and docs/context clean.` : `${problems.length} problem(s).`)
process.exit(problems.length === 0 ? 0 : 1)
