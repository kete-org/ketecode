#!/usr/bin/env node
// Runs one check and prints only what an agent needs: PASS or FAIL, then the failing tests or
// errors with short excerpts. Never the full log.
// Usage: node scripts/agent/check-summary.mjs <command> [args …]
//   e.g. node scripts/agent/check-summary.mjs pnpm --filter portal exec vitest run test/sync.test.ts
// Exit code: the command's.
import { spawnSync } from "node:child_process"
import { root } from "./lib.mjs"

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error("usage: check-summary.mjs <command> [args …]")
  process.exit(2)
}

const started = Date.now()
const result = spawnSync(command, args, {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 64 * 1024 * 1024,
})
const seconds = ((Date.now() - started) / 1000).toFixed(1)
const label = [command, ...args].join(" ")
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "")
const all = output.split("\n")

// vitest ("Tests  12 passed (12)") and bun ("12 pass", "0 fail").
const counts = all.filter((line) => /^\s*(Test Files|Tests)\s+\d|^\s*\d+ (pass|fail)$/.test(line)).map((line) => line.trim())

if (result.status === 0) {
  console.log(`PASS  ${label}  (${seconds}s)${counts.length ? `  ${counts.join(" · ")}` : ""}`)
  process.exit(0)
}

console.log(`FAIL  ${label}  (${seconds}s, exit ${result.status ?? result.signal})${counts.length ? `  ${counts.join(" · ")}` : ""}`)

// Lines that start a failure: vitest, tsc, oxlint, pgTAP, generic errors.
const starts = [
  /^\s*(FAIL|×|✗)\s/,
  /^\(fail\) /,
  /error TS\d+:/,
  /^\s*×\s|^\s*x\s.*\(eslint|oxc\)/,
  /^not ok \d+/,
  /AssertionError|Error:/,
]
const excerpts = []
const seen = new Set()
for (let index = 0; index < all.length && excerpts.length < 12; index++) {
  const line = all[index]
  if (!starts.some((pattern) => pattern.test(line))) continue
  const key = line.trim()
  if (seen.has(key)) continue
  seen.add(key)
  excerpts.push(all.slice(index, index + 10).filter((item) => item.trim() !== "").slice(0, 10).join("\n"))
  index += 5
}

if (excerpts.length === 0) {
  // Nothing recognised: the last lines usually say why.
  console.log(all.filter((line) => line.trim() !== "").slice(-10).join("\n"))
} else {
  for (const excerpt of excerpts) console.log(`---\n${excerpt}`)
  if (excerpts.length === 12) console.log("--- (more failures not shown)")
}
process.exit(result.status ?? 1)
