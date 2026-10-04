/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MARK_PIXELS, markCells, markLines } from "../../src/kete/mark"

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
