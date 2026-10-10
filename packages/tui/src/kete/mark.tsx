import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import { Logo } from "../component/logo"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"

/**
 * The Kete mark (assets/brand/kete-logo-512.png, packages/app/src/kete/mark.tsx) as terminal pixel
 * art: four columns (narrow, wide, wide, narrow) and four bands (narrow, wide, wide, narrow) with
 * one-pixel gaps, so the short ink bars stand apart as in the artwork. "K" is an ink bar (the
 * theme's text colour), "P" a brand bar, "." empty. Two pixel rows make one terminal line (half
 * blocks), so the mark is 9 columns by 5 lines.
 */
export const MARK_PIXELS = [
  "..KK.KK..",
  ".....KK..",
  "PPPPPKK.P",
  "PPPPPKK.P",
  "..KK.KK..",
  "P.KKPPPPP",
  "P.KKPPPPP",
  "..KK.....",
  "..KK.KK..",
] as const

/** The brand colour, fixed like the portal's and the web UI's mark (not a theme hue). */
export const BRAND = RGBA.fromHex("#6e47f5")

type Pixel = "K" | "P" | "."
export type MarkCell = { char: string; fg?: "K" | "P"; bg?: "K" | "P" }

/** One terminal line from two pixel rows: upper and lower half blocks, or a full block. */
export function markCells(top: string, bottom: string): MarkCell[] {
  return Array.from(top).map((char, i) => {
    const upper = char as Pixel
    const lower = (bottom[i] ?? ".") as Pixel
    if (upper === "." && lower === ".") return { char: " " }
    if (lower === ".") return { char: "▀", fg: upper as "K" | "P" }
    if (upper === ".") return { char: "▄", fg: lower }
    if (upper === lower) return { char: "█", fg: upper }
    return { char: "▀", fg: upper, bg: lower }
  })
}

export function markLines(): MarkCell[][] {
  const lines: MarkCell[][] = []
  for (let row = 0; row < MARK_PIXELS.length; row += 2) lines.push(markCells(MARK_PIXELS[row]!, MARK_PIXELS[row + 1] ?? ""))
  return lines
}

