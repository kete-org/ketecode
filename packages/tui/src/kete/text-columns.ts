// Display columns as the TUI's text and textarea renderables count them: text offsets,
// `lineInfo.lineStartCols` and textarea offsets are cells from the start of the text under the renderer's width
// method (`wcwidth` or `unicode`: they differ on emoji like "⚠️"), with a tab as its fixed width and a newline as
// one. `measureEditText` is the renderer's own measure; widths add up grapheme by grapheme.

import { measureEditText, type WidthMethod } from "@opentui/core"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The column of string index `index` (an index inside a grapheme counts that whole grapheme). */
export function columnOf(text: string, index: number, widthMethod: WidthMethod) {
  let column = 0
  for (const { index: start, segment } of graphemes.segment(text)) {
    if (start >= index) break
    column += measureEditText(segment, { widthMethod })
  }
  return column
}

/** The string index at `column`, snapped to the start of the grapheme the column falls inside. */
export function indexOf(text: string, column: number, widthMethod: WidthMethod) {
  let current = 0
  for (const { index, segment } of graphemes.segment(text)) {
    const next = current + measureEditText(segment, { widthMethod })
    if (next > column) return index
    current = next
  }
  return text.length
}
