import { expect, test } from "bun:test"
import { TextRenderable, type WidthMethod } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { columnOf, indexOf } from "../../src/kete/text-columns"

const SAMPLES = ["\tab", "abc\tb", "⚠️x", "👨‍👩‍👧y", "éz", "中文", "🇬🇧!", "👍🏽k", "ｱｲ", "🙂"]

test("columns match the renderer's own widths, under its width method", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 14 })
  try {
    const nodes = SAMPLES.map((content, i) => {
      const node = new TextRenderable(renderer, { id: `t${i}`, content, wrapMode: "none" })
      renderer.root.add(node)
      return node
    })
    await renderOnce()
    for (const [i, sample] of SAMPLES.entries())
      expect(columnOf(sample, sample.length, renderer.widthMethod)).toBe(nodes[i]!.lineInfo.lineWidthCols[0]!)
  } finally {
    renderer.destroy()
  }
})

test.each(["wcwidth", "unicode"] as WidthMethod[])("indexOf inverts columnOf and snaps inside wide characters (%s)", (method) => {
  const text = "中\t😀\nz"
  const boundaries = [0, 1, 2, 4, 5, 6]
  for (const index of boundaries) expect(indexOf(text, columnOf(text, index, method), method)).toBe(index)
  expect(indexOf(text, 1, method)).toBe(0)
  expect(indexOf(text, 99, method)).toBe(text.length)
  // An index inside the emoji's surrogate pair counts the whole emoji.
  expect(columnOf(text, 3, method)).toBe(columnOf(text, 4, method))
})
