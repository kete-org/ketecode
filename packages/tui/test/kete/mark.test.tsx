/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MARK_PIXELS, WORDMARK, WORDMARK_WIDTH, markCells, markLines, wordmarkCells } from "../../src/kete/mark"

test("the mark keeps the brand mark's half-turn symmetry", () => {
  const rotated = [...MARK_PIXELS].reverse().map((row) => Array.from(row).reverse().join(""))
  expect(rotated).toEqual([...MARK_PIXELS])
  for (const row of MARK_PIXELS) expect(row).toHaveLength(9)
  expect(MARK_PIXELS.join("")).toMatch(/^[KP.]+$/)
})

test("two pixel rows become one terminal line of half blocks", () => {
  expect(markCells("K.P", ".PP")).toEqual([
    { char: "▀", fg: "K" },
    { char: "▄", fg: "P" },
    { char: "█", fg: "P" },
  ])
  expect(markCells("KP", "PK")).toEqual([
    { char: "▀", fg: "K", bg: "P" },
    { char: "▀", fg: "P", bg: "K" },
  ])
  expect(markCells(".", ".")).toEqual([{ char: " " }])
})

test("the mark is five lines tall and draws exactly these glyphs", () => {
  const lines = markLines()
  expect(lines).toHaveLength(5)
  expect(lines.map((line) => line.map((cell) => cell.char).join(""))).toEqual([
    "  ▀▀ ██  ",
    "███████ █",
    "▄ ██▄▀▀▄▄",
    "▀ ██▀▀▀▀▀",
    "  ▀▀ ▀▀  ",
  ])
})

test("the wordmark reads Kete Code: two words of equal width in four lines", () => {
  expect(WORDMARK.kete).toHaveLength(4)
  expect(WORDMARK.code).toHaveLength(4)
  for (const line of [...WORDMARK.kete, ...WORDMARK.code]) {
    expect(Array.from(line)).toHaveLength(19)
    expect(line).toMatch(/^[ █▀▄_^]+$/)
  }
  expect(WORDMARK_WIDTH).toBe(40)
})

test("wordmark shade codes become shaded cells", () => {
  expect(wordmarkCells("█_^")).toEqual([
    { char: "█", shaded: false },
    { char: " ", shaded: true },
    { char: "▀", shaded: true },
  ])
})
