// The user-facing release notes in the repository's root CHANGELOG.md (docs/release.md). The CLI
// build embeds one section into the binary (packages/cli/script/kete-release-notes.ts), the TUI
// shows it (`/release-notes`, packages/tui/src/kete/release-notes.tsx), and the release workflow
// refuses a stable tag without its section (packages/kete-tools/src/changelog-check.ts).
// Plain functions over strings: no Node imports.

export const UNRELEASED = "Unreleased"
/** The most a section may embed into the binary, in UTF-8 bytes. */
export const MAX_BYTES = 4096
const ELLIPSIS = "…"

/** The body of `## <name>` (up to the next `## ` heading), trimmed; undefined when there is no such heading. */
export function section(text: string, name: string): string | undefined {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s/.test(line) && line.slice(2).trim() === name)
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim()
}

/** Cuts `notes` at a line boundary so it fits `max` bytes, ending with "…" when anything was cut. */
export function cap(notes: string, max = MAX_BYTES): string {
  const encoder = new TextEncoder()
  if (encoder.encode(notes).length <= max) return notes
  const room = max - encoder.encode("\n" + ELLIPSIS).length
  const kept: string[] = []
  let size = 0
  for (const line of notes.split("\n")) {
    const next = encoder.encode(line).length + (kept.length > 0 ? 1 : 0)
    if (size + next > room) break
    kept.push(line)
    size += next
  }
  return [...kept, ELLIPSIS].join("\n")
}

/** Whether a version carries a pre-release suffix (`0.3.0-rc.1`, `0.0.0-main-123`). */
export function isPrerelease(version: string) {
  return version.includes("-")
}

/**
 * The notes a build of `version` embeds: its own `## <version>` section; for a preview build or a
 * pre-release version without one, `## Unreleased`; otherwise nothing. Never throws.
 */
export function notesFor(text: string | undefined, version: string, preview: boolean): string {
  if (text === undefined) return ""
  const own = section(text, version)
  if (own) return cap(own)
  if (preview || isPrerelease(version)) return cap(section(text, UNRELEASED) ?? "")
  return ""
}

type Parsed = { core: [number, number, number]; pre: string[] }

function parse(version: string): Parsed | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  }
}

function comparePart(a: string, b: string) {
  const numeric = /^\d+$/
  if (numeric.test(a) && numeric.test(b)) return Math.sign(Number(a) - Number(b))
  if (numeric.test(a)) return -1
  if (numeric.test(b)) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semantic-version order of `a` and `b` (-1, 0, 1); undefined when either isn't a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return undefined
  for (const index of [0, 1, 2] as const) {
    const diff = Math.sign(left.core[index] - right.core[index])
    if (diff !== 0) return diff
  }
  if (left.pre.length === 0 || right.pre.length === 0) return Math.sign(right.pre.length - left.pre.length)
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const diff = comparePart(l, r)
    if (diff !== 0) return diff
  }
  return 0
}

export * as KeteChangelog from "./changelog.js"
