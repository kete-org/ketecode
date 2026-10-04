#!/usr/bin/env node
// Generates Kete Code agents (.kete/agents/*.md) and project permissions (.kete/kete.jsonc) from the
// Claude Code definitions (.claude/agents/*.md, .claude/settings.json), which are the source.
// Edit the Claude Code files, then run: node scripts/agent/kete-agents.mjs
// `--check` fails when the generated files are out of date.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { root } from "./lib.mjs"

// Claude Code model aliases → Kete gateway models ("provider/model"). Only models confirmed to
// work through the Kete gateway are mapped; an unmapped alias leaves `model` out, so the agent
// uses the session's model. Add haiku and opus here once they're in your gateway's catalog.
const MODELS = {
  sonnet: "kete/claude-sonnet-4-5",
}

// Claude Code tools → Kete permission actions.
const ACTIONS = { Read: ["read"], Grep: ["grep"], Glob: ["glob"], Edit: ["edit"], Write: ["edit"], Bash: ["shell"], Agent: ["subagent"] }

const source = path.join(root, ".claude/agents")
const target = path.join(root, ".kete/agents")
const check = process.argv.includes("--check")

function parse(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) return undefined
  const fields = {}
  for (const line of match[1].split("\n")) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line)
    if (pair) fields[pair[1]] = pair[2].trim()
  }
  return { fields, body: match[2].trim() }
}

/** `Read, Bash(git diff *), Bash(git log *)` → [["Read"], ["Bash", "git diff *"], …] */
function tools(value) {
  const items = []
  for (const match of (value ?? "").matchAll(/(\w+)(?:\(([^)]*)\))?/g)) items.push([match[1], match[2]])
  return items
}

function permissions(toolList, disallowed = []) {
  const rules = [{ action: "*", resource: "*", effect: "deny" }]
  for (const [tool, pattern] of toolList)
    for (const action of ACTIONS[tool] ?? [])
      rules.push({ action, resource: pattern ?? "*", effect: "allow" })
  // Kete applies the last matching rule, so disallowed tools come after the allows.
  for (const [tool, pattern] of disallowed)
    for (const action of ACTIONS[tool] ?? [])
      rules.push({ action, resource: pattern ?? "*", effect: "deny" })
  // Same secrets rule as the project: never read env or key files, even when reads are allowed.
  for (const resource of ["*.env", "*.env.*", "*.pem", "*.key"]) rules.push({ action: "read", resource, effect: "deny" })
  return rules
}

const quote = (value) => JSON.stringify(value)

function render(name, parsed) {
  const model = MODELS[parsed.fields.model]
  const lines = [
    "---",
    `description: ${quote(parsed.fields.description ?? name)}`,
    "mode: subagent",
    ...(model ? [`model: ${quote(model)}`] : []),
    "permissions:",
    ...permissions(tools(parsed.fields.tools), tools(parsed.fields.disallowedTools)).map(
      (rule) => `  - { action: ${quote(rule.action)}, resource: ${quote(rule.resource)}, effect: ${quote(rule.effect)} }`,
    ),
    "---",
    `<!-- Generated from .claude/agents/${name}.md by scripts/agent/kete-agents.mjs. Edit the source, not this file. -->`,
    "",
    parsed.body,
    "",
  ]
  return lines.join("\n")
}

/** The project's deny rules from .claude/settings.json, as Kete permission rules. */
function projectConfig() {
  const settings = JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8"))
  const rules = []
  for (const entry of settings.permissions?.deny ?? []) {
    const match = /^(\w+)\((.*)\)$/.exec(entry)
    if (!match) continue
    const [, tool, pattern] = match
    for (const action of ACTIONS[tool] ?? []) {
      const resource = action === "read" ? pattern.replace(/^\.\/(\*\*\/)?/, "") : pattern
      if (!rules.some((rule) => rule.action === action && rule.resource === resource)) rules.push({ action, resource, effect: "deny" })
    }
  }
  return `// Generated from .claude/settings.json by scripts/agent/kete-agents.mjs. Edit the source, not this file.\n${JSON.stringify({ permissions: rules }, null, 2)}\n`
}

const outputs = new Map()
for (const file of readdirSync(source).filter((name) => name.endsWith(".md")).sort()) {
  const name = file.replace(/\.md$/, "")
  const parsed = parse(readFileSync(path.join(source, file), "utf8"))
  if (!parsed) throw new Error(`.claude/agents/${file}: no front matter`)
  outputs.set(path.join(target, file), render(name, parsed))
}
outputs.set(path.join(root, ".kete/kete.jsonc"), projectConfig())

let stale = 0
for (const [file, text] of outputs) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (current === text) continue
  stale++
  if (check) console.log(`out of date: ${path.relative(root, file)}`)
  else {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
    console.log(`wrote ${path.relative(root, file)}`)
  }
}
if (check) {
  console.log(stale === 0 ? "Kete agents are current." : `${stale} file(s) out of date: run node scripts/agent/kete-agents.mjs`)
  process.exit(stale === 0 ? 0 : 1)
}
