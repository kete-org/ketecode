// Builds the `@path#Lstart-end` reference the extension types into the Kete Code
// prompt. Kept free of the `vscode` module so it can be unit-tested with Bun.

/** The parts of a `vscode.Selection` the reference needs (zero-based positions). */
export type Selection = {
  isEmpty: boolean
  start: { line: number }
  end: { line: number; character: number }
}

export function fileReference(relativePath: string, selection?: Selection) {
  if (!selection || selection.isEmpty) return `@${relativePath}`
  const start = selection.start.line + 1
  // A selection of whole lines ends at column 0 of the following line; that line is not selected.
  const end =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line
      : selection.end.line + 1
  if (start === end) return `@${relativePath}#L${start}`
  return `@${relativePath}#L${start}-${end}`
}
