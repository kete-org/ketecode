import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, type JSX } from "solid-js"
import { Logo } from "../component/logo"
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

export function KeteMark(): JSX.Element {
  const theme = useTheme()
  const color = (pixel: "K" | "P" | undefined) => (pixel === "K" ? theme.text.base : pixel === "P" ? BRAND : undefined)
  return (
    <box>
      <For each={markLines()}>
        {(line) => (
          <box flexDirection="row">
            <For each={line}>
              {(cell) => (
                <text fg={color(cell.fg)} bg={color(cell.bg)} selectable={false}>
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

export type WordmarkColors = { text: RGBA; muted: RGBA; background: RGBA }

export function KeteWordmark(props: WordmarkColors): JSX.Element {
  const word = (line: string, fg: RGBA, bold: boolean) => {
    const shadow = tint(props.background, fg, 0.25)
    const attributes = bold ? TextAttributes.BOLD : undefined
    return (
      <box flexDirection="row">
        <For each={wordmarkCells(line)}>
          {(cell) => (
            <text fg={fg} bg={cell.shaded ? shadow : undefined} attributes={attributes} selectable={false}>
              {cell.char}
            </text>
          )}
        </For>
      </box>
    )
  }
  return (
    <box>
      <For each={WORDMARK.kete}>
        {(line, index) => (
          <box flexDirection="row" gap={2}>
            {word(line, props.text, true)}
            {word(WORDMARK.code[index()]!, props.muted, false)}
          </box>
        )}
      </For>
    </box>
  )
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
  const dimensions = useTerminalDimensions()
  const layout = () => logoLayout(dimensions().width, dimensions().height)
  return (
    <Show when={layout() !== "compact"} fallback={<Logo />}>
      <box flexDirection="row" gap={3} alignItems="flex-end">
        <Show when={layout() === "mark"}>
          <KeteMark />
        </Show>
        <KeteWordmark text={theme.text.base} muted={theme.text.muted} background={theme.background.base} />
      </box>
    </Show>
  )
}
