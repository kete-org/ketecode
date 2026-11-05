import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { columnOf, indexOf } from "../../src/kete/text-columns"

test("columns match the renderer's own widths, including tabs and joined emoji", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 12 })
  try {
    const samples = ["\tab", "⚠️x", "👨‍👩‍👧y", "éz", "中文", "🇬🇧!", "👍🏽k", "ｱｲ", "🙂"]
    const nodes = samples.map((content, i) => {
      const node = new TextRenderable(renderer, { id: `t${i}`, content, wrapMode: "none" })
      renderer.root.add(node)
      return node
    })
    await renderOnce()
    for (const [i, sample] of samples.entries()) expect(columnOf(sample, sample.length)).toBe(nodes[i]!.lineInfo.lineWidthCols[0]!)
  } finally {
    renderer.destroy()
  }
})

test("indexOf inverts columnOf and snaps inside wide characters", () => {
  const text = "中\t😀\nz"
  expect([0, 1, 2, 4, 5, 6].map((index) => columnOf(text, index))).toEqual([0, 2, 4, 6, 7, 8])
  expect([0, 2, 4, 6, 7].map((column) => indexOf(text, column))).toEqual([0, 1, 2, 4, 5])
  expect(indexOf(text, 1)).toBe(0)
  expect(indexOf(text, 99)).toBe(text.length)
})
