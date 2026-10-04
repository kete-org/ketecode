// A turn's changes as VS Code diffs: the file before the turn, rebuilt from the runtime's unified
// patch (`GET /api/session/:id/diff`), against the file on disk. Session diffs carry the whole file
// as context, so the "before" side comes from the patch alone; a patch with only some context is
// reversed against the current file instead, and refused if that file changed since the turn.
// Kept free of the `vscode` module so it can be unit-tested.

type Line = { readonly kind: " " | "-" | "+"; readonly text: string; readonly newline: boolean }
type Hunk = { readonly oldStart: number; readonly newStart: number; readonly lines: Line[] }

export function parse(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  const rows = patch.split("\n")
  for (let index = 0; index < rows.length; index++) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rows[index]!)
    if (!header) continue
    const lines: Line[] = []
    for (index++; index < rows.length; index++) {
      const row = rows[index]!
      if (row.startsWith("@@")) {
        index--
        break
      }
      if (row.startsWith("\\")) {
        // "\ No newline at end of file" applies to the line before it.
        const last = lines.pop()
        if (last) lines.push({ ...last, newline: false })
        continue
      }
      const kind = row[0]
      if (kind !== " " && kind !== "-" && kind !== "+") {
        if (row === "") continue
        break
      }
      lines.push({ kind, text: row.slice(1), newline: true })
    }
    hunks.push({ oldStart: Number(header[1]), newStart: Number(header[2]), lines })
  }
  return hunks
}

/**
 * The file as it was before the patch. `current` (the file on disk) is only needed when the patch
 * doesn't carry the whole file; undefined means the file doesn't exist now.
 */
export function before(patch: string, current: string | undefined): string {
  const hunks = parse(patch)
  if (hunks.length === 0) return current ?? ""
  if (hunks.length === 1 && hunks[0]!.oldStart <= 1 && hunks[0]!.newStart <= 1 && coversWhole(hunks[0]!, current))
    return join(hunks[0]!.lines.filter((line) => line.kind !== "+"))
  if (current === undefined) throw new Error("the file is gone, and the patch doesn't carry all of it")
  return reverse(hunks, current)
}

function coversWhole(hunk: Hunk, current: string | undefined) {
  // The whole file: its new side is exactly the current file (or the file is gone now).
  return current === undefined || join(hunk.lines.filter((line) => line.kind !== "-")) === current
}

/** Undoes the hunks on `current`, checking every context and added line still matches. */
function reverse(hunks: Hunk[], current: string) {
  const lines = split(current)
  const out: Line[] = []
  let cursor = 0
  for (const hunk of hunks) {
    const start = Math.max(hunk.newStart - 1, 0)
    if (start < cursor) throw new Error("overlapping hunks")
    out.push(...lines.slice(cursor, start))
    cursor = start
    for (const line of hunk.lines) {
      if (line.kind === "-") {
        out.push(line)
        continue
      }
      if (lines[cursor]?.text !== line.text) throw new Error("the file changed since this turn")
      if (line.kind === " ") out.push(lines[cursor]!)
      cursor++
    }
  }
  out.push(...lines.slice(cursor))
  return join(out)
}

function split(text: string): Line[] {
  if (text === "") return []
  const parts = text.split("\n")
  const newline = text.endsWith("\n")
  if (newline) parts.pop()
  return parts.map((part, index) => ({ kind: " ", text: part, newline: index < parts.length - 1 || newline }))
}

function join(lines: readonly Line[]) {
  return lines.map((line) => line.text + (line.newline ? "\n" : "")).join("")
}