export function KeteMark(props: { glow?: Glow }): JSX.Element {
  const theme = useTheme()
  // Ink bars light up in the brand colour as the sweep passes; brand bars in the text colour.
  const color = (pixel: "K" | "P" | undefined, column: number, row: number) => {
    if (!pixel) return undefined
    const base = pixel === "K" ? theme.text.base : BRAND
    const level = props.glow?.(column, row) ?? 0
    return level > 0 ? tint(base, pixel === "K" ? BRAND : theme.text.base, level) : base
  }
  return (
    <box>
      <For each={markLines()}>
        {(line, row) => (
          <box flexDirection="row">
            <For each={line}>
              {(cell, column) => (
                <text
                  fg={color(cell.fg, column(), row())}
                  bg={color(cell.bg, column(), row())}
                  selectable={false}
                >
                  {cell.char}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

/**
 * "Kete Code" in block letters, in the style of upstream's wordmark (tui/src/logo.ts) and with two
 * of its cell codes: "_" a shaded space, "^" an upper half block on shade. As in the web UI's wordmark (app/src/kete/wordmark.tsx), "Kete" is in the
 * text colour and "Code" a step fainter.
 */
export const WORDMARK = {
  kete: ["▄  ▄               ", "█ ▄▀ █▀▀█ ▄█▄▄ █▀▀█", "█▀▄  █^^^  █   █^^^", "▀  ▀ ▀▀▀▀  ▀▀▀ ▀▀▀▀"],
  code: ["▄▄▄▄         ▄     ", "█    █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
} as const

/** Columns the wordmark needs: both words and the two-column space between them. */
export const WORDMARK_WIDTH = WORDMARK.kete[0].length + 2 + WORDMARK.code[0].length

export type WordmarkCell = { char: string; shaded: boolean }

/** One wordmark line as cells: the glyph to draw and where the shade colour goes. */
export function wordmarkCells(line: string): WordmarkCell[] {
  return Array.from(line).map((char) => {
    if (char === "_") return { char: " ", shaded: true }
    if (char === "^") return { char: "▀", shaded: true }
    return { char, shaded: false }
  })
}

export type WordmarkColors = { text: RGBA; muted: RGBA; background: RGBA; highlight?: RGBA }

/** How lit a cell is (0 to 1) at a column and line of the wordmark. */
export type Glow = (column: number, row: number) => number

export function KeteWordmark(props: WordmarkColors & { glow?: Glow }): JSX.Element {
  const word = (line: string, row: number, offset: number, fg: RGBA, bold: boolean) => {
    const shadow = tint(props.background, fg, 0.25)
    const attributes = bold ? TextAttributes.BOLD : undefined
    const lit = (column: number) => {
      const level = props.glow?.(offset + column, row) ?? 0
      return level > 0 && props.highlight ? tint(fg, props.highlight, level) : fg
    }
    return (
      <box flexDirection="row">
        <For each={wordmarkCells(line)}>
          {(cell, column) => (
            <text fg={lit(column())} bg={cell.shaded ? shadow : undefined} attributes={attributes} selectable={false}>
              {cell.char}
            </text>
          )}
        </For>
      </box>
    )
  }
  const code = WORDMARK.kete[0].length + 2
  return (
    <box>
      <For each={WORDMARK.kete}>
        {(line, index) => (
          <box flexDirection="row" gap={2}>
            {word(line, index(), 0, props.text, true)}
            {word(WORDMARK.code[index()]!, index(), code, props.muted, false)}
          </box>
        )}
      </For>
    </box>
  )
}

/**
 * The logo's animation: a soft diagonal band of light sweeps across the mark and the wordmark, a
 * moment after the home screen opens and then every few seconds. Between sweeps nothing runs.
 */
export const SWEEP = { delay: 400, duration: 1400, pause: 6000, frame: 33, width: 7 } as const

/** How lit the cell at a column and line of the whole logo is while the sweep is at `progress` (0 to 1). */
export function sweepLevel(column: number, row: number, progress: number, span: number): number {
  const center = -SWEEP.width + progress * (span + 2 * SWEEP.width)
  const distance = Math.abs(column + row - center)
  if (distance >= SWEEP.width) return 0
  const x = 1 - distance / SWEEP.width
  return x * x * (3 - 2 * x)
}

/** The sweep's progress (0 to 1) while it runs, undefined between sweeps and when animations are off. */
export function createSweep(enabled: Accessor<boolean>): Accessor<number | undefined> {
  const [progress, setProgress] = createSignal<number | undefined>()
  createEffect(() => {
    if (!enabled()) return setProgress(undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    let start = 0
    const tick = () => {
      const elapsed = (performance.now() - start) / SWEEP.duration
      if (elapsed >= 1) {
        setProgress(undefined)
        timer = setTimeout(begin, SWEEP.pause)
        return
      }
      setProgress(elapsed)
      timer = setTimeout(tick, SWEEP.frame)
    }
    const begin = () => {
      start = performance.now()
      tick()
    }
    timer = setTimeout(begin, SWEEP.delay)
    onCleanup(() => clearTimeout(timer))
  })
  return progress
}

/**
 * What the home screen's logo shows at a terminal size: the mark beside the "Kete Code" wordmark
 * when both fit, the wordmark alone when it fits, and upstream's compact logos otherwise.
 */
export function logoLayout(width: number, height: number): "mark" | "wordmark" | "compact" {
  if (height < 12 || width < WORDMARK_WIDTH + 4) return "compact"
  return width >= WORDMARK_WIDTH + 16 ? "mark" : "wordmark"
}

export function KeteLogo(): JSX.Element {
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const layout = () => logoLayout(dimensions().width, dimensions().height)
  const progress = createSweep(() => (config.animations ?? true) && layout() !== "compact")
  // Columns before the wordmark: the mark (9) and the gap (3) when the mark is shown.
  const offset = () => (layout() === "mark" ? 12 : 0)
  const span = () => offset() + WORDMARK_WIDTH + 5
  const glow =
    (shift: () => number, line: number): Glow =>
    (column, row) => {
      const value = progress()
      return value === undefined ? 0 : sweepLevel(shift() + column, line + row, value, span())
    }
  return (
    <Show when={layout() !== "compact"} fallback={<Logo />}>
      <box flexDirection="row" gap={3} alignItems="flex-end">
        <Show when={layout() === "mark"}>
          <KeteMark glow={glow(() => 0, 0)} />
        </Show>
        <KeteWordmark
          text={theme.text.base}
          muted={theme.text.muted}
          background={theme.background.base}
          highlight={theme.text.action.primary.selected}
          glow={glow(offset, 1)}
        />
      </box>
    </Show>
  )
}
