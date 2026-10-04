#!/usr/bin/env node
// Creates a task folder from docs/tasks/_template.
// Usage: node scripts/agent/task-new.mjs <slug> [medium|large] ["Title"]
// Small tasks don't get a folder: scout if needed, edit, run the narrow check.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { root } from "./lib.mjs"

const [slug, size = "medium", ...titleWords] = process.argv.slice(2)
if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error("usage: task-new.mjs <slug: lowercase-with-dashes> [medium|large] [title]")
  process.exit(2)
}
if (size === "small") {
  console.log("Small tasks don't need a task folder: scout if needed → edit → narrow check → done.")
  process.exit(0)
}
if (size !== "medium" && size !== "large") {
  console.error(`unknown size "${size}": use medium or large`)
  process.exit(2)
}

const date = new Date().toISOString().slice(0, 10)
const folder = `docs/tasks/${date}-${slug}`
const target = path.join(root, folder)
if (existsSync(target)) {
  console.error(`${folder} already exists`)
  process.exit(1)
}

const title = titleWords.join(" ") || slug.replaceAll("-", " ")
const template = path.join(root, "docs/tasks/_template")
mkdirSync(target, { recursive: true })
for (const file of readdirSync(template)) {
  const text = readFileSync(path.join(template, file), "utf8")
    .replaceAll("{{title}}", title)
    .replaceAll("{{folder}}", folder)
    .replaceAll("{{size}}", size)
    .replaceAll("{{date}}", date)
  writeFileSync(path.join(target, file), text)
}
console.log(folder)
if (size === "large") console.log("Large: spec.md and plan.md need approval before building.")
