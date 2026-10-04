#!/usr/bin/env node
// Lists module cards whose `paths` changed since their `verified-at` commit, committed or not.
// Usage: node scripts/agent/stale-cards.mjs [card-name …]
// Exit code: 0 when every card is current, 1 when any is stale or unreadable.
import { cards, frontMatter, git, pathspecs } from "./lib.mjs"

const only = new Set(process.argv.slice(2).map((name) => name.replace(/\.md$/, "")))
let stale = 0

for (const card of cards()) {
  const name = card.name.replace(/\.md$/, "")
  if (only.size > 0 && !only.has(name)) continue
  const meta = frontMatter(card.text)
  if (!meta?.verifiedAt || meta.paths.length === 0) {
    console.log(`BAD    ${name}: missing verified-at or paths`)
    stale++
    continue
  }
  const specs = pathspecs(meta.paths)
  let changed
  try {
    const committed = git(["diff", "--name-only", `${meta.verifiedAt}..HEAD`, "--", ...specs])
    const working = git(["status", "--porcelain", "--", ...specs]).replace(/^.{3}/gm, "")
    changed = [...new Set(`${committed}\n${working}`.split("\n").filter(Boolean))]
  } catch (error) {
    console.log(`BAD    ${name}: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`)
    stale++
    continue
  }
  if (changed.length === 0) continue
  stale++
  const shown = changed.slice(0, 8).join(", ")
  console.log(`STALE  ${name} (${changed.length} file${changed.length === 1 ? "" : "s"} since ${meta.verifiedAt}): ${shown}${changed.length > 8 ? ", …" : ""}`)
}

console.log(stale === 0 ? "All cards current." : `${stale} card(s) need the librarian.`)
process.exit(stale === 0 ? 0 : 1)
