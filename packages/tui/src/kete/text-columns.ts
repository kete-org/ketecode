// Display columns as the TUI's text and textarea renderables count them (@opentui/core 0.8): each code point
// adds its own width (so "⚠️" is 1 and a joined emoji family is the sum of its people), a tab adds 2, and a
// newline adds 1 between lines. Text offsets, `lineInfo.lineStartCols` and textarea offsets use these columns.

import { stringWidth } from "../util/string-width"

const TAB = 2

export const columns = (char: string) => (char === "\t" ? TAB : char === "\n" ? 1 : stringWidth(char))

/** The column of string index `index` (rounded up past a surrogate pair it falls inside). */
export function columnOf(text: string, index: number) {
  let column = 0
  let at = 0
  for (const char of text) {
    if (at >= index) break
    column += columns(char)
    at += char.length
  }
  return column
}

/** The string index at `column`, snapped to the start of the character the column falls inside. */
export function indexOf(text: string, column: number) {
  let at = 0
  let current = 0
  for (const char of text) {
    const next = current + columns(char)
    if (next > column) return at
    current = next
    at += char.length
  }
  return text.length
}
